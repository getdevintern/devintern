import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { DashboardData, handleRetryRun, handleRunDetail } from "../src/lib/dashboard-api";
import type { RetryHandlerDeps } from "../src/lib/dashboard-api";
import { isRunRetriable, ScheduledRetryStore } from "../src/lib/run-retry";
import type { SpawnedRetryProcess } from "../src/lib/run-retry";
import { RunStore } from "../src/lib/run-recorder";
import type { RunStatus } from "../src/lib/run-recorder";

const ACTOR: NonNullable<RetryHandlerDeps["resolveActor"]> = async () => ({
  email: "sup@example.com",
});

/** Deps with a fake spawn that records the task key it was invoked for. */
function stubDeps(overrides: Partial<RetryHandlerDeps> = {}): {
  deps: RetryHandlerDeps;
  spawned: string[];
  pids: number[];
} {
  const spawned: string[] = [];
  const pids: number[] = [];
  let nextPid = 4000;
  const deps: RetryHandlerDeps = {
    resolveActor: ACTOR,
    spawn: (taskKey: string) => {
      spawned.push(taskKey);
      pids.push(nextPid++);
      return { pid: pids[pids.length - 1], command: `bun devintern ${taskKey} --force` };
    },
    ...overrides,
  };
  return { deps, spawned, pids };
}

describe("isRunRetriable", () => {
  test("failed, escalated, and abandoned runs with a task key are eligible", () => {
    for (const status of ["failed", "escalated", "abandoned"] as RunStatus[]) {
      expect(isRunRetriable({ status, taskKey: "PROJ-1" })).toEqual({ eligible: true });
    }
  });

  test("succeeded, in_progress, and deferred runs are not eligible", () => {
    for (const status of ["succeeded", "in_progress", "deferred"] as RunStatus[]) {
      const result = isRunRetriable({ status, taskKey: "PROJ-1" });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBeString();
    }
  });

  test("runs without a task key can never be retried", () => {
    expect(isRunRetriable({ status: "failed" }).eligible).toBe(false);
    expect(isRunRetriable({ status: "succeeded" }).reason).toContain("no task key");
  });
});

describe("handleRetryRun", () => {
  let dir: string;
  let dbPath: string;
  let data: DashboardData;

  beforeEach(() => {
    dir = join(tmpdir(), `retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    data = new DashboardData({ dbPath, workingDir: dir });
  });

  afterEach(() => {
    data.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedFailedRun(taskKey = "PROJ-1"): number {
    const store = new RunStore(dbPath);
    const id = store.createRun({ origin: "task", taskKey, harness: "claude-code" });
    store.finishRun(id, "failed", "agent exited non-zero");
    store.close();
    return id;
  }

  test("validates the run id and rejects unknown runs", async () => {
    const { deps } = stubDeps();
    seedFailedRun();

    expect((await handleRetryRun(data, "abc", deps)).status).toBe(400);
    expect((await handleRetryRun(data, "9999", deps)).status).toBe(404);
  });

  test("spawns devintern TASK --force and returns 202 with audit details", async () => {
    const id = seedFailedRun("PROJ-7");
    const { deps, spawned, pids } = stubDeps();

    const response = await handleRetryRun(data, String(id), deps);
    expect(response.status).toBe(202);
    const body = response.body as { status: string; taskKey?: string; pid?: number };
    expect(body.status).toBe("triggered");
    expect(body.taskKey).toBe("PROJ-7");
    expect(body.pid).toBe(pids[0]);
    expect(spawned).toEqual(["PROJ-7"]);

    // The retry shows up in the run's detail payload.
    const detailBody = handleRunDetail(data, String(id)).body as {
      retry: { eligible: boolean; audit: { action: string; actor: string; pid?: number }[] };
    };
    expect(detailBody.retry.eligible).toBe(true);
    expect(detailBody.retry.audit.length).toBe(1);
    expect(detailBody.retry.audit[0].action).toBe("triggered");
    expect(detailBody.retry.audit[0].actor).toBe("sup@example.com");
    expect(detailBody.retry.audit[0].pid).toBe(pids[0]);
  });

  test("rejects non-terminal or ineligible statuses with 409", async () => {
    const store = new RunStore(dbPath);
    const succeeded = store.createRun({ origin: "task", taskKey: "PROJ-1" });
    store.finishRun(succeeded, "succeeded");
    const deferred = store.createRun({ origin: "task", taskKey: "PROJ-1" });
    store.finishRun(deferred, "deferred");
    const mention = store.createRun({ origin: "pr_mention" });
    store.finishRun(mention, "failed"); // no task key
    store.close();
    const { deps } = stubDeps();

    for (const ineligible of [succeeded, deferred, mention]) {
      const response = await handleRetryRun(data, String(ineligible), deps);
      expect(response.status).toBe(409);
      expect((response.body as { error: string }).error).toContain("not retriable");
    }
  });

  test("uses a local audit identity when no signed-in actor is available", async () => {
    const id = seedFailedRun();
    const { deps } = stubDeps({ resolveActor: async () => null });

    const response = await handleRetryRun(data, String(id), deps);
    expect(response.status).toBe(202);
    const detail = handleRunDetail(data, String(id)).body as {
      retry: { audit: { actor: string }[] };
    };
    expect(detail.retry.audit[0]?.actor).toBe("local-dashboard");
  });

  test("blocks concurrent retries of the same task", async () => {
    const id = seedFailedRun("PROJ-1");
    const first = stubDeps();
    expect((await handleRetryRun(data, String(id), first.deps)).status).toBe(202);
    expect(first.spawned).toEqual(["PROJ-1"]);

    // While the previous retry's claim is held (the spawned CLI has not
    // recorded its run row yet), another trigger for the same task is refused.
    const second = stubDeps();
    const again = await handleRetryRun(data, String(id), second.deps);
    expect(again.status).toBe(409);
    expect((again.body as { error: string }).error).toContain("just triggered");
    expect(second.spawned).toEqual([]);
  });

  test("claims expire after the TTL so a later retry can proceed", async () => {
    // Fresh instance: the claim lives on the data source, not the handler.
    const claiming = new DashboardData({ dbPath, workingDir: dir, inflightRetryTtlMs: -1 });
    expect(claiming.claimRetry("PROJ-1")).toBe(true);
    // TTL of -1 → the claim is already stale on the next access.
    expect(claiming.hasInflightRetry("PROJ-1")).toBe(false);

    const id = seedFailedRun("PROJ-1");
    const { deps, spawned } = stubDeps();
    expect((await handleRetryRun(claiming, String(id), deps)).status).toBe(202);
    expect(spawned).toEqual(["PROJ-1"]);
    claiming.close();
  });

  test("a live in-progress run for the task blocks a retry", async () => {
    const store = new RunStore(dbPath);
    const failedId = store.createRun({ origin: "task", taskKey: "PROJ-LIVE" });
    store.finishRun(failedId, "failed");
    store.createRun({ origin: "task", taskKey: "PROJ-LIVE" }); // stays in_progress
    store.close();

    const { deps } = stubDeps();
    const response = await handleRetryRun(data, String(failedId), deps);
    expect(response.status).toBe(409);
    expect((response.body as { error: string }).error).toContain("in progress");
  });

  test("records a failed audit entry when the CLI could not be spawned", async () => {
    const id = seedFailedRun("PROJ-1");
    const failing: RetryHandlerDeps = {
      resolveActor: ACTOR,
      spawn: (): SpawnedRetryProcess => {
        throw new Error("entry point missing");
      },
    };

    const response = await handleRetryRun(data, String(id), failing);
    expect(response.status).toBe(500);
    expect((response.body as { error: string }).error).toContain("entry point missing");

    const detailBody = handleRunDetail(data, String(id)).body as {
      retry: { audit: { action: string; message?: string }[] };
    };
    expect(detailBody.retry.audit[0].action).toBe("failed");
    expect(detailBody.retry.audit[0].message).toContain("entry point missing");
  });
});

describe("handleRetryRun (schedule mode)", () => {
  let dir: string;
  let dbPath: string;
  let data: DashboardData;

  beforeEach(() => {
    dir = join(tmpdir(), `retry-sched-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    data = new DashboardData({ dbPath, workingDir: dir, retryMode: "schedule" });
  });

  afterEach(() => {
    data.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedFailedRun(taskKey = "PROJ-1"): number {
    const store = new RunStore(dbPath);
    const id = store.createRun({ origin: "task", taskKey, harness: "claude-code" });
    store.finishRun(id, "failed", "agent exited non-zero");
    store.close();
    return id;
  }

  test("inserts a pending row and returns 202 without spawning", async () => {
    const id = seedFailedRun("PROJ-9");
    const { deps, spawned } = stubDeps();

    const response = await handleRetryRun(data, String(id), deps);
    expect(response.status).toBe(202);
    const body = response.body as { status: string; taskKey?: string; pid?: number };
    expect(body.status).toBe("scheduled");
    expect(body.taskKey).toBe("PROJ-9");
    expect(body.pid).toBeUndefined();
    expect(spawned).toEqual([]);

    const store = data.getScheduledRetryStore();
    expect(store.hasActive("PROJ-9")).toBe(true);

    const detailBody = handleRunDetail(data, String(id)).body as {
      retry: { audit: { action: string; actor: string }[] };
    };
    expect(detailBody.retry.audit[0].action).toBe("scheduled");
    expect(detailBody.retry.audit[0].actor).toBe("sup@example.com");
  });

  test("refuses a second retry while one is scheduled or running", async () => {
    const id = seedFailedRun("PROJ-1");
    const { deps } = stubDeps();

    expect((await handleRetryRun(data, String(id), deps)).status).toBe(202);
    const again = await handleRetryRun(data, String(id), stubDeps().deps);
    expect(again.status).toBe(409);
    expect((again.body as { error: string }).error).toContain("already scheduled or running");
  });

  test("unblocks once the worker settled the scheduled retry", async () => {
    const id = seedFailedRun("PROJ-1");
    const { deps } = stubDeps();
    expect((await handleRetryRun(data, String(id), deps)).status).toBe(202);

    const store = data.getScheduledRetryStore();
    const row = store.claimNext();
    expect(row?.taskKey).toBe("PROJ-1");
    store.finish(row!.id, "done");
    expect(store.hasActive("PROJ-1")).toBe(false);

    expect((await handleRetryRun(data, String(id), stubDeps().deps)).status).toBe(202);
  });

  test("a live in-progress run for the task blocks a scheduled retry", async () => {
    const store = new RunStore(dbPath);
    const failedId = store.createRun({ origin: "task", taskKey: "PROJ-LIVE" });
    store.finishRun(failedId, "failed");
    store.createRun({ origin: "task", taskKey: "PROJ-LIVE" }); // stays in_progress
    store.close();

    const response = await handleRetryRun(data, String(failedId), stubDeps().deps);
    expect(response.status).toBe(409);
    expect((response.body as { error: string }).error).toContain("in progress");
  });
});

describe("ScheduledRetryStore", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `retry-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("claims the oldest pending row atomically", () => {
    const store = new ScheduledRetryStore(dbPath);
    store.schedule({ taskKey: "PROJ-2", actor: "a@x.com", createdAt: 2000 });
    store.schedule({ taskKey: "PROJ-1", actor: "b@x.com", createdAt: 1000 });

    const first = store.claimNext();
    expect(first?.taskKey).toBe("PROJ-1");
    expect(first?.status).toBe("running");
    // The other row stays pending; a second claimer gets it, not null races.
    expect(store.claimNext()?.taskKey).toBe("PROJ-2");
    expect(store.claimNext()).toBeNull();
    store.close();
  });

  test("requeue returns a claimed row to the pending queue", () => {
    const store = new ScheduledRetryStore(dbPath);
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });

    const row = store.claimNext();
    store.requeue(row!.id);
    expect(store.hasActive("PROJ-1")).toBe(true);
    expect(store.hasPending()).toBe(true);
    expect(store.claimNext()?.taskKey).toBe("PROJ-1");
    store.close();
  });

  test("finish only settles rows still claimed as running", () => {
    const store = new ScheduledRetryStore(dbPath);
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });
    const row = store.claimNext();
    store.finish(row!.id, "failed", "pipeline failed");
    // A late finish (or double finish) must not resurrect the row.
    store.finish(row!.id, "done");

    expect(store.hasActive("PROJ-1")).toBe(false);
    expect(store.hasPending()).toBe(false);
    store.close();
  });

  test("failRunning settles every running row and leaves others alone", () => {
    const store = new ScheduledRetryStore(dbPath);
    store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });
    store.schedule({ taskKey: "PROJ-2", actor: "b@x.com" });
    const running = store.claimNext(); // PROJ-1
    store.claimNext(); // PROJ-2

    store.finish(running!.id, "done");
    store.schedule({ taskKey: "PROJ-3", actor: "c@x.com" }); // stays pending

    const settled = store.failRunning("worker restarted");
    expect(settled.map((row) => row.taskKey)).toEqual(["PROJ-2"]);
    expect(store.hasActive("PROJ-2")).toBe(false);
    expect(store.hasActive("PROJ-1")).toBe(false);
    expect(store.hasPending()).toBe(true); // PROJ-3 untouched
    expect(store.claimNext()?.taskKey).toBe("PROJ-3");
    store.close();
  });

  test("refuses a duplicate while active but allows re-schedule after finish", () => {
    const store = new ScheduledRetryStore(dbPath);
    expect(store.schedule({ taskKey: "PROJ-1", actor: "a@x.com" }).scheduled).toBe(true);
    expect(store.schedule({ taskKey: "PROJ-1", actor: "b@x.com" })).toEqual({
      scheduled: false,
      reason: "a retry is already scheduled or running",
    });

    store.finish(store.claimNext()!.id, "done");
    expect(store.schedule({ taskKey: "PROJ-1", actor: "b@x.com" }).scheduled).toBe(true);
    store.close();
  });
});
