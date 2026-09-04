/**
 * Process-wide Sentry initialization for @devintern/code entry points.
 *
 * Every entry point that can crash — the CLI main/subcommands, the worker
 * daemon, and the standalone webhook server — calls {@link initSentryOnce}
 * exactly once per process; later calls are no-ops so events are never
 * double-initialized. Exit paths own flushing via `flushErrorTracking`.
 */

import { initErrorTracking } from "@devintern/utils";

let initialized = false;

/**
 * Initialize error tracking at most once per process. Safe to call
 * unconditionally: with `SENTRY_DISABLED=1` this is a no-op, and repeat
 * calls after the first do nothing.
 */
export function initSentryOnce(release?: string): void {
  if (initialized) return;
  initialized = true;
  initErrorTracking({
    ...(release ? { release } : {}),
    environment: process.env.NODE_ENV ?? "production",
  });
}
