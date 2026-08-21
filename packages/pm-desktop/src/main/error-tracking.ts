/**
 * Sentry error tracking for the Electron main process.
 *
 * Mirrors analytics.ts conventions: no-ops without a DSN (baked at build time
 * via electron.vite.config.ts), respects the shared analytics opt-out setting,
 * and never breaks IPC/UI.
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
 * Safe to call unconditionally: without a baked DSN this is a no-op.
 */
export async function initErrorTrackingFromSettings(appVersion: string): Promise<void> {
  try {
    telemetryEnabled = isAnalyticsEnabled(await readSettings());
  } catch {
    // Settings unreadable — default to enabled.
  }
  initErrorTracking({
    dsn: process.env.SENTRY_DSN,
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
 */
export async function captureError(error: unknown): Promise<void> {
  try {
    captureWithSentry(error);
  } catch {
    // Swallow — product use must not fail because of error reporting.
  }
}

/** Flush pending events on quit. Safe to call when tracking is unused. */
export async function shutdownErrorTracking(): Promise<void> {
  await flushSentry();
}
