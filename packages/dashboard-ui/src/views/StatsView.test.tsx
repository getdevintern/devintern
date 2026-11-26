import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RunOrigin, StatsResponse } from "@/lib/api";
import { AutoMergeSummary, SummaryRow, rateCounts } from "@/views/StatsView";

type Stats = NonNullable<StatsResponse["stats"]>;

const ORIGINS: RunOrigin[] = [
  "task",
  "error_monitor",
  "pr_mention",
  "ci_fix",
  "conflict_resolution",
  "auto_merge",
  "scheduled",
  "estimate",
  "manual",
  "local",
];

function stats(overrides: Partial<Stats> = {}): Stats {
  const zero = { succeeded: 0, failed: 0, escalated: 0, abandoned: 0 };
  return {
    totals: {
      runs: 14,
      byStatus: {
        in_progress: 0,
        succeeded: 9,
        failed: 1,
        deferred: 0,
        escalated: 4,
        abandoned: 0,
      },
    },
    successRate: 8 / 9,
    escalationRate: 0,
    rateBasis: { terminal: 9, succeeded: 8, escalated: 0 },
    runsPerWeek: [{ weekStart: "2026-11-16", count: 14 }],
    medianDurationMs: null,
    byHarness: [],
    byOrigin: Object.fromEntries(
      ORIGINS.map((o) => [o, o === "task" ? 9 : o === "auto_merge" ? 5 : 0]),
    ) as Record<RunOrigin, number>,
    byOriginStatus: Object.fromEntries(
      ORIGINS.map((o) => [
        o,
        o === "task"
          ? { ...zero, succeeded: 8, failed: 1 }
          : o === "auto_merge"
            ? { ...zero, succeeded: 1, escalated: 4 }
            : zero,
      ]),
    ) as Stats["byOriginStatus"],
    ...overrides,
  };
}

test("summary details use the non-auto-merge counts behind the rates", () => {
  const html = renderToStaticMarkup(createElement(SummaryRow, { stats: stats() }));
  expect(html).toContain("8 of 9 finished");
  expect(html).toContain("0 handed to a human");
});

test("auto-merge summary shows merged and left-for-review counts", () => {
  const html = renderToStaticMarkup(createElement(AutoMergeSummary, { stats: stats() }));
  expect(html).toContain("Rates exclude auto-merge decisions");
  expect(html).toMatch(/>1<\/span> merged/);
  expect(html).toMatch(/>4<\/span> left\s+for review/);
});

test("auto-merge summary is omitted without auto-merge runs", () => {
  const s = stats();
  const html = renderToStaticMarkup(
    createElement(AutoMergeSummary, {
      stats: { ...s, byOrigin: { ...s.byOrigin, auto_merge: 0 } },
    }),
  );
  expect(html).toBe("");
});

test("rateCounts falls back to totals for older workers", () => {
  expect(rateCounts(stats({ rateBasis: undefined }))).toEqual({
    terminal: 14,
    succeeded: 9,
    escalated: 4,
  });
});
