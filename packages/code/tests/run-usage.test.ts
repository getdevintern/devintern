import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";

import { RunStore } from "../src/lib/run-recorder";
import type { RunUsage } from "../src/lib/run-recorder";

function usage(overrides: Partial<RunUsage> = {}): RunUsage {
  return {
    source: "structured_output",
    complete: true,
    model: "claude-sonnet-4-5",
    inputTokens: 1000,
    outputTokens: 500,
    cachedInputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    costUsd: 0.02,
    costCurrency: "USD",
    costSource: "estimated",
    pricingVersion: "2026-08-01",
    sessionCount: 1,
    sessionsWithoutUsage: 0,
    ...overrides,
  };
}

describe("RunStore usage recording", () => {
  let dbPath: string;
  let store: RunStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `ru-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("recordRunUsage persists every normalized field and round-trips", () => {
    const id = store.createRun({ origin: "task", taskKey: "USE-1", unattended: true });
    store.recordRunUsage(
      id,
      usage({
        cachedInputTokens: 250,
        reasoningTokens: 75,
        totalTokens: 1825,
        costSource: "reported",
        pricingVersion: null,
      }),
    );
    store.finishRun(id, "succeeded");

    const run = store.getRun(id);
    expect(run?.usage).not.toBeNull();
    expect(run?.usage?.inputTokens).toBe(1000);
    expect(run?.usage?.outputTokens).toBe(500);
    expect(run?.usage?.cachedInputTokens).toBe(250);
    expect(run?.usage?.reasoningTokens).toBe(75);
    expect(run?.usage?.totalTokens).toBe(1825);
    expect(run?.usage?.model).toBe("claude-sonnet-4-5");
    expect(run?.usage?.costUsd).toBeCloseTo(0.02);
    expect(run?.usage?.costCurrency).toBe("USD");
    expect(run?.usage?.costSource).toBe("reported");
    expect(run?.usage?.pricingVersion).toBeNull();
    expect(run?.usage?.complete).toBe(true);
    expect(run?.unattended).toBe(true);
  });

  test("null usage fields stay null (unknown, never zero)", () => {
    const id = store.createRun({ origin: "task", taskKey: "USE-2" });
    store.recordRunUsage(
      id,
      usage({
        complete: false,
        model: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        costCurrency: null,
        costSource: null,
        pricingVersion: null,
      }),
    );

    const run = store.getRun(id);
    expect(run?.usage?.inputTokens).toBeNull();
    expect(run?.usage?.outputTokens).toBeNull();
    expect(run?.usage?.costUsd).toBeNull();
    expect(run?.usage?.costSource).toBeNull();
    expect(run?.usage?.model).toBeNull();
    expect(run?.usage?.complete).toBe(false);
  });

  test("historical rows without usage read as usage: null", () => {
    const id = store.createRun({ origin: "task", taskKey: "OLD-1" });
    store.finishRun(id, "succeeded");
    const run = store.getRun(id);
    expect(run?.usage).toBeNull();
  });

  test("opening a pre-usage database migrates additively and stays readable", () => {
    const legacyPath = join(
      tmpdir(),
      `ru-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
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
    legacy.run(`INSERT INTO runs (origin, task_key, started_at) VALUES ('task', 'LEGACY-1', 1)`);
    legacy.close();

    const migrated = new RunStore(legacyPath);
    // Historical row readable with null usage.
    const runs = migrated.listRuns({ taskKey: "LEGACY-1" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.usage).toBeNull();

    // New writes work.
    const id = migrated.createRun({ origin: "task", taskKey: "LEGACY-2" });
    migrated.recordRunUsage(id, usage());
    expect(migrated.getRun(id)?.usage?.costUsd).toBeCloseTo(0.02);
    migrated.close();

    // Re-opening is idempotent (no duplicate ALTER TABLE errors).
    const reopened = new RunStore(legacyPath);
    expect(reopened.getRun(id)?.usage?.inputTokens).toBe(1000);
    reopened.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${legacyPath}${suffix}`, { force: true });
    }
  });

  test("getUnattendedSpendSince sums only unattended finished runs and counts unknown exposure", () => {
    const now = Date.now();
    const attended = store.createRun({ origin: "task", taskKey: "MAN-1" });
    store.finishRun(attended, "succeeded");
    store.recordRunUsage(attended, usage({ costUsd: 99 }));

    const unattendedPriced = store.createRun({
      origin: "task",
      taskKey: "AUTO-1",
      unattended: true,
    });
    store.recordRunUsage(unattendedPriced, usage({ costUsd: 1.25 }));
    store.finishRun(unattendedPriced, "succeeded");

    const unattendedUnknown = store.createRun({
      origin: "pr_mention",
      repo: "a/b",
      unattended: true,
    });
    store.recordRunUsage(unattendedUnknown, usage({ costUsd: null }));
    store.finishRun(unattendedUnknown, "failed");

    // Manual run is not counted; unknown-cost run is reported separately.
    const summary = store.getUnattendedSpendSince(0);
    expect(summary.knownSpendUsd).toBeCloseTo(1.25);
    expect(summary.runsWithUnknownCost).toBe(1);

    // A window before the runs excludes everything.
    const empty = store.getUnattendedSpendSince(now + 10_000);
    expect(empty.knownSpendUsd).toBeNull();
    expect(empty.runsWithUnknownCost).toBe(0);
  });
});

describe("RunStats usage aggregation", () => {
  let dbPath: string;
  let store: RunStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `rs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function seedFinished(meta: {
    taskKey: string;
    harness?: string;
    unattended?: boolean;
    runUsage?: Partial<RunUsage>;
  }): void {
    const id = store.createRun({
      origin: "task",
      taskKey: meta.taskKey,
      harness: meta.harness ?? "claude-code",
      unattended: meta.unattended,
    });
    if (meta.runUsage) {
      store.recordRunUsage(id, usage(meta.runUsage));
    }
    store.finishRun(id, "succeeded");
  }

  test("aggregates tokens and known spend without treating unknown as zero", () => {
    seedFinished({
      taskKey: "AGG-1",
      runUsage: { inputTokens: 1000, outputTokens: 500, costUsd: 1 },
    });
    seedFinished({
      taskKey: "AGG-2",
      runUsage: { inputTokens: 400, outputTokens: null, costUsd: null, complete: false },
    });
    seedFinished({ taskKey: "AGG-3" }); // no usage at all

    const stats = store.getStats(null);
    expect(stats.usage.inputTokens).toBe(1400);
    expect(stats.usage.outputTokens).toBe(500);
    expect(stats.usage.cachedInputTokens).toBeNull(); // nothing reported → null, not 0
    expect(stats.usage.knownSpendUsd).toBeCloseTo(1); // unknown run adds nothing
    expect(stats.usage.currency).toBe("USD");
    expect(stats.usage.runsWithUsage).toBe(2);
    expect(stats.usage.runsWithoutUsage).toBe(1);
    expect(stats.usage.runsWithIncompleteUsage).toBe(1);
  });

  test("per-harness spend splits by harness with unknown-cost counters", () => {
    seedFinished({
      taskKey: "H-1",
      harness: "claude-code",
      runUsage: { costUsd: 0.5 },
    });
    seedFinished({
      taskKey: "H-2",
      harness: "codex",
      runUsage: { costUsd: 2, model: "gpt-5" },
    });
    seedFinished({
      taskKey: "H-3",
      harness: "codex",
      runUsage: { costUsd: null, complete: false },
    });

    const stats = store.getStats(null);
    const claude = stats.byHarness.find((h) => h.harness === "claude-code");
    const codex = stats.byHarness.find((h) => h.harness === "codex");
    expect(claude?.spendUsd).toBeCloseTo(0.5);
    expect(codex?.spendUsd).toBeCloseTo(2);
    expect(codex?.runsWithUnknownCost).toBe(1);
  });

  test("window filtering only includes runs started within the window", () => {
    seedFinished({ taskKey: "WIN-1", runUsage: { costUsd: 3 } });
    // Backdate a second run beyond the 7d window.
    const oldId = store.createRun({ origin: "task", taskKey: "WIN-2", unattended: true });
    store.recordRunUsage(oldId, usage({ costUsd: 100 }));
    const db = (store as unknown as { db: { run: (sql: string, ...params: unknown[]) => void } })
      .db;
    db.run(`UPDATE runs SET started_at = ? WHERE id = ?`, [
      Date.now() - 8 * 24 * 60 * 60 * 1000,
      oldId,
    ]);
    store.finishRun(oldId, "succeeded");

    const week = store.getStats(7 * 24 * 60 * 60 * 1000);
    expect(week.totals.runs).toBe(1);
    expect(week.usage.knownSpendUsd).toBeCloseTo(3);

    const all = store.getStats(null);
    expect(all.totals.runs).toBe(2);
    expect(all.usage.knownSpendUsd).toBeCloseTo(103);
  });
});
