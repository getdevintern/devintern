import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { startDashboardServer } from "../src/dashboard-server";
import { DashboardData, handleRetryRun } from "../src/lib/observability/dashboard-api";
import { handleCancelTask } from "../src/lib/observability/dashboard-tasks";
import type { DashboardCancelTaskResponse } from "../src/lib/observability/dashboard-tasks";
import { handleQueuedWork } from "../src/lib/observability/queued-work";
import type { QueuedWorkResponse } from "../src/lib/observability/queued-work";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { RunStore } from "../src/lib/state/run-recorder";
import { isRunRetriable } from "../src/lib/state/run-retry";
import { classifyDependency } from "../src/lib/dependencies/gate";
import { readLocalDependencyFacts } from "../src/lib/dependencies/local-facts";
import { runWorkerAdd, WAIT_CANCELLED_EXIT_CODE } from "../src/lib/workspace/add-command";
import { parseWorkerCancelArgs, runWorkerCancel } from "../src/lib/workspace/cancel-command";
import { cancelInjectedTask } from "../src/lib/workspace/injected-cancel";
import { InjectedTaskAcquirer } from "../src/lib/workspace/injected-acquirer";
import { workspaceConfigPath, workspaceDbPath } from "../src/lib/workspace/paths";
import type { TaskExecutionResult } from "../src/lib/acquirers/task-polling";

const WORKSPACE_TOML = `[workspace]
dashboard = false

[defaults]
tracker = "markdown"
worker_task_args = "--no-git"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
`;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-cancel-test-"));
  writeFileSync(workspaceConfigPath(dir), WORKSPACE_TOML);
  dbPath = workspaceDbPath(dir);
  process.env.DEVINTERN_SKIP_LICENSE_CHECK = "1";
});

afterEach(() => {
  delete process.env.DEVINTERN_SKIP_LICENSE_CHECK;
  rmSync(dir, { recursive: true, force: true });
});

function withStore<T>(fn: (store: InjectedTaskStore) => T): T {
  const store = new InjectedTaskStore(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function seed(taskKey: string, extra: { idempotencyKey?: string; createdAt?: number } = {}) {
  const taskFile = join(dir, `${taskKey}.md`);
  writeFileSync(taskFile, "prompt");
  return withStore(
    (store) =>
      store.enqueue({
        taskKey,
        repo: "backend",
        title: `Title of ${taskKey}`,
        body: "secret prompt body",
        taskFile,
        ...extra,
      }).task,
  );
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    options: {
      log: (message: string) => out.push(message),
      error: (message: string) => err.push(message),
    },
  };
}

function cancelCli(...args: string[]) {
  const cap = capture();
  const code = runWorkerCancel(["--workspace", workspaceConfigPath(dir), ...args], cap.options);
  return { code, ...cap };
}

describe("InjectedTaskStore.cancel", () => {
  test("moves a pending row to cancelled with time, actor, and reason", () => {
    const task = seed("local-a");
    const result = withStore((store) =>
      store.cancel("local-a", { actor: "cli", reason: " duplicate ", now: 1234 }),
    );
    expect(result.outcome).toBe("cancelled");
    expect(result.task).toMatchObject({
      id: task.id,
      status: "cancelled",
      finishedAt: 1234,
      cancelledBy: "cli",
      cancelReason: "duplicate",
    });
  });

  test("repeated cancel keeps the original time and actor", () => {
    seed("local-a");
    withStore((store) => store.cancel("local-a", { actor: "cli", now: 1000 }));
    const again = withStore((store) =>
      store.cancel("local-a", { actor: "dashboard", reason: "late", now: 2000 }),
    );
    expect(again.outcome).toBe("already_cancelled");
    expect(again.task).toMatchObject({ finishedAt: 1000, cancelledBy: "cli" });
    expect(again.task?.cancelReason).toBeUndefined();
  });

  test("running, done, failed, and unknown rows are left unchanged", () => {
    seed("local-run");
    seed("local-done", { createdAt: Date.now() + 1 });
    seed("local-fail", { createdAt: Date.now() + 2 });
    withStore((store) => {
      const running = store.claimNext()!;
      store.setChildPid(running.id, 4242, 99);
      store.finish(store.claimNext()!.id, "done");
      store.finish(store.claimNext()!.id, "failed", "boom");

      const started = store.cancel("local-run", { actor: "cli" });
      expect(started.outcome).toBe("already_started");
      const after = store.getByTaskKey("local-run")!;
      expect(after).toMatchObject({ status: "running", childPid: 4242, childStartedAt: 99 });

      expect(store.cancel("local-done", { actor: "cli" }).outcome).toBe("already_finished");
      expect(store.getByTaskKey("local-done")!.status).toBe("done");
      expect(store.cancel("local-fail", { actor: "cli" }).outcome).toBe("already_finished");
      expect(store.getByTaskKey("local-fail")!.status).toBe("failed");
      expect(store.cancel("local-nope", { actor: "cli" }).outcome).toBe("not_found");
    });
  });

  test("a deferred row backing off with a future not_before is cancellable", () => {
    seed("local-deferred");
    withStore((store) => {
      const claimed = store.claimNext()!;
      store.defer(claimed.id, {
        maxDeferrals: 5,
        backoffMs: () => 6 * 24 * 60 * 60 * 1000,
        exhaustedMessage: "x",
      });
      expect(store.getById(claimed.id)!.notBefore).toBeGreaterThan(Date.now());
      expect(store.cancel("local-deferred", { actor: "cli" }).outcome).toBe("cancelled");
      expect(store.claimNext([], Date.now() + 7 * 24 * 60 * 60 * 1000)).toBeNull();
    });
  });

  test("cancelling a usage-limit-deferred task settles its deferred run", () => {
    seed("local-deferred-run");
    withStore((store) => {
      const claimed = store.claimNext()!;
      store.defer(claimed.id, { maxDeferrals: 5, backoffMs: () => 60_000, exhaustedMessage: "x" });
    });
    const runs = new RunStore(dbPath);
    try {
      const other = runs.createRun({ origin: "local", taskKey: "local-other" });
      runs.finishRun(other, "deferred", "usage limit");
      const runId = runs.createRun({ origin: "local", taskKey: "local-deferred-run" });
      runs.finishRun(runId, "deferred", "usage limit");
      expect(isRunRetriable(runs.getRun(runId)!).reason).toContain("retried automatically");

      expect(
        withStore(
          (store) =>
            cancelInjectedTask(store, "local-deferred-run", { actor: "cli", reason: "dup" })
              .outcome,
        ),
      ).toBe("cancelled");

      const settled = runs.getRun(runId)!;
      expect(settled.status).toBe("abandoned");
      expect(settled.outcomeReason).toMatch(/^cancelled by cli at .* \(reason: dup\)$/);
      expect(runs.listStages(runId).filter((s) => s.stage === "outcome")).toMatchObject([
        { status: "abandoned" },
      ]);
      // No longer claims an automatic retry; a manual Retry is refused by the
      // handler because the injected row is cancelled.
      expect(isRunRetriable(settled)).toEqual({ eligible: true, kind: "injected" });
      // Another task's deferred run is untouched.
      expect(runs.getRun(other)!.status).toBe("deferred");
    } finally {
      runs.close();
    }
  });

  test("cancel leaves a task's earlier settled run alone and is a no-op without runs", () => {
    seed("local-failed-before");
    seed("local-no-runs");
    const runs = new RunStore(dbPath);
    try {
      const runId = runs.createRun({ origin: "local", taskKey: "local-failed-before" });
      runs.finishRun(runId, "failed", "boom");
      const store = new InjectedTaskStore(dbPath);
      try {
        expect(cancelInjectedTask(store, "local-failed-before", { actor: "cli" }).outcome).toBe(
          "cancelled",
        );
        expect(cancelInjectedTask(store, "local-no-runs", { actor: "cli" }).outcome).toBe(
          "cancelled",
        );
      } finally {
        store.close();
      }
      expect(runs.getRun(runId)).toMatchObject({ status: "failed", outcomeReason: "boom" });
    } finally {
      runs.close();
    }
  });

  test("a row requeued after a claim cancels as cancelled, never as already started", () => {
    seed("local-requeued");
    withStore((store) => {
      const claimed = store.claimNext()!;
      expect(store.cancel("local-requeued", { actor: "cli" }).outcome).toBe("already_started");
      store.requeue(claimed.id);
      const result = store.cancel("local-requeued", { actor: "dashboard" });
      expect(result.outcome).toBe("cancelled");
      expect(store.getByTaskKey("local-requeued")).toMatchObject({
        status: "cancelled",
        cancelledBy: "dashboard",
      });
    });
  });

  test("cancel and claimNext on two connections: exactly one wins", () => {
    for (let round = 0; round < 20; round++) {
      const key = `local-race-${round}`;
      seed(key);
      const claimer = new InjectedTaskStore(dbPath);
      const canceller = new InjectedTaskStore(dbPath);
      try {
        // Alternate which statement commits first.
        let claimed;
        let cancel;
        if (round % 2 === 0) {
          claimed = claimer.claimNext();
          cancel = canceller.cancel(key, { actor: "cli" });
        } else {
          cancel = canceller.cancel(key, { actor: "cli" });
          claimed = claimer.claimNext();
        }
        const claimWon = claimed?.taskKey === key;
        const cancelWon = cancel.outcome === "cancelled";
        expect(claimWon !== cancelWon).toBe(true);
        expect(cancel.outcome).toBe(claimWon ? "already_started" : "cancelled");
        const final = claimer.getByTaskKey(key)!;
        expect(final.status).toBe(claimWon ? "running" : "cancelled");
        if (claimed) claimer.finish(claimed.id, "done");
      } finally {
        claimer.close();
        canceller.close();
      }
    }
  });

  test("a cancelled idempotency key admits a new task", () => {
    seed("local-first", { idempotencyKey: "nightly" });
    withStore((store) => {
      store.cancel("local-first", { actor: "cli" });
      expect(store.findActiveByIdempotencyKey("nightly")).toBeNull();
      const next = store.enqueue({
        taskKey: "local-second",
        repo: "backend",
        title: "again",
        body: "",
        taskFile: join(dir, "second.md"),
        idempotencyKey: "nightly",
      });
      expect(next.deduplicated).toBe(false);
      expect(next.task.taskKey).toBe("local-second");
    });
  });

  test("requeueSettled refuses a cancelled row", () => {
    seed("local-a");
    withStore((store) => {
      store.cancel("local-a", { actor: "cli" });
      expect(store.requeueSettled("local-a")).toBeNull();
      expect(store.getByTaskKey("local-a")!.status).toBe("cancelled");
    });
  });

  test("keeps the prompt file until pruning, then reads back as cancelled", () => {
    const task = seed("local-a");
    withStore((store) => {
      store.cancel("local-a", { actor: "cli", reason: "wrong repo", now: 1000 });
      expect(existsSync(task.taskFile)).toBe(true);
      expect(store.pruneSettled(60_000, 2000)).toBe(0);
      expect(existsSync(task.taskFile)).toBe(true);
      expect(store.pruneSettled(500, 2000)).toBe(1);
      expect(existsSync(task.taskFile)).toBe(false);
      expect(store.getPrunedOutcome(task.id)).toEqual({
        repo: "backend",
        status: "cancelled",
        message: "wrong repo",
      });
    });
  });

  test("migrates a legacy table without the cancel columns", () => {
    mkdirSync(dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`CREATE TABLE injected_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_key TEXT NOT NULL, repo TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', task_file TEXT NOT NULL,
      idempotency_key TEXT, actor TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      message TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)`);
    legacy.run(
      "INSERT INTO injected_tasks (task_key, repo, title, task_file, actor, created_at) VALUES ('local-old', 'backend', 'Old', '/nope', 'local:add', 1)",
    );
    legacy.close();
    const result = withStore((store) => store.cancel("local-old", { actor: "dashboard" }));
    expect(result).toMatchObject({ outcome: "cancelled", task: { cancelledBy: "dashboard" } });
  });

  test("a cancelled dependency blocks its dependents", () => {
    seed("local-base");
    withStore((store) => {
      store.cancel("local-base", { actor: "cli" });
      const db = new Database(dbPath, { readonly: true });
      try {
        const [facts] = readLocalDependencyFacts(db, ["local-base"]);
        expect(classifyDependency(facts!)).toMatchObject({
          state: "blocked",
          reason: "local-base was cancelled",
        });
      } finally {
        db.close();
      }
    });
  });
});

describe("worker drain", () => {
  test("never runs a row cancelled before its first claim, including after a restart", async () => {
    seed("local-cancelled");
    seed("local-kept", { createdAt: Date.now() + 1 });
    withStore((store) => store.cancel("local-cancelled", { actor: "cli" }));

    // A fresh store models a restarted worker reading the same DB.
    const calls: string[] = [];
    const drain = new InjectedTaskStore(dbPath);
    const acquirer = new InjectedTaskAcquirer({
      store: drain,
      execute: async (task) => {
        calls.push(task.taskKey);
        return true as TaskExecutionResult;
      },
      intervalSeconds: 3600,
    });
    try {
      await acquirer.tick();
      await acquirer.tick();
    } finally {
      drain.close();
    }
    expect(calls).toEqual(["local-kept"]);
    withStore((store) => {
      const cancelled = store.getByTaskKey("local-cancelled")!;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.startedAt).toBeUndefined();
    });
  });
});

describe("devintern worker cancel", () => {
  test("parses the task key, reason, and flags", () => {
    expect(parseWorkerCancelArgs(["local-a", "--reason", "dup", "--json"])).toEqual({
      kind: "ok",
      taskKey: "local-a",
      reason: "dup",
      json: true,
      workspacePath: undefined,
    });
    expect(parseWorkerCancelArgs(["--help"]).kind).toBe("help");
    expect(parseWorkerCancelArgs([]).kind).toBe("error");
    expect(parseWorkerCancelArgs(["a", "b"]).kind).toBe("error");
    expect(parseWorkerCancelArgs(["a", "--bogus"]).kind).toBe("error");
  });

  test("cancels a pending task and prints Cancelled <taskKey>", () => {
    seed("local-a");
    const result = cancelCli("local-a", "--reason", "bad prompt");
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["Cancelled local-a"]);
    expect(withStore((store) => store.getByTaskKey("local-a"))).toMatchObject({
      status: "cancelled",
      cancelledBy: "cli",
      cancelReason: "bad prompt",
    });
  });

  test("repeat cancel reports already cancelled and exits 0", () => {
    seed("local-a");
    cancelCli("local-a");
    const again = cancelCli("local-a");
    expect(again.code).toBe(0);
    expect(again.out.join("\n")).toContain("already cancelled by cli at ");
  });

  test("unknown, running, and finished rows exit non-zero", () => {
    seed("local-run");
    seed("local-done", { createdAt: Date.now() + 1 });
    withStore((store) => {
      store.claimNext();
      store.finish(store.claimNext()!.id, "done");
    });
    const missing = cancelCli("local-nope");
    expect(missing.code).toBe(1);
    expect(missing.err.join("\n")).toContain("not found");
    const running = cancelCli("local-run");
    expect(running.code).toBe(1);
    expect(running.err.join("\n")).toContain("already started");
    const done = cancelCli("local-done");
    expect(done.code).toBe(1);
    expect(done.err.join("\n")).toContain("already finished (done)");
  });

  test("--json prints one object with taskKey, outcome, and message", () => {
    seed("local-a");
    const first = cancelCli("local-a", "--json");
    expect(first.out).toHaveLength(1);
    expect(JSON.parse(first.out[0]!)).toEqual({
      taskKey: "local-a",
      outcome: "cancelled",
      message: "Cancelled local-a",
    });
    expect(JSON.parse(cancelCli("local-a", "--json").out[0]!).outcome).toBe("already_cancelled");
    const missing = cancelCli("local-zzz", "--json");
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out[0]!)).toMatchObject({ outcome: "not_found" });
  });
});

describe("worker add with a cancelled task", () => {
  function liveWorkerLock() {
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );
  }

  async function waitThenCancel(json: boolean) {
    liveWorkerLock();
    const canceller = (async () => {
      const store = new InjectedTaskStore(dbPath);
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          const [pending] = store.listPending(1);
          if (pending) {
            store.cancel(pending.taskKey, { actor: "dashboard", reason: "dup" });
            return Date.now();
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("task was never enqueued");
      } finally {
        store.close();
      }
    })();
    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        workspaceConfigPath(dir),
        "--title",
        "Wait me",
        "--wait",
        ...(json ? ["--json"] : []),
      ],
      { ...cap.options, waitPollIntervalMs: 20 },
    );
    const cancelledAt = await canceller;
    return { code, cancelledAt, returnedAt: Date.now(), ...cap };
  }

  test("--wait returns the dedicated exit code within one poll of the cancel", async () => {
    const result = await waitThenCancel(false);
    expect(result.code).toBe(WAIT_CANCELLED_EXIT_CODE);
    expect(result.returnedAt - result.cancelledAt).toBeLessThan(1000);
    expect(result.err.join("\n")).toContain("local-wait-me was cancelled by dashboard");
    expect(result.err.join("\n")).not.toContain("Timed out");
  });

  test("--wait --json reports status cancelled with a message", async () => {
    const result = await waitThenCancel(true);
    expect(result.code).toBe(WAIT_CANCELLED_EXIT_CODE);
    expect(result.out).toHaveLength(1);
    const body = JSON.parse(result.out[0]!);
    expect(body).toMatchObject({ taskKey: "local-wait-me", status: "cancelled" });
    expect(body.message).toContain("was cancelled by dashboard");
    expect(body).not.toHaveProperty("error");
  });

  test("--resume refuses a cancelled row", async () => {
    seed("local-a");
    withStore((store) => store.cancel("local-a", { actor: "cli" }));
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", workspaceConfigPath(dir), "--resume", "local-a"],
      cap.options,
    );
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("cannot be resumed");
    expect(withStore((store) => store.getByTaskKey("local-a")!.status)).toBe("cancelled");
  });

  test("a new enqueue with the cancelled row's idempotency key is accepted", async () => {
    seed("local-a", { idempotencyKey: "k1" });
    withStore((store) => store.cancel("local-a", { actor: "cli" }));
    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        workspaceConfigPath(dir),
        "--title",
        "Second try",
        "--idempotency-key",
        "k1",
        "--json",
      ],
      cap.options,
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.out.at(-1)!)).toMatchObject({
      taskKey: "local-second-try",
      status: "pending",
      deduplicated: false,
    });
  });
});

describe("dashboard cancel", () => {
  let data: DashboardData;

  beforeEach(() => {
    data = new DashboardData({ dbPath, workingDir: dir, workspaceDir: dir, logDirs: [] });
  });

  afterEach(() => {
    data.close();
  });

  test("cancels by task key or row id and records the dashboard actor", () => {
    seed("local-a");
    const b = seed("local-b", { createdAt: Date.now() + 1 });
    const byKey = handleCancelTask(data, "local-a", { reason: "dup" });
    expect(byKey.status).toBe(200);
    expect(byKey.body as DashboardCancelTaskResponse).toEqual({
      taskKey: "local-a",
      outcome: "cancelled",
      message: "Cancelled local-a",
    });
    const byId = handleCancelTask(data, String(b.id), undefined);
    expect(byId.status).toBe(200);
    expect((byId.body as DashboardCancelTaskResponse).taskKey).toBe("local-b");
    expect(withStore((store) => store.getByTaskKey("local-a"))).toMatchObject({
      cancelledBy: "dashboard",
      cancelReason: "dup",
    });
  });

  test("dashboard cancel settles the task's deferred run", async () => {
    seed("local-a");
    const runs = new RunStore(dbPath);
    try {
      const runId = runs.createRun({ origin: "local", taskKey: "local-a" });
      runs.finishRun(runId, "deferred", "usage limit");
      expect(handleCancelTask(data, "local-a", undefined).status).toBe(200);
      expect(runs.getRun(runId)).toMatchObject({ status: "abandoned" });
      expect(runs.getRun(runId)!.outcomeReason).toMatch(/^cancelled by dashboard at /);
      // A manual Retry of the settled run is refused, not silently re-queued.
      const retry = await handleRetryRun(data, String(runId));
      expect(retry.status).toBe(409);
      expect(JSON.stringify(retry.body)).toContain("was cancelled");
      // The run-detail GET must not offer a Retry button the POST would refuse.
      const retryInfo = data.getRetryInfo(runId);
      expect(retryInfo?.eligible).toBe(false);
      expect(retryInfo?.reason).toContain("was cancelled");
    } finally {
      runs.close();
    }
  });

  test("a row claimed after the list loaded reports already started, unchanged", () => {
    seed("local-a");
    withStore((store) => store.claimNext());
    const response = handleCancelTask(data, "local-a", undefined);
    expect(response.status).toBe(409);
    expect((response.body as DashboardCancelTaskResponse).outcome).toBe("already_started");
    expect(withStore((store) => store.getByTaskKey("local-a")!.status)).toBe("running");
    expect(handleCancelTask(data, "local-missing", undefined).status).toBe(404);
    expect(handleCancelTask(data, "local-a", { reason: 5 }).status).toBe(400);
  });

  test("the queue drops the cancelled row and lists it as recently cancelled", () => {
    seed("local-a");
    seed("local-b", { createdAt: Date.now() + 1 });
    const before = handleQueuedWork(data).body as QueuedWorkResponse;
    expect(before.items.map((item) => item.taskKey)).toEqual(["local-a", "local-b"]);
    expect(before.cancelled).toEqual([]);

    handleCancelTask(data, "local-a", { reason: "dup" });
    const after = handleQueuedWork(data).body as QueuedWorkResponse;
    expect(after.items.map((item) => item.taskKey)).toEqual(["local-b"]);
    expect(after.total).toBe(before.total - 1);
    expect(after.cancelled).toEqual([
      expect.objectContaining({
        taskKey: "local-a",
        cancelledBy: "dashboard",
        cancelReason: "dup",
      }),
    ]);
    expect(after.cancelled[0]).not.toHaveProperty("body");
  });

  test("the server routes the cancel and the write guard refuses cross-origin calls", async () => {
    seed("local-a");
    seed("local-b", { createdAt: Date.now() + 1 });
    data.close();
    const server = startDashboardServer({
      port: 0,
      dbPath,
      workingDir: dir,
      workspaceDir: dir,
      logDirs: [],
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const evil = await fetch(`${base}/api/tasks/local-a/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: "{}",
      });
      expect(evil.status).toBe(403);
      const rebind = await fetch(`${base}/api/tasks/local-a/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base, Host: "evil.example" },
        body: "{}",
      });
      expect(rebind.status).toBe(403);
      expect(withStore((store) => store.getByTaskKey("local-a")!.status)).toBe("pending");

      const ok = await fetch(`${base}/api/tasks/local-a/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: "{}",
      });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as DashboardCancelTaskResponse).outcome).toBe("cancelled");

      // An empty body (no reason) is accepted too.
      const empty = await fetch(`${base}/api/tasks/local-b/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
      });
      expect(empty.status).toBe(200);
    } finally {
      server.stop(true);
    }
    expect(withStore((store) => store.getByTaskKey("local-a")!.status)).toBe("cancelled");
  });
});
