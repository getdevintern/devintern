import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { RunStore } from "../src/lib/state/run-recorder";
import { resetWorkerFailover } from "../src/lib/worker/failover";
import { createTaskSupervisor } from "../src/lib/worker/supervisor";
import {
  InjectedTaskAcquirer,
  injectedDeferBackoffMs,
} from "../src/lib/workspace/injected-acquirer";
import type { TaskExecutionResult } from "../src/lib/acquirers/task-polling";

describe("InjectedTaskAcquirer", () => {
  let dir: string;
  let store: InjectedTaskStore;

  beforeEach(() => {
    // The default `isPaused` reads the process-wide failover singleton, so a
    // controller leaked by an earlier test (or a preload) would silently
    // disable every drain in this file. Start each test from a clean slate.
    resetWorkerFailover();
    dir = join(tmpdir(), `injected-acq-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    store = new InjectedTaskStore(join(dir, "queue.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    resetWorkerFailover();
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

  test("runs pending tasks concurrently instead of one after another", async () => {
    enqueue("local-a");
    enqueue("local-b");

    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async () => {
        started++;
        if (started === 2) release();
        await gate;
        return true as TaskExecutionResult;
      },
      intervalSeconds: 3600,
    });

    const tick = acquirer.tick();
    // Sequential drains would block on the first execute forever; the second
    // only starts if both rows were claimed before awaiting either run.
    const bothStarted = await Promise.race([
      gate.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    release();
    await tick;

    expect(bothStarted).toBe(true);
    expect(started).toBe(2);
    expect(store.hasPending()).toBe(false);
  });

  test("requeues deferred tasks and retries them once the backoff elapses", async () => {
    enqueue("local-a");

    const calls: string[] = [];
    let busy = true;
    let now = 1_000_000;
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      const acquirer = new InjectedTaskAcquirer({
        store,
        execute: async (task) => {
          calls.push(task.taskKey);
          return busy ? "deferred" : true;
        },
        intervalSeconds: 3600,
        now: () => now,
      });

      await acquirer.tick();
      expect(calls).toEqual(["local-a"]);
      expect(store.hasPending()).toBe(true);
      expect(store.getByTaskKey("local-a")?.deferCount).toBe(1);
      expect(store.getByTaskKey("local-a")?.notBefore).toBe(now + 60_000);

      // Still backing off: the next tick does not re-run it.
      busy = false;
      now += 30_000;
      await acquirer.tick();
      expect(calls).toEqual(["local-a"]);

      now += 30_000;
      await acquirer.tick();
      expect(calls).toEqual(["local-a", "local-a"]);
      expect(store.hasPending()).toBe(false);
    } finally {
      logs.mockRestore();
    }
  });

  test("fails a task that keeps deferring once its deferral budget is spent", async () => {
    enqueue("local-a");

    let calls = 0;
    const logs = spyOn(console, "log").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const acquirer = new InjectedTaskAcquirer({
        store,
        execute: async () => {
          calls++;
          return "deferred";
        },
        intervalSeconds: 3600,
        maxDeferrals: 3,
        deferBackoffMs: () => 0,
      });
      for (let i = 0; i < 5; i++) await acquirer.tick();

      expect(calls).toBe(3);
      const task = store.getByTaskKey("local-a");
      expect(task?.status).toBe("failed");
      expect(task?.deferCount).toBe(3);
      expect(task?.message).toContain("devintern worker add --resume local-a");

      // An explicit re-queue restores the full budget.
      const requeued = store.requeueSettled("local-a");
      expect(requeued?.deferCount).toBe(0);
      expect(requeued?.notBefore).toBeUndefined();
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  test("deferral backoff doubles from one minute and caps at one hour", () => {
    expect(injectedDeferBackoffMs(1)).toBe(60_000);
    expect(injectedDeferBackoffMs(2)).toBe(120_000);
    expect(injectedDeferBackoffMs(6)).toBe(32 * 60_000);
    expect(injectedDeferBackoffMs(7)).toBe(60 * 60_000);
    expect(injectedDeferBackoffMs(500)).toBe(60 * 60_000);
  });

  test("leaves pending rows untouched and silent while the harness chain is paused", async () => {
    enqueue("local-a");

    const calls: string[] = [];
    let paused = true;
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      const acquirer = new InjectedTaskAcquirer({
        store,
        execute: async (task) => {
          calls.push(task.taskKey);
          return true;
        },
        isPaused: () => paused,
        intervalSeconds: 3600,
      });

      // Many paused ticks must not claim, run, requeue, or log the row.
      for (let i = 0; i < 50; i++) {
        await acquirer.tick();
      }
      expect(calls).toEqual([]);
      expect(logs).not.toHaveBeenCalled();
      expect(store.hasPending()).toBe(true);
      expect(store.getById(1)?.status).toBe("pending");

      // The first unpaused tick drains the row normally.
      paused = false;
      await acquirer.tick();
      expect(calls).toEqual(["local-a"]);
      expect(store.hasPending()).toBe(false);
      expect(store.getById(1)?.status).toBe("done");
    } finally {
      logs.mockRestore();
    }
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

  test("leaves a claimed row running when a graceful drain interrupts its run", async () => {
    enqueue("local-a");
    const supervisor = createTaskSupervisor({ maxConcurrency: 1, maxConcurrencyPerRepo: 1 });
    const acquirer = new InjectedTaskAcquirer({
      store,
      // The fleet executor reports a drain abort as "interrupted" (see
      // runTaskViaCli), distinct from a genuine pipeline failure.
      execute: async (task) =>
        supervisor.schedule({
          id: task.taskKey,
          source: "test",
          repo: task.repo,
          kind: "task",
          checkoutClass: "task_worktree",
          run: (signal) =>
            new Promise<TaskExecutionResult>((resolve) => {
              signal.addEventListener("abort", () => resolve("interrupted"), { once: true });
            }),
        }),
      isDraining: () => supervisor.isDraining(),
      intervalSeconds: 3600,
    });

    const tick = acquirer.tick();
    await waitFor(() => supervisor.inFlightCount() === 1);
    // Shutdown order in createWorkerShutdownHandler: drain starts, acquirers
    // stop, the drain aborts the child and settles before onShutdown closes
    // the store.
    acquirer.stop();
    await supervisor.drain({ graceMs: 0 });
    await tick;

    expect(store.getById(1)?.status).toBe("running");
    expect(store.getById(1)?.message).toBeUndefined();
  });

  test("settles a genuine failure that happens during the shutdown window", async () => {
    enqueue("local-a");
    // The drain flag alone must not launder a real pipeline failure: only the
    // executor's "interrupted" marker means the outcome is unknown.
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async () => false,
      isDraining: () => true,
      intervalSeconds: 3600,
    });

    await acquirer.tick();

    const row = store.getById(1);
    expect(row?.status).toBe("failed");
    expect(row?.message).toBe("task pipeline did not complete cleanly");
  });

  test("persists the current failed local run reason", async () => {
    enqueue("local-a");
    const dbPath = join(dir, "queue.db");
    const acquirer = new InjectedTaskAcquirer({
      store,
      runDbPath: dbPath,
      execute: async (task) => {
        const runs = new RunStore(dbPath);
        const id = runs.createRun({ origin: "local", taskKey: task.taskKey, repo: task.repo });
        runs.finishRun(id, "failed", "verification failed");
        runs.close();
        return false;
      },
      intervalSeconds: 3600,
    });

    await acquirer.tick();
    expect(store.getByTaskKey("local-a")).toMatchObject({
      status: "failed",
      message: "verification failed",
    });
  });

  test("ignores old and unrelated run reasons", async () => {
    const dbPath = join(dir, "queue.db");
    enqueue("local-old");
    enqueue("local-other-source");
    const runs = new RunStore(dbPath);
    const old = runs.createRun({ origin: "local", taskKey: "local-old", repo: "backend" });
    runs.finishRun(old, "failed", "old failure");
    const raw = new Database(dbPath);
    raw.run("UPDATE runs SET started_at = 1 WHERE id = ?", [old]);
    raw.close();
    runs.close();

    const acquirer = new InjectedTaskAcquirer({
      store,
      runDbPath: dbPath,
      execute: async (task) => {
        if (task.taskKey === "local-other-source") {
          const records = new RunStore(dbPath);
          const id = records.createRun({ origin: "task", taskKey: task.taskKey, repo: task.repo });
          records.finishRun(id, "failed", "wrong source");
          records.close();
        }
        return false;
      },
      intervalSeconds: 3600,
    });

    await acquirer.tick();
    expect(store.getByTaskKey("local-old")?.message).toBe("task pipeline did not complete cleanly");
    expect(store.getByTaskKey("local-other-source")?.message).toBe(
      "task pipeline did not complete cleanly",
    );
  });

  test("settles a failed row even when run history cannot be read", async () => {
    enqueue("local-a");
    const acquirer = new InjectedTaskAcquirer({
      store,
      runDbPath: join(dir, "missing", "queue.db"),
      execute: async () => false,
      intervalSeconds: 3600,
    });

    await acquirer.tick();
    expect(store.getByTaskKey("local-a")).toMatchObject({
      status: "failed",
      message: "task pipeline did not complete cleanly",
    });
  });

  test("start returns without waiting for a slow injected task", async () => {
    enqueue("local-a");
    let started = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async () => {
        started = true;
        await gate;
        return true as TaskExecutionResult;
      },
      intervalSeconds: 3600,
    });

    try {
      const returned = await Promise.race([
        acquirer.start().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      expect(returned).toBe(true);
      expect(started).toBe(true);
    } finally {
      release();
      acquirer.stop();
      await waitFor(() => store.list().every((task) => task.status !== "running"));
    }
  });

  test("claims only up to maxConcurrency and refills a freed slot on the next drain", async () => {
    enqueue("local-a");
    enqueue("local-b");
    enqueue("local-c");

    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const acquirer = new InjectedTaskAcquirer({
      store,
      maxConcurrency: 2,
      execute: async (task) => {
        started.push(task.taskKey);
        await new Promise<void>((resolve) => releases.set(task.taskKey, resolve));
        return true as TaskExecutionResult;
      },
      intervalSeconds: 3600,
    });

    try {
      void acquirer.start();
      await waitFor(() => started.length === 2);
      expect(store.list().filter((task) => task.status === "running")).toHaveLength(2);
      expect(store.list().filter((task) => task.status === "pending")).toHaveLength(1);

      // Freeing one slot does not start the third until the next drain; the
      // interval does that in production, and the cap still holds meanwhile.
      const first = started[0]!;
      releases.get(first)!();
      await waitFor(() => store.list().find((task) => task.taskKey === first)?.status === "done");
      void acquirer.tick();
      await waitFor(() => started.length === 3);
      expect(new Set(started)).toEqual(new Set(["local-a", "local-b", "local-c"]));
    } finally {
      for (const release of releases.values()) release();
      acquirer.stop();
      await waitFor(() => store.list().every((task) => task.status !== "running"));
    }
  });

  test("keeps a saturated repo pending while another repo starts", async () => {
    enqueue("local-a", "r1");
    enqueue("local-b", "r1");
    enqueue("local-c", "r2");

    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const acquirer = new InjectedTaskAcquirer({
      store,
      maxConcurrency: 3,
      maxConcurrencyPerRepo: 1,
      execute: async (task) => {
        started.push(task.taskKey);
        await new Promise<void>((resolve) => releases.set(task.taskKey, resolve));
        return true as TaskExecutionResult;
      },
      intervalSeconds: 3600,
    });

    try {
      void acquirer.start();
      await waitFor(() => started.length === 2);
      expect(new Set(started)).toEqual(new Set(["local-a", "local-c"]));
      expect(
        store
          .list()
          .filter((task) => task.status === "pending")
          .map((task) => task.taskKey),
      ).toEqual(["local-b"]);

      releases.get("local-a")!();
      await waitFor(
        () => store.list().find((task) => task.taskKey === "local-a")?.status === "done",
      );
      void acquirer.tick();
      await waitFor(() => started.includes("local-b"));
      expect(store.list().find((task) => task.taskKey === "local-b")?.status).toBe("running");
    } finally {
      for (const release of releases.values()) release();
      acquirer.stop();
      await waitFor(() => store.list().every((task) => task.status !== "running"));
    }
  });
});

/** Poll a synchronous condition; replace fixed sleeps in concurrency tests. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
