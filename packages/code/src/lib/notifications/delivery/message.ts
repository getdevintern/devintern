/**
 * Channel-neutral delivery messages: a single notification, or a daily digest.
 *
 * Everything that leaves the machine passes through the shared
 * `redactText` helper (title, body, link labels and URLs), so a token that
 * slipped into a failure cause is never posted to Slack or a webhook.
 */

import { redactText } from "@devintern/utils";

import type { WorkspaceConfig } from "../../workspace/config-types";
import type { Notification, NotificationKind } from "../types";
import type { DeliveryCandidate } from "./policy";

const DEFAULT_DASHBOARD_PORT = 4400;
const MAX_CAUSE_CHARS = 300;
/** Items listed by name in a digest (the rest are only counted). */
export const DIGEST_TOP_ITEMS = 5;

/** Why a message is sent. */
export type DeliveryEvent = "created" | "resurfaced" | "resolved" | "test";

/** One notification as a channel renders it. */
export interface NotificationMessage {
  type: "notification";
  event: DeliveryEvent;
  /** Redacted notification (title, body, links). */
  notification: Notification;
  /** First line of the body: the short cause. */
  cause?: string;
  /** Dashboard page for this notification. */
  dashboardUrl: string;
}

/** One line of a digest. */
export interface DigestItem {
  kind: NotificationKind;
  title: string;
  count: number;
  repo?: string;
  resolved: boolean;
  dashboardUrl: string;
}

/** A daily summary of routine items. */
export interface DigestMessage {
  type: "digest";
  /** Window covered (epoch ms, start exclusive). */
  since: number;
  until: number;
  /** Items in the window. */
  total: number;
  /** Items per kind, largest first. */
  countsByKind: Array<{ kind: NotificationKind; count: number }>;
  /** Most frequent items. */
  top: DigestItem[];
  /** Dashboard inbox. */
  dashboardUrl: string;
}

export type DeliveryMessage = NotificationMessage | DigestMessage;

/**
 * Base URL of the dashboard for links: `[notifications].dashboard_url`, else
 * the first explicit `[dashboard].allowed_origins` entry (the address people
 * already open from other devices), else `http://localhost:<port>`.
 */
export function resolveDashboardBaseUrl(
  config: Pick<WorkspaceConfig, "workspace" | "dashboard" | "notifications">,
  env: Record<string, string | undefined> = process.env,
): string {
  if (config.notifications?.dashboardUrl) return config.notifications.dashboardUrl;
  const origin = config.dashboard.allowedOrigins.find((entry) => entry.source === "explicit");
  if (origin) return origin.origin;
  const port =
    config.workspace.dashboardPort ??
    (Number.parseInt(env.DASHBOARD_PORT || "", 10) || DEFAULT_DASHBOARD_PORT);
  return `http://localhost:${port}`;
}

/** Dashboard page for a notification: its run, else the inbox. */
export function notificationDashboardUrl(base: string, notification: Notification): string {
  return notification.runId !== undefined
    ? `${base}/#/runs/${notification.runId}`
    : `${base}/#/inbox`;
}

function redactUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const redacted = redactText(url);
  // A URL whose credentials were scrubbed is no longer a working link.
  return redacted === url ? url : undefined;
}

/** A copy of a notification with every free-text field redacted. */
export function redactNotification(notification: Notification): Notification {
  return {
    ...notification,
    title: redactText(notification.title),
    ...(notification.body !== undefined ? { body: redactText(notification.body) } : {}),
    links: notification.links.map((link) => {
      const url = redactUrl(link.url);
      const { url: _url, ...rest } = link;
      return { ...rest, label: redactText(link.label), ...(url ? { url } : {}) };
    }),
  };
}

/** First non-empty body line, clipped. */
export function shortCause(body: string | undefined): string | undefined {
  const line = body
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > MAX_CAUSE_CHARS ? `${line.slice(0, MAX_CAUSE_CHARS - 1)}…` : line;
}

/** Build the message for one notification event. */
export function buildNotificationMessage(
  notification: Notification,
  event: DeliveryEvent,
  dashboardBase: string,
): NotificationMessage {
  const redacted = redactNotification(notification);
  const cause = shortCause(redacted.body);
  return {
    type: "notification",
    event,
    notification: redacted,
    ...(cause ? { cause } : {}),
    dashboardUrl: notificationDashboardUrl(dashboardBase, notification),
  };
}

/**
 * Summarize routine items for a digest; null when there is nothing to send.
 *
 * @param items - Digest candidates already filtered for the channel
 * @param window - Period covered
 * @param dashboardBase - Link base
 */
export function buildDigest(
  items: readonly DeliveryCandidate[],
  window: { since: number; until: number },
  dashboardBase: string,
): DigestMessage | null {
  if (items.length === 0) return null;
  const counts = new Map<NotificationKind, number>();
  for (const { notification } of items) {
    counts.set(notification.kind, (counts.get(notification.kind) ?? 0) + 1);
  }
  const countsByKind = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const top = [...items]
    .sort(
      (a, b) =>
        b.notification.count - a.notification.count ||
        b.notification.updatedAt - a.notification.updatedAt,
    )
    .slice(0, DIGEST_TOP_ITEMS)
    .map(({ notification }): DigestItem => ({
      kind: notification.kind,
      title: redactText(notification.title),
      count: notification.count,
      ...(notification.repo ? { repo: notification.repo } : {}),
      resolved: notification.resolvedAt !== undefined,
      dashboardUrl: notificationDashboardUrl(dashboardBase, notification),
    }));
  return {
    type: "digest",
    since: window.since,
    until: window.until,
    total: items.length,
    countsByKind,
    top,
    dashboardUrl: `${dashboardBase}/#/inbox`,
  };
}

/** Human-readable kind label. */
export function kindLabel(kind: NotificationKind): string {
  return kind.replaceAll("_", " ");
}

/** Plain-text headline for a notification message. */
export function messageHeadline(message: NotificationMessage): string {
  const { notification } = message;
  const count = notification.count > 1 ? ` (×${notification.count})` : "";
  switch (message.event) {
    case "resolved":
      return `Resolved: ${notification.title}`;
    case "test":
      return notification.title;
    default:
      return `${notification.title}${count}`;
  }
}

/** Plain-text digest headline. */
export function digestHeadline(digest: DigestMessage): string {
  return `DevIntern daily digest: ${digest.total} item${digest.total === 1 ? "" : "s"}`;
}

/** A synthetic notification for `worker doctor --test-notifications`. */
export function testNotification(now: number): Notification {
  return {
    id: 0,
    kind: "internal_error",
    severity: "high",
    groupKey: "test",
    count: 1,
    title: "DevIntern test notification",
    body: "Sent by `devintern worker doctor --test-notifications`. Delivery works.",
    links: [],
    createdAt: now,
    updatedAt: now,
    muted: false,
  };
}
