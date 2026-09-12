import { flushAnalytics, trackWorkerTaskRun } from "../observability/analytics";
import { endRun } from "./run-recorder";
import type { RunStatus } from "./run-recorder";
import { VERSION } from "../cli/bootstrap";

/** Finish the local run record and emit exactly one outcome event for worker tasks. */
export async function finishTaskRun(
  status: Exclude<RunStatus, "in_progress">,
  reason?: string,
): Promise<void> {
  endRun(status, reason);
  const tracked = trackWorkerTaskRun(status, {
    cliVersion: VERSION,
    tracker: process.env.TASK_TRACKER || "jira",
  });
  if (tracked) {
    await flushAnalytics();
  }
}
