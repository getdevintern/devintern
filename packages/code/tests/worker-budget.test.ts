import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SpendCapConfigError } from "../src/lib/budget-guard";
import {
  beginRun,
  endRun,
  recordSessionOutput,
  resetRunRecorderForTests,
} from "../src/lib/run-recorder";
import { TaskPollingAcquirer } from "../src/lib/task-polling-acquirer";
import type { ChangeDetector } from "../src/lib/change-detector";
import {
  checkWorkerAdmission,
  getWorkerBudget,
  initWorkerBudget,
  isWorkerProcess,
  resetWorkerBudgetForTests,
} from "../src/lib/worker-budget";

const ENV_KEYS = [
  "DEVINTERN_WORKER",
  "WORKER_MAX_SPEND_PER_RUN_USD",
  "WORKER_MAX_SPEND_PER_DAY_USD",
  "WEBHOOK_QUEUE_DB",
] as const;

describe("worker budget admission", () => {
  let dir: string;
  let dbPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = join(tmpdir(), `wb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.WEBHOOK_QUEUE_DB = dbPath;
  });

  afterEach(() => {
    resetWorkerBudgetForTests();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function seedUnattendedSpend(costUsd: number): void {
    const { RunStore } =
      require("../src/lib/run-recorder") as typeof import("../src/lib/run-recorder");
    const store = new RunStore(dbPath);
    const id = store.createRun({ origin: "task", taskKey: "SEED-1", unattended: true });
    store.recordRunUsage(id, {
      source: null,
      complete: true,
      model: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      costUsd,
      costCurrency: "USD",
      costSource: "estimated",
      pricingVersion: "v",
      sessionCount: 1,
      sessionsWithoutUsage: 0,
    });
    store.finishRun(id, "succeeded");
    store.close();
  }

  test("invalid cap configuration aborts startup with an actionable error", () => {
    process.env.WORKER_MAX_SPEND_PER_DAY_USD = "-3";
    expect(() => initWorkerBudget({ dbPath })).toThrow(SpendCapConfigError);
    // The marker must not be set when startup fails.
    expect(isWorkerProcess()).toBe(false);
  });

  test("no caps configured → admission is ungated and marker still set", () => {
    initWorkerBudget({ dbPath });
    expect(isWorkerProcess()).toBe(true);
    expect(checkWorkerAdmission()).toBeNull();
    expect(getWorkerBudget()).toBeNull();
  });

  test("daily cap blocks admission after persisted spend reaches it", () => {
    process.env.WORKER_MAX_SPEND_PER_DAY_USD = "10";
    initWorkerBudget({ dbPath });
    expect(getWorkerBudget()).not.toBeNull();

    seedUnattendedSpend(9);
    expect(checkWorkerAdmission()?.allowed).toBe(true);

    seedUnattendedSpend(1);
    const decision = checkWorkerAdmission();
    expect(decision?.allowed).toBe(false);
    if (decision && !decision.allowed) {
      expect(decision.spentTodayUsd).toBeCloseTo(10);
    }
  });

  test("manual processes are never gated even with caps configured", () => {
    // No initWorkerBudget call: manual CLI run.
    process.env.WORKER_MAX_SPEND_PER_DAY_USD = "0.01";
    expect(isWorkerProcess()).toBe(false);
    expect(checkWorkerAdmission()).toBeNull();
  });

  test("capped-state notice logs once per UTC day", () => {
    process.env.WORKER_MAX_SPEND_PER_DAY_USD = "1";
    initWorkerBudget({ dbPath });
    seedUnattendedSpend(5);

    const logs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      checkWorkerAdmission();
      checkWorkerAdmission();
      checkWorkerAdmission();
    } finally {
      console.warn = originalWarn;
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[budget]");
    expect(logs[0]).toContain("UTC");
  });
});

describe("module-level usage recording", () => {
  let dir: string;
  let dbPath: string;
  let savedQueueDb: string | undefined;

  beforeEach(() => {
    resetRunRecorderForTests();
    dir = join(tmpdir(), `wb-rec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    savedQueueDb = process.env.WEBHOOK_QUEUE_DB;
    process.env.WEBHOOK_QUEUE_DB = dbPath;
  });

  afterEach(() => {
    resetRunRecorderForTests();
    if (savedQueueDb === undefined) {
      delete process.env.WEBHOOK_QUEUE_DB;
    } else {
      process.env.WEBHOOK_QUEUE_DB = savedQueueDb;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("sessions merge across stages and persist on endRun without double counting", () => {
    const { RunStore } =
      require("../src/lib/run-recorder") as typeof import("../src/lib/run-recorder");
    beginRun({
      origin: "task",
      taskKey: "MERGE-1",
      harness: "codex",
      unattended: true,
    });

    // Feasibility session: structured result.
    recordSessionOutput(
      "codex",
      JSON.stringify({
        modelUsage: { "gpt-5": { input_tokens: 100, output_tokens: 40 } },
        total_cost_usd: 0.01,
      }),
      "",
    );
    // Implementation session: text summary on stderr.
    recordSessionOutput("codex", "", "tokens used: 500\n");

    endRun("succeeded");

    const store = new RunStore(dbPath);
    const run = store.getRun(1);
    expect(run?.usage).not.toBeNull();
    expect(run?.usage?.sessionCount).toBe(2);
    // Structured tokens (100 in / 40 out) survive; the bare total does not
    // fabricate per-category numbers.
    expect(run?.usage?.inputTokens).toBe(100);
    expect(run?.usage?.outputTokens).toBe(40);
    // Provider-reported cost wins for the priced session.
    expect(run?.usage?.costUsd).toBeCloseTo(0.01);
    expect(run?.usage?.costSource).toBe("reported");
    expect(run?.usage?.complete).toBe(false); // second session had partial data
    store.close();
  });

  test("runs with no agent sessions persist no usage row data", () => {
    const { RunStore } =
      require("../src/lib/run-recorder") as typeof import("../src/lib/run-recorder");
    beginRun({ origin: "task", taskKey: "NOUSAGE-1" });
    endRun("failed", "branch creation failed");
    const store = new RunStore(dbPath);
    expect(store.getRun(1)?.status).toBe("failed");
    expect(store.getRun(1)?.usage).toBeNull();
    store.close();
  });
});

describe("TaskPollingAcquirer budget gating", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `wb-tpa-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  interface FixtureDetector extends ChangeDetector {
    source: string;
    changesSince: () => Promise<{ changed: boolean; nextCursor: string | null }>;
  }

  function makeAcquirer(canStart: () => boolean, executed: string[]) {
    const detector: FixtureDetector = {
      source: "fixture",
      changesSince: async () => ({ changed: true, nextCursor: null }),
    };
    const { WebhookQueue } =
      require("../src/lib/webhook-queue") as typeof import("../src/lib/webhook-queue");
    const { WorkerState } =
      require("../src/lib/worker-state") as typeof import("../src/lib/worker-state");
    return new TaskPollingAcquirer({
      trackerType: "markdown",
      query: "*",
      intervalSeconds: 60,
      detector,
      workerState: new WorkerState(dbPath),
      queue: new WebhookQueue({ dbPath }),
      searchTasks: async () => ({
        tasks: [{ key: "T-1" }, { key: "T-2" }, { key: "T-3" }],
      }),
      executeTask: async (taskKey) => {
        executed.push(taskKey);
        return true;
      },
      canStartTask: canStart,
    });
  }

  test("blocked gate skips execution without consuming queue slots", async () => {
    const executed: string[] = [];
    let allow = false;
    const acquirer = makeAcquirer(() => allow, executed);

    await acquirer.tick();
    expect(executed).toEqual([]);

    // Gate opens: the same work is picked up (recoverable).
    allow = true;
    await acquirer.tick();
    expect(executed).toEqual(["T-1", "T-2", "T-3"]);
  });

  test("mid-tick pause leaves unstarted work queued for later ticks", async () => {
    const executed: string[] = [];
    const detector: FixtureDetector = {
      source: "fixture-mid",
      changesSince: async () => ({ changed: true, nextCursor: null }),
    };
    const { WebhookQueue } =
      require("../src/lib/webhook-queue") as typeof import("../src/lib/webhook-queue");
    const { WorkerState } =
      require("../src/lib/worker-state") as typeof import("../src/lib/worker-state");
    const make = (canStart: () => boolean): TaskPollingAcquirer =>
      new TaskPollingAcquirer({
        trackerType: "markdown",
        query: "*",
        intervalSeconds: 60,
        detector,
        workerState: new WorkerState(dbPath),
        queue: new WebhookQueue({ dbPath }),
        searchTasks: async () => ({
          tasks: [{ key: "M-1" }, { key: "M-2" }, { key: "M-3" }],
        }),
        executeTask: async (taskKey) => {
          executed.push(taskKey);
          return true;
        },
        canStartTask: canStart,
      });

    // Cap crossed after the first run finishes.
    await make(() => executed.length < 1).tick();
    expect(executed).toEqual(["M-1"]);

    // Gate reopens on a later tick: remaining work is recovered.
    await make(() => true).tick();
    expect(executed).toEqual(["M-1", "M-2", "M-3"]);
  });
});
