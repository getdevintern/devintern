/**
 * Terminal run status handed from a CLI child to the worker that spawned it.
 *
 * The child records its run in the queue database, but the parent only sees
 * the exit code, and a clean exit (0) covers both a successful run and one the
 * agent reported as blocked (recorded `escalated`). Changing the exit code
 * would feed failover and retry logic meant for transient failures, so the
 * child instead writes its recorded status to a file named by
 * {@link RUN_OUTCOME_FILE_ENV}, and the parent reads it after a clean exit
 * purely to report the run accurately.
 */
import { readFileSync, writeFileSync } from "fs";

import type { RunStatus } from "../state/run-recorder";

/** Absolute path the child writes its terminal run status into. */
export const RUN_OUTCOME_FILE_ENV = "DEVINTERN_RUN_OUTCOME_FILE";

/** Bound on the reason read back from the hint file. */
const MAX_REASON_LENGTH = 500;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "deferred",
  "escalated",
  "abandoned",
]);

/** Terminal status the child recorded for its run. */
export interface RunOutcomeHint {
  status: Exclude<RunStatus, "in_progress">;
  reason?: string;
}

/** Best-effort: write the recorded status when the parent asked for it. */
export function writeRunOutcomeHint(
  hint: RunOutcomeHint,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env[RUN_OUTCOME_FILE_ENV];
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(hint), "utf8");
  } catch {
    /* best-effort: reporting must never fail a run */
  }
}

/** Read and validate a hint file; undefined when absent or malformed. */
export function readRunOutcomeHint(path: string | undefined): RunOutcomeHint | undefined {
  if (!path) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { status, reason } = parsed as { status?: unknown; reason?: unknown };
  if (typeof status !== "string" || !TERMINAL_STATUSES.has(status)) return undefined;
  return {
    status: status as RunOutcomeHint["status"],
    ...(typeof reason === "string" && reason.trim()
      ? { reason: reason.trim().slice(0, MAX_REASON_LENGTH) }
      : {}),
  };
}
