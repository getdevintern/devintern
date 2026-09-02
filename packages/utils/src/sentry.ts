/**
 * Shared Sentry error tracking for DevIntern CLIs and apps.
 *
 * Uses the baked-in {@link DEVINTERN_SENTRY_DSN} unless disabled via
 * `SENTRY_DISABLED=1`. Callers own their process-level error handlers — this
 * module disables Sentry's built-in global handlers so fatal errors are
 * reported exactly once and can be flushed before exit.
 */

import {
  captureException as sentryCaptureException,
  flush as sentryFlush,
  init as sentryInit,
} from "@sentry/node";
import { redactText, redactValue } from "./redact.ts";

/**
 * DevIntern Sentry project DSN (public, write-only).
 * Replace with your project DSN from Sentry → Settings → Client Keys (DSN).
 */
export const DEVINTERN_SENTRY_DSN =
  "https://5e2a1d40b29e9cb07959456303c1a1fb@o4511953234690048.ingest.us.sentry.io/4511953239605248";

export interface ErrorTrackingOptions {
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

/** Minimal structural view of the Sentry event fields we scrub. */
interface SentryEventLike {
  extra?: Record<string, unknown>;
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
}

/**
 * Scrub secrets out of an event before it leaves the machine. Error messages
 * can embed credentials (API errors quoting tokens, URLs with credentials),
 * so this is defense-in-depth on top of callers never attaching secrets.
 */
function redactEvent<T extends SentryEventLike>(event: T): T {
  event.extra = redactValue(event.extra) as T["extra"];
  if (typeof event.message === "string") {
    event.message = redactText(event.message);
  }
  for (const exceptionValue of event.exception?.values ?? []) {
    if (typeof exceptionValue.value === "string") {
      exceptionValue.value = redactText(exceptionValue.value);
    }
  }
  return event;
}

/**
 * Initialize error tracking. Safe to call unconditionally: with
 * `SENTRY_DISABLED=1` (or an empty baked-in DSN) this is a no-op and
 * capture/flush do nothing.
 */
export function initErrorTracking(options: ErrorTrackingOptions): void {
  const dsn = DEVINTERN_SENTRY_DSN.trim();
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
      // Respect live opt-out at send time, and scrub secrets from the event
      // payload before it leaves the machine.
      beforeSend: (event) => (isEnabled() ? redactEvent(event) : null),
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
