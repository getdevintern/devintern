/**
 * Sentry error tracking for the Electron main process.
 *
 * Uses the baked-in DevIntern DSN from `@devintern/utils`, respects the shared
 * analytics opt-out setting, and never breaks IPC/UI.
 */

import {
  captureError as captureWithSentry,
  flushErrorTracking as flushSentry,
  initErrorTracking,
} from "@devintern/utils";
import { isAnalyticsEnabled, readSettings } from "./settings.ts";

/** Mirrors the analytics opt-out; synced at startup and on opt-in/out. */
let telemetryEnabled = true;

/**
 * Initialize error tracking using the current telemetry setting.
 * Safe to call unconditionally: disabled via Settings or SENTRY_DISABLED=1.
 */
export async function initErrorTrackingFromSettings(appVersion: string): Promise<void> {
  try {
    telemetryEnabled = isAnalyticsEnabled(await readSettings());
  } catch {
    // Settings unreadable — default to enabled.
  }
  initErrorTracking({
    release: `pm-desktop@${appVersion}`,
    environment: process.env.NODE_ENV ?? "production",
    isEnabled: () => telemetryEnabled,
  });
}

/** Keep the live opt-out guard in sync when the user changes the setting. */
export function setTelemetryEnabled(enabled: boolean): void {
  telemetryEnabled = enabled;
}

/**
 * Report an error. Never throws — tracking must not break the app.
 * No-op when telemetry is opted out or SENTRY_DISABLED=1.
 */
export async function captureError(
  error: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  try {
    captureWithSentry(error, context);
  } catch {
    // Swallow — product use must not fail because of error reporting.
  }
}

/**
 * Repeated identical failures (same channel/operation + message) are common
 * (a stuck engine, a failing poll). Suppress repeats within this window so a
 * handled error that fires every few hundred ms does not flood Sentry.
 */
const DEDUP_WINDOW_MS = 60_000;
/** Upper bound on tracked keys so the map can never grow unbounded. */
const DEDUP_MAP_LIMIT = 128;

const recentReports = new Map<string, number>();

/** @internal Clear deduplication state (tests). */
export function resetErrorDeduplicationForTests(): void {
  recentReports.clear();
}

/** Best-effort dedup key: operation + error message. */
function dedupKey(operation: string | undefined, error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return `${operation ?? ""}|${message.slice(0, 500)}`;
}

/**
 * Report an error, suppressing repeats of the same operation+message inside
 * {@link DEDUP_WINDOW_MS}. Use for handled errors that can recur (IPC
 * handlers, forwarded renderer errors).
 */
export async function captureErrorOnce(
  error: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  const key = dedupKey(context?.["operation"] as string | undefined, error);
  const now = Date.now();
  const last = recentReports.get(key);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    return;
  }
  if (recentReports.size >= DEDUP_MAP_LIMIT) {
    const oldest = recentReports.keys().next().value;
    if (oldest !== undefined) {
      recentReports.delete(oldest);
    }
  }
  recentReports.set(key, now);
  await captureError(error, context);
}

/** Flush pending events on quit. Safe to call when tracking is unused. */
export async function shutdownErrorTracking(): Promise<void> {
  await flushSentry();
}
