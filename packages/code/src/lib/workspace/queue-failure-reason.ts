import { RunStore } from "../state/run-recorder";
import type { RunRecord } from "../state/run-recorder";

/** Passed to the task subprocess so its run record names the queue execution. */
export const QUEUE_CLAIM_ENV = "DEVINTERN_QUEUE_CLAIM";

const FALLBACK_REASON = "task pipeline did not complete cleanly";

/** Read the run produced by this queue execution, best-effort. */
function readQueueClaimRun(dbPath: string | undefined, queueClaim: string): RunRecord | null {
  if (!dbPath) return null;

  let runs: RunStore | undefined;
  try {
    runs = new RunStore(dbPath, { readonly: true });
    return runs.runForQueueClaim(queueClaim);
  } catch {
    // Run recording is best-effort. A missing or unreadable record must not
    // prevent the durable queue row from settling.
    return null;
  } finally {
    try {
      runs?.close();
    } catch {
      // Closing a diagnostic reader must not mask the pipeline outcome.
    }
  }
}

/** Read the failed run produced by this queue execution, if it was recorded. */
export function queueFailureReason(dbPath: string | undefined, queueClaim: string): string {
  const run = readQueueClaimRun(dbPath, queueClaim);
  if (
    (run?.status === "failed" || run?.status === "abandoned" || run?.status === "escalated") &&
    run.outcomeReason
  ) {
    return run.outcomeReason;
  }
  return FALLBACK_REASON;
}

/**
 * Reason of a run that the pipeline recorded `failed` even though its process
 * exited cleanly (for example a pushed branch whose PR could not be created),
 * or `undefined` when the run did not fail or cannot be read.
 */
export function cleanExitFailureReason(
  dbPath: string | undefined,
  queueClaim: string,
): string | undefined {
  const run = readQueueClaimRun(dbPath, queueClaim);
  if (run?.status !== "failed") return undefined;
  return run.outcomeReason ?? FALLBACK_REASON;
}
