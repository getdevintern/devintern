/**
 * Worker budget caps (DEV-78).
 *
 * Operators running DevIntern unattended can cap agent spend:
 *
 * - `WORKER_MAX_SPEND_PER_RUN_USD` — maximum reported cost for a
 *   single agent run. Hard enforcement requires native harness cancellation,
 *   which no supported CLI exposes today, so this acts as an
 * *admission/post-run* cap: a run whose final usage exceeds the cap finishes
 *   normally, is recorded, and triggers one loud warning. The limitation is
 *   logged once at worker startup whenever the cap is configured.
 * - `WORKER_MAX_SPEND_PER_DAY_USD` — maximum cumulative spend for
 *   **unattended worker-originated** runs finished within one UTC calendar
 *   day. Checked immediately before admitting each new run; a run admitted
 *   below the cap may push the total above it (final cost is only known when
 *   the harness exits), but no subsequent run starts until the next UTC day.
 *
 * Manual `devintern TASK-123` executions are never gated: caps apply only
 * inside the worker process tree (`devintern worker` sets an internal env
 * marker inherited by the task subprocesses it spawns).
 *
 * Only *known* spend counts toward caps; runs whose harness did not report
 * a cost are surfaced as unknown exposure in every capped-state notification
 * rather than silently treated as $0.
 */

import { RunStore } from "./run-recorder";
import type { RunUsage } from "./run-recorder";
import { resolveQueueDbPath } from "./webhook-queue";

/** Environment variable holding the per-run USD cap. */
export const PER_RUN_CAP_ENV = "WORKER_MAX_SPEND_PER_RUN_USD";
/** Environment variable holding the daily USD cap. */
export const PER_DAY_CAP_ENV = "WORKER_MAX_SPEND_PER_DAY_USD";

/** Internal marker set by `devintern worker`; enables admission gating. */
export const WORKER_PROCESS_ENV = "DEVINTERN_WORKER";

export interface SpendCapConfig {
  /** Per-run USD cap; null disables. */
  perRunUsd: number | null;
  /** Per-UTC-day USD cap over unattended runs; null disables. */
  perDayUsd: number | null;
}

/** Invalid cap configuration; message is written for the operator. */
export class SpendCapConfigError extends Error {
  constructor(
    public readonly envKey: string,
    public readonly rawValue: string,
    reason: string,
  ) {
    super(`${envKey}=${rawValue}: ${reason}`);
    this.name = "SpendCapConfigError";
  }
}

/**
 * Parse one non-negative decimal USD cap.
 *
 * Accepts plain decimals only (`0`, `0.5`, `12`, `99.99`). Rejects negative
 * numbers, non-finite values, scientific notation, and currency markers —
 * the caps are USD-only by definition. Unset or blank disables the cap.
 */
export function parseSpendCap(env: Record<string, string | undefined>, key: string): number | null {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const value = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    let reason: string;
    if (/^-/.test(value)) {
      reason = "must not be negative";
    } else if (/^\$|[^\d.]/.test(value)) {
      reason =
        "must be a plain non-negative decimal number of US dollars (currency suffixes/symbols are unsupported; the value is always interpreted as USD)";
    } else if (!Number.isFinite(Number(value))) {
      reason = "must be finite";
    } else {
      reason = 'must be a plain non-negative decimal number (e.g. "10" or "4.50")';
    }
    throw new SpendCapConfigError(key, raw, reason);
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new SpendCapConfigError(key, raw, "must be a finite non-negative number");
  }
  return parsed;
}

/** Parse both worker cap variables; throws {@link SpendCapConfigError} on bad input. */
export function parseSpendCapConfig(
  env: Record<string, string | undefined> = process.env,
): SpendCapConfig {
  return {
    perRunUsd: parseSpendCap(env, PER_RUN_CAP_ENV),
    perDayUsd: parseSpendCap(env, PER_DAY_CAP_ENV),
  };
}

/** True when any cap is configured. */
export function hasAnyCap(config: SpendCapConfig): boolean {
  return config.perRunUsd !== null || config.perDayUsd !== null;
}

/**
 * Start of the UTC calendar day containing `epochMs`, in epoch milliseconds.
 * The daily cap window is documented as UTC: it rolls over at midnight UTC
 * regardless of the host's local timezone.
 */
export function startOfUtcDay(epochMs: number): number {
  const date = new Date(epochMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export type AdmissionDecision =
  | { allowed: true; spentTodayUsd: number | null }
  | {
      allowed: false;
      cap: "daily";
      limitUsd: number;
      spentTodayUsd: number | null;
      /** ISO timestamp of the next UTC midnight (when the cap resets). */
      resetsAtIso: string;
      /** Runs today whose cost is unknown — exposure above `spentTodayUsd`. */
      runsWithUnknownCost: number;
    };

/**
 * Store-backed budget gate shared by every worker acquisition path.
 *
 * One instance per process evaluates admission against persisted spend, so
 * polling, relay, review-polling, mention-sweep, webhook, and workspace
 * routes all observe the same numbers, including runs recorded by other
 * processes (task subprocesses share the database file).
 */
export class BudgetGate {
  constructor(
    private readonly store: RunStore,
    private readonly config: SpendCapConfig,
  ) {}

  /**
   * Whether a new unattended agent run may start right now. Evaluated
   * immediately before admission; callers must treat this as advisory-close:
   * a run admitted below the daily cap can finish above it, and the next
   * evaluation will block.
   */
  checkAdmission(nowMs: number = Date.now()): AdmissionDecision {
    if (this.config.perDayUsd === null) {
      return { allowed: true, spentTodayUsd: null };
    }
    const since = startOfUtcDay(nowMs);
    const { knownSpendUsd, runsWithUnknownCost } = this.store.getUnattendedSpendSince(since);
    // Exact boundary blocks: meeting the cap means no further headroom.
    if (knownSpendUsd !== null && knownSpendUsd >= this.config.perDayUsd) {
      return {
        allowed: false,
        cap: "daily",
        limitUsd: this.config.perDayUsd,
        spentTodayUsd: knownSpendUsd,
        resetsAtIso: new Date(startOfUtcDay(nowMs) + 24 * 60 * 60 * 1000).toISOString(),
        runsWithUnknownCost,
      };
    }
    return { allowed: true, spentTodayUsd: knownSpendUsd };
  }

  /** Configured daily cap (null when disabled). */
  get dailyCapUsd(): number | null {
    return this.config.perDayUsd;
  }

  /** Configured per-run cap (null when disabled). */
  get perRunCapUsd(): number | null {
    return this.config.perRunUsd;
  }

  /**
   * Post-run per-run-cap evaluation. Emits one warning per offending run
   * (not spammy: once per run completion, only when exceeded).
   */
  noteRunFinished(usage: RunUsage | null): void {
    const cap = this.config.perRunUsd;
    if (cap === null || !usage?.costUsd) {
      return;
    }
    if (usage.costUsd > cap) {
      const caveat = usage.complete === false ? " (usage incomplete; actual spend may differ)" : "";
      console.warn(
        `💸 Run exceeded WORKER_MAX_SPEND_PER_RUN_USD: $${usage.costUsd.toFixed(4)} > $${cap.toFixed(
          2,
        )}${caveat}. ` +
          "Per-run caps cannot abort in-flight sessions (no harness-native spend cancellation), " +
          "so this run was allowed to finish and was recorded normally.",
      );
    }
  }

  /**
   * Human-readable summary of the capped state for notifications.
   */
  describeCappedState(decision: Extract<AdmissionDecision, { allowed: false }>): string {
    const unknownNote =
      decision.runsWithUnknownCost > 0
        ? ` ${decision.runsWithUnknownCost} run(s) today have unknown cost, so actual exposure may already be higher.`
        : "";
    return (
      `Daily spend cap reached: $${decision.spentTodayUsd?.toFixed(4) ?? "0"} known spent of ` +
      `$${decision.limitUsd.toFixed(2)} (WORKER_MAX_SPEND_PER_DAY_USD).${unknownNote} ` +
      `New unattended tasks stay paused until ${decision.resetsAtIso} (UTC midnight); ` +
      "queued/detected work is preserved and will resume then. In-flight runs are finishing."
    );
  }
}
