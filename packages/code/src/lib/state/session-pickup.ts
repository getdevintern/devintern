/**
 * Session pickup
 *
 * On worker restart or a dashboard retry, in-flight work used to be redone from
 * scratch. The run store already records the branch a run worked on and the
 * agent's own implementation report; this module reconstructs that state and
 * decides whether a re-run can inherit it ("resume") or must start over
 * ("fresh").
 *
 * A pickup is inheritance: the prior attempt already paid for reading the code,
 * cloning the worktree, and producing changes. Resuming reuses its branch and
 * hands the prior report to the next agent so it continues instead of
 * re-deriving. Incomplete state (no branch, no report, or a branch that no
 * longer exists) always falls back to a fresh run.
 *
 * Every read is best-effort: a storage or parse error degrades to "fresh", the
 * safe default.
 */

import type { RunRecord, RunStatus, RunStore } from "./run-recorder";

/** Terminal statuses whose runs are candidates for pickup. */
export const PICKUP_STATUSES: readonly RunStatus[] = ["failed", "escalated", "abandoned"];

/** Run statuses that qualify a run as a pickup candidate. */
export type PickupRunStatus = "failed" | "escalated" | "abandoned";

/** Reconstructed state from a prior, interrupted run. */
export interface SessionPickup {
  runId: number;
  taskKey: string;
  /** Terminal status the prior run ended in. */
  status: PickupRunStatus;
  /** Feature branch the prior run created or resumed. */
  branch: string;
  /** Attempt number of the prior run (1-based), when recorded. */
  attempt?: number;
  /** The agent's own implementation report from the prior run. */
  report?: string;
  /** Best-effort description of changes already landed on the branch. */
  landed?: string;
  /** PR the prior run created, when one was recorded. */
  prUrl?: string;
  /** Why the prior run stopped (its recorded outcome reason). */
  outcomeReason?: string;
  repo?: string;
  team?: string;
}

/** Resume the recorded session, or start fresh because state is incomplete. */
export type SessionPickupDecision =
  | { kind: "resume"; session: SessionPickup }
  | { kind: "fresh"; reason: string };

/** Run-store slice the resolver reads. */
export type SessionPickupRunStore = Pick<RunStore, "getRun" | "listRuns" | "listStages">;

export interface SessionPickupOptions {
  runStore: SessionPickupRunStore;
  taskKey: string;
  /** Prefer this specific run (e.g. the run a dashboard retry targeted). */
  runId?: number;
  /**
   * Optional existence probe for the recorded branch. When it resolves false,
   * the resolver falls back to a fresh run. Absent → trust the record.
   */
  branchExists?: (branch: string) => boolean | Promise<boolean>;
  /** Optional description of already-landed work (git log/diff). Never fatal. */
  describeLanded?: (session: {
    branch: string;
    run: RunRecord;
  }) => string | undefined | Promise<string | undefined>;
}

/** Whether a run status can be picked up. */
export function isPickupStatus(status: RunStatus): status is PickupRunStatus {
  return (PICKUP_STATUSES as readonly RunStatus[]).includes(status);
}

/**
 * Extract the implementation report a run recorded, if any.
 *
 * The pipeline stores the agent's `implementation-summary[-incomplete].md` as a
 * JSON `detail.report` on the `implementation` stage; the most recent such
 * stage wins. Malformed or truncated detail reads as "no report".
 */
export function readImplementationReport(
  runStore: SessionPickupRunStore,
  runId: number,
): string | undefined {
  let stages: ReturnType<SessionPickupRunStore["listStages"]>;
  try {
    stages = runStore.listStages(runId);
  } catch {
    return undefined;
  }
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    const stage = stages[i];
    if (stage.stage !== "implementation" || !stage.detail) {
      continue;
    }
    try {
      const detail = JSON.parse(stage.detail) as { report?: unknown };
      if (typeof detail.report === "string" && detail.report.trim()) {
        return detail.report;
      }
    } catch {
      // Truncated or non-JSON detail: treat as missing.
    }
  }
  return undefined;
}

/**
 * The run to pick up: the explicitly requested one, else the task's latest
 * attempt. Only the latest run's state is authoritative — a successful or
 * deferred run that followed a failure means the task moved on, so an older
 * failed run is never resumed.
 */
function findCandidateRun(
  runStore: SessionPickupRunStore,
  taskKey: string,
  runId?: number,
): RunRecord | undefined {
  if (runId !== undefined) {
    return runStore.getRun(runId) ?? undefined;
  }
  return runStore.listRuns({ taskKey })[0];
}

/**
 * Reconstruct a resumable session from the run store, or explain why a fresh
 * run is required.
 *
 * Resume requires a terminal retriable run with a recorded branch and an
 * implementation report, and (when a probe is supplied) a branch that still
 * exists. Everything else falls back to a fresh run.
 */
export async function resolveSessionPickup(
  options: SessionPickupOptions,
): Promise<SessionPickupDecision> {
  const { runStore, taskKey, runId, branchExists, describeLanded } = options;

  let run: RunRecord | undefined;
  try {
    run = findCandidateRun(runStore, taskKey, runId);
  } catch {
    return { kind: "fresh", reason: "run store unavailable" };
  }

  if (!run) {
    return { kind: "fresh", reason: "no prior attempt on record" };
  }
  if (!isPickupStatus(run.status)) {
    return { kind: "fresh", reason: `prior run is ${run.status}` };
  }

  const branch = run.branch?.trim();
  if (!branch) {
    return { kind: "fresh", reason: "prior run recorded no branch" };
  }

  const report = readImplementationReport(runStore, run.id);
  if (!report) {
    return { kind: "fresh", reason: "prior run recorded no implementation report" };
  }

  if (branchExists) {
    let exists: boolean;
    try {
      exists = await branchExists(branch);
    } catch {
      exists = false;
    }
    if (!exists) {
      return { kind: "fresh", reason: `branch '${branch}' no longer exists` };
    }
  }

  let landed: string | undefined;
  if (describeLanded) {
    try {
      landed = await describeLanded({ branch, run });
    } catch {
      landed = undefined;
    }
  }

  return {
    kind: "resume",
    session: {
      runId: run.id,
      taskKey: run.taskKey ?? taskKey,
      status: run.status,
      branch,
      attempt: run.attempt,
      report,
      landed,
      prUrl: run.prUrl,
      outcomeReason: run.outcomeReason,
      repo: run.repo,
      team: run.team,
    },
  };
}
