/**
 * Labels and wording for a non-successful run's outcome class, failing
 * stage, cause, and work status (see `RunOutcomeClass` in `api.ts`).
 */

import type { RunOutcomeClass, RunRecord } from "@/lib/api";

export const OUTCOME_CLASSES: readonly RunOutcomeClass[] = [
  "internal",
  "environment",
  "agent",
  "review_hold",
];

export interface OutcomeClassMeta {
  /** Short badge label. */
  label: string;
  /** One line for the run-detail banner: what it means and what to do. */
  description: string;
}

export const OUTCOME_CLASS_META: Record<RunOutcomeClass, OutcomeClassMeta> = {
  review_hold: {
    label: "Waiting on review",
    description:
      "A review or auto-merge rule wants a human to approve this. Nothing is broken: review the PR and merge or close it.",
  },
  agent: {
    label: "Agent stopped",
    description:
      "The agent could not complete the task. Clarify the ticket or fix the blocker, then retry.",
  },
  internal: {
    label: "DevIntern problem",
    description:
      "A DevIntern step failed, not the agent's work. Retry the run; if it keeps failing, report the problem.",
  },
  environment: {
    label: "Environment",
    description:
      "Credentials, network, a rate limit, or a missing tool stopped the run. Fix the setup, then retry.",
  },
};

/** `verify: remote branch … not found`, falling back to the outcome reason. */
export function runCause(
  run: Pick<RunRecord, "failureStage" | "failureCause" | "outcomeReason">,
): string | undefined {
  if (run.failureCause) {
    return run.failureStage ? `${run.failureStage}: ${run.failureCause}` : run.failureCause;
  }
  return run.outcomeReason;
}

/** Whether a run finished in a way that has an outcome class to show. */
export function isUnsuccessfulRun(run: Pick<RunRecord, "status">): boolean {
  return run.status === "failed" || run.status === "escalated" || run.status === "abandoned";
}

/** One sentence for where the work went, or undefined when unknown. */
export function workStatusText(run: Pick<RunRecord, "workStatus" | "workRef">): string | undefined {
  switch (run.workStatus) {
    case "saved":
      return run.workRef ? `Work saved on branch ${run.workRef}` : "Work saved to its branch";
    case "kept":
      return run.workRef ? `Work kept in worktree ${run.workRef}` : "Work kept in its worktree";
    case "discarded":
      return "Work discarded";
    case "none":
      return "No unsaved work";
    default:
      return undefined;
  }
}

/**
 * Web URL of a saved branch, when the run's host can be told: from a GitHub
 * PR URL, or a GitHub `owner/repo` slug. Workspace repo names (no slash)
 * have no known host, so the branch shows as text.
 */
export function runBranchHref(
  run: Pick<RunRecord, "prUrl" | "repo">,
  branch: string,
): string | undefined {
  const fromPr = run.prUrl?.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/);
  const base =
    fromPr?.[1] ??
    (run.repo && /^[\w.-]+\/[\w.-]+$/.test(run.repo)
      ? `https://github.com/${run.repo}`
      : undefined);
  return base ? `${base}/tree/${branch.split("/").map(encodeURIComponent).join("/")}` : undefined;
}
