import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RunRecord, WorkerResponse } from "@/lib/api";
import {
  buildTaskActivity,
  cleanTitle,
  phaseIndex,
  stepDetail,
  stepLabel,
  stepPhase,
} from "@/lib/task-activity";
import { TaskActivityList } from "@/views/TaskActivityView";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const run: RunRecord = {
  id: 1,
  origin: "task",
  taskKey: "TASK-1",
  taskTitle: "Fix the login",
  repo: "acme/web",
  harness: "claude-code",
  status: "in_progress",
  startedAt: NOW - 10 * MIN,
  step: "implement",
  stepStartedAt: NOW - 3 * MIN,
  stepActive: true,
};

test("raw pipeline steps collapse into a few phases", () => {
  expect(stepPhase("prepare-branch")).toBe("preparing");
  expect(stepPhase("clarity")).toBe("preparing");
  expect(stepPhase("feasibility")).toBe("assessing");
  for (const step of ["implement", "commit", "verify", "repair", "__repair-2", "finalize"]) {
    expect(stepPhase(step)).toBe("implementing");
  }
  expect(stepPhase("auto-review")).toBe("reviewing");
  expect(stepPhase("publish")).toBe("publishing");
  expect(stepPhase("security-audit")).toBe("working");
  expect(stepPhase(undefined)).toBe("working");
  expect(phaseIndex("publish")).toBe(4);
  expect(phaseIndex("security-audit")).toBe(-1);
});

test("step detail names the exact step, or admits the gap between steps", () => {
  expect(stepLabel("__repair-1")).toBe("Repair 1");
  expect(stepLabel("security-audit")).toBe("security-audit");
  expect(stepDetail(run, NOW)).toBe("Implementation · 3m 00s");
  expect(stepDetail({ ...run, step: "verify", stepActive: false }, NOW)).toBe(
    "Between steps, after verify",
  );
  expect(stepDetail({ ...run, step: undefined }, NOW)).toBe("Step not recorded");
});

test("attempts fold into one task and finished work leaves the active list", () => {
  const runs: RunRecord[] = [
    { ...run, id: 5, status: "failed", startedAt: NOW - 5 * HOUR, finishedAt: NOW - 4 * HOUR },
    { ...run, id: 9, attempt: 3 },
    { ...run, id: 7, status: "failed", startedAt: NOW - 3 * HOUR, finishedAt: NOW - 2 * HOUR },
    { ...run, id: 2, taskKey: "TASK-2", status: "succeeded", finishedAt: NOW - HOUR },
  ];
  const activity = buildTaskActivity(runs, NOW);
  expect(activity.active.map((entry) => entry.latest.id)).toEqual([9]);
  expect(activity.active[0]!.attempts).toBe(3);
  expect(activity.finished.map((entry) => entry.latest.id)).toEqual([2]);
});

test("only recently deferred tasks count as waiting", () => {
  const deferred = (id: number, ago: number): RunRecord => ({
    ...run,
    id,
    taskKey: `T-${id}`,
    status: "deferred",
    startedAt: NOW - ago - MIN,
    finishedAt: NOW - ago,
  });
  const scheduled = { ...deferred(3, HOUR), origin: "scheduled" as const };
  const activity = buildTaskActivity(
    [deferred(1, HOUR), deferred(2, 30 * 24 * HOUR), scheduled],
    NOW,
  );
  expect(activity.waiting.map((entry) => entry.latest.id)).toEqual([1]);
  expect(activity.finished.map((entry) => entry.latest.id).sort()).toEqual([2, 3]);
});

test("a frontmatter fence is never shown as a title", () => {
  expect(cleanTitle("---")).toBeUndefined();
  expect(cleanTitle("  Fix it ")).toBe("Fix it");
});

const worker = (overrides: Partial<WorkerResponse["queue"]> = {}) =>
  ({
    worker: { status: "running" },
    queue: {
      pending: 0,
      processing: 0,
      failed: 0,
      injected: { pending: 1, running: 0 },
      retries: { pending: 0, running: 0 },
      ...overrides,
    },
  }) as WorkerResponse;

function render(runs: RunRecord[], w?: WorkerResponse) {
  return renderToStaticMarkup(
    createElement(TaskActivityList, {
      activity: buildTaskActivity(runs, NOW),
      worker: w,
      now: NOW,
      onOpenRun: () => {},
    }),
  );
}

test("rows show phase, exact step, title and live elapsed time", () => {
  const html = render(
    [run, { ...run, id: 2, taskKey: "T-2", step: "verify", stepActive: false }],
    worker(),
  );
  expect(html).toContain("In progress");
  expect(html).toContain("Implementing");
  expect(html).toContain("Implementation · 3m 00s");
  expect(html).toContain("Between steps, after verify");
  expect(html).toContain("10m 00s");
  expect(html).toContain("Fix the login");
  expect(html).toContain("Open run 1: Fix the login");
  expect(html).not.toContain("Waiting to retry");
});

test("waiting tasks give the reason; idle state reports the queue", () => {
  const html = render(
    [
      {
        ...run,
        status: "deferred",
        finishedAt: NOW - HOUR,
        outcomeReason: "Agent usage limit reached",
      },
    ],
    worker(),
  );
  expect(html).toContain("Waiting to retry");
  expect(html).toContain("Agent usage limit reached");
  expect(html).toContain("Stopped at implementation");
  const idle = render([], worker());
  expect(idle).toContain("Worker is idle");
  expect(idle).toContain("1 task is queued");
  expect(render([], { ...worker(), worker: { status: "stopped" } })).toContain(
    "Worker is not running",
  );
});

test("finished tasks sit in a closed disclosure with a link to all runs", () => {
  const html = render([{ ...run, status: "succeeded", finishedAt: NOW - HOUR, taskTitle: "---" }]);
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(html).toContain("Recently finished");
  expect(html).toContain('href="#/"');
  expect(html).not.toContain(">---<");
});

test("finished tasks are newest first and succeeded rows link their result", () => {
  const done = (id: number, ago: number, extra: Partial<RunRecord> = {}): RunRecord => ({
    ...run,
    id,
    taskKey: `T-${id}`,
    status: "succeeded",
    startedAt: NOW - ago - MIN,
    finishedAt: NOW - ago,
    ...extra,
  });
  const { finished } = buildTaskActivity([done(1, 13 * HOUR), done(2, 12 * HOUR)], NOW);
  expect(finished.map((entry) => entry.latest.id)).toEqual([2, 1]);
  const html = render([
    done(3, HOUR, { prNumber: 42, prUrl: "https://github.com/acme/web/pull/42" }),
    done(4, 2 * HOUR, { status: "failed", outcomeReason: "Verification failed" }),
  ]);
  expect(html).toContain("#42");
  expect(html).toContain("Verification failed");
  expect(html).toContain("View all runs");
});

test("the phase track is described for assistive tech and hover", () => {
  const html = render([run]);
  expect(html).toContain("Phase 3 of 5: Implementing");
  expect(html).toContain("3/5");
});
