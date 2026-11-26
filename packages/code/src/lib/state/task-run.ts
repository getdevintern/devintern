import { flushAnalytics, trackWorkerTaskRun } from "../observability/analytics";
import { endRun, pendingRunFailure } from "./run-recorder";
import type { RunOutcomeDetail, RunStatus } from "./run-recorder";
import { describeRunFailure } from "./run-outcome";
import { VERSION } from "../cli/bootstrap";
import { writeRunOutcomeHint } from "../worker/run-outcome-protocol";

/** Classification, work status, and a note appended to the reason. */
export interface TaskRunOutcome extends RunOutcomeDetail {
  /** Appended after the reason (`<reason>; <note>`), e.g. where unfinished work went. */
  note?: string;
}

/**
 * The outcome reason a non-successful run records: `<stage>: <cause>` when a
 * classified failure carries its cause (instead of the caller's generic
 * phrase), then the note.
 *
 * @param status - Terminal status
 * @param reason - The caller's reason
 * @param outcome - Classification and note
 */
export function composeOutcomeReason(
  status: Exclude<RunStatus, "in_progress">,
  reason: string | undefined,
  outcome: TaskRunOutcome = {},
): string | undefined {
  const failing = status === "failed" || status === "escalated" || status === "abandoned";
  const failure = failing ? (pendingRunFailure() ?? outcome.failure) : undefined;
  const head = describeRunFailure(failure) ?? reason;
  if (!outcome.note) return head;
  return head ? `${head}; ${outcome.note}` : outcome.note;
}

/** Finish the local run record and emit exactly one outcome event for worker tasks. */
export async function finishTaskRun(
  status: Exclude<RunStatus, "in_progress">,
  reason?: string,
  outcome: TaskRunOutcome = {},
): Promise<void> {
  const recorded = composeOutcomeReason(status, reason, outcome);
  endRun(status, recorded, {
    ...(outcome.failure ? { failure: outcome.failure } : {}),
    ...(outcome.work ? { work: outcome.work } : {}),
  });
  writeRunOutcomeHint(recorded === undefined ? { status } : { status, reason: recorded });
  const tracked = trackWorkerTaskRun(status, {
    cliVersion: VERSION,
    tracker: process.env.TASK_TRACKER || "jira",
  });
  if (tracked) {
    await flushAnalytics();
  }
}
