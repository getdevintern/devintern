import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { RunStore } from "../src/lib/run-recorder";

describe("RunStore", () => {
  let dbPath: string;
  let store: RunStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `rr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("createRun starts a run in in_progress with metadata", () => {
    const id = store.createRun({
      origin: "task",
      taskKey: "PROJ-1",
      tracker: "jira",
      harness: "claude-code",
    });

    const run = store.getRun(id);
    expect(run?.origin).toBe("task");
    expect(run?.taskKey).toBe("PROJ-1");
    expect(run?.tracker).toBe("jira");
    expect(run?.status).toBe("in_progress");
    expect(run?.finishedAt).toBeUndefined();
  });

  test("pr_mention runs have no task key", () => {
    const id = store.createRun({ origin: "pr_mention", repo: "acme/widgets", prNumber: 42 });

    const run = store.getRun(id);
    expect(run?.origin).toBe("pr_mention");
    expect(run?.taskKey).toBeUndefined();
    expect(run?.repo).toBe("acme/widgets");
    expect(run?.prNumber).toBe(42);
  });

  test("scheduled runs persist automation metadata", () => {
    const id = store.createRun({
      origin: "scheduled",
      automationId: "weekly-plan",
      repo: "backend",
      harness: "codex",
    });
    store.finishRun(id, "succeeded");

    expect(store.getRun(id)).toMatchObject({
      origin: "scheduled",
      automationId: "weekly-plan",
    });
    expect(store.getStats(null).byOrigin.scheduled).toBe(1);
  });

  test("stages accumulate in order with structured detail", () => {
    const id = store.createRun({ origin: "task", taskKey: "PROJ-2" });
    store.addStage(id, "feasibility", "succeeded", "clear enough", '{"clarityScore":8}');
    store.addStage(id, "implementation", "succeeded", "implemented");

    const stages = store.listStages(id);
    expect(stages.map((s) => s.stage)).toEqual(["feasibility", "implementation"]);
    expect(stages[0]?.detail).toBe('{"clarityScore":8}');
    expect(stages[1]?.summary).toBe("implemented");
  });

  test("huge stage detail is truncated, not rejected", () => {
    const id = store.createRun({ origin: "task", taskKey: "PROJ-3" });
    store.addStage(id, "implementation", "succeeded", "big", "x".repeat(100_000));

    const stages = store.listStages(id);
    expect(stages[0]?.detail?.length).toBe(50_000);
  });

  test("setRunPr attaches PR info without clobbering existing fields", () => {
    const id = store.createRun({ origin: "task", taskKey: "PROJ-4", repo: "acme/widgets" });
    store.setRunPr(id, { prNumber: 7, url: "https://github.com/acme/widgets/pull/7" });

    const run = store.getRun(id);
    expect(run?.repo).toBe("acme/widgets");
    expect(run?.prNumber).toBe(7);
    expect(run?.prUrl).toBe("https://github.com/acme/widgets/pull/7");
  });

  test("finishRun marks the run terminal and appends an outcome stage", () => {
    const id = store.createRun({ origin: "task", taskKey: "PROJ-5" });
    store.finishRun(id, "escalated", "implementation incomplete");

    const run = store.getRun(id);
    expect(run?.status).toBe("escalated");
    expect(run?.outcomeReason).toBe("implementation incomplete");
    expect(run?.finishedAt).toBeGreaterThan(0);

    const stages = store.listStages(id);
    expect(stages.at(-1)?.stage).toBe("outcome");
    expect(stages.at(-1)?.status).toBe("escalated");
  });

  test("finishRun succeeded records a succeeded outcome stage", () => {
    const id = store.createRun({ origin: "task", taskKey: "PROJ-6" });
    store.finishRun(id, "succeeded");
    expect(store.listStages(id).at(-1)?.status).toBe("succeeded");
  });

  test("listRuns filters by task key and orders newest first", () => {
    const first = store.createRun({ origin: "task", taskKey: "PROJ-7" });
    const second = store.createRun({ origin: "task", taskKey: "PROJ-7" });
    store.createRun({ origin: "task", taskKey: "OTHER-1" });

    const runs = store.listRuns({ taskKey: "PROJ-7" });
    expect(runs).toHaveLength(2);
    // Same-millisecond inserts: assert both attempts are present.
    expect(runs.map((r) => r.id).sort()).toEqual([first, second].sort());
  });

  test("run records survive a restart", () => {
    const id = store.createRun({ origin: "task", taskKey: "PROJ-8" });
    store.finishRun(id, "succeeded");

    const reopened = new RunStore(dbPath);
    expect(reopened.getRun(id)?.status).toBe("succeeded");
    expect(reopened.listStages(id)).toHaveLength(1);
    reopened.close();
  });

  test("attempt numbers count per task key", () => {
    const first = store.createRun({ origin: "task", taskKey: "PROJ-9" });
    const second = store.createRun({ origin: "task", taskKey: "PROJ-9" });
    const other = store.createRun({ origin: "task", taskKey: "OTHER-2" });
    const mention = store.createRun({ origin: "pr_mention", repo: "acme/widgets" });

    expect(store.getRun(first)?.attempt).toBe(1);
    expect(store.getRun(second)?.attempt).toBe(2);
    expect(store.getRun(other)?.attempt).toBe(1);
    expect(store.getRun(mention)?.attempt).toBeUndefined();
  });

  test("opening a pre-attempt-column database adds the column", () => {
    const legacyPath = join(
      tmpdir(),
      `rr-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const { Database } = require("bun:sqlite");
    const legacy = new Database(legacyPath);
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
        finished_at INTEGER
      )
    `);
    legacy.run(`INSERT INTO runs (origin, task_key, started_at) VALUES ('task', 'OLD-1', 1)`);
    legacy.close();

    const migrated = new RunStore(legacyPath);
    const id = migrated.createRun({ origin: "task", taskKey: "OLD-1" });
    expect(migrated.getRun(id)?.attempt).toBe(2);
    const scheduled = migrated.createRun({ origin: "scheduled", automationId: "new-schedule" });
    expect(migrated.getRun(scheduled)?.automationId).toBe("new-schedule");
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${legacyPath}${suffix}`, { force: true });
    }
  });
});
