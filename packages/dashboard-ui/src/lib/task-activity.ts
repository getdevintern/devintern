import type { RunRecord } from "@/lib/api";
import { groupRunAttempts } from "@/lib/run-groups";
import type { RunGroup } from "@/lib/run-groups";

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
 * or an honest "between steps" when nothing is executing right now.
 */
export function stepDetail(run: RunRecord, now = Date.now()): string {
  if (!run.step) return "Step not recorded";
  const label = stepLabel(run.step);
  if (!run.stepActive) return `Between steps, after ${label.toLowerCase()}`;
  return `${label} · ${formatClock(now - (run.stepStartedAt ?? now))}`;
}

/** Live clock for a running step: `42s`, `3m 05s`, `1h 02m`. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * A deferred task only counts as waiting while its retry is plausibly still
 * due. Scheduled occurrences are never retried: the next occurrence replaces
 * them, so they go straight to history.
 */
export const WAITING_WINDOW_MS = 48 * 60 * 60 * 1000;
export const FINISHED_LIMIT = 8;

/** One task (attempts folded) shown in a list row. */
export interface TaskEntry {
  key: string;
  latest: RunRecord;
  /** Attempts at this task on the page, including the latest. */
  attempts: number;
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
