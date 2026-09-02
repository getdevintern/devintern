import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AutomationsTable } from "@/views/AutomationsView";
import type { AutomationSchedule, RunRecord } from "@/lib/api";
import { RUN_ORIGIN_LABELS } from "@/lib/run-origin";

const STARTED_AT = 1_800_000_000_000;

function lastRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 42,
    origin: "scheduled",
    status: "succeeded",
    startedAt: STARTED_AT,
    taskKey: "DEV-42",
    ...overrides,
  };
}

function automation(overrides: Partial<AutomationSchedule> = {}): AutomationSchedule {
  return {
    id: "nightly-triage",
    enabled: true,
    schedule: "0 3 * * *",
    repo: "acme/widgets",
    prompt: "Triage open issues and summarise blockers.",
    nextDueAt: STARTED_AT,
    ...overrides,
  };
}

function render(automations: AutomationSchedule[], busyId: string | null = null): string {
  return renderToStaticMarkup(
    createElement(AutomationsTable, {
      automations,
      busyId,
      onRunNow: () => {},
      onOpenRun: () => {},
    }),
  );
}

/** Index of a column header in the rendered header row, -1 when missing. */
function headerIndex(html: string, label: string): number {
  return html.indexOf(`>${label}<`);
}

function formatExpected(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

test("columns read in scanning order: automation, schedule, repo, next run, last run, actions", () => {
  const html = render([automation()]);

  const labels = ["Automation", "Schedule", "Repo", "Next run", "Last run", "Actions"];
  const indices = labels.map((label) => headerIndex(html, label));
  expect(indices.every((index) => index >= 0)).toBe(true);
  expect([...indices].sort((a, b) => a - b)).toEqual(indices);
});

test("long automation ids and prompts are capped and truncated in place", () => {
  const longId = "nightly-dependency-audit-and-report-generation-across-every-monorepo";
  const longPrompt = `${"Build the release notes draft. ".repeat(20)}\nSecond line stays out of the preview.`;
  const html = render([automation({ id: longId, prompt: longPrompt })]);

  expect(html).toContain("max-w-72");
  expect(html).toContain("truncate");
  expect(html).toContain(`title="${longId}"`);
  expect(html).toContain(`title="${longPrompt}"`);
});

test("long cron expressions and repo names are capped with the full value on hover", () => {
  const html = render([
    automation({
      schedule: "*/5 1-6 29-31 11-12 0-6",
      repo: "acme/very-long-repository-name-for-width-testing",
    }),
  ]);

  expect(html).toContain("max-w-28");
  expect(html).toContain("max-w-32");
  expect(html).toContain('title="*/5 1-6 29-31 11-12 0-6"');
  expect(html).toContain('title="acme/very-long-repository-name-for-width-testing"');
});

test("last run cell shows the status badge, origin, start time, and result link", () => {
  const html = render([
    automation({
      lastRun: lastRun({
        ticketKey: "DEV-42",
        ticketUrl: "https://acme.atlassian.net/browse/DEV-42",
      }),
    }),
  ]);

  expect(html).toContain("succeeded");
  expect(html).toContain(RUN_ORIGIN_LABELS.scheduled);
  expect(html).toContain(formatExpected(STARTED_AT));
  expect(html).toContain("DEV-42");
  expect(html).toContain('href="https://acme.atlassian.net/browse/DEV-42"');
});

test("missing schedule, repo, next run, and last run degrade to a dash", () => {
  const html = render([
    automation({ schedule: undefined, repo: undefined, nextDueAt: undefined, lastRun: undefined }),
  ]);

  expect(html).toContain("–");
  expect(html).not.toContain("0 3 * * *");
  expect(html).not.toContain("acme/widgets");
});

test("enabled automations render an accessible Run now action", () => {
  const html = render([automation()]);

  expect(html).toContain('aria-label="Run nightly-triage now"');
  expect(html).toContain("Run now");
});

test("triggered automations show a busy label while the request is in flight", () => {
  const html = render([automation()], "nightly-triage");

  expect(html).toContain("Starting…");
  expect(html).toContain("disabled");
});

test("disabled automations render a hint instead of the Run now action", () => {
  const html = render([automation({ enabled: false })]);

  expect(html).not.toContain("Run now</button>");
  expect(html).not.toContain("Run nightly-triage now");
  expect(html).toContain("Enable this automation in the config to run it manually");
});
