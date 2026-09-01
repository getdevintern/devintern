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

  test("reapOrphanedRuns fails only in_progress runs, terminal runs stay untouched", () => {
    const orphan = store.createRun({ origin: "conflict_resolution" });
    const finished = store.createRun({ origin: "task", taskKey: "PROJ-2" });
    store.finishRun(finished, "succeeded", "done");

    const reaped = store.reapOrphanedRuns();
    expect(reaped).toBe(1);

    const orphanRun = store.getRun(orphan);
    expect(orphanRun?.status).toBe("failed");
    expect(orphanRun?.outcomeReason).toContain("orphaned");
    expect(orphanRun?.finishedAt).toBeDefined();

    // Terminal rows are not modified by a second sweep.
    expect(store.reapOrphanedRuns()).toBe(0);
    expect(store.getRun(finished)?.status).toBe("succeeded");
  });

  test("a late finishRun from an outlived subprocess wins over the reap", () => {
    const id = store.createRun({ origin: "conflict_resolution" });
    store.reapOrphanedRuns();
    store.finishRun(id, "succeeded", "late completion");

    const run = store.getRun(id);
    expect(run?.status).toBe("succeeded");
    expect(run?.outcomeReason).toBe("late completion");
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

  test("estimate runs are a distinct origin carrying the schedule id", () => {
    const id = store.createRun({
      origin: "estimate",
      taskKey: "PROJ-9",
      automationId: "weekday-groom",
    });
    store.finishRun(id, "succeeded");

    expect(store.getRun(id)).toMatchObject({ origin: "estimate", automationId: "weekday-groom" });
    const stats = store.getStats(null).byOrigin;
    expect(stats.estimate).toBe(1);
    expect(stats.scheduled).toBe(0);
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

  test("createRun persists the derived ticket URL and setRunTicket snapshots the description", () => {
    const id = store.createRun({
      origin: "task",
      taskKey: "PROJ-10",
      tracker: "jira",
      ticketKey: "PROJ-10",
      ticketUrl: "https://acme.atlassian.net/browse/PROJ-10",
    });
    expect(store.getRun(id)?.ticketUrl).toBe("https://acme.atlassian.net/browse/PROJ-10");

    store.setRunTicket(id, { description: "# Task\n\nBuild it." });

    const run = store.getRun(id);
    expect(run?.taskDescription).toBe("# Task\n\nBuild it.");
  });

  test("setRunTicket fills missing fields without erasing them and skips blank descriptions", () => {
    const id = store.createRun({
      origin: "task",
      taskKey: "PROJ-11",
      ticketUrl: "https://acme.atlassian.net/browse/PROJ-11",
    });
    // No URL passed: the existing one must survive.
    store.setRunTicket(id, { key: "PROJ-11" });
    store.setRunTicket(id, { description: "   \n\t  " });

    const run = store.getRun(id);
    expect(run?.ticketKey).toBe("PROJ-11");
    expect(run?.ticketUrl).toBe("https://acme.atlassian.net/browse/PROJ-11");
    expect(run?.taskDescription).toBeUndefined();
  });

  test("huge task descriptions are truncated, not rejected", () => {
    const id = store.createRun({ origin: "task", taskKey: "PROJ-12" });
    store.setRunTicket(id, { description: "x".repeat(100_000) });

    const run = store.getRun(id);
    expect(run?.taskDescription?.length).toBe(20_000);
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

  test("listRuns filters by automation id and status", () => {
    const scheduled = store.createRun({
      origin: "scheduled",
      automationId: "dependency-health",
    });
    const manual = store.createRun({ origin: "manual", automationId: "dependency-health" });
    store.createRun({ origin: "scheduled", automationId: "other-schedule" });

    const all = store.listRuns({ automationId: "dependency-health" });
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.id).sort()).toEqual([scheduled, manual].sort());

    const manualOnly = store.listRuns({
      automationId: "dependency-health",
      origin: "manual",
    });
    expect(manualOnly.map((r) => r.id)).toEqual([manual]);
  });

  test("latestRunByTaskKey returns the newest run per key in one query", () => {
    const firstProj = store.createRun({ origin: "task", taskKey: "PROJ-10" });
    store.finishRun(firstProj, "failed");
    const secondProj = store.createRun({ origin: "task", taskKey: "PROJ-10" });
    const otherRun = store.createRun({ origin: "task", taskKey: "OTHER-3" });
    store.createRun({ origin: "pr_mention", repo: "acme/widgets" });

    const latest = store.latestRunByTaskKey(["PROJ-10", "OTHER-3", "PROJ-10", "UNKNOWN-1"]);
    expect(latest.size).toBe(2);
    expect(latest.get("PROJ-10")?.id).toBe(secondProj);
    expect(latest.get("PROJ-10")?.status).toBe("in_progress");
    expect(latest.get("OTHER-3")?.id).toBe(otherRun);
    expect(latest.has("UNKNOWN-1")).toBe(false);
  });

  test("run records survive a restart", () => {
    const id = store.createRun({ origin: "task", taskKey: "PROJ-8" });
    store.finishRun(id, "succeeded");

    const reopened = new RunStore(dbPath);
    expect(reopened.getRun(id)?.status).toBe("succeeded");
    expect(reopened.listStages(id)).toHaveLength(1);
    reopened.close();
  });

  test("setRunBranch attaches the working branch without clobbering", () => {
    // Task runs learn their branch only after createFeatureBranch succeeds
    // (the name can gain an attempt suffix), so it is attached post-hoc.
    const id = store.createRun({ origin: "task", taskKey: "PROJ-11", harness: "claude-code" });
    store.setRunBranch(id, "feature/proj-11");
    expect(store.getRun(id)?.branch).toBe("feature/proj-11");

    // pr_mention runs record their branch at beginRun; a late write must not
    // replace it.
    const mention = store.createRun({ origin: "pr_mention", branch: "agent/task" });
    store.setRunBranch(mention, "feature/proj-11");
    expect(store.getRun(mention)?.branch).toBe("agent/task");
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
    // Description snapshots (and their column) work on migrated databases too.
    migrated.setRunTicket(id, {
      url: "https://acme.atlassian.net/browse/OLD-1",
      description: "doc",
    });
    expect(migrated.getRun(id)?.ticketUrl).toBe("https://acme.atlassian.net/browse/OLD-1");
    expect(migrated.getRun(id)?.taskDescription).toBe("doc");
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${legacyPath}${suffix}`, { force: true });
    }
  });
});
