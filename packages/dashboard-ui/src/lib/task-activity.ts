import type { OverviewRunningRun, RunRecord } from "@/lib/api";
import { groupRunAttempts, runGroupKey } from "@/lib/run-groups";
import type { RunGroup } from "@/lib/run-groups";
import { formatSpan } from "@/lib/utils";

/** The few stages a task passes through while it is not yet completed. */
export const PHASES = [
  "preparing",
  "assessing",
  "implementing",
  "reviewing",
  "publishing",
] as const;
export type Phase = (typeof PHASES)[number];

/** Phase for steps outside the default pipeline (plugins, older runs). */
export type PhaseOrOther = Phase | "working";

export const PHASE_LABELS: Record<PhaseOrOther, string> = {
  preparing: "Preparing",
  assessing: "Assessing",
  implementing: "Implementing",
  reviewing: "Reviewing",
  publishing: "Publishing",
  working: "Working",
};

const STEP_LABELS: Record<string, string> = {
  "prepare-branch": "Prepare branch",
  "prepare-prompt": "Prepare prompt",
  "in-progress": "Update tracker",
  clarity: "Clarity check",
  feasibility: "Feasibility",
  implement: "Implementation",
  commit: "Commit",
  verify: "Verify",
  repair: "Repair",
  finalize: "Finalize",
  "auto-review": "Auto-review",
  publish: "Publish",
};

const STEP_PHASES: Record<string, Phase> = {
  "prepare-branch": "preparing",
  "prepare-prompt": "preparing",
  "in-progress": "preparing",
  clarity: "preparing",
  feasibility: "assessing",
  implement: "implementing",
  commit: "implementing",
  verify: "implementing",
  repair: "implementing",
  finalize: "implementing",
  "auto-review": "reviewing",
  publish: "publishing",
};

/** The verify-repair loop records `repair` or `__repair-N`. */
function repairRound(step: string): string | undefined {
  return /^_*repair-(\d+)$/.exec(step)?.[1];
}

export function stepLabel(step: string): string {
  const round = repairRound(step);
  if (round) return `Repair ${round}`;
  return STEP_LABELS[step] ?? step;
}

/** Phase a raw pipeline step belongs to; unknown steps stay neutral. */
export function stepPhase(step: string | undefined): PhaseOrOther {
  if (!step) return "working";
  return STEP_PHASES[repairRound(step) ? "repair" : step] ?? "working";
}

/** Zero-based position of the run's phase in the default pipeline, or -1. */
export function phaseIndex(step: string | undefined): number {
  const phase = stepPhase(step);
  return phase === "working" ? -1 : PHASES.indexOf(phase);
}

/**
 * One-line detail under the phase: the exact step, with how long it has run,
 * or an honest "between steps" when nothing is executing right now. A stalled
 * run (worker stopped, agents paused) names its step without a running clock.
 */
export function stepDetail(run: RunRecord, now = Date.now(), stalled = false): string {
  if (!run.step) return "Step not recorded";
  const label = stepLabel(run.step);
  if (stalled) return `Holding at ${label.toLowerCase()}`;
  if (!run.stepActive) return `Between steps, after ${label.toLowerCase()}`;
  if (run.stepStartedAt === undefined) return label;
  return `${label} · ${formatSpan(now - run.stepStartedAt)}`;
}

/**
 * A deferred task only counts as waiting while its retry is plausibly still
 * due. Scheduled occurrences are never retried: the next occurrence replaces
 * them, so they go straight to history.
 */
export const WAITING_WINDOW_MS = 48 * 60 * 60 * 1000;
export const FINISHED_LIMIT = 5;

/** One task (attempts folded) shown in a list row. */
export interface TaskEntry {
  key: string;
  latest: RunRecord;
  /** Attempts at this task on the page, including the latest. */
  attempts: number;
  /** Workspace repo the run was attributed to, shown instead of the raw repo. */
  repoLabel?: string;
}

export interface TaskActivity {
  active: TaskEntry[];
  waiting: TaskEntry[];
  finished: TaskEntry[];
  /** Finished tasks beyond `FINISHED_LIMIT`. */
  finishedHidden: number;
}

function toEntry(group: RunGroup): TaskEntry {
  const latestAttempt = group.latest.attempt ?? 0;
  return {
    key: group.key,
    latest: group.latest,
    attempts: Math.max(group.earlier.length + 1, latestAttempt),
  };
}

/** Bucket the API's runs by task: working now, waiting to retry, or finished. */
export function buildTaskActivity(runs: RunRecord[], now = Date.now()): TaskActivity {
  // The API lists unfinished runs before history; folding needs newest first.
  const newestFirst = [...runs].sort((a, b) => b.startedAt - a.startedAt || b.id - a.id);
  const active: TaskEntry[] = [];
  const waiting: TaskEntry[] = [];
  const finished: TaskEntry[] = [];
  for (const group of groupRunAttempts(newestFirst)) {
    const entry = toEntry(group);
    const { status, finishedAt, startedAt } = group.latest;
    if (status === "in_progress") active.push(entry);
    else if (
      status === "deferred" &&
      group.latest.origin !== "scheduled" &&
      now - (finishedAt ?? startedAt) <= WAITING_WINDOW_MS
    ) {
      waiting.push(entry);
    } else finished.push(entry);
  }
  // Longest-running first, so the task needing attention sits on top.
  active.sort((a, b) => a.latest.startedAt - b.latest.startedAt);
  const settledAt = (entry: TaskEntry) => entry.latest.finishedAt ?? entry.latest.startedAt;
  waiting.sort((a, b) => settledAt(b) - settledAt(a));
  finished.sort((a, b) => settledAt(b) - settledAt(a));
  return {
    active,
    waiting,
    finished: finished.slice(0, FINISHED_LIMIT),
    finishedHidden: Math.max(0, finished.length - FINISHED_LIMIT),
  };
}

/** Tooltip/aria text for the phase track: the current phase among all of them. */
export function phaseTrackLabel(step: string | undefined): string {
  const index = phaseIndex(step);
  if (index < 0) return "";
  const names = PHASES.map((name, position) =>
    position === index ? `[${PHASE_LABELS[name]}]` : PHASE_LABELS[name],
  );
  return `Phase ${index + 1} of ${PHASES.length}: ${PHASE_LABELS[PHASES[index]!]}. ${names.join(" › ")}`;
}

/** Task title, hiding frontmatter fences older backends leak as the title. */
export function cleanTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  return trimmed && !/^-{3,}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Overview's active work. Which runs are in progress (and so how many) comes
 * from the `/api/overview` capacity snapshot, the same one behind the meter
 * and the per-repo counts, so the rows never disagree with the count. The
 * `/api/task-activity` snapshot only enriches those rows (title, step timing,
 * attempts) and supplies the waiting and finished lists. The two polls can be
 * a few seconds apart: a run capacity still counts is never also listed as
 * finished, and a run only task activity has started yet waits for the next
 * overview poll.
 */
export function buildActiveWork(
  running: OverviewRunningRun[],
  runs: RunRecord[],
  now = Date.now(),
): TaskActivity {
  const runningIds = new Set(running.map((run) => run.id));
  const byId = new Map(runs.map((run) => [run.id, run]));
  const history = buildTaskActivity(
    runs.map((run) => (runningIds.has(run.id) ? { ...run, status: "in_progress" as const } : run)),
    now,
  );
  const active = [...running]
    .sort((a, b) => a.startedAt - b.startedAt || a.id - b.id)
    .map((run): TaskEntry => {
      const record = byId.get(run.id);
      const latest: RunRecord = {
        ...record,
        id: run.id,
        origin: run.origin,
        taskKey: run.taskKey,
        repo: run.repo,
        harness: run.harness,
        // The step's timing travels with the record's step; keep the pair together.
        step: record ? record.step : run.step,
        status: "in_progress",
        startedAt: run.startedAt,
      };
      // Without its task-activity record the step timing is unknown, not zero.
      if (!record) latest.stepActive = true;
      const key = runGroupKey(latest);
      const earlier = runs.filter(
        (other) =>
          other.id !== run.id && other.startedAt <= run.startedAt && runGroupKey(other) === key,
      ).length;
      return {
        key: `run:${run.id}`,
        latest,
        attempts: Math.max(earlier + 1, latest.attempt ?? 0),
        repoLabel: run.workspaceRepo ?? run.repo,
      };
    });
  return { ...history, active };
}
