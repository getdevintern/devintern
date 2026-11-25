/**
 * Notification store: the `notifications` and `notification_mutes` tables in
 * the workspace `queue.db`.
 *
 * Grouping: at most one unresolved row exists per `group_key` (partial unique
 * index). Emitting into an open group increments `count`, bumps `updated_at`,
 * clears `read_at` (the row resurfaces as unread), and replaces title/body.
 * Re-emitting the same run into its own group only refreshes the text, so a
 * retried write never double-counts. Once a row is resolved, the next emit
 * for its key opens a fresh row.
 *
 * Mutes are persisted per group key: an emit for a muted key writes nothing.
 */

import type { Database } from "bun:sqlite";

import {
  optionalNumber,
  optionalString,
  parseRowObject,
  requireEnum,
  requireNumber,
  requireString,
} from "../state/row-parse";
import type { RowRecord } from "../state/row-parse";
import { NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES } from "./types";
import type {
  EmitResult,
  Notification,
  NotificationInput,
  NotificationLink,
  NotificationListFilter,
  NotificationMute,
  NotificationPage,
  NotificationPatch,
  UnreadCount,
} from "./types";

const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS = 4_000;
const MAX_LABEL_CHARS = 200;
const MAX_URL_CHARS = 2_000;
const MAX_LINKS = 50;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Create the notification tables and indexes (idempotent). */
export function initNotificationSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      group_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      run_id INTEGER,
      repo TEXT,
      subject TEXT,
      title TEXT NOT NULL,
      body TEXT,
      links TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      read_at INTEGER,
      resolved_at INTEGER,
      muted INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_open_group
     ON notifications(group_key) WHERE resolved_at IS NULL`,
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_notifications_updated ON notifications(updated_at DESC, id DESC)",
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_notifications_open_subject
     ON notifications(subject) WHERE resolved_at IS NULL`,
  );
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_mutes (
      group_key TEXT PRIMARY KEY,
      muted_at INTEGER NOT NULL
    )
  `);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An http(s) URL, or undefined: other schemes are never rendered as links. */
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_URL_CHARS) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Parse one link from untrusted JSON; null when it has no usable label. */
export function parseNotificationLink(value: unknown): NotificationLink | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.label !== "string" || !raw.label.trim()) return null;
  const url = safeUrl(raw.url);
  const runId =
    typeof raw.runId === "number" && Number.isSafeInteger(raw.runId) && raw.runId > 0
      ? raw.runId
      : undefined;
  const taskKey =
    typeof raw.taskKey === "string" && raw.taskKey.trim()
      ? clip(raw.taskKey.trim(), MAX_LABEL_CHARS)
      : undefined;
  return {
    label: clip(raw.label.trim(), MAX_LABEL_CHARS),
    ...(url ? { url } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(taskKey ? { taskKey } : {}),
  };
}

function normalizeLinks(links: readonly unknown[]): NotificationLink[] {
  const seen = new Set<string>();
  const result: NotificationLink[] = [];
  for (const entry of links) {
    const link = parseNotificationLink(entry);
    if (!link) continue;
    const identity = JSON.stringify([link.url, link.runId, link.taskKey, link.label]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(link);
  }
  // Keep the newest links when a grouped row accumulates more than the cap.
  return result.slice(-MAX_LINKS);
}

function parseLinksColumn(raw: string | undefined): NotificationLink[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeLinks(parsed) : [];
  } catch {
    return [];
  }
}

const CONTEXT = "notifications row";

/** Map a raw row to a {@link Notification}; throws `RowParseError` on a malformed row. */
function rowToNotification(value: unknown): Notification {
  const row: RowRecord = parseRowObject(value, CONTEXT);
  const runId = optionalNumber(row, "run_id", CONTEXT);
  const repo = optionalString(row, "repo", CONTEXT);
  const subject = optionalString(row, "subject", CONTEXT);
  const body = optionalString(row, "body", CONTEXT);
  const readAt = optionalNumber(row, "read_at", CONTEXT);
  const resolvedAt = optionalNumber(row, "resolved_at", CONTEXT);
  return {
    id: requireNumber(row, "id", CONTEXT),
    kind: requireEnum(NOTIFICATION_KINDS, row.kind, "kind", CONTEXT),
    severity: requireEnum(NOTIFICATION_SEVERITIES, row.severity, "severity", CONTEXT),
    groupKey: requireString(row, "group_key", CONTEXT),
    count: requireNumber(row, "count", CONTEXT),
    ...(runId !== undefined ? { runId } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(subject !== undefined ? { subject } : {}),
    title: requireString(row, "title", CONTEXT),
    ...(body !== undefined ? { body } : {}),
    links: parseLinksColumn(optionalString(row, "links", CONTEXT)),
    createdAt: requireNumber(row, "created_at", CONTEXT),
    updatedAt: requireNumber(row, "updated_at", CONTEXT),
    ...(readAt !== undefined ? { readAt } : {}),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    muted: row.muted === 1,
  };
}

/** Clamp a page size into `1..MAX_PAGE_SIZE`. */
function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

/** Match for resolving open notifications by what they are about. */
export interface ResolveMatch {
  kinds: readonly Notification["kind"][];
  subject?: string;
  groupKey?: string;
  /** Rows whose run recorded this PR URL. Needs the `runs` table in the same DB. */
  runPrUrl?: string;
}

/** Store over one writable connection; the caller owns (and closes) the connection. */
export class NotificationStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    initNotificationSchema(db);
  }

  /** Whether a group key is muted. */
  isMuted(groupKey: string): boolean {
    return (
      this.db.query("SELECT 1 AS one FROM notification_mutes WHERE group_key = ?").get(groupKey) !==
      null
    );
  }

  /**
   * Record an event: insert a row, or fold it into the open row of its group.
   *
   * @param input - What happened
   * @returns What the store did and the written row
   */
  emit(input: NotificationInput): EmitResult {
    return this.db
      .transaction((): EmitResult => {
        if (this.isMuted(input.groupKey)) return { action: "muted" };
        const now = this.now();
        const existing = this.findOpenGroup(input.groupKey);
        const body = input.body ? clip(input.body, MAX_BODY_CHARS) : null;
        if (!existing) {
          const links = normalizeLinks(input.links ?? []);
          const title = clip(input.groupTitle?.(1) ?? input.title, MAX_TITLE_CHARS);
          const result = this.db.run(
            `INSERT INTO notifications
               (kind, severity, group_key, count, run_id, repo, subject, title, body, links,
                created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              input.kind,
              input.severity,
              input.groupKey,
              input.runId ?? null,
              input.repo ?? null,
              input.subject ?? null,
              title,
              body,
              JSON.stringify(links),
              now,
              now,
            ],
          );
          return {
            action: "created",
            notification: this.requireById(Number(result.lastInsertRowid)),
          };
        }
        const links = normalizeLinks(
          input.appendLinks ? [...existing.links, ...(input.links ?? [])] : (input.links ?? []),
        );
        // The same run emitting again (a retried finish) is not a new event.
        const sameEvent =
          !input.distinctEvents && input.runId !== undefined && existing.runId === input.runId;
        const count = sameEvent ? existing.count : existing.count + 1;
        const title = clip(input.groupTitle?.(count) ?? input.title, MAX_TITLE_CHARS);
        if (sameEvent) {
          this.db.run(`UPDATE notifications SET title = ?, body = ?, links = ? WHERE id = ?`, [
            title,
            body,
            JSON.stringify(links),
            existing.id,
          ]);
          return { action: "refreshed", notification: this.requireById(existing.id) };
        }
        this.db.run(
          `UPDATE notifications SET
             count = ?, severity = ?, run_id = ?, repo = COALESCE(?, repo),
             subject = COALESCE(?, subject), title = ?, body = ?, links = ?,
             updated_at = ?, read_at = NULL
           WHERE id = ?`,
          [
            count,
            input.severity,
            input.runId ?? null,
            input.repo ?? null,
            input.subject ?? null,
            title,
            body,
            JSON.stringify(links),
            now,
            existing.id,
          ],
        );
        return { action: "grouped", notification: this.requireById(existing.id) };
      })
      .immediate();
  }

  /**
   * Update an open row without counting a new event (rollup progress).
   *
   * @param groupKey - Group of the open row
   * @param patch - New title/body/links
   * @param options - `resurface` marks the row unread and bumps `updated_at`
   * @returns The updated row, or null when the group has no open row
   */
  updateOpenGroup(
    groupKey: string,
    patch: NotificationPatch,
    options: { resurface?: boolean } = {},
  ): Notification | null {
    const existing = this.findOpenGroup(groupKey);
    if (!existing) return null;
    const title = patch.title !== undefined ? clip(patch.title, MAX_TITLE_CHARS) : existing.title;
    const body =
      patch.body !== undefined ? clip(patch.body, MAX_BODY_CHARS) : (existing.body ?? null);
    const links = patch.links !== undefined ? normalizeLinks(patch.links) : existing.links;
    if (options.resurface) {
      this.db.run(
        `UPDATE notifications SET title = ?, body = ?, links = ?, updated_at = ?, read_at = NULL
         WHERE id = ?`,
        [title, body, JSON.stringify(links), this.now(), existing.id],
      );
    } else {
      this.db.run(`UPDATE notifications SET title = ?, body = ?, links = ? WHERE id = ?`, [
        title,
        body,
        JSON.stringify(links),
        existing.id,
      ]);
    }
    return this.requireById(existing.id);
  }

  /** The unresolved row of a group, if any. */
  findOpenGroup(groupKey: string): Notification | null {
    const row = this.db
      .query("SELECT * FROM notifications WHERE group_key = ? AND resolved_at IS NULL")
      .get(groupKey);
    return row ? rowToNotification(row) : null;
  }

  getById(id: number): Notification | null {
    const row = this.db.query("SELECT * FROM notifications WHERE id = ?").get(id);
    return row ? rowToNotification(row) : null;
  }

  private requireById(id: number): Notification {
    const notification = this.getById(id);
    if (!notification) throw new Error(`notification ${id} disappeared after write`);
    return notification;
  }

  /** Page through notifications, most recently updated first. */
  list(filter: NotificationListFilter = {}): NotificationPage {
    return listNotifications(this.db, filter);
  }

  unreadCount(): UnreadCount {
    return countUnread(this.db);
  }

  /** Mark one row read; false when it does not exist. */
  markRead(id: number): boolean {
    if (!this.getById(id)) return false;
    this.db.run("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL", [
      this.now(),
      id,
    ]);
    return true;
  }

  /** Mark every unread row read. @returns Rows changed */
  markAllRead(): number {
    return this.db.run("UPDATE notifications SET read_at = ? WHERE read_at IS NULL", [this.now()])
      .changes;
  }

  /** Resolve one row by hand; false when it does not exist. */
  resolve(id: number): boolean {
    if (!this.getById(id)) return false;
    this.db.run("UPDATE notifications SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL", [
      this.now(),
      id,
    ]);
    return true;
  }

  /**
   * Resolve open rows of the given kinds that match a subject, a group key,
   * or a run's PR URL (any that are set).
   *
   * @returns Rows resolved
   */
  resolveMatching(match: ResolveMatch): number {
    if (match.kinds.length === 0) return 0;
    const ors: string[] = [];
    const params: Array<string | number> = [];
    if (match.subject) {
      ors.push("subject = ?");
      params.push(match.subject);
    }
    if (match.groupKey) {
      ors.push("group_key = ?");
      params.push(match.groupKey);
    }
    if (match.runPrUrl && hasTable(this.db, "runs")) {
      ors.push("run_id IN (SELECT id FROM runs WHERE pr_url = ?)");
      params.push(match.runPrUrl);
    }
    if (ors.length === 0) return 0;
    const kinds = match.kinds.map(() => "?").join(", ");
    return this.db.run(
      `UPDATE notifications SET resolved_at = ?
       WHERE resolved_at IS NULL AND kind IN (${kinds}) AND (${ors.join(" OR ")})`,
      [this.now(), ...match.kinds, ...params],
    ).changes;
  }

  /** Mute a group: future emits are dropped and its open row is flagged muted. */
  mute(groupKey: string): void {
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO notification_mutes (group_key, muted_at) VALUES (?, ?) ON CONFLICT(group_key) DO NOTHING",
        [groupKey, this.now()],
      );
      this.db.run("UPDATE notifications SET muted = 1 WHERE group_key = ?", [groupKey]);
    })();
  }

  /** Unmute a group. @returns Whether it was muted */
  unmute(groupKey: string): boolean {
    return this.db.transaction(() => {
      const { changes } = this.db.run("DELETE FROM notification_mutes WHERE group_key = ?", [
        groupKey,
      ]);
      this.db.run("UPDATE notifications SET muted = 0 WHERE group_key = ?", [groupKey]);
      return changes > 0;
    })();
  }

  listMutes(): NotificationMute[] {
    return listNotificationMutes(this.db);
  }
}

/** Whether a table exists (an older or foreign DB may lack it). */
export function hasTable(db: Database, table: string): boolean {
  return (
    db.query("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    null
  );
}

/** Read-path list over any connection (readonly included). */
export function listNotifications(
  db: Database,
  filter: NotificationListFilter = {},
): NotificationPage {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.unresolved) clauses.push("resolved_at IS NULL");
  if (!filter.includeMuted) clauses.push("muted = 0");
  if (filter.severity) {
    clauses.push("severity = ?");
    params.push(filter.severity);
  }
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = pageSize(filter.limit);
  const offset = Math.max(0, Math.floor(filter.offset ?? 0));
  const rows = db
    .query(
      `SELECT * FROM notifications ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const totalRow = parseRowObject(
    db.query(`SELECT COUNT(*) AS n FROM notifications ${where}`).get(...params),
    "notifications count",
  );
  return {
    notifications: rows.map(rowToNotification),
    total: requireNumber(totalRow, "n", "notifications count"),
  };
}

/** Read-path unread count over any connection. */
export function countUnread(db: Database): UnreadCount {
  const row = parseRowObject(
    db
      .query(
        `SELECT COUNT(*) AS unread,
           COALESCE(SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END), 0) AS unread_high
         FROM notifications WHERE read_at IS NULL AND resolved_at IS NULL AND muted = 0`,
      )
      .get(),
    "notifications unread count",
  );
  return {
    unread: requireNumber(row, "unread", "notifications unread count"),
    unreadHigh: requireNumber(row, "unread_high", "notifications unread count"),
  };
}

/** Read-path mute list over any connection. */
export function listNotificationMutes(db: Database): NotificationMute[] {
  return db
    .query("SELECT group_key, muted_at FROM notification_mutes ORDER BY muted_at DESC")
    .all()
    .map((value) => {
      const row = parseRowObject(value, "notification_mutes row");
      return {
        groupKey: requireString(row, "group_key", "notification_mutes row"),
        mutedAt: requireNumber(row, "muted_at", "notification_mutes row"),
      };
    });
}
