/**
 * Automation source health (error monitors today): which sources need the
 * operator's attention and how their rows read. The server already limits
 * the list to sources in the current config.
 */

import type { StatusTone } from "@/components/shared";
import type { SourceHealth, SourceHealthStatus } from "@/lib/api";

/** Hash route of the Automations view, where the Source health section lives. */
export const SOURCE_HEALTH_HASH = "#/automations";

/** Each failure status gets its own tone so the three read differently. */
export const SOURCE_STATUS_TONES: Record<SourceHealthStatus, StatusTone> = {
  ok: "neutral",
  unreadable: "warning",
  "rate-limited": "info",
  "auth-failed": "danger",
};

/** Plain-language hint shown as the status pill's tooltip. */
export const SOURCE_STATUS_HINTS: Record<SourceHealthStatus, string> = {
  ok: "The last read succeeded.",
  unreadable: "The provider could not be read (network error, timeout, 5xx, or a renamed project).",
  "rate-limited": "The provider rate-limited reads; the worker waits for its retry window.",
  "auth-failed": "The provider rejected the credentials; check or rotate the token.",
};

/** Sources whose most recent read did not succeed. */
export function sourcesNeedingAttention(
  sources: readonly SourceHealth[] | undefined,
): SourceHealth[] {
  return (sources ?? []).filter((source) => source.status !== "ok");
}

/** "1 source needs attention" / "2 sources need attention". */
export function attentionLabel(count: number): string {
  return count === 1 ? "1 source needs attention" : `${count} sources need attention`;
}

/** Tooltip for the header item: one "id: status" per unhealthy source. */
export function attentionTitle(sources: readonly SourceHealth[]): string {
  const detail = sources.map((source) => `${source.sourceId}: ${source.status}`).join(", ");
  return `${detail}. Open Automations for source health.`;
}

/**
 * The next-retry instant to display, or null when none applies: only a
 * future `retryAfterAt` is a pending window (a past one resumes on the next
 * poll and needs no countdown).
 */
export function nextRetryAt(source: SourceHealth, now: number): number | null {
  const at = source.retryAfterAt;
  return typeof at === "number" && at > now ? at : null;
}

/** Display name of a provider (`sentry` → `Sentry`). */
export function providerLabel(provider: string): string {
  if (provider === "sentry") return "Sentry";
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider;
}
