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
