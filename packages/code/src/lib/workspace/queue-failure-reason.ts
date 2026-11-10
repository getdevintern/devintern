import { RunStore } from "../state/run-recorder";
import type { RunOrigin } from "../state/run-recorder";

const FALLBACK_REASON = "task pipeline did not complete cleanly";

/** Snapshot the last matching run before the executor can create this attempt. */
export function previousRunIdForClaim(
  dbPath: string | undefined,
  claim: { taskKey: string; origin: RunOrigin; repo?: string; team?: string },
): number | undefined {
  if (!dbPath) return undefined;
  let runs: RunStore | undefined;
  try {
    runs = new RunStore(dbPath, { readonly: true });
    return runs.latestRunForClaim(claim)?.id ?? 0;
  } catch {
    return undefined;
  } finally {
    try {
      runs?.close();
    } catch {
      // Diagnostic lookup must not affect execution.
    }
  }
}

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
    const run = runs.latestRunForClaim(claim);
    if (
      run?.status === "failed" &&
      (run.startedAt > claim.startedAt ||
        (run.startedAt === claim.startedAt &&
          claim.previousRunId !== undefined &&
          run.id > claim.previousRunId)) &&
      (claim.previousRunId === undefined || run.id > claim.previousRunId) &&
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
