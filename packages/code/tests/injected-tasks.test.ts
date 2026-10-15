import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { InjectedTaskStore } from "../src/lib/state/injected-tasks";

describe("InjectedTaskStore", () => {
  let dir: string;
  let dbPath: string;
  let store: InjectedTaskStore;

  beforeEach(() => {
    dir = join(tmpdir(), `injected-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    store = new InjectedTaskStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = {
    taskKey: "local-fix-flaky-test",
    repo: "backend",
    title: "Fix flaky test",
    body: "Investigate the flake.",
    taskFile: "/ws/injected/local-fix-flaky-test.md",
  };

  test("enqueues a pending task and claims it", () => {
    const { task, deduplicated } = store.enqueue(base);
    expect(deduplicated).toBe(false);
    expect(task.status).toBe("pending");
    expect(task.repo).toBe("backend");
    expect(task.actor).toBe("local:add");
    expect(store.hasPending()).toBe(true);

    const claimed = store.claimNext();
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("running");
    expect(store.claimNext()).toBeNull();
  });

  test("enqueue is idempotent on the idempotency key", () => {
    const first = store.enqueue({ ...base, idempotencyKey: "run-42" });
    const second = store.enqueue({
      ...base,
      taskKey: "local-other",
      taskFile: "/ws/injected/other.md",
      idempotencyKey: "run-42",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(store.list()).toHaveLength(1);
  });

  test("tasks without an idempotency key never dedupe", () => {
    store.enqueue(base);
    store.enqueue({ ...base, taskKey: "local-second", taskFile: "/ws/injected/second.md" });
    expect(store.list()).toHaveLength(2);
  });

  test("finish, requeue, and failRunning settle rows", () => {
    const a = store.enqueue(base);
    store.enqueue({ ...base, taskKey: "local-b", taskFile: "/ws/injected/b.md" });

    const claimedA = store.claimNext()!;
    store.requeue(claimedA.id);
    expect(store.getById(a.task.id)?.status).toBe("pending");

    const claimedAgain = store.claimNext()!;
    store.finish(claimedAgain.id, "done");
    expect(store.getById(claimedAgain.id)?.status).toBe("done");

    const claimedB = store.claimNext()!;
    store.finish(claimedB.id, "failed", "boom");
    const failed = store.getById(claimedB.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.message).toBe("boom");

    // A crashed worker leaves a row running; startup recovery fails it.
    store.enqueue({ ...base, taskKey: "local-c", taskFile: "/ws/injected/c.md" });
    const claimedC = store.claimNext()!;
    const settled = store.failRunning("worker restarted");
    expect(settled.map((task) => task.id)).toEqual([claimedC.id]);
    expect(store.getById(claimedC.id)?.status).toBe("failed");
  });

  test("hasTaskKey detects generated-key collisions", () => {
    store.enqueue(base);
    expect(store.hasTaskKey(base.taskKey)).toBe(true);
    expect(store.hasTaskKey("local-nope")).toBe(false);
  });

  test("rejects a duplicate task_key without an idempotency key", () => {
    store.enqueue(base);
    expect(() => store.enqueue({ ...base, taskFile: "/ws/injected/other-path.md" })).toThrow(
      /task_key/,
    );
    expect(store.list()).toHaveLength(1);
  });

  test("pruneSettled removes settled rows and spares pending/running ones", () => {
    const doneTask = store.enqueue(base);
    store.finish(store.claimNext()!.id, "done");

    store.enqueue({ ...base, taskKey: "local-running", taskFile: "/ws/injected/running.md" });
    store.claimNext();

    store.enqueue({ ...base, taskKey: "local-pending", taskFile: "/ws/injected/pending.md" });

    const pruned = store.pruneSettled(0, Date.now() + 1_000);
    expect(pruned).toBe(1);
    expect(store.getById(doneTask.task.id)).toBeNull();
    expect(
      store
        .list()
        .map((task) => task.taskKey)
        .sort(),
    ).toEqual(["local-pending", "local-running"]);
  });
});
