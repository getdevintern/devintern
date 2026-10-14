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

/**
 * Env marker carrying the run a retry targets (`retry.runId`), so the pipeline
 * resolves pickup from that specific run instead of guessing by task key. Set
 * by the fleet executor for dashboard and orphan-recovery retries.
 */
export const PICKUP_RUN_ID_ENV = "DEVINTERN_PICKUP_RUN_ID";

/** Parse a `DEVINTERN_PICKUP_RUN_ID` value, ignoring malformed input. */
export function parsePickupRunId(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Choose how {@link resolveSessionPickup} should select the run to resume. A
 * run id pinned by the retry (via {@link PICKUP_RUN_ID_ENV}) wins; otherwise
 * the current run is excluded so the immediately preceding terminal attempt is
 * selected instead of the just-opened `in_progress` run shadowing it.
 *
 * @param currentRunId - Run the pipeline just opened, excluded when unpinned
 * @param env - Environment to read the pinned run id from (defaults to process.env)
 */
export function pickupSelection(
  currentRunId: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { runId?: number; excludeRunId?: number } {
  const runId = parsePickupRunId(env[PICKUP_RUN_ID_ENV]);
  return runId !== undefined ? { runId } : { excludeRunId: currentRunId };
}

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
   * Run id to ignore when falling back to the latest task run. The pipeline
   * opens the current run before resolving pickup, so without this the
   * just-created `in_progress` run shadows the prior terminal run and every
   * pickup degrades to fresh.
   */
  excludeRunId?: number;
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

/** A selected candidate run, or why no run qualified. */
type CandidateRun = { kind: "found"; run: RunRecord } | { kind: "none"; reason: string };

/**
 * The run to pick up: the explicitly requested one, else the task's latest
 * attempt. Only the latest run's state is authoritative — a successful or
 * deferred run that followed a failure means the task moved on, so an older
 * failed run is never resumed. `excludeRunId` drops the current run (opened by
 * the pipeline before resolution) so the immediately preceding attempt wins.
 *
 * A pinned run (from {@link PICKUP_RUN_ID_ENV}) is only accepted when it belongs
 * to `taskKey`: a stale or mis-propagated pin must never let a task resume
 * another task's branch and inherit that task's implementation report.
 */
function findCandidateRun(
  runStore: SessionPickupRunStore,
  taskKey: string,
  runId?: number,
  excludeRunId?: number,
): CandidateRun {
  if (runId !== undefined) {
    const run = runStore.getRun(runId) ?? undefined;
    if (!run) {
      return { kind: "none", reason: "no prior attempt on record" };
    }
    if (run.taskKey !== taskKey) {
      return { kind: "none", reason: "pinned run belongs to another task" };
    }
    return { kind: "found", run };
  }
  const runs = runStore.listRuns({ taskKey });
  const run = runs.find((candidate) => candidate.id !== excludeRunId);
  return run ? { kind: "found", run } : { kind: "none", reason: "no prior attempt on record" };
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
  const { runStore, taskKey, runId, excludeRunId, branchExists, describeLanded } = options;

  let candidate: CandidateRun;
  try {
    candidate = findCandidateRun(runStore, taskKey, runId, excludeRunId);
  } catch {
    return { kind: "fresh", reason: "run store unavailable" };
  }

  if (candidate.kind === "none") {
    return { kind: "fresh", reason: candidate.reason };
  }
  const run = candidate.run;
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
