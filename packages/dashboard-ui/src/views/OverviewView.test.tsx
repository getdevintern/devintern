import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  OverviewAlertBanner,
  OverviewScreen,
  queueBreakdown,
  queueParts,
  queueProgress,
} from "@/views/OverviewView";
import type { OverviewResponse, RunRecord, WorkerResponse } from "@/lib/api";

const NOW = new Date(2026, 10, 13, 12, 20, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function overview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    generatedAt: NOW,
    worker: {
      status: "running",
      pid: 4242,
      startedAt: new Date(NOW - 7 * HOUR - 12 * MINUTE).toISOString(),
    },
    config: { status: "ok", path: "/w/workspace.toml" },
    capacity: {
      running: 1,
      maxConcurrency: 4,
      perRepo: [
        { repo: "web", running: 1, maxConcurrency: 2, configured: true },
        { repo: "api", running: 0, maxConcurrency: 2, configured: true },
      ],
      unattributed: 0,
      runs: [
        {
          id: 77,
          origin: "task",
          taskKey: "DEV-9",
          repo: "acme/web",
          workspaceRepo: "web",
          team: "frontend",
          harness: "codex",
          step: "implementation",
          startedAt: NOW - 23 * MINUTE,
        },
      ],
    },
    harnesses: {
      source: "workspace_env",
      entries: [{ name: "codex", priority: 0, known: true, active: true, state: "healthy" }],
      active: "codex",
      allExhausted: false,
      stateAvailable: true,
    },
    trackers: {
      mode: "teams",
      pollIntervalSeconds: 60,
      sources: [
        {
          team: "frontend",
          tracker: "jira",
          repo: "web",
          cursorSource: "jira:frontend",
          lastPolledAt: NOW - 40_000,
        },
      ],
    },
    ...overrides,
  };
}

const queue: WorkerResponse["queue"] = {
  pending: 0,
  processing: 0,
  failed: 0,
  injected: { pending: 0, running: 0 },
  retries: { pending: 0, running: 0 },
};

const workerInfo = {
  worker: { status: "running", pid: 4242 },
  queue,
  agentPrs: { open: 0, closed: 0 },
  schedule: null,
  cursors: [],
  dbPath: "/w/runs.db",
  dbMissing: false,
  queueDbPath: "/w/queue.db",
  queueDbMissing: false,
} satisfies WorkerResponse;

function render(data: OverviewResponse, info: WorkerResponse | null = workerInfo): string {
  return renderToStaticMarkup(
    createElement(OverviewScreen, { overview: data, workerInfo: info, now: NOW }),
  );
}

test("a healthy worker renders calm facts, running work and fresh polls without alerts", () => {
  const html = render(overview());

  expect(html).not.toContain('data-slot="overview-alert"');
  // Liveness and the queue total live in the status strip; the facts add depth.
  expect(html).not.toContain("pid 4242");
  expect(html).toContain("7h 12m");
  expect(html).toContain("No window");
  // An empty queue is the strip's "0 queued"; the band does not repeat it.
  expect(html).not.toContain("Queue mix");
  expect(html).toContain("sm:grid-cols-2");
  // Capacity semantics live in a hint, not an always-on footnote.
  expect(html).not.toContain("<code");
  expect(html).toContain("How capacity is counted");
  // The section is "Active work"; the running run opens its detail page and
  // shows its live step and elapsed time.
  expect(html).toContain("Active work");
  expect(html).not.toContain("Running now");
  expect(html).toContain("Open run 77: DEV-9");
  expect(html).toContain("implementation");
  expect(html).toContain("status-dot-live");
  expect(html).toContain(">23m<");
  expect(html).toContain("web");
  expect(html).toContain('aria-valuetext="1 of 4"');
  // One tab stop per run: the row-wide title button, no table or chevron.
  expect(html).not.toContain("<th");
  expect(html).not.toMatch(/<button[^>]*tabindex="-1"/);
  expect(html).toContain('title="DEV-9"');
  expect(html).toContain("just now");
  expect(html).not.toContain('data-freshness="stale"');
});

test("a stale poll is flagged on its row and raised as a warning", () => {
  const html = render(
    overview({
      trackers: {
        mode: "teams",
        pollIntervalSeconds: 60,
        sources: [
          {
            team: "frontend",
            tracker: "jira",
            cursorSource: "jira:frontend",
            lastPolledAt: NOW - 14 * MINUTE,
          },
        ],
      },
    }),
  );

  expect(html).toContain('data-freshness="stale"');
  expect(html).toContain("Tracker polling has stalled");
  // The source name in the banner is a button that reveals its row.
  expect(html).toMatch(/<button[^>]*>frontend<\/button>/);
  expect(html).toContain('id="ov-tracker-jira-frontend"');
  expect(html).toContain("14m ago");
  expect(html).toContain("expected every 1m");
});

test("an exhausted chain shows the queue-paused banner with its countdown", () => {
  const html = render(
    overview({
      harnesses: {
        source: "workspace_env",
        entries: [
          {
            name: "claude",
            priority: 0,
            known: true,
            active: true,
            state: "limited",
            limitedUntil: NOW + 3 * HOUR,
          },
          {
            name: "codex",
            priority: 1,
            known: true,
            active: false,
            state: "limited",
            limitedUntil: NOW + 2 * HOUR + 10 * MINUTE,
          },
        ],
        active: "claude",
        allExhausted: true,
        resumesAt: NOW + 2 * HOUR + 10 * MINUTE,
        stateAvailable: true,
      },
    }),
  );

  expect(html).toContain("Agent work is paused until");
  expect(html).toContain("in 2h 10m");
  expect(html).toMatch(/<strong[^>]*>codex<\/strong>/);
  expect(html).toContain("data-prominent");
  // Nothing is in use while every harness is limited; codex resumes first.
  expect(html).not.toContain(">in use<");
  expect(html).toContain("resumes first");
  // No queue info: the copy does not claim tickets are waiting.
  expect(html).toContain("New agent work waits");
});

test("unknown harness state is reported honestly", () => {
  const html = render(
    overview({
      harnesses: {
        source: "default",
        entries: [{ name: "claude", priority: 0, known: true, active: false, state: "unknown" }],
        active: null,
        allExhausted: false,
        stateAvailable: false,
      },
    }),
  );

  expect(html).toContain("health is unknown");
  expect(html).toContain("unknown");
  expect(html).not.toContain("healthy");
});

test("a missing config and a stopped worker both surface, with orphaned runs explained", () => {
  const html = render(
    overview({
      worker: { status: "stopped", pid: 99 },
      config: { status: "missing", path: "/w/workspace.toml" },
      capacity: { ...overview().capacity, maxConcurrency: null },
      trackers: { mode: "none", sources: [] },
    }),
  );

  expect(html).toContain("No workspace configuration");
  expect(html).toContain("devintern worker init");
  expect(html).toContain("Worker is not running");
  expect(html).toContain("pid 99");
  expect(html).toContain("stalled · not advancing while the worker is stopped");
  expect(html).toContain("data-stalled");
  // A stopped worker uses no harness.
  expect(html).not.toContain(">in use<");
  // No config: the idle copy must not promise a tracker poll.
  expect(html).not.toContain("next tracker poll");
  expect(html).toContain("limit unknown until workspace.toml loads");
  expect(html).toContain("Copy command");
  expect(html).toContain("Tracker sources appear once workspace.toml loads.");
  // Stalled runs neither pulse nor count up.
  expect(html).not.toContain("status-dot-live");
  expect(html).toContain("23m ago");
});

test("idle capacity collapses to one calm line and repos are summarised", () => {
  const idle = overview({
    capacity: {
      running: 0,
      maxConcurrency: 16,
      perRepo: [
        { repo: "web", running: 0, maxConcurrency: 8, configured: true },
        { repo: "api", running: 0, maxConcurrency: 8, configured: true },
      ],
      unattributed: 0,
      runs: [],
    },
  });
  const html = render(idle);

  expect(html).toContain("Idle");
  expect(html).toContain("0 of 16 slots in use");
  expect(html).toContain("2 repos idle");
  expect(html).not.toContain('role="meter"');
});

test("a repo at its cap is marked at capacity", () => {
  const html = render(
    overview({
      capacity: {
        ...overview().capacity,
        perRepo: [{ repo: "web", running: 2, maxConcurrency: 2, configured: true }],
      },
    }),
  );

  expect(html).toContain("at capacity");
});

test("queued work makes the paused banner say tickets wait", () => {
  const html = renderToStaticMarkup(
    createElement(OverviewAlertBanner, {
      alert: { kind: "harnesses-exhausted", resumesAt: NOW + HOUR, resumesWith: "codex" },
      now: NOW,
      queued: 3,
    }),
  );

  expect(html).toContain("3 queued tasks wait");
});

test("the queue fact lists only the non-empty parts", () => {
  expect(queueBreakdown(queue)).toBe("nothing waiting");
  expect(queueBreakdown({ ...queue, pending: 2, retries: { pending: 1, running: 0 } })).toBe(
    "2 webhook · 1 retry",
  );
});

test("the queue progress says whether queued work has started, not the total", () => {
  expect(queueProgress({ ...queue, pending: 3 })).toBe("none picked up yet");
  expect(queueProgress({ ...queue, processing: 1, injected: { pending: 2, running: 0 } })).toBe(
    "1 picked up",
  );
});

test("idle copy follows how work can reach the worker", () => {
  const noTrackers = render(
    overview({
      capacity: { running: 0, maxConcurrency: 4, perRepo: [], unattributed: 0, runs: [] },
      trackers: { mode: "none", sources: [] },
    }),
  );
  expect(noTrackers).toContain("new work starts when a task is queued");
});

test("idle copy waits for a closed working window instead of promising the next poll", () => {
  const html = render(
    overview({
      capacity: { running: 0, maxConcurrency: 4, perRepo: [], unattributed: 0, runs: [] },
    }),
    {
      ...workerInfo,
      schedule: {
        enabled: true,
        pickupAllowed: false,
        active: ["09:00-19:00"],
        blocked: [],
        timezone: "UTC",
        catchUpMissed: false,
        manualRequested: false,
        nextChange: { at: Date.now() + 3_600_000, kind: "open" },
      },
    },
  );
  expect(html).toContain("new work starts when the window opens at");
  expect(html).not.toContain("next tracker poll");
});

test("a long custom step is capped to its cell with the full name in the tooltip", () => {
  const step = "custom-pipeline: run browser smoke tests";
  const base = overview();
  const [run] = base.capacity.runs;
  const html = render(
    overview({ capacity: { ...base.capacity, runs: run ? [{ ...run, step }] : [] } }),
  );

  // The detail line truncates in CSS and keeps the full name in its tooltip.
  expect(html).toContain(`<span class="aw-detail" title="${step}">${step}</span>`);
});

const activityRun: RunRecord = {
  id: 77,
  origin: "task",
  taskKey: "DEV-9",
  taskTitle: "Fix the login",
  repo: "acme/web",
  harness: "codex",
  status: "in_progress",
  startedAt: NOW - 23 * MINUTE,
  step: "implement",
  stepStartedAt: NOW - 3 * MINUTE,
  stepActive: true,
};

function renderWork(
  activityRuns: RunRecord[],
  data: OverviewResponse = overview(),
  info: WorkerResponse | null = workerInfo,
): string {
  return renderToStaticMarkup(
    createElement(OverviewScreen, { overview: data, workerInfo: info, activityRuns, now: NOW }),
  );
}

test("active rows show title, phase track, exact step and elapsed time", () => {
  const html = renderWork([activityRun]);
  expect(html).toContain("Fix the login");
  expect(html).toContain("Open run 77: Fix the login");
  expect(html).toContain("Implementing");
  expect(html).toContain("Phase 3 of 5: Implementing");
  expect(html).toContain("3/5");
  expect(html).toContain("Implementation · 3m");
  expect(html).toContain(">23m<");
  expect(html).toContain("status-dot-live");
  // Nothing waiting or finished: neither sub-list renders.
  expect(html).not.toContain("Waiting to retry");
  expect(html).not.toContain("Recently finished");
});

test("between steps the dot stops pulsing and the detail says so", () => {
  const html = renderWork([{ ...activityRun, step: "verify", stepActive: false }]);
  expect(html).toContain("Between steps, after verify");
  expect(html).not.toContain("status-dot-live");
});

test("stalled rows neither pulse nor count up, and say why", () => {
  const stopped = renderWork([activityRun], overview({ worker: { status: "stopped", pid: 99 } }));
  expect(stopped).not.toContain("status-dot-live");
  expect(stopped).toContain("data-stalled");
  expect(stopped).toContain("Implementing · not advancing while the worker is stopped");
  expect(stopped).toContain("Holding at implementation");
  expect(stopped).toContain("23m ago");
  expect(stopped).not.toContain("text-info");

  const base = overview();
  const paused = renderWork(
    [activityRun],
    overview({ harnesses: { ...base.harnesses, allExhausted: true } }),
  );
  expect(paused).not.toContain("status-dot-live");
  expect(paused).toContain("not advancing while agent work is paused");
});

test("waiting tasks get their own sub-list with the reason", () => {
  const html = renderWork([
    activityRun,
    {
      ...activityRun,
      id: 80,
      taskKey: "DEV-12",
      status: "deferred",
      finishedAt: NOW - HOUR,
      outcomeReason: "Agent usage limit reached",
    },
  ]);
  expect(html).toContain("Waiting to retry");
  expect(html).toContain("Agent usage limit reached");
  expect(html).toContain("Stopped at implementation");
  expect(html).toContain("1h ago");
});

test("finished tasks sit in a closed disclosure with a link to all runs", () => {
  const html = renderWork([
    {
      ...activityRun,
      id: 60,
      taskKey: "DEV-1",
      status: "succeeded",
      finishedAt: NOW - HOUR,
      taskTitle: "---",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
    },
    {
      ...activityRun,
      id: 61,
      taskKey: "DEV-2",
      status: "failed",
      finishedAt: NOW - 2 * HOUR,
      outcomeReason: "Verification failed",
    },
  ]);
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(html).toContain("Recently finished");
  expect(html).toContain("View all runs");
  expect(html).toContain('href="#/runs"');
  expect(html).toContain("#42");
  expect(html).toContain("Verification failed");
  expect(html).not.toContain(">---<");
});

test("idle with history keeps the calm line and a closed finished list", () => {
  const html = renderWork(
    [{ ...activityRun, status: "succeeded", finishedAt: NOW - HOUR }],
    overview({
      capacity: { running: 0, maxConcurrency: 4, perRepo: [], unattributed: 0, runs: [] },
    }),
  );
  expect(html).toContain("Idle");
  expect(html).toContain("0 of 4 slots in use");
  expect(html).toContain("Recently finished");
  expect(html).not.toContain('aria-label="Runs in progress"');
});

test("without a config the window is unknown, not around the clock", () => {
  const html = render(overview({ config: { status: "missing", path: "/w/workspace.toml" } }));

  expect(html).toContain("set in workspace.toml");
  expect(html).not.toContain("around the clock");
});

test("a non-empty queue shows its mix without repeating the total", () => {
  const html = render(overview(), { ...workerInfo, queue: { ...queue, pending: 2 } });

  expect(html).toContain("Queue mix");
  expect(html).toContain("2 webhook");
  expect(html).toContain("none picked up yet");
});

test("the capacity hint is a focusable button, not a title-only image", () => {
  const html = render(overview());

  expect(html).toMatch(/<button[^>]*aria-label="How capacity is counted"/);
  expect(html).not.toContain('role="img"');
});

test("the queue fact keeps each count with its label", () => {
  expect(queueParts({ ...queue, pending: 2, retries: { pending: 1, running: 0 } })).toEqual([
    "2 webhook",
    "1 retry",
  ]);
});
