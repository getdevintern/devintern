import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { ScheduledRetryStore } from "../src/lib/run-retry";
import { RetryQueueAcquirer } from "../src/lib/workspace/retry-acquirer";
import type { TaskExecutionResult } from "../src/lib/task-polling-acquirer";

describe("RetryQueueAcquirer", () => {
  let dir: string;
  let dbPath: string;
  let store: ScheduledRetryStore;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `retry-acquirer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    store = new ScheduledRetryStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeAcquirer(
    behavior: (taskKey: string) => Promise<TaskExecutionResult> | TaskExecutionResult,
    calls: string[],
  ): RetryQueueAcquirer {
    return new RetryQueueAcquirer({
      store,
      execute: async (taskKey) => {
        calls.push(taskKey);
        return await behavior(taskKey);
      },
      intervalSeconds: 3600, // ticks are driven manually in tests
    });
  }

  test("drains pending retries through the executor and marks them done", async () => {
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });
    store.schedule({ taskKey: "PROJ-2", actor: "b@x.com" });

    const calls: string[] = [];
    const acquirer = makeAcquirer(() => true, calls);
    await acquirer.tick();

    expect(calls).toEqual(["PROJ-1", "PROJ-2"]);
    expect(store.hasActive("PROJ-1")).toBe(false);
    expect(store.hasActive("PROJ-2")).toBe(false);
    expect(store.hasPending()).toBe(false);
  });

  test("passes persisted team and repo context to the executor", async () => {
    store.schedule({
      taskKey: "PROJ-1",
      team: "platform",
      repo: "api",
      actor: "a@x.com",
    });
    const contexts: Array<{ team?: string; repo?: string }> = [];
    const acquirer = new RetryQueueAcquirer({
      store,
      execute: async (_taskKey, _routable, retry) => {
        contexts.push({ team: retry.team, repo: retry.repo });
        return true;
      },
      intervalSeconds: 3600,
    });

    await acquirer.tick();
    expect(contexts).toEqual([{ team: "platform", repo: "api" }]);
  });

  test("marks failed rows with a message when the pipeline fails", async () => {
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });

    const calls: string[] = [];
    const acquirer = makeAcquirer(() => false, calls);
    await acquirer.tick();

    expect(calls).toEqual(["PROJ-1"]);
    expect(store.hasActive("PROJ-1")).toBe(false);
  });

  test("requeues deferred rows for the next tick", async () => {
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });

    const calls: string[] = [];
    let busy = true;
    const acquirer = makeAcquirer(() => (busy ? "deferred" : true), calls);

    await acquirer.tick();
    expect(calls).toEqual(["PROJ-1"]);
    expect(store.hasPending()).toBe(true);

    busy = false;
    await acquirer.tick();
    expect(calls).toEqual(["PROJ-1", "PROJ-1"]);
    expect(store.hasPending()).toBe(false);
  });

  test("records the error message when the executor throws", async () => {
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });

    const acquirer = makeAcquirer(() => {
      throw new Error("boom");
    }, []);
    await acquirer.tick();

    expect(store.hasActive("PROJ-1")).toBe(false);
  });

  test("a tick while draining is a no-op (busy guard)", async () => {
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });

    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquirer = new RetryQueueAcquirer({
      store,
      execute: async (taskKey) => {
        calls.push(taskKey);
        await gate;
        return true;
      },
      intervalSeconds: 3600,
    });

    const first = acquirer.tick();
    await acquirer.tick(); // blocked by the busy guard, must not claim
    release();
    await first;

    expect(calls).toEqual(["PROJ-1"]);
  });
});
