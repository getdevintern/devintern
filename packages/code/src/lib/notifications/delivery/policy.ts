/**
 * Which notifications a channel delivers, and when.
 *
 * - Kind filters (`kinds`, `exclude_kinds`) apply to every message, digest
 *   included.
 * - Immediate delivery needs the channel's `min_severity`.
 * - With a daily digest configured, "routine" items (normal severity, and
 *   escalations that are review holds) go to the digest only, so a real
 *   DevIntern failure is not lost among routine review holds.
 * - A group key sends at most one message per `rate_limit_minutes`; a count
 *   increase inside the window stays pending and goes out once it ends.
 */

import type { Notification } from "../types";
import type { NotificationChannelConfig } from "./config";

/** A stored notification plus the facts delivery decides on. */
export interface DeliveryCandidate {
  notification: Notification;
  /** `outcome_class` of the notification's run, when known. */
  runOutcomeClass?: string;
}

export type ImmediateDecision = "send" | "skip" | "digest";

/** Whether a kind passes the channel's include/exclude lists. */
export function kindAllowed(
  channel: NotificationChannelConfig,
  kind: Notification["kind"],
): boolean {
  if (channel.kinds && !channel.kinds.includes(kind)) return false;
  return !channel.excludeKinds.includes(kind);
}

/** Whether a notification meets the channel's minimum severity. */
export function severityAllowed(
  channel: NotificationChannelConfig,
  severity: Notification["severity"],
): boolean {
  return channel.minSeverity === "normal" || severity === "high";
}

/** Routine items a digest collects: normal severity, or a review-hold escalation. */
export function isDigestItem(candidate: DeliveryCandidate): boolean {
  const { notification } = candidate;
  if (notification.severity === "normal") return true;
  return notification.kind === "escalated" && candidate.runOutcomeClass === "review_hold";
}

/** What a channel does with a new or resurfaced notification. */
export function decideImmediate(
  channel: NotificationChannelConfig,
  candidate: DeliveryCandidate,
): ImmediateDecision {
  const { notification } = candidate;
  if (!kindAllowed(channel, notification.kind)) return "skip";
  if (channel.digestTime && isDigestItem(candidate)) return "digest";
  return severityAllowed(channel, notification.severity) ? "send" : "skip";
}

/** Whether a group may send now given when it last sent. */
export function rateLimitAllows(
  channel: NotificationChannelConfig,
  lastSentAt: number | undefined,
  now: number,
): boolean {
  if (lastSentAt === undefined || channel.rateLimitMinutes <= 0) return true;
  return now - lastSentAt >= channel.rateLimitMinutes * 60_000;
}

/** Whether a digest item belongs in this channel's digest. */
export function digestIncludes(
  channel: NotificationChannelConfig,
  candidate: DeliveryCandidate,
): boolean {
  return kindAllowed(channel, candidate.notification.kind) && isDigestItem(candidate);
}
