/**
 * Durable state machine for the scheduled conflict-resolution window
 * (`[workspace].conflict_resolution = "scheduled"`). The PR review poller
 * owns the window; this module holds its persisted shape and the pure
 * open/extend/parse transitions so they stay testable in isolation.
 */
import type { CronOrIntervalSchedule } from "../automation/config";
import { parseEnvInteger } from "../config/env-integer";

/** Durable cursor source for the scheduled conflict-resolution window. */
export const CONFLICT_WINDOW_SOURCE = "worker:conflict-window";

/** Default minutes a scheduled conflict-resolution window stays open. */
export const DEFAULT_CONFLICT_WINDOW_GRACE_MINUTES = 60;

/**
 * Drain extension: while conflict work that started in an open window is
 * still active, each newly observed base-sync event or resolution attempt
 * keeps the window open at least this long. It covers the auto-merge quiet
 * period plus CI on a freshly resolved sibling PR, so the conflict its merge
 * creates in the next sibling is still caught by the same window.
 */
export const CONFLICT_WINDOW_DRAIN_GRACE_MS = 15 * 60_000;

/** Dashboard view of the scheduled conflict-resolution window. */
export interface ConflictWindowStatus {
  schedule: CronOrIntervalSchedule;
  /** Next scheduled window (ms epoch); absent before the first tick registered it. */
  nextWindowAt?: number;
  /**
   * A window (scheduled or opened on demand) is open until this instant,
   * including any drain extension.
   */
  openUntil?: number;
}

/** Result of opening the conflict window on demand (dashboard "Run now"). */
export type ConflictWindowTriggerOutcome = { ok: true } | { ok: false; reason: string };

/** Durable state for scheduled conflict resolution (persisted per worker). */
export interface ConflictWindowState {
  /** Next scheduled occurrence (ms epoch). */
  nextWindowAt: number;
  /** Resolution attempts are allowed until this instant (0 = none opened yet). */
  windowOpenUntil: number;
  /**
   * Hard cap for drain extensions: the nominal close plus one more grace
   * period. `windowOpenUntil` never moves past it.
   */
  windowCapAt: number;
}

/** Window length: the explicit override, else `WORKER_RESOLVE_WINDOW_GRACE_MINUTES` or 60. */
export function resolveConflictWindowGraceMs(override?: number): number {
  return (
    override ??
    parseEnvInteger("WORKER_RESOLVE_WINDOW_GRACE_MINUTES", DEFAULT_CONFLICT_WINDOW_GRACE_MINUTES, {
      min: 0,
    }) * 60_000
  );
}

/** Parse the persisted cursor value; `null` when absent or corrupt. */
export function parseConflictWindowState(raw: string | undefined): ConflictWindowState | null {
  if (!raw) return null;
  let parsed: Partial<ConflictWindowState>;
  try {
    parsed = JSON.parse(raw) as Partial<ConflictWindowState>;
  } catch {
    return null;
  }
  if (typeof parsed.nextWindowAt !== "number" || typeof parsed.windowOpenUntil !== "number") {
    return null;
  }
  return {
    nextWindowAt: parsed.nextWindowAt,
    windowOpenUntil: parsed.windowOpenUntil,
    // State written before drain extensions existed: no extension allowed.
    windowCapAt:
      typeof parsed.windowCapAt === "number" ? parsed.windowCapAt : parsed.windowOpenUntil,
  };
}

/** Scheduled mode only: are resolution attempts currently allowed? */
export function isConflictWindowOpen(
  state: ConflictWindowState | null | undefined,
  now: number,
): boolean {
  return state != null && now <= state.windowOpenUntil;
}

/** Open a window now for `graceMs`, extendable by drain work up to 2x the grace. */
export function openConflictWindow(
  nextWindowAt: number,
  now: number,
  graceMs: number,
): ConflictWindowState {
  return { nextWindowAt, windowOpenUntil: now + graceMs, windowCapAt: now + 2 * graceMs };
}

/**
 * Push the close out to `now + drain grace`, bounded by the hard cap.
 * Returns the new state, or `null` when nothing changes (past the cap, or
 * the window already stays open longer).
 */
export function extendConflictWindow(
  state: ConflictWindowState,
  now: number,
): ConflictWindowState | null {
  if (now > state.windowCapAt) return null;
  const until = Math.min(state.windowCapAt, now + CONFLICT_WINDOW_DRAIN_GRACE_MS);
  if (until <= state.windowOpenUntil) return null;
  return { ...state, windowOpenUntil: until };
}
