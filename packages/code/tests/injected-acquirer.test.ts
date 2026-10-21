import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { InjectedTaskAcquirer } from "../src/lib/workspace/injected-acquirer";
import type { TaskExecutionResult } from "../src/lib/acquirers/task-polling";

describe("InjectedTaskAcquirer", () => {
  let dir: string;
  let store: InjectedTaskStore;

  beforeEach(() => {
    dir = join(tmpdir(), `injected-acq-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    store = new InjectedTaskStore(join(dir, "queue.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function enqueue(taskKey: string, repo = "backend") {
    store.enqueue({
      taskKey,
      repo,
      title: taskKey,
      body: "",
      taskFile: join(dir, `${taskKey}.md`),
    });
  }

  test("drains pending tasks through the executor and marks them done", async () => {
    enqueue("local-a");
    enqueue("local-b");

    const calls: string[] = [];
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async (task) => {
        calls.push(task.taskKey);
        return true;
      },
      intervalSeconds: 3600,
    });
    await acquirer.tick();

    expect(calls).toEqual(["local-a", "local-b"]);
    expect(store.hasPending()).toBe(false);
  });

  test("requeues deferred tasks for the next tick", async () => {
    enqueue("local-a");

    const calls: string[] = [];
    let busy = true;
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async (task) => {
        calls.push(task.taskKey);
        return busy ? "deferred" : true;
      },
      intervalSeconds: 3600,
    });

    await acquirer.tick();
    expect(calls).toEqual(["local-a"]);
    expect(store.hasPending()).toBe(true);

    busy = false;
    await acquirer.tick();
    expect(calls).toEqual(["local-a", "local-a"]);
    expect(store.hasPending()).toBe(false);
  });

  test("settles a skipped task as done rather than failed", async () => {
    enqueue("local-a");

    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async () => "skipped",
      intervalSeconds: 3600,
    });
    await acquirer.tick();

    const [task] = store.list();
    expect(task?.status).toBe("done");
    expect(task?.message).toContain("skipped");
    expect(store.hasPending()).toBe(false);
  });

  test("a deferred repo does not starve tasks for other repos", async () => {
    enqueue("local-a", "r1");
    enqueue("local-b", "r2");

    const calls: string[] = [];
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async (task) => {
        calls.push(task.taskKey);
        return task.repo === "r1" ? "deferred" : true;
      },
      intervalSeconds: 3600,
    });
    await acquirer.tick();

    // local-a is blocked on r1, but local-b on a free repo still runs in the
    // same drain instead of waiting behind it.
    expect(calls).toEqual(["local-a", "local-b"]);
    const byKey = Object.fromEntries(store.list().map((task) => [task.taskKey, task.status]));
    expect(byKey["local-b"]).toBe("done");
    expect(byKey["local-a"]).toBe("pending");
    expect(store.hasPending()).toBe(true);
  });

  test("marks failed rows when the pipeline fails or throws", async () => {
    enqueue("local-a");
    const failed = new InjectedTaskAcquirer({
      store,
      execute: async () => false,
      intervalSeconds: 3600,
    });
    await failed.tick();
    expect(store.hasPending()).toBe(false);

    enqueue("local-b");
    const threw = new InjectedTaskAcquirer({
      store,
      execute: async () => {
        throw new Error("boom");
      },
      intervalSeconds: 3600,
    });
    await threw.tick();
    expect(store.hasPending()).toBe(false);
  });

  test("a tick while draining is a no-op (busy guard)", async () => {
    enqueue("local-a");

    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async (task) => {
        calls.push(task.taskKey);
        await gate;
        return true as TaskExecutionResult;
      },
      intervalSeconds: 3600,
    });

    const first = acquirer.tick();
    await acquirer.tick();
    release();
    await first;

    expect(calls).toEqual(["local-a"]);
  });

  test("does not settle a row through a closed store during shutdown", async () => {
    enqueue("local-a");
    const dbPath = join(dir, "queue.db");

    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async () => {
        signalStarted();
        await gate;
        return true as TaskExecutionResult;
      },
      intervalSeconds: 3600,
    });

    const tick = acquirer.tick();
    // The row is now claimed `running` and `execute` is in flight.
    await started;
    // Shutdown order: the worker stops the acquirer, then closes the store,
    // while the in-flight execute has not resolved yet.
    acquirer.stop();
    store.close();
    release();
    // Must resolve cleanly (no unhandled throw) and must not reopen the DB.
    await tick;

    const verify = new InjectedTaskStore(dbPath);
    try {
      // Left `running` for the successor's orphan recovery, not settled `done`
      // through a resurrected connection.
      expect(verify.getById(1)?.status).toBe("running");
    } finally {
      verify.close();
    }
  });
});
