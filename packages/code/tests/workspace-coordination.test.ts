import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import { CoordinationStore } from "../src/lib/workspace/coordination";
import type { MultiRepoPlan } from "../src/lib/workspace/plan";
import { beginRun, endRun, RunStore } from "../src/lib/run-recorder";

function makePlan(coordinationId: string): MultiRepoPlan {
  return {
    taskKey: "DEV-9",
    coordinationId,
    entries: [
      { repo: "shared-config", rationale: "flags first", change: "add flag", dependencies: [] },
      {
        repo: "backend",
        rationale: "consumes flag",
        change: "use flag",
        dependencies: ["shared-config"],
      },
    ],
    executionOrder: ["shared-config", "backend"],
  };
}

describe("CoordinationStore", () => {
  let dir: string;
  let dbPath: string;
  let store: CoordinationStore;

  beforeEach(() => {
    dir = join(tmpdir(), `ws-coord-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    store = new CoordinationStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("ensureCoordination is idempotent and preserves the original plan", () => {
    const plan = makePlan("dev-9-aaaa");
    expect(
      store.ensureCoordination({ coordinationId: plan.coordinationId, taskKey: "DEV-9", plan }),
    ).toBe(true);
    expect(
      store.ensureCoordination({ coordinationId: plan.coordinationId, taskKey: "DEV-9", plan }),
    ).toBe(false);

    const record = store.getCoordination("dev-9-aaaa");
    expect(record?.status).toBe("in_progress");
    expect(record?.plan?.entries).toHaveLength(2);
  });

  test("latestForTask returns the newest effort for a task", () => {
    const older = makePlan("dev-9-old1");
    const newer = makePlan("dev-9-new2");
    // created_at is identical within the same millisecond; break the tie via
    // the coordination id ordering used by the query.
    store.ensureCoordination({
      coordinationId: newer.coordinationId,
      taskKey: "DEV-9",
      plan: newer,
    });
    store.ensureCoordination({
      coordinationId: older.coordinationId,
      taskKey: "DEV-9",
      plan: older,
    });
    store.setCoordinationStatus(newer.coordinationId, "partial_failure");

    expect(store.latestForTask("DEV-9")?.coordinationId).toBe(older.coordinationId);
    expect(store.latestForTask("DEV-404")).toBeNull();
  });

  test("per-repo runs are created once per plan and patched independently", () => {
    const plan = makePlan("dev-9-bbbb");
    store.ensureCoordination({ coordinationId: plan.coordinationId, taskKey: "DEV-9", plan });
    store.ensureRuns(plan);
    store.ensureRuns(plan); // resume-safe: no duplicates

    expect(store.listRuns(plan.coordinationId)).toHaveLength(2);

    store.patchRun(plan.coordinationId, "shared-config", {
      status: "succeeded",
      branch: "feature/dev-9-bbbb",
      repoSlug: "acme/shared-config",
      prUrl: "https://github.com/acme/shared-config/pull/1",
      prNumber: 1,
    });
    store.patchRun(plan.coordinationId, "backend", {
      status: "blocked",
      reason: 'prerequisite "shared-config" did not succeed',
    });

    const shared = store.getRun(plan.coordinationId, "shared-config");
    expect(shared).toMatchObject({
      status: "succeeded",
      branch: "feature/dev-9-bbbb",
      prUrl: "https://github.com/acme/shared-config/pull/1",
      repoSlug: "acme/shared-config",
      dependencies: [],
    });
    const backend = store.getRun(plan.coordinationId, "backend");
    expect(backend?.dependencies).toEqual(["shared-config"]);
    expect(backend?.reason).toContain("prerequisite");
  });

  test("markReconciled tracks reconciliation state", () => {
    const plan = makePlan("dev-9-cccc");
    store.ensureCoordination({ coordinationId: plan.coordinationId, taskKey: "DEV-9", plan });
    expect(store.getCoordination(plan.coordinationId)?.reconciledAt).toBeUndefined();
    store.markReconciled(plan.coordinationId, false);
    expect(store.getCoordination(plan.coordinationId)?.reconciledAt).toBeUndefined();
    store.markReconciled(plan.coordinationId, true);
    expect(store.getCoordination(plan.coordinationId)?.reconciledAt).toBeDefined();
  });
});

describe("RunStore coordination linkage", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `ws-runs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs persist coordination_id and filter by it", () => {
    const runs = new RunStore(dbPath);
    const child = runs.createRun({
      origin: "task",
      taskKey: "DEV-9",
      coordinationId: "dev-9-zzzz",
      repo: "backend",
    });
    runs.createRun({ origin: "task", taskKey: "DEV-10" }); // uncoordinated

    const coordinated = runs.listRuns({ coordinationId: "dev-9-zzzz" });
    expect(coordinated).toHaveLength(1);
    expect(coordinated[0]?.id).toBe(child);
    expect(coordinated[0]?.coordinationId).toBe("dev-9-zzzz");

    const detail = runs.getRun(child);
    expect(detail?.coordinationId).toBe("dev-9-zzzz");
    runs.close();
  });

  test("the coordination_id migration is additive for pre-existing databases", () => {
    // Simulate an old database whose runs table predates the column.
    const legacy = new Database(dbPath);
    legacy.run(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        origin TEXT NOT NULL,
        task_key TEXT,
        tracker TEXT,
        harness TEXT,
        branch TEXT,
        repo TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        status TEXT NOT NULL DEFAULT 'in_progress',
        outcome_reason TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        attempt INTEGER
      )
    `);
    legacy
      .query(
        `INSERT INTO runs (origin, task_key, status, started_at) VALUES ('task', 'DEV-OLD', 'succeeded', ?)`,
      )
      .run(Date.now());
    legacy.close();

    const runs = new RunStore(dbPath); // triggers additive migrations
    const migrated = runs.listRuns({ taskKey: "DEV-OLD" });
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.coordinationId).toBeUndefined();

    const freshId = runs.createRun({
      origin: "task",
      taskKey: "DEV-NEW",
      coordinationId: "dev-new-0001",
    });
    expect(runs.getRun(freshId)?.coordinationId).toBe("dev-new-0001");
    runs.close();
  });

  test("beginRun links the run to DEVINTERN_COORDINATION_ID from the environment", () => {
    const previousDb = process.env.WEBHOOK_QUEUE_DB;
    const previousCoordination = process.env.DEVINTERN_COORDINATION_ID;
    process.env.WEBHOOK_QUEUE_DB = dbPath;
    process.env.DEVINTERN_COORDINATION_ID = "dev-env-link-42";

    beginRun({ origin: "task", taskKey: "DEV-ENV" });
    endRun("succeeded", "linked");

    if (previousDb === undefined) delete process.env.WEBHOOK_QUEUE_DB;
    else process.env.WEBHOOK_QUEUE_DB = previousDb;
    if (previousCoordination === undefined) delete process.env.DEVINTERN_COORDINATION_ID;
    else process.env.DEVINTERN_COORDINATION_ID = previousCoordination;

    const runs = new RunStore(dbPath);
    const [run] = runs.listRuns({ taskKey: "DEV-ENV" });
    expect(run?.coordinationId).toBe("dev-env-link-42");
    runs.close();
  });
});
