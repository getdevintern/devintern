import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FilterSelect } from "@/components/shared";
import { RunsTable } from "@/views/RunsView";
import type { RunOrigin, RunRecord } from "@/lib/api";
import { RUN_ORIGIN_LABELS } from "@/lib/run-origin";

const STARTED_AT = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 7,
    origin: "task",
    status: "succeeded",
    startedAt: STARTED_AT - HOUR,
    finishedAt: STARTED_AT,
    taskKey: "DEV-7",
    ...overrides,
  };
}

/** Index of a column header in the rendered header row, -1 when missing. */
function headerIndex(html: string, label: string): number {
  return html.indexOf(`>${label}<`);
}

test("columns read in scanning order: work, origin, harness, status, result, started, duration", () => {
  const html = renderToStaticMarkup(
    createElement(RunsTable, { runs: [run()], onOpenRun: () => {} }),
  );

  const labels = ["Work", "Origin", "Harness", "Status", "Result", "Started", "Duration"];
  const indices = labels.map((label) => headerIndex(html, label));
  expect(indices.every((index) => index >= 0)).toBe(true);
  expect([...indices].sort((a, b) => a - b)).toEqual(indices);
});

test("no branch column: branches stay on the run detail view", () => {
  const html = renderToStaticMarkup(
    createElement(RunsTable, { runs: [run({ branch: "feature/dev-7" })], onOpenRun: () => {} }),
  );

  expect(headerIndex(html, "Branch")).toBe(-1);
  expect(html).not.toContain("feature/dev-7");
});

test("started column shows the run start time; duration comes from finishedAt", () => {
  const html = renderToStaticMarkup(
    createElement(RunsTable, { runs: [run()], onOpenRun: () => {} }),
  );

  expect(html).toContain(">Started<");
  expect(html).toContain(formatExpected(STARTED_AT - HOUR));
  expect(html).toContain("1h 0m");
});

function formatExpected(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

test("in-progress runs show a placeholder duration; missing harness degrades to a dash", () => {
  const html = renderToStaticMarkup(
    createElement(RunsTable, {
      runs: [run({ finishedAt: undefined, harness: undefined })],
      onOpenRun: () => {},
    }),
  );

  expect(html).toContain(">…<");
  expect(html).toContain("–");
});

test("task key renders in the work column with a tracker link when available", () => {
  const html = renderToStaticMarkup(
    createElement(RunsTable, {
      runs: [run({ ticketUrl: "https://acme.atlassian.net/browse/DEV-7" })],
      onOpenRun: () => {},
    }),
  );

  expect(html).toContain("DEV-7");
  expect(html).toContain('href="https://acme.atlassian.net/browse/DEV-7"');
});

test("filter select trigger shows the filter name and the current selection", () => {
  type StatusFilter = "all" | "in_progress" | "failed";
  const STATUS_OPTIONS: readonly StatusFilter[] = ["all", "in_progress", "failed"];
  const html = renderToStaticMarkup(
    createElement(FilterSelect<StatusFilter>, {
      label: "Status",
      options: STATUS_OPTIONS,
      value: "all",
      onChange: () => {},
    }),
  );

  expect(html).toContain("Status");
  expect(html).toContain(">all<");
});

test("filter select trigger shows the formatted non-default selection", () => {
  type OriginFilter = RunOrigin | "all";
  const ORIGIN_OPTIONS: readonly OriginFilter[] = ["all", "task", "pr_mention"];
  const html = renderToStaticMarkup(
    createElement(FilterSelect<OriginFilter>, {
      label: "Origin",
      options: ORIGIN_OPTIONS,
      value: "task",
      formatLabel: (option) => (option === "all" ? "all" : RUN_ORIGIN_LABELS[option]),
      onChange: () => {},
    }),
  );

  expect(html).toContain("Origin");
  expect(html).toContain("Tracker task");
});
