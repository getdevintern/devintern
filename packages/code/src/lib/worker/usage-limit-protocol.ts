/**
 * Protocol between a long-running worker and the CLI subprocesses it spawns.
 *
 * Fleet/polling/review/automation runs execute `devintern` as a child. When
 * that child hits a usage limit it must not look like a generic failure
 * (exit 1 + failure comment) — the parent owns failover and needs a distinct
 * signal plus the parsed reset window.
 *
 * Exit 75 is EX_TEMPFAIL (sysexits): "temporary failure, try again later".
 * Exit 77 is EX_NOPERM and tells the parent to defer a task until the worker's
 * automation access is restored.
 */

import { readFileSync, writeFileSync } from "fs";

import { resetHintToMs, UsageLimitError } from "@devintern/agent-harness";
import type { UsageLimitPeriod } from "@devintern/agent-harness";

/** sysexits EX_TEMPFAIL — the worker retries on the next harness. */
export const USAGE_LIMIT_EXIT_CODE = 75;

/** sysexits EX_NOPERM — parent workers defer the task until access is restored. */
export const AUTOMATION_ACCESS_EXIT_CODE = 77;

/**
 * sysexits EX_CONFIG — the selected harness could not start (sandbox denial,
 * mise shim install failure, missing binary). The parent marks that entry
 * unavailable for the process and tries the next one; when none remain the
 * task is deferred instead of consuming an attempt.
 *
 * Distinct from 0 (success), 1 (task failure), 75 (usage limit), and 77
 * (automation access denied).
 */
export const HARNESS_UNAVAILABLE_EXIT_CODE = 78;

/**
 * App-specific exit code (not sysexits) emitted only by worker children when
 * the retry gate skipped the task because a previous attempt was reported
 * incomplete and the ticket has not changed since.
 *
 * Distinct from 0 (success), 1 (failure), 75 (usage limit), and 77 (automation
 * access denied): a skip is neither a completed run nor a failed one, so the
 * parent must log it as skipped instead of completed.
 */
export const TASK_SKIP_EXIT_CODE = 3;

/** Set to `"1"` on CLI subprocesses the worker will fail over for. */
export const WORKER_CHILD_ENV = "DEVINTERN_WORKER_CHILD";

/** Absolute path the child writes a JSON usage-limit hint into. */
export const USAGE_LIMIT_FILE_ENV = "DEVINTERN_USAGE_LIMIT_FILE";

/**
 * First fallback cooldown when the reset hint cannot be parsed. The worker
 * doubles it for each further limit on the same harness without a reset time
 * (see `WorkerFailover`), up to {@link RATE_LIMIT_FALLBACK_MAX_MS}.
 */
export const RATE_LIMIT_FALLBACK_MS = 60 * 60 * 1000;

/** Ceiling for the escalating no-reset-time fallback. */
export const RATE_LIMIT_FALLBACK_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum cooldown for a limit that names its quota period but no reset time.
 * A monthly or weekly quota will not come back within the hour, so probing it
 * hourly only launches tasks that fail.
 */
export const RATE_LIMIT_PERIOD_FLOOR_MS: Record<UsageLimitPeriod, number> = {
  daily: 4 * 60 * 60 * 1000,
  weekly: 24 * 60 * 60 * 1000,
  monthly: 24 * 60 * 60 * 1000,
};

export interface UsageLimitHint {
  /**
   * Epoch ms when the limited harness's window ends, when the agent output
   * said so. Absent means the reset time is unknown and the parent worker
   * picks the fallback cooldown.
   */
  untilMs?: number;
  /** Human-readable reset hint from the agent output, when present. */
  resetsAt?: string;
  /** Quota period the limit message named, if any. */
  period?: UsageLimitPeriod;
}

const USAGE_LIMIT_PERIODS: readonly string[] = ["daily", "weekly", "monthly"];

function parsePeriod(value: unknown): UsageLimitPeriod | undefined {
  return typeof value === "string" && USAGE_LIMIT_PERIODS.includes(value)
    ? (value as UsageLimitPeriod)
    : undefined;
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
  // Leave `untilMs` null when the output had no parsable reset time: the
  // parent owns the fallback so it can escalate across repeated limits.
  const untilMs = resetHintToMs(error.resetHint, Date.now());
  writeFileSync(
    path,
    JSON.stringify({
      resetsAt: error.resetHint ?? null,
      untilMs,
      period: error.period ?? null,
    }),
  );
}

/**
 * Read a hint file written by {@link writeUsageLimitHint}.
 *
 * Missing, empty, or malformed files yield a hint with no `untilMs`, so the
 * parent applies its fallback cooldown and a crashed child still trips
 * failover instead of spinning.
 *
 * @param path - Hint file path (from {@link USAGE_LIMIT_FILE_ENV})
 */
export function readUsageLimitHint(path: string | undefined): UsageLimitHint {
  if (!path) {
    return {};
  }
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as { untilMs?: unknown; resetsAt?: unknown; period?: unknown };
    const resetsAt = typeof parsed.resetsAt === "string" ? parsed.resetsAt : undefined;
    const period = parsePeriod(parsed.period);
    const parsedUntil = typeof parsed.untilMs === "number" ? parsed.untilMs : NaN;
    const untilMs =
      Number.isFinite(parsedUntil) && parsedUntil > Date.now()
        ? parsedUntil
        : (resetHintToMs(resetsAt, Date.now()) ?? undefined);
    return {
      ...(untilMs !== undefined ? { untilMs } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      ...(period ? { period } : {}),
    };
  } catch {
    return {};
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
