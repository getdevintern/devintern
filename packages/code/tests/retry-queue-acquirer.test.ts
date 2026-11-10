import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { RunStore } from "../src/lib/state/run-recorder";
import { resetWorkerFailover } from "../src/lib/worker/failover";
import { RetryQueueAcquirer } from "../src/lib/workspace/retry-acquirer";
import type { TaskExecutionResult } from "../src/lib/acquirers/task-polling";

describe("RetryQueueAcquirer", () => {
  let dir: string;
  let dbPath: string;
  let store: ScheduledRetryStore;

  beforeEach(() => {
    // The default `isPaused` reads the process-wide failover singleton, so a
    // controller leaked by an earlier test (or a preload) would silently
    // disable every drain in this file. Start each test from a clean slate.
    resetWorkerFailover();
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
    resetWorkerFailover();
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

  test("persists the current failed retry reason and ignores the pickup run", async () => {
    const runs = new RunStore(dbPath);
    const previous = runs.createRun({ origin: "task", taskKey: "PROJ-1", repo: "api" });
    runs.finishRun(previous, "failed", "previous failure");
    store.schedule({ taskKey: "PROJ-1", repo: "api", runId: previous, actor: "a@x.com" });

    const acquirer = new RetryQueueAcquirer({
      store,
      runDbPath: dbPath,
      execute: async () => {
        const current = runs.createRun({ origin: "task", taskKey: "PROJ-1", repo: "api" });
        runs.finishRun(current, "failed", "current retry failure");
        return false;
      },
      intervalSeconds: 3600,
    });
    await acquirer.tick();
    runs.close();

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .query("SELECT status, message FROM scheduled_retries WHERE task_key = 'PROJ-1'")
      .get() as {
      status: string;
      message: string;
    };
    raw.close();
    expect(row).toEqual({ status: "failed", message: "current retry failure" });
  });

  test("falls back when the latest retry run is from another source", async () => {
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });
    const acquirer = new RetryQueueAcquirer({
      store,
      runDbPath: dbPath,
      execute: async () => {
        const runs = new RunStore(dbPath);
        const id = runs.createRun({ origin: "local", taskKey: "PROJ-1" });
        runs.finishRun(id, "failed", "unrelated failure");
        runs.close();
        return false;
      },
      intervalSeconds: 3600,
    });
    await acquirer.tick();

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .query("SELECT message FROM scheduled_retries WHERE task_key = 'PROJ-1'")
      .get() as {
      message: string;
    };
    raw.close();
    expect(row.message).toBe("task pipeline did not complete cleanly");
  });

  test("does not reuse a prior attempt's reason at the claim millisecond", async () => {
    const runs = new RunStore(dbPath);
    const previous = runs.createRun({ origin: "task", taskKey: "PROJ-1" });
    runs.finishRun(previous, "failed", "prior attempt failed");
    runs.close();
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });

    const acquirer = new RetryQueueAcquirer({
      store,
      runDbPath: dbPath,
      execute: async (_taskKey, _routable, retry) => {
        const raw = new Database(dbPath);
        raw.run("UPDATE runs SET started_at = ? WHERE id = ?", [retry.startedAt!, previous]);
        raw.close();
        return false;
      },
      intervalSeconds: 3600,
    });
    await acquirer.tick();

    const reader = new Database(dbPath, { readonly: true });
    const row = reader
      .query("SELECT message FROM scheduled_retries WHERE task_key = 'PROJ-1'")
      .get() as {
      message: string;
    };
    reader.close();
    expect(row.message).toBe("task pipeline did not complete cleanly");
  });

  test("settles a skipped row as done rather than failed", async () => {
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });

    const calls: string[] = [];
    const acquirer = makeAcquirer(() => "skipped", calls);
    await acquirer.tick();

    const { Database } = require("bun:sqlite");
    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .query("SELECT status, message FROM scheduled_retries WHERE task_key = 'PROJ-1'")
      .get() as { status: string; message: string | null };
    raw.close();

    expect(calls).toEqual(["PROJ-1"]);
    expect(row.status).toBe("done");
    expect(row.message).toContain("skipped");
    expect(store.hasPending()).toBe(false);
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

  test("leaves queued retries untouched and silent while the harness chain is paused", async () => {
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });

    const calls: string[] = [];
    let paused = true;
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      const acquirer = new RetryQueueAcquirer({
        store,
        execute: async (taskKey) => {
          calls.push(taskKey);
          return true;
        },
        isPaused: () => paused,
        intervalSeconds: 3600,
      });

      // Many paused ticks must not claim, re-run, requeue, or log the row.
      for (let i = 0; i < 50; i++) {
        await acquirer.tick();
      }
      expect(calls).toEqual([]);
      expect(logs).not.toHaveBeenCalled();
      expect(store.hasActive("PROJ-1")).toBe(true);
      expect(store.hasPending()).toBe(true);

      // The first unpaused tick drains the row normally.
      paused = false;
      await acquirer.tick();
      expect(calls).toEqual(["PROJ-1"]);
      expect(store.hasActive("PROJ-1")).toBe(false);
      expect(store.hasPending()).toBe(false);
    } finally {
      logs.mockRestore();
    }
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
