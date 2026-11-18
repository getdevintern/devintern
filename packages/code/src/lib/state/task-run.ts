import { flushAnalytics, trackWorkerTaskRun } from "../observability/analytics";
import { endRun } from "./run-recorder";
import type { RunStatus } from "./run-recorder";
import { VERSION } from "../cli/bootstrap";
import { writeRunOutcomeHint } from "../worker/run-outcome-protocol";

/** Finish the local run record and emit exactly one outcome event for worker tasks. */
export async function finishTaskRun(
  status: Exclude<RunStatus, "in_progress">,
  reason?: string,
): Promise<void> {
  endRun(status, reason);
  writeRunOutcomeHint(reason === undefined ? { status } : { status, reason });
  const tracked = trackWorkerTaskRun(status, {
    cliVersion: VERSION,
    tracker: process.env.TASK_TRACKER || "jira",
  });
  if (tracked) {
    await flushAnalytics();
  }
}
