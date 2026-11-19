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
 * re-deriving. A branch with real commits ahead of its base is resumable even
 * when the report is missing (legacy/interrupted runs) or the implementation
 * stage failed before delivery (incomplete, commit, or review halt). When a
 * commit probe is supplied it decides for every status — the stage is written
 * before delivery runs, so a succeeded stage plus a report can still describe
 * an empty branch. Incomplete state (no branch, no report and no landed
 * commits, or a branch that no longer exists) falls back to a fresh run.
 *
 * A `succeeded` run is normally final. Explicit re-queues of ad-hoc tasks opt
 * in to resuming one whose branch was pushed without a PR or whose PR is still
 * open (see {@link SessionPickupOptions.reopenSucceeded}).
 *
 * Every read is best-effort: a storage or parse error degrades to "fresh", the
 * safe default.
 */

import { isBlockedOutcomeReason, isPrDeliveryFailedReason } from "../agent/implementation-outcome";
import type { RunRecord, RunStatus, RunStore, StageStatus } from "./run-recorder";

/** Terminal statuses whose runs are candidates for pickup. */
export const PICKUP_STATUSES: readonly RunStatus[] = ["failed", "escalated", "abandoned"];

/** Run statuses that qualify a run as a pickup candidate. */
export type PickupRunStatus = "failed" | "escalated" | "abandoned";

/** Code-host PR/MR state for a branch: any open, all merged/closed, or none. */
export type ChangeRequestState = "open" | "closed" | "none";

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
 * Env marker carrying the enqueue time (epoch ms) of the injected queue row a
 * `worker add` task runs for. Runs that started before it belong to an earlier
 * task that happened to share the `local-<slug>` key (settled rows are pruned,
 * so a later `worker add` with the same title can reuse the key), never to a
 * re-queue of this row. Set by the injected-task acquirer.
 */
export const INJECTED_CREATED_AT_ENV = "DEVINTERN_INJECTED_CREATED_AT";

/** Parse a `DEVINTERN_INJECTED_CREATED_AT` value, ignoring malformed input. */
export function parseInjectedCreatedAt(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const at = Number(raw);
  return Number.isSafeInteger(at) && at > 0 ? at : undefined;
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
  /**
   * Terminal status the prior run ended in. `succeeded` only when
   * {@link SessionPickupOptions.reopenSucceeded} allowed an undelivered branch.
   */
  status: PickupRunStatus | "succeeded";
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
  /** Task keys are only unique within this tracker/team/repository context. */
  scope?: Partial<Pick<RunRecord, "tracker" | "team" | "repo" | "origin" | "automationId">>;
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
  /**
   * Optional probe for commits on the recorded branch ahead of its target base.
   *
   * Older/interrupted runs can carry real implementation commits without a
   * saved report (the stage used to be written only after auto-review). The
   * stage is also written before commit/verify/auto-review, so even a
   * `succeeded` stage with a report can predate delivery: a crash or SIGTERM
   * during those phases leaves an empty branch behind. Whenever this probe is
   * supplied it is authoritative — resume requires landed commits regardless
   * of the report. Absent → a report from a stage that did not fail is trusted;
   * false → the run stays fresh.
   */
  hasLandedCommits?: (session: { branch: string; run: RunRecord }) => boolean | Promise<boolean>;
  /**
   * Opt-in: also resume a `succeeded` run whose branch was left undelivered or
   * still awaits review, instead of starting a fresh `-attempt-N` branch.
   *
   * Explicit re-queues of ad-hoc tasks (`worker add --resume`, dashboard
   * re-queue) set this: a run can succeed and still fail its PR step (for
   * example on bad credentials), leaving a pushed branch without a PR. Such a
   * run resumes when its branch has landed commits and either recorded no PR
   * (pushed without a PR) or its PR is still open. A recorded PR that is no
   * longer open (merged or closed), or whose state cannot be confirmed, keeps
   * the fresh-branch path. The probe is consulted even when the run recorded
   * no PR: a PR opened by hand from the branch and then merged or closed also
   * keeps the fresh-branch path.
   */
  reopenSucceeded?: {
    /**
     * Only a succeeded run that started at or after this time (epoch ms) is
     * reopened. The injected row's enqueue time: a run from before it belongs
     * to an earlier task that reused the key, so only a re-queue of the same
     * row can find a qualifying run.
     */
    notBefore: number;
    /**
     * State of the branch's PR/MR on the code host: `"open"` when any is
     * open, `"closed"` when all are merged or closed, `"none"` when the branch
     * has none. `undefined` means the state is unknown (unsupported code host,
     * lookup failure).
     */
    isChangeRequestOpen: (session: {
      branch: string;
      run: RunRecord;
    }) => ChangeRequestState | undefined | Promise<ChangeRequestState | undefined>;
  };
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

/** Implementation report and the status of the stage that recorded it. */
export interface RecordedImplementation {
  report?: string;
  status?: StageStatus;
}

/**
 * Extract the implementation report a run recorded, plus that stage's status.
 *
 * The pipeline stores the agent's `implementation-summary[-incomplete].md` as a
 * JSON `detail.report` on the `implementation` stage; the most recent such
 * stage wins. Malformed or truncated detail reads as "no report". The status
 * lets pickup tell a completed implementation apart from one that failed
 * before delivery.
 */
export function readImplementationStage(
  runStore: SessionPickupRunStore,
  runId: number,
): RecordedImplementation {
  let stages: ReturnType<SessionPickupRunStore["listStages"]>;
  try {
    stages = runStore.listStages(runId);
  } catch {
    return {};
  }
  let latestStatus: StageStatus | undefined;
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    const stage = stages[i];
    if (stage.stage !== "implementation") {
      continue;
    }
    latestStatus ??= stage.status;
    if (!stage.detail) {
      continue;
    }
    try {
      const detail = JSON.parse(stage.detail) as { report?: unknown };
      if (typeof detail.report === "string" && detail.report.trim()) {
        return { report: detail.report, status: latestStatus };
      }
    } catch {
      // Truncated or non-JSON detail: treat as missing.
    }
  }
  return latestStatus === undefined ? {} : { status: latestStatus };
}

/**
 * Extract the implementation report a run recorded, if any.
 *
 * @param runStore - Run store holding the stage records
 * @param runId - Run to inspect
 */
export function readImplementationReport(
  runStore: SessionPickupRunStore,
  runId: number,
): string | undefined {
  return readImplementationStage(runStore, runId).report;
}

/** Whether a run belongs to the requested tracker/team/repository context. */
function matchesScope(run: RunRecord, scope: SessionPickupOptions["scope"] = {}): boolean {
  return (
    run.origin === (scope.origin ?? "task") &&
    run.tracker === scope.tracker &&
    run.team === scope.team &&
    run.repo === scope.repo &&
    run.automationId === scope.automationId
  );
}

/**
 * The latest run for `taskKey` in `scope`, regardless of status.
 *
 * Startup recovery needs the actual outcome even when no pickup is possible: a
 * run that finished `succeeded` before its row settled means the task is done,
 * not interrupted. Shares {@link findCandidateRun}'s scope rules so both
 * callers agree on which run is authoritative.
 */
export function latestScopedTaskRun(
  runStore: SessionPickupRunStore,
  taskKey: string,
  scope: SessionPickupOptions["scope"] = {},
): RunRecord | undefined {
  return runStore.listRuns({ taskKey }).find((run) => matchesScope(run, scope));
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
  scope: SessionPickupOptions["scope"] = {},
): CandidateRun {
  const inScope = (run: RunRecord) => matchesScope(run, scope);
  if (runId !== undefined) {
    const run = runStore.getRun(runId) ?? undefined;
    if (!run) {
      return { kind: "none", reason: "no prior attempt on record" };
    }
    if (run.taskKey !== taskKey) {
      return { kind: "none", reason: "pinned run belongs to another task" };
    }
    if (!inScope(run)) {
      return { kind: "none", reason: "pinned run belongs to another task context" };
    }
    return { kind: "found", run };
  }
  const runs = runStore.listRuns({ taskKey });
  const run = runs.find((candidate) => candidate.id !== excludeRunId && inScope(candidate));
  return run ? { kind: "found", run } : { kind: "none", reason: "no prior attempt on record" };
}

/**
 * Whether a `succeeded` run may be reopened: the caller opted in and the run
 * started no earlier than the injected row it would be re-queued for.
 */
function mayReopenSucceeded(
  run: RunRecord,
  reopen: SessionPickupOptions["reopenSucceeded"],
): boolean {
  return run.status === "succeeded" && reopen !== undefined && run.startedAt >= reopen.notBefore;
}

/**
 * Why a reopened `succeeded` run's branch PR blocks resume, or `undefined`
 * when resume may proceed.
 *
 * A run that recorded a PR resumes only on a confirmed `open`: a merged or
 * closed PR means the branch is finished, and an unknown state (or no PR where
 * one was recorded) is not worth the risk of stacking new work on a merged
 * branch. A run that recorded no PR was pushed (or committed) without one, so
 * `none` or an unknown state lets the commit probe decide; only a PR someone
 * opened by hand and then merged or closed (`closed`) blocks it.
 */
async function prBlocksReopen(
  reopen: NonNullable<SessionPickupOptions["reopenSucceeded"]>,
  branch: string,
  run: RunRecord,
): Promise<string | undefined> {
  let state: ChangeRequestState | undefined;
  try {
    state = await reopen.isChangeRequestOpen({ branch, run });
  } catch {
    state = undefined;
  }
  if (!run.prUrl) {
    return state === "closed" ? `a PR for '${branch}' was already merged or closed` : undefined;
  }
  if (state === "open") return undefined;
  return state === "closed"
    ? `prior run's PR for '${branch}' is no longer open`
    : `could not confirm prior run's PR for '${branch}' is still open`;
}

/**
 * Reconstruct a resumable session from the run store, or explain why a fresh
 * run is required.
 *
 * Resume requires a terminal retriable run with a recorded branch that still
 * exists, plus landed commits when a commit probe is supplied (otherwise an
 * implementation report from a stage that did not fail). Everything else falls
 * back to a fresh run.
 */
export async function resolveSessionPickup(
  options: SessionPickupOptions,
): Promise<SessionPickupDecision> {
  const {
    runStore,
    taskKey,
    runId,
    excludeRunId,
    scope,
    branchExists,
    hasLandedCommits,
    reopenSucceeded,
    describeLanded,
  } = options;

  let candidate: CandidateRun;
  try {
    candidate = findCandidateRun(runStore, taskKey, runId, excludeRunId, scope);
  } catch {
    return { kind: "fresh", reason: "run store unavailable" };
  }

  if (candidate.kind === "none") {
    return { kind: "fresh", reason: candidate.reason };
  }
  const run = candidate.run;
  const reopening = mayReopenSucceeded(run, reopenSucceeded);
  const status: SessionPickup["status"] | undefined = isPickupStatus(run.status)
    ? run.status
    : reopening
      ? "succeeded"
      : undefined;
  if (!status) {
    return { kind: "fresh", reason: `prior run is ${run.status}` };
  }
  // An agent-reported `blocked` outcome escalates a run that otherwise
  // finished cleanly and delivered (PR opened, ticket actioned). Its branch is
  // not interrupted work to continue: the blocker is outside the code, so the
  // next attempt starts fresh, exactly as it did when such runs succeeded.
  if (run.status === "escalated" && isBlockedOutcomeReason(run.outcomeReason)) {
    return { kind: "fresh", reason: "prior run reported its goal as blocked" };
  }
  // A run that pushed its branch but could not open the PR finished its agent
  // work; the delivery failure (code host, token, config) is outside the code.
  // Its re-run starts a fresh session, exactly as it did when such runs were
  // recorded succeeded.
  if (run.status === "failed" && isPrDeliveryFailedReason(run.outcomeReason)) {
    return { kind: "fresh", reason: "prior run failed only at PR creation" };
  }

  const branch = run.branch?.trim();
  if (!branch) {
    return { kind: "fresh", reason: "prior run recorded no branch" };
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

  if (reopening && reopenSucceeded) {
    const closed = await prBlocksReopen(reopenSucceeded, branch, run);
    if (closed) return { kind: "fresh", reason: closed };
  }

  const implementation = readImplementationStage(runStore, run.id);
  const report = implementation.report;
  // A report proves the agent wrote a summary, not that the branch carries
  // delivered work. The stage is written as soon as the agent session ends,
  // before commit/verify/auto-review, so even a `succeeded` stage can be
  // followed by a hard crash or SIGTERM during delivery that leaves the branch
  // empty. A supplied commit probe is therefore authoritative for every
  // status; without one, a failed stage (incomplete handoff or a delivery halt
  // after the early success record) still requires commits ahead of the base.
  if (hasLandedCommits || !report || implementation.status === "failed" || reopening) {
    let landedCommits = false;
    if (hasLandedCommits) {
      try {
        landedCommits = await hasLandedCommits({ branch, run });
      } catch {
        landedCommits = false;
      }
    }
    if (!landedCommits) {
      return {
        kind: "fresh",
        reason: hasLandedCommits
          ? `branch '${branch}' has no commits to resume`
          : report
            ? `branch '${branch}' has no verifiable commits to resume`
            : "prior run recorded no implementation report",
      };
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
      status,
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
