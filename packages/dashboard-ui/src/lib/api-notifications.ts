/**
 * Notification center API: types mirroring
 * `packages/code/src/lib/notifications/types.ts` and the routes in
 * `packages/code/src/lib/observability/dashboard-notifications.ts`, plus the
 * write helpers the bell, inbox, and overview call.
 */

export type NotificationKind =
  | "escalated"
  | "retries_exhausted"
  | "automation_broke"
  | "work_spawned"
  | "pr_opened"
  | "pr_auto_merged"
  | "source_unhealthy"
  | "internal_error";

export type NotificationSeverity = "high" | "normal";

/** A link shown with a notification (a run, PR, ticket, or delegated task). */
export interface NotificationLink {
  label: string;
  /** Web URL (http/https only). */
  url?: string;
  /** Dashboard run this link opens. */
  runId?: number;
  /** Ad-hoc or tracker task key. */
  taskKey?: string;
}

export interface NotificationRecord {
  id: number;
  kind: NotificationKind;
  severity: NotificationSeverity;
  groupKey: string;
  /** How many events this row absorbed (grouped rows show "×N"). */
  count: number;
  runId?: number;
  repo?: string;
  subject?: string;
  title: string;
  body?: string;
  links: NotificationLink[];
  createdAt: number;
  updatedAt: number;
  readAt?: number;
  resolvedAt?: number;
  muted: boolean;
}

/** `GET /api/notifications` body. */
export interface NotificationListResponse {
  notifications: NotificationRecord[];
  total: number;
  limit: number;
  offset: number;
}

/** `GET /api/notifications/unread-count` body: unread, unresolved, unmuted rows. */
export interface NotificationUnreadResponse {
  unread: number;
  unreadHigh: number;
}

export const NOTIFICATIONS_URL = "/api/notifications";
export const NOTIFICATION_UNREAD_URL = "/api/notifications/unread-count";
export const NOTIFICATION_MUTES_URL = "/api/notifications/mutes";

/** A muted group key. */
export interface NotificationMute {
  groupKey: string;
  mutedAt: number;
}

/** `GET /api/notifications/mutes` body. */
export interface NotificationMutesResponse {
  mutes: NotificationMute[];
}

/** Filters `GET /api/notifications` accepts. */
export interface NotificationListQuery {
  unresolved?: boolean;
  severity?: NotificationSeverity;
  kind?: NotificationKind;
  limit?: number;
  offset?: number;
}

/** `/api/notifications` URL for a filter (stable parameter order). */
export function notificationsUrl(query: NotificationListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.unresolved !== undefined) params.set("unresolved", String(query.unresolved));
  if (query.severity) params.set("severity", query.severity);
  if (query.kind) params.set("kind", query.kind);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const search = params.toString();
  return search ? `${NOTIFICATIONS_URL}?${search}` : NOTIFICATIONS_URL;
}

/**
 * Inbox tabs. `problems` (DevIntern-side failures) and `review` (escalations
 * waiting on a human) are kept apart so a likely DevIntern bug is never
 * buried among routine review holds.
 */
export type InboxTab = "needs_you" | "problems" | "review" | "activity" | "all";

export const INBOX_TABS: readonly InboxTab[] = [
  "needs_you",
  "problems",
  "review",
  "activity",
  "all",
];

export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
  needs_you: "Needs you",
  problems: "DevIntern problems",
  review: "Waiting on review",
  activity: "Activity",
  all: "All",
};

/** Kind behind a kind-scoped inbox tab. */
const TAB_KINDS: Partial<Record<InboxTab, NotificationKind>> = {
  problems: "internal_error",
  review: "escalated",
};

/** The list query behind an inbox tab; resolved rows are hidden unless asked for. */
export function inboxQuery(
  tab: InboxTab,
  showResolved: boolean,
  limit: number,
): NotificationListQuery {
  return {
    ...(showResolved ? {} : { unresolved: true }),
    ...(tab === "needs_you" ? { severity: "high" as const } : {}),
    ...(tab === "activity" ? { severity: "normal" as const } : {}),
    ...(TAB_KINDS[tab] ? { kind: TAB_KINDS[tab] } : {}),
    limit,
  };
}

/**
 * Window event fired after this tab changed a notification (read, resolve,
 * mute), so the bell, inbox, and overview re-fetch at once.
 */
export const NOTIFICATIONS_CHANGED_EVENT = "devintern:notifications-changed";

export function notifyNotificationsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new window.Event(NOTIFICATIONS_CHANGED_EVENT));
  }
}

export type NotificationActionResult = { ok: true } | { ok: false; error: string };

async function post(url: string, body?: unknown): Promise<NotificationActionResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
    }
    notifyNotificationsChanged();
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function markNotificationRead(id: number): Promise<NotificationActionResult> {
  return post(`${NOTIFICATIONS_URL}/${id}/read`);
}

export function resolveNotification(id: number): Promise<NotificationActionResult> {
  return post(`${NOTIFICATIONS_URL}/${id}/resolve`);
}

export function markAllNotificationsRead(): Promise<NotificationActionResult> {
  return post(`${NOTIFICATIONS_URL}/read-all`);
}

export function muteNotificationGroup(groupKey: string): Promise<NotificationActionResult> {
  return post(`${NOTIFICATIONS_URL}/mute`, { groupKey });
}

export function unmuteNotificationGroup(groupKey: string): Promise<NotificationActionResult> {
  return post(`${NOTIFICATIONS_URL}/unmute`, { groupKey });
}

export function isUnread(notification: NotificationRecord): boolean {
  return notification.readAt === undefined && notification.resolvedAt === undefined;
}

/** "×88" for a grouped row; null for a single event. */
export function groupCountLabel(count: number): string | null {
  return count > 1 ? `×${count}` : null;
}
