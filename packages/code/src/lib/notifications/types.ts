/**
 * Notification center domain types.
 *
 * A notification is either "something needs a human" (`high`) or "DevIntern
 * changed something outside itself" (`normal`). It is not a mirror of the
 * runs list: ordinary successful runs, individual retry attempts, and
 * deferrals never produce one.
 */

/** Every notification kind v1 emits. */
export const NOTIFICATION_KINDS = [
  "escalated",
  "retries_exhausted",
  "automation_broke",
  "work_spawned",
  "pr_opened",
  "pr_auto_merged",
  "source_unhealthy",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ["high", "normal"] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

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

/** A stored notification. */
export interface Notification {
  id: number;
  kind: NotificationKind;
  severity: NotificationSeverity;
  /** Emits with the same key fold into one open row. */
  groupKey: string;
  /** How many emits this row absorbed. */
  count: number;
  /** Run of the latest emit, when one triggered it. */
  runId?: number;
  repo?: string;
  /** What the notification is about (`task:KEY`, `pr:URL`, `automation:ID`, …); drives auto-resolve. */
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

/** What an emitter asks the store to record. */
export interface NotificationInput {
  kind: NotificationKind;
  severity: NotificationSeverity;
  groupKey: string;
  runId?: number;
  repo?: string;
  subject?: string;
  title: string;
  body?: string;
  links?: NotificationLink[];
  /**
   * Title for a grouped row given its new count (e.g. "3 PRs opened in
   * owner/repo today"); `title` is used when omitted.
   */
  groupTitle?: (count: number) => string;
  /** Keep the open row's links and append these (deduplicated) instead of replacing them. */
  appendLinks?: boolean;
  /**
   * Count every emit as a new event, even from the run of the open row. By
   * default a run re-emitting into its own group only refreshes the text (a
   * retried finish); set this when the caller already deduplicates and one
   * run can produce several real events (one run opening two PRs).
   */
  distinctEvents?: boolean;
}

/** What an emit did. */
export type EmitAction = "created" | "grouped" | "refreshed" | "muted";

export interface EmitResult {
  action: EmitAction;
  /** The written row; absent when the group is muted. */
  notification?: Notification;
}

/** Filters for listing notifications. */
export interface NotificationListFilter {
  /** Only rows not yet resolved. */
  unresolved?: boolean;
  severity?: NotificationSeverity;
  kind?: NotificationKind;
  /** Include rows of muted groups (excluded by default). */
  includeMuted?: boolean;
  limit?: number;
  offset?: number;
}

export interface NotificationPage {
  notifications: Notification[];
  /** Rows matching the filter, ignoring pagination. */
  total: number;
}

/** Unread, unresolved, unmuted notifications. */
export interface UnreadCount {
  unread: number;
  unreadHigh: number;
}

/** A persisted mute. */
export interface NotificationMute {
  groupKey: string;
  mutedAt: number;
}

/** Change to an open notification that is not a new event (rollup progress). */
export interface NotificationPatch {
  title?: string;
  body?: string;
  links?: NotificationLink[];
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

export function isNotificationSeverity(value: unknown): value is NotificationSeverity {
  return (
    typeof value === "string" && (NOTIFICATION_SEVERITIES as readonly string[]).includes(value)
  );
}
