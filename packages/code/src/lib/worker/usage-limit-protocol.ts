/**
 * Protocol between a long-running worker and the CLI subprocesses it spawns.
 *
 * Fleet/polling/review/automation runs execute `devintern` as a child. When
 * that child hits a usage limit it must not look like a generic failure
 * (exit 1 + failure comment) — the parent owns failover and needs a distinct
 * signal plus the parsed reset window.
 *
 * Exit 75 is EX_TEMPFAIL (sysexits): "temporary failure, try again later".
 */

import { readFileSync, writeFileSync } from "fs";

import { resetHintToMs, UsageLimitError } from "@devintern/agent-harness";

/** sysexits EX_TEMPFAIL — the worker retries on the next harness. */
export const USAGE_LIMIT_EXIT_CODE = 75;

/** Set to `"1"` on CLI subprocesses the worker will fail over for. */
export const WORKER_CHILD_ENV = "DEVINTERN_WORKER_CHILD";

/** Absolute path the child writes a JSON usage-limit hint into. */
export const USAGE_LIMIT_FILE_ENV = "DEVINTERN_USAGE_LIMIT_FILE";

/** Fallback cooldown when the reset hint cannot be parsed. */
export const RATE_LIMIT_FALLBACK_MS = 60 * 60 * 1000;

export interface UsageLimitHint {
  /** Epoch ms when the limited harness's window ends. */
  untilMs: number;
  /** Human-readable reset hint from the agent output, when present. */
  resetsAt?: string;
}

/** True when this process was spawned by the worker for failover. */
export function isWorkerChild(): boolean {
  return process.env[WORKER_CHILD_ENV] === "1";
}

/**
 * Persist the parsed reset window so the parent can fail over without
 * re-scanning the child's inherited stdio.
 *
 * @param error - Usage-limit error raised by the agent spawn
 */
export function writeUsageLimitHint(error: UsageLimitError): void {
  const path = process.env[USAGE_LIMIT_FILE_ENV];
  if (!path) {
    return;
  }
  const untilMs = resetHintToMs(error.resetHint, Date.now()) ?? Date.now() + RATE_LIMIT_FALLBACK_MS;
  writeFileSync(
    path,
    JSON.stringify({
      resetsAt: error.resetHint ?? null,
      untilMs,
    }),
  );
}

/**
 * Read a hint file written by {@link writeUsageLimitHint}.
 *
 * Missing, empty, or malformed files fall back to a 1-hour cooldown so a
 * crashed child still trips failover instead of spinning.
 *
 * @param path - Hint file path (from {@link USAGE_LIMIT_FILE_ENV})
 */
export function readUsageLimitHint(path: string | undefined): UsageLimitHint {
  const fallback = Date.now() + RATE_LIMIT_FALLBACK_MS;
  if (!path) {
    return { untilMs: fallback };
  }
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) {
      return { untilMs: fallback };
    }
    const parsed = JSON.parse(raw) as { untilMs?: unknown; resetsAt?: unknown };
    const resetsAt = typeof parsed.resetsAt === "string" ? parsed.resetsAt : undefined;
    const parsedUntil = typeof parsed.untilMs === "number" ? parsed.untilMs : NaN;
    const untilMs =
      Number.isFinite(parsedUntil) && parsedUntil > Date.now()
        ? parsedUntil
        : (resetHintToMs(resetsAt, Date.now()) ?? fallback);
    return { untilMs, resetsAt };
  } catch {
    return { untilMs: fallback };
  }
}

/**
 * If this is a worker child and `error` is a usage limit, write the hint
 * and exit 75. Returns false so callers can continue with one-shot handling.
 *
 * @param error - Caught error from an agent run
 * @returns Always false when it does not exit
 */
export function exitIfWorkerUsageLimit(error: unknown): boolean {
  if (!(error instanceof UsageLimitError)) {
    return false;
  }
  if (!isWorkerChild()) {
    return false;
  }
  console.warn(`\n⏳ ${error.message}. Signaling worker to fail over.`);
  writeUsageLimitHint(error);
  process.exit(USAGE_LIMIT_EXIT_CODE);
}
