/**
 * The CI half of auto-merge's "Ready" gate: decide from the head commit's
 * check runs (Checks API) and legacy commit statuses whether CI has passed.
 *
 * GitHub reports `mergeable_state: clean` for a commit with no checks at
 * all, so `mergeable_state` alone cannot tell "CI passed" from "there is no
 * CI". The rule here:
 *
 * - any failing check (`failure`, `error`, `timed_out`, `cancelled`,
 *   `action_required`, or an unknown conclusion) → not ready;
 * - any pending check (`queued`, `in_progress`, status `pending`, ...) → not ready;
 * - otherwise at least one `success` is required when the caller asks;
 *   only asks for it with `auto_merge_require_checks` (never for safe-path-only PRs).
 *
 * `skipped` and `neutral` checks never count as the required success and
 * never block on their own.
 */

import type { CheckRun, CombinedStatus } from "../code-host/github/reviews-types";

export type CiCheckState = "success" | "failing" | "pending" | "neutral";

/** One check on the head commit, from either API. */
export interface CiCheck {
  name: string;
  state: CiCheckState;
}

/** Check-run conclusions that neither pass nor block. */
const NEUTRAL_CONCLUSIONS = new Set(["neutral", "skipped"]);

/** State of one check run; unknown conclusions fail closed. */
export function checkRunState(run: Pick<CheckRun, "status" | "conclusion">): CiCheckState {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success") return "success";
  if (run.conclusion && NEUTRAL_CONCLUSIONS.has(run.conclusion)) return "neutral";
  // failure, timed_out, cancelled, action_required, startup_failure, stale, null.
  return "failing";
}

/** State of one legacy commit status (`error`, `failure`, `pending`, `success`). */
export function commitStatusState(state: string): CiCheckState {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  return "failing";
}

/** Normalize both APIs into one list of checks. */
export function normalizeCiChecks(
  checkRuns: ReadonlyArray<Pick<CheckRun, "name" | "status" | "conclusion">>,
  statuses: ReadonlyArray<Pick<CombinedStatus["statuses"][number], "context" | "state">>,
): CiCheck[] {
  return [
    ...checkRuns.map((run) => ({ name: run.name, state: checkRunState(run) })),
    ...statuses.map((status) => ({
      name: status.context || "(unnamed status)",
      state: commitStatusState(status.state),
    })),
  ];
}

/** Name for check runs whose details the credential cannot read. */
export function hiddenCheckRunsName(count: number): string {
  return `${count} check ${count === 1 ? "run" : "runs"} (names need the Checks: Read permission)`;
}

/** Rollup states (GraphQL `StatusState`) mapped to one check's state. */
function rollupCheckState(state: string): CiCheckState {
  if (state === "SUCCESS") return "success";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  // FAILURE, ERROR, or an unknown state: fail closed.
  return "failing";
}

/**
 * The head commit's checks when check runs cannot be listed (a fine-grained
 * token has no Checks permission): the commit statuses by name, plus one
 * entry standing for the check runs, whose state comes from GitHub's
 * combined `statusCheckRollup`. When the statuses alone already explain a
 * failing or pending rollup, the check runs' own state is unknown, so their
 * entry is neutral rather than blamed by name. GitHub counts `skipped` and
 * `neutral` runs as success in the rollup.
 */
export function ciChecksFromRollup(
  statusChecks: readonly CiCheck[],
  rollup: { state: string | null; total: number },
): CiCheck[] {
  const hidden = rollup.total - statusChecks.length;
  if (hidden <= 0 || rollup.state === null) return [...statusChecks];
  const rolled = rollupCheckState(rollup.state);
  const explained = rolled !== "success" && statusChecks.some((check) => check.state === rolled);
  return [
    ...statusChecks,
    { name: hiddenCheckRunsName(hidden), state: explained ? "neutral" : rolled },
  ];
}

/** Exact wording for a commit with no checks at all. */
export const NO_CI_CHECKS_MESSAGE =
  "No CI checks reported for this commit; auto-merge needs at least one passing check.";

/** Why CI is not ready, for the status comment. */
export type CiChecksProblem = "no-checks" | "no-passing" | "pending" | "failing";

export type CiChecksVerdict =
  | { ready: true }
  | { ready: false; problem: CiChecksProblem; message: string };

/** Check names listed in a message before summarizing the rest. */
const MAX_NAMED_CHECKS = 5;

function nameList(names: readonly string[]): string {
  const unique = [...new Set(names)];
  const listed = unique.slice(0, MAX_NAMED_CHECKS).join(", ");
  const more = unique.length - MAX_NAMED_CHECKS;
  return more > 0 ? `${listed} and ${more} more` : listed;
}

/**
 * Decide whether the head commit's checks let the PR merge.
 *
 * @param checks - Every check on the head commit (complete list)
 * @param options.requireSuccess - Whether at least one `success` is needed
 */
export function evaluateCiChecks(
  checks: readonly CiCheck[],
  options: { requireSuccess: boolean },
): CiChecksVerdict {
  const named = (state: CiCheckState) =>
    checks.filter((check) => check.state === state).map((check) => check.name);
  const failing = named("failing");
  if (failing.length > 0) {
    return {
      ready: false,
      problem: "failing",
      message: `${failing.length === 1 ? "CI check" : "CI checks"} failed: ${nameList(failing)}.`,
    };
  }
  const pending = named("pending");
  if (pending.length > 0) {
    return {
      ready: false,
      problem: "pending",
      message: `CI checks are still pending: ${nameList(pending)}.`,
    };
  }
  if (!options.requireSuccess || named("success").length > 0) return { ready: true };
  if (checks.length === 0) {
    return { ready: false, problem: "no-checks", message: NO_CI_CHECKS_MESSAGE };
  }
  return {
    ready: false,
    problem: "no-passing",
    message:
      `No CI check passed on this commit (${checks.length} skipped or neutral); ` +
      "auto-merge needs at least one passing check.",
  };
}
