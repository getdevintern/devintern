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
    hour: "numeric",
    minute: "2-digit",
  });
}

test("columns read in scanning order: automation, schedule, next run, last run, actions", () => {
  const html = render([automation()]);

  const labels = ["Automation", "Schedule", "Next run", "Last run", "Actions"];
  const indices = labels.map((label) => headerIndex(html, label));
  expect(indices.every((index) => index >= 0)).toBe(true);
  expect([...indices].sort((a, b) => a - b)).toEqual(indices);
});

test("schedule is humanized with the raw cron kept as secondary text", () => {
  const html = render([automation({ schedule: "0 4 * * *" })]);
  expect(html).toContain("Daily 04:00");
  expect(html).toContain('title="Cron: 0 4 * * *"');
  expect(html).not.toContain("<code");

  const unknown = render([automation({ schedule: "*/5 1-6 29-31 11-12 0-6" })]);
  expect(unknown).toContain("<code");
  expect(unknown).toContain('title="Cron: */5 1-6 29-31 11-12 0-6"');
});

test("PR-creating automations show a quiet indicator, not a pill", () => {
  const on = render([automation({ openPr: true })]);
  expect(on).toContain("open_pr = true");
  expect(on).not.toContain("opens PR");

  const off = render([automation()]);
  expect(off).not.toContain("open_pr = true");
});

test("a single repo renders one ungrouped body and states the repo once", () => {
  const same = render([automation({ id: "a" }), automation({ id: "b" })]);
  expect(same).not.toContain(">Repo<");
  expect(same).not.toContain('scope="rowgroup"');
  expect(same).not.toContain("<h2");
  expect(same).toContain("All automations run in");
});

test("all-general automations render without group chrome or a repo note", () => {
  const html = render([
    automation({ id: "a", repo: undefined }),
    automation({ id: "b", repo: "" }),
  ]);
  expect(html).not.toContain('scope="rowgroup"');
  expect(html).not.toContain(">General<");
  expect(html).not.toContain("All automations run in");
});

test("mixed repos group into rowgroups: General first, then repos by name", () => {
  const html = render([
    automation({ id: "web-job", repo: "web" }),
    automation({ id: "loose-job", repo: undefined }),
    automation({ id: "api-job", repo: "api" }),
    automation({ id: "api-two", repo: "api", nextDueAt: STARTED_AT + 1 }),
  ]);

  expect(html).not.toContain(">Repo<");
  expect(html).not.toContain("All automations run in");
  expect(html.split("<tbody").length - 1).toBe(3);
  expect(html.split('scope="rowgroup"').length - 1).toBe(3);
  expect(html.split("<h2").length - 1).toBe(3);
  expect(html).toContain("2 automations");
  expect(html).toContain("1 automation<");

  const order = [
    ">General<",
    ">loose-job<",
    ">api<",
    ">api-job<",
    ">api-two<",
    ">web<",
    ">web-job<",
  ];
  const indices = order.map((label) => html.indexOf(label));
  expect(indices.every((index) => index >= 0)).toBe(true);
  expect([...indices].sort((a, b) => a - b)).toEqual(indices);
});

test("only one Next marker across groups, on the soonest enabled automation", () => {
  const html = render([
    automation({ id: "a", repo: "api", nextDueAt: Date.now() + 7_200_000 }),
    automation({ id: "b", repo: "web", nextDueAt: Date.now() + 3_600_000 }),
    automation({ id: "c", repo: "web", enabled: false, nextDueAt: Date.now() + 60_000 }),
  ]);
  expect(html.split(">Next<").length - 1).toBe(1);
  const next = html.indexOf(">Next<");
  expect(next).toBeGreaterThan(html.indexOf(">b<"));
  expect(next).toBeLessThan(html.indexOf(">c<"));
});

test("list rows omit the prompt and link to the automation detail page", () => {
  const html = render([automation({ id: "needs space", prompt: "Secret prompt body" })]);

  expect(html).not.toContain("Secret prompt body");
  expect(html).not.toContain("Show more");
  expect(html).toContain('href="#/automations/needs%20space"');
});

test("last run is one tidy line: status, relative time, origin and time on hover, result link", () => {
  const html = render([
    automation({
      lastRun: lastRun({
        ticketKey: "DEV-42",
        ticketUrl: "https://acme.atlassian.net/browse/DEV-42",
      }),
    }),
  ]);

  expect(html).toContain("succeeded");
  expect(html).toContain("ago");
  expect(html).toContain(RUN_ORIGIN_LABELS.scheduled);
  expect(html).toContain(formatExpected(STARTED_AT));
  expect(html).toContain("DEV-42");
  expect(html).toContain('href="https://acme.atlassian.net/browse/DEV-42"');
});

test("last run without a result renders no empty result placeholder", () => {
  const html = render([automation({ lastRun: lastRun({ ticketKey: undefined }) })]);
  expect(html).not.toContain("ref-link");
});

test("the soonest enabled automation is emphasized and sorted first", () => {
  const html = render([
    automation({ id: "later", nextDueAt: Date.now() + 5 * 86_400_000 }),
    automation({ id: "soon", nextDueAt: Date.now() + 3_600_000 }),
  ]);
  expect(html.indexOf(">soon<")).toBeLessThan(html.indexOf(">later<"));
  expect(html.split(">Next<").length - 1).toBe(1);
});

test("missing schedule, repo, next run, and last run degrade to a dash", () => {
  const html = render([
    automation({ schedule: undefined, repo: undefined, nextDueAt: undefined, lastRun: undefined }),
  ]);

  expect(html).toContain("–");
  expect(html).not.toContain("0 3 * * *");
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
  expect(html).toContain('aria-busy="true"');
});

test("a just-started automation shows a Started confirmation", () => {
  const html = renderToStaticMarkup(
    createElement(AutomationsTable, {
      automations: [automation()],
      busyId: null,
      startedId: "nightly-triage",
      onRunNow: () => {},
      onOpenRun: () => {},
    }),
  );
  expect(html).toContain("Started");
});

test("disabled automations render a hint instead of the Run now action", () => {
  const html = render([automation({ enabled: false })]);

  expect(html).not.toContain("Run now</button>");
  expect(html).not.toContain("Run nightly-triage now");
  expect(html).toContain("Enable this automation in the config to run it manually");
});
