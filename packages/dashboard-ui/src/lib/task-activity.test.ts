import { expect, test } from "bun:test";

import type { OverviewRunningRun, RunRecord } from "@/lib/api";
import {
  FINISHED_LIMIT,
  buildActiveWork,
  buildTaskActivity,
  cleanTitle,
  phaseIndex,
  stepDetail,
  stepLabel,
  stepPhase,
} from "@/lib/task-activity";

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
  // Durations use the dashboard's shared compact span.
  expect(stepDetail(run, NOW)).toBe("Implementation · 3m");
  expect(stepDetail({ ...run, stepStartedAt: NOW - 42_000 }, NOW)).toBe("Implementation · 42s");
  expect(stepDetail({ ...run, step: "verify", stepActive: false }, NOW)).toBe(
    "Between steps, after verify",
  );
  expect(stepDetail({ ...run, step: undefined }, NOW)).toBe("Step not recorded");
  // Unknown step timing is not a zero clock.
  expect(stepDetail({ ...run, stepStartedAt: undefined }, NOW)).toBe("Implementation");
});

test("a stalled run names its step without a running clock", () => {
  expect(stepDetail(run, NOW, true)).toBe("Holding at implementation");
  expect(stepDetail({ ...run, step: undefined }, NOW, true)).toBe("Step not recorded");
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

const done = (id: number, ago: number, extra: Partial<RunRecord> = {}): RunRecord => ({
  ...run,
  id,
  taskKey: `T-${id}`,
  status: "succeeded",
  startedAt: NOW - ago - MIN,
  finishedAt: NOW - ago,
  ...extra,
});

test("finished tasks are newest first and capped to a few", () => {
  const { finished } = buildTaskActivity([done(1, 13 * HOUR), done(2, 12 * HOUR)], NOW);
  expect(finished.map((entry) => entry.latest.id)).toEqual([2, 1]);
  const many = Array.from({ length: FINISHED_LIMIT + 3 }, (_, i) => done(i + 10, (i + 1) * HOUR));
  const capped = buildTaskActivity(many, NOW);
  expect(FINISHED_LIMIT).toBe(5);
  expect(capped.finished).toHaveLength(FINISHED_LIMIT);
  expect(capped.finishedHidden).toBe(3);
});

const capacityRun = (overrides: Partial<OverviewRunningRun> = {}): OverviewRunningRun => ({
  id: 1,
  origin: "task",
  taskKey: "TASK-1",
  repo: "acme/web",
  workspaceRepo: "web",
  harness: "claude-code",
  step: "implement",
  startedAt: NOW - 10 * MIN,
  ...overrides,
});

test("active work rows are the overview's running runs, enriched by task activity", () => {
  const work = buildActiveWork(
    [capacityRun({ id: 4, taskKey: "T-4", startedAt: NOW - 2 * MIN }), capacityRun()],
    [run, { ...run, id: 3, taskKey: "T-3" }],
    NOW,
  );
  // Membership and order come from capacity (longest-running first).
  expect(work.active.map((entry) => entry.latest.id)).toEqual([1, 4]);
  const [first, second] = work.active;
  expect(first!.latest.taskTitle).toBe("Fix the login");
  expect(first!.latest.stepStartedAt).toBe(NOW - 3 * MIN);
  expect(first!.repoLabel).toBe("web");
  // No task-activity record yet: the step still shows, without a zero clock.
  expect(second!.latest.taskTitle).toBeUndefined();
  expect(stepDetail(second!.latest, NOW)).toBe("Implementation");
  // An in-progress run capacity does not count is not shown at all yet.
  expect(work.active.some((entry) => entry.latest.id === 3)).toBe(false);
  expect(work.finished).toHaveLength(0);
});

test("a run capacity still counts is never also listed as finished or waiting", () => {
  const work = buildActiveWork(
    [capacityRun()],
    [
      { ...run, status: "succeeded", finishedAt: NOW - 5_000 },
      done(2, HOUR),
      { ...done(3, HOUR), status: "deferred" },
    ],
    NOW,
  );
  expect(work.active.map((entry) => entry.latest.id)).toEqual([1]);
  expect(work.active[0]!.latest.status).toBe("in_progress");
  expect(work.finished.map((entry) => entry.latest.id)).toEqual([2]);
  expect(work.waiting.map((entry) => entry.latest.id)).toEqual([3]);
});

test("active rows count earlier attempts at the same task", () => {
  const work = buildActiveWork(
    [capacityRun({ id: 9 })],
    [
      { ...run, id: 9 },
      { ...run, id: 7, status: "failed", startedAt: NOW - 3 * HOUR, finishedAt: NOW - 2 * HOUR },
    ],
    NOW,
  );
  expect(work.active[0]!.attempts).toBe(2);
  // The failed earlier attempt folds into the running task, not "finished".
  expect(work.finished).toHaveLength(0);
});
