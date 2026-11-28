/**
 * Scheduling after a usage limit: when a job blocked by a harness limit runs
 * next, and the worker log line for a deferred run.
 */

import type { AutomationConfig } from "./config";
import type { AutomationDeferral } from "./state";

/** Catch-up runs start this long after a usage-limit reset, spread per job. */
const CATCH_UP_MIN_DELAY_MS = 60_000;
const CATCH_UP_MAX_DELAY_MS = 5 * 60_000;

/**
 * Worker log line for a run (or occurrence) deferred on a usage limit.
 *
 * @param label - Log prefix such as `automation:release`
 * @param deferral - Reset time and harness that hit the limit
 * @param next - When the job runs next and whether that is a catch-up run
 * @param subject - Noun for the run (`""` or `"manual run "`)
 */
export function automationDeferralMessage(
  label: string,
  deferral: AutomationDeferral,
  next: { catchUp: boolean; nextDueAt?: number },
  subject = "",
): string {
  const harness = deferral.harness ? `${deferral.harness} usage limit` : "usage limit";
  const until = new Date(deferral.untilMs).toISOString();
  const tail = next.catchUp
    ? "catching up then"
    : next.nextDueAt !== undefined
      ? `next occurrence ${new Date(next.nextDueAt).toISOString()}`
      : "not rescheduled";
  return `⏳ [${label}] ${subject}deferred: ${harness} until ${until}; ${tail}`;
}

/**
 * Small per-job delay after a usage-limit reset, so jobs that hit the same
 * limit do not all start in the same second. Stable for one job id.
 */
export function catchUpJitterMs(stateId: string): number {
  let hash = 0;
  for (const char of stateId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CATCH_UP_MIN_DELAY_MS + (hash % (CATCH_UP_MAX_DELAY_MS - CATCH_UP_MIN_DELAY_MS + 1));
}

/**
 * Next due time for a job whose occurrence a usage limit blocked: one
 * catch-up run shortly after the reset when that comes before the next
 * scheduled occurrence (`on_usage_limit = "catch_up"`, the default), else
 * the scheduled occurrence.
 *
 * @param automation - The job; its `onUsageLimit` policy decides
 * @param stateId - Durable schedule id (seeds the jitter)
 * @param nextScheduledAt - Next scheduled occurrence
 * @param resetAt - When the usage limit resets (epoch ms)
 * @param now - Current epoch ms
 */
export function usageLimitNextDue(
  automation: AutomationConfig,
  stateId: string,
  nextScheduledAt: number,
  resetAt: number,
  now: number,
): { nextDueAt: number; catchUp: boolean } {
  if (automation.onUsageLimit === "skip") return { nextDueAt: nextScheduledAt, catchUp: false };
  const catchUpAt = Math.max(resetAt, now) + catchUpJitterMs(stateId);
  return catchUpAt < nextScheduledAt
    ? { nextDueAt: catchUpAt, catchUp: true }
    : { nextDueAt: nextScheduledAt, catchUp: false };
}
