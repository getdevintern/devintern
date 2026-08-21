/**
 * Shared Sentry error tracking for DevIntern CLIs and apps.
 *
 * No-ops unless a DSN is provided, so local/unconfigured installs never send
 * anything. Callers own their process-level error handlers — this module
 * disables Sentry's built-in global handlers so fatal errors are reported
 * exactly once and can be flushed before exit.
 */

import {
  captureException as sentryCaptureException,
  flush as sentryFlush,
  init as sentryInit,
} from "@sentry/node";

export interface ErrorTrackingOptions {
  /** Sentry project DSN. Tracking stays off when empty/missing. */
  dsn?: string;
  /** Environment tag, e.g. "production" or "development". */
  environment?: string;
  /** Release identifier, e.g. "code@1.2.3". */
  release?: string;
  /**
   * Extra guard evaluated before every send (live opt-out support).
   * Combined with the SENTRY_DISABLED=1 env opt-out.
   */
  isEnabled?: () => boolean;
}

/** How long to wait for pending events before force-exiting callers proceed. */
const FLUSH_TIMEOUT_MS = 2000;

interface ErrorTrackingState {
  isEnabled: () => boolean;
}

let state: ErrorTrackingState | null = null;

/**
 * Initialize error tracking. Safe to call unconditionally: without a DSN (or
 * with SENTRY_DISABLED=1) this is a no-op and capture/flush do nothing.
 */
export function initErrorTracking(options: ErrorTrackingOptions): void {
  const dsn = options.dsn?.trim();
  if (!dsn || dsn.length === 0 || process.env.SENTRY_DISABLED === "1") {
    state = null;
    return;
  }

  const isEnabled = options.isEnabled ?? (() => true);
  state = { isEnabled };

  try {
    sentryInit({
      dsn,
      environment: options.environment,
      release: options.release,
      // Respect live opt-out at send time.
      beforeSend: (event) => (isEnabled() ? event : null),
      // We register our own process-level handlers so we can flush before
      // exiting; Sentry's default global handlers would double-report.
      defaultIntegrations: false,
    });
  } catch {
    state = null;
  }
}

/** Flip the live opt-out guard (e.g. when the user changes telemetry settings). */
export function setErrorTrackingEnabled(enabled: boolean): void {
  if (state) {
    state.isEnabled = () => enabled;
  }
}

/**
 * Report an error. Never throws — tracking must not break the caller.
 * No-op when tracking is uninitialized or disabled.
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!state || !state.isEnabled()) return;
  try {
    sentryCaptureException(error, context ? { extra: context } : undefined);
  } catch {
    // Swallow — reporting must never break the app.
  }
}

/**
 * Wait (bounded) for pending events to be sent. Resolves even on failure so
 * exit paths are never blocked by the network.
 */
export async function flushErrorTracking(): Promise<void> {
  if (!state) return;
  try {
    await sentryFlush(FLUSH_TIMEOUT_MS);
  } catch {
    // Ignore — best-effort flush.
  }
}
