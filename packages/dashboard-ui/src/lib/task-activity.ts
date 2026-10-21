import type { RunRecord } from "@/lib/api";

const STEP_LABELS: Record<string, string> = {
  "prepare-branch": "Prepare branch",
  "prepare-prompt": "Prepare prompt",
  "in-progress": "Update tracker",
  feasibility: "Feasibility",
  implement: "Implementation",
  commit: "Commit",
  "auto-review": "Auto-review",
  publish: "Publish",
};

export function stepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
}

/** Preserve custom step identities rather than squeezing them into a guessed pipeline. */
export function activityLane(run: RunRecord): string {
  return run.step ?? "unknown";
}

export function activityDescription(run: RunRecord, now = Date.now()): string {
  if (!run.step) return "Step unavailable for this run";
  if (run.status !== "in_progress") return `Last recorded step: ${stepLabel(run.step)}`;
  if (!run.stepActive) return `Between steps · last: ${stepLabel(run.step)}`;
  const seconds = Math.max(0, Math.floor((now - (run.stepStartedAt ?? now)) / 1000));
  return `Running ${stepLabel(run.step)} · ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const DEFAULT_LANES = ["feasibility", "implement", "auto-review", "publish"];

export function activityLanes(runs: RunRecord[]): string[] {
  const order = [
    "prepare-branch",
    "prepare-prompt",
    "feasibility",
    "in-progress",
    "implement",
    "commit",
    "auto-review",
    "publish",
  ];
  const present = new Set([...DEFAULT_LANES, ...runs.map(activityLane)]);
  return [
    ...order.filter((step) => present.has(step)),
    ...[...present].filter((step) => !order.includes(step) && step !== "unknown").sort(),
    ...(present.has("unknown") ? ["unknown"] : []),
  ];
}
