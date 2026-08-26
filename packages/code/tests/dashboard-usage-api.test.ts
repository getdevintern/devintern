import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DashboardData, handleRuns, handleRunDetail, handleStats } from "../src/lib/dashboard-api";
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
    costUsd: 0.75,
    costCurrency: "USD",
    sessionCount: 1,
    sessionsWithoutUsage: 0,
    ...overrides,
  };
}

describe("dashboard API usage exposure", () => {
  let dir: string;
  let dbPath: string;
  let store: RunStore;
  let data: DashboardData;

  beforeEach(() => {
    dir = join(tmpdir(), `du-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    store = new RunStore(dbPath);
    data = new DashboardData({ dbPath });
  });

  afterEach(() => {
    data.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("GET /api/runs returns per-run usage fields", () => {
    const id = store.createRun({ origin: "task", taskKey: "API-1", unattended: true });
    store.recordRunUsage(id, usage());
    store.finishRun(id, "succeeded");

    const response = handleRuns(data, new URLSearchParams());
    expect(response.status).toBe(200);
    const body = response.body as { runs: Array<Record<string, unknown>> };
    const run = body.runs.find((r) => r.id === id);
    expect(run).toBeDefined();
    const record = run as never as { usage: RunUsage; unattended?: boolean };
    expect(record.usage.costUsd).toBeCloseTo(0.75);
    expect(record.usage.model).toBe("claude-sonnet-4-5");
    expect(record.unattended).toBe(true);
  });

  test("historical rows without usage stay compatible (usage null)", () => {
    const id = store.createRun({ origin: "task", taskKey: "API-OLD" });
    store.finishRun(id, "failed", "boom");

    const detail = handleRunDetail(data, String(id));
    expect(detail.status).toBe(200);
    const body = detail.body as { run: { status: string; usage: RunUsage | null } };
    expect(body.run.status).toBe("failed");
    expect(body.run.usage).toBeNull();
  });

  test("GET /api/stats exposes token totals, known spend, and coverage counts", () => {
    const priced = store.createRun({
      origin: "task",
      taskKey: "S-1",
      harness: "claude-code",
      unattended: true,
    });
    store.recordRunUsage(priced, usage({ costUsd: 2 }));
    store.finishRun(priced, "succeeded");

    const unknownCost = store.createRun({
      origin: "task",
      taskKey: "S-2",
      harness: "codex",
      unattended: true,
    });
    // Usage present but unpriceable: unknown model → cost stays null.
    store.recordRunUsage(
      unknownCost,
      usage({ inputTokens: 300, outputTokens: 200, costUsd: null, model: null, complete: false }),
    );
    store.finishRun(unknownCost, "succeeded");

    const bare = store.createRun({ origin: "task", taskKey: "S-3" });
    store.finishRun(bare, "escalated");

    const response = handleStats(data, new URLSearchParams("window=all"));
    expect(response.status).toBe(200);
    const payload = response.body as {
      stats: {
        totals: { runs: number };
        usage: {
          inputTokens: number | null;
          outputTokens: number | null;
          knownSpendUsd: number | null;
          runsWithUsage: number;
          runsWithoutUsage: number;
          runsWithIncompleteUsage: number;
        };
        byHarness: Array<{ harness: string; spendUsd: number | null; runsWithUnknownCost: number }>;
      };
    };

    expect(payload.stats.totals.runs).toBe(3);
    expect(payload.stats.usage.inputTokens).toBe(1300);
    expect(payload.stats.usage.outputTokens).toBe(700);
    // Only known spend sums; the unknown-cost run is counted, not zeroed.
    expect(payload.stats.usage.knownSpendUsd).toBeCloseTo(2);
    expect(payload.stats.usage.runsWithUsage).toBe(2);
    expect(payload.stats.usage.runsWithoutUsage).toBe(1);
    expect(payload.stats.usage.runsWithIncompleteUsage).toBe(1);

    const claude = payload.stats.byHarness.find((h) => h.harness === "claude-code");
    const codex = payload.stats.byHarness.find((h) => h.harness === "codex");
    expect(claude?.spendUsd).toBeCloseTo(2);
    expect(codex?.spendUsd).toBeNull();
    expect(codex?.runsWithUnknownCost).toBe(1);
  });
});
