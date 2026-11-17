import { RunStore } from "../state/run-recorder";

/** Passed to the task subprocess so its run record names the queue execution. */
export const QUEUE_CLAIM_ENV = "DEVINTERN_QUEUE_CLAIM";

const FALLBACK_REASON = "task pipeline did not complete cleanly";

/** Read the failed run produced by this queue execution, if it was recorded. */
export function queueFailureReason(dbPath: string | undefined, queueClaim: string): string {
  if (!dbPath) return FALLBACK_REASON;

  let runs: RunStore | undefined;
  try {
    runs = new RunStore(dbPath, { readonly: true });
    const run = runs.runForQueueClaim(queueClaim);
    if (
      (run?.status === "failed" || run?.status === "abandoned" || run?.status === "escalated") &&
      run.outcomeReason
    ) {
      return run.outcomeReason;
    }
  } catch {
    // Run recording is best-effort. A missing or unreadable record must not
    // prevent the durable queue row from settling.
  } finally {
    try {
      runs?.close();
    } catch {
      // Closing a diagnostic reader must not mask the pipeline failure.
    }
  }
  return FALLBACK_REASON;
}
