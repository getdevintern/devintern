import { RunStore } from "../state/run-recorder";
import type { RunOrigin } from "../state/run-recorder";

const FALLBACK_REASON = "task pipeline did not complete cleanly";

/** Read the failed run produced by this queue claim, if it was recorded. */
export function queueFailureReason(
  dbPath: string | undefined,
  claim: {
    taskKey: string;
    startedAt?: number;
    origin: RunOrigin;
    repo?: string;
    team?: string;
    previousRunId?: number;
  },
): string {
  if (!dbPath || claim.startedAt === undefined) return FALLBACK_REASON;

  let runs: RunStore | undefined;
  try {
    runs = new RunStore(dbPath, { readonly: true });
    const run = runs.latestRunByTaskKey([claim.taskKey]).get(claim.taskKey);
    if (
      run?.status === "failed" &&
      run.origin === claim.origin &&
      run.startedAt >= claim.startedAt &&
      run.id !== claim.previousRunId &&
      (claim.repo === undefined || run.repo === claim.repo) &&
      (claim.team === undefined || run.team === claim.team) &&
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
