/**
 * Notification center API for the dashboard.
 *
 * | Method | Path                                   | Purpose                                   |
 * | ------ | -------------------------------------- | ----------------------------------------- |
 * | GET    | `/api/notifications`                   | list (`unresolved`, `severity`, `kind`, `includeMuted`, `limit`, `offset`) |
 * | GET    | `/api/notifications/unread-count`      | unread, unresolved, unmuted counts        |
 * | GET    | `/api/notifications/mutes`             | muted group keys                          |
 * | POST   | `/api/notifications/:id/read`          | mark one read                             |
 * | POST   | `/api/notifications/read-all`          | mark every unread row read                |
 * | POST   | `/api/notifications/:id/resolve`       | resolve one                               |
 * | POST   | `/api/notifications/mute`              | `{ "groupKey": "…" }` mute a group        |
 * | POST   | `/api/notifications/unmute`            | `{ "groupKey": "…" }` unmute a group      |
 *
 * GETs open the database read-only and never create it or its tables (a DB
 * from before notifications existed reads as empty). Writes open a writable
 * connection lazily.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

import { configureSqliteConnection } from "../state/sqlite";
import { prepareQueueDbDirectory } from "../state/webhook-queue";
import {
  countUnread,
  DEFAULT_PAGE_SIZE,
  hasTable,
  listNotificationMutes,
  listNotifications,
  MAX_PAGE_SIZE,
  NotificationStore,
} from "../notifications/store";
import { isNotificationKind, isNotificationSeverity } from "../notifications/types";
import type {
  Notification,
  NotificationListFilter,
  NotificationMute,
  UnreadCount,
} from "../notifications/types";
import type { ApiResponse } from "./dashboard-api";

/** `GET /api/notifications` body. */
export interface NotificationListResponse {
  notifications: Notification[];
  total: number;
  limit: number;
  offset: number;
}

/** `GET /api/notifications/unread-count` body. */
export type NotificationUnreadResponse = UnreadCount;

/** `GET /api/notifications/mutes` body. */
export interface NotificationMutesResponse {
  mutes: NotificationMute[];
}

/** Body of a one-row write (`read`, `resolve`). */
export interface NotificationWriteResponse {
  notification: Notification;
}

/** `POST /api/notifications/read-all` body. */
export interface NotificationReadAllResponse {
  updated: number;
}

/** `POST /api/notifications/mute|unmute` body. */
export interface NotificationMuteResponse {
  groupKey: string;
  muted: boolean;
}

/** Parsed `{ groupKey }` request. */
export interface MuteRequest {
  groupKey: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_GROUP_KEY_CHARS = 500;

function parseBoolean(raw: string | null, name: string): Parsed<boolean | undefined> {
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if (raw === "1" || raw === "true") return { ok: true, value: true };
  if (raw === "0" || raw === "false") return { ok: true, value: false };
  return { ok: false, error: `${name} must be true or false` };
}

function parseInteger(
  raw: string | null,
  name: string,
  min: number,
  max: number,
): Parsed<number | undefined> {
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if (!/^\d+$/.test(raw)) return { ok: false, error: `${name} must be an integer` };
  const value = Number(raw);
  if (value < min || value > max) {
    return { ok: false, error: `${name} must be between ${min} and ${max}` };
  }
  return { ok: true, value };
}

/** Parse list query parameters into a {@link NotificationListFilter}. */
export function parseNotificationListQuery(
  params: URLSearchParams,
): Parsed<NotificationListFilter> {
  const unresolved = parseBoolean(params.get("unresolved"), "unresolved");
  if (!unresolved.ok) return unresolved;
  const includeMuted = parseBoolean(params.get("includeMuted"), "includeMuted");
  if (!includeMuted.ok) return includeMuted;
  const limit = parseInteger(params.get("limit"), "limit", 1, MAX_PAGE_SIZE);
  if (!limit.ok) return limit;
  const offset = parseInteger(params.get("offset"), "offset", 0, Number.MAX_SAFE_INTEGER);
  if (!offset.ok) return offset;
  const severity = params.get("severity");
  if (severity && !isNotificationSeverity(severity)) {
    return { ok: false, error: "severity must be high or normal" };
  }
  const kind = params.get("kind");
  if (kind && !isNotificationKind(kind)) return { ok: false, error: `unknown kind "${kind}"` };
  return {
    ok: true,
    value: {
      ...(unresolved.value !== undefined ? { unresolved: unresolved.value } : {}),
      ...(includeMuted.value !== undefined ? { includeMuted: includeMuted.value } : {}),
      ...(severity && isNotificationSeverity(severity) ? { severity } : {}),
      ...(kind && isNotificationKind(kind) ? { kind } : {}),
      limit: limit.value ?? DEFAULT_PAGE_SIZE,
      offset: offset.value ?? 0,
    },
  };
}

/** Parse a `{ "groupKey": "…" }` body. */
export function parseMuteRequest(body: unknown): Parsed<MuteRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "expected a JSON object with groupKey" };
  }
  const groupKey = (body as Record<string, unknown>).groupKey;
  if (typeof groupKey !== "string" || !groupKey.trim()) {
    return { ok: false, error: "groupKey must be a non-empty string" };
  }
  if (groupKey.length > MAX_GROUP_KEY_CHARS) {
    return { ok: false, error: `groupKey must be at most ${MAX_GROUP_KEY_CHARS} characters` };
  }
  return { ok: true, value: { groupKey } };
}

function parseId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function badRequest(error: string): ApiResponse {
  return { status: 400, body: { error } };
}

const NOT_FOUND: ApiResponse = { status: 404, body: { error: "notification not found" } };

/** Notification handlers over one database file. */
export class DashboardNotifications {
  constructor(private readonly dbPath: string) {}

  /** Run a read over a read-only connection; `fallback` when the DB or table is missing. */
  private read<T>(fallback: T, read: (db: Database) => T): T {
    if (!existsSync(this.dbPath)) return fallback;
    let db: Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true });
      configureSqliteConnection(db, { readonly: true });
      return hasTable(db, "notifications") ? read(db) : fallback;
    } catch {
      // Missing table, locked/corrupt file, or a file removed between check and
      // open: degrade to an empty page like the other dashboard read helpers
      // instead of failing the whole request.
      return fallback;
    } finally {
      db?.close();
    }
  }

  /** Run a write over a short-lived writable connection (the server holds none open). */
  private write<T>(work: (store: NotificationStore) => T): T {
    prepareQueueDbDirectory(this.dbPath);
    const db = new Database(this.dbPath);
    try {
      configureSqliteConnection(db);
      return work(new NotificationStore(db));
    } finally {
      db.close();
    }
  }

  /** Dispatch a notification GET route; null when the path is not one. */
  routeGet(pathname: string, params: URLSearchParams): ApiResponse | null {
    if (pathname === "/api/notifications") return this.list(params);
    if (pathname === "/api/notifications/unread-count") return this.unreadCount();
    if (pathname === "/api/notifications/mutes") return this.mutes();
    return null;
  }

  list(params: URLSearchParams): ApiResponse {
    const filter = parseNotificationListQuery(params);
    if (!filter.ok) return badRequest(filter.error);
    const page = this.read({ notifications: [], total: 0 }, (db) =>
      listNotifications(db, filter.value),
    );
    const body: NotificationListResponse = {
      ...page,
      limit: filter.value.limit ?? DEFAULT_PAGE_SIZE,
      offset: filter.value.offset ?? 0,
    };
    return { status: 200, body };
  }

  unreadCount(): ApiResponse {
    const body: NotificationUnreadResponse = this.read({ unread: 0, unreadHigh: 0 }, countUnread);
    return { status: 200, body };
  }

  mutes(): ApiResponse {
    const body: NotificationMutesResponse = {
      mutes: this.read<NotificationMute[]>([], (db) =>
        hasTable(db, "notification_mutes") ? listNotificationMutes(db) : [],
      ),
    };
    return { status: 200, body };
  }

  markRead(rawId: string): ApiResponse {
    return this.writeOne(rawId, (store, id) => store.markRead(id));
  }

  resolve(rawId: string): ApiResponse {
    return this.writeOne(rawId, (store, id) => store.resolve(id));
  }

  markAllRead(): ApiResponse {
    if (!existsSync(this.dbPath)) {
      const empty: NotificationReadAllResponse = { updated: 0 };
      return { status: 200, body: empty };
    }
    const body: NotificationReadAllResponse = {
      updated: this.write((store) => store.markAllRead()),
    };
    return { status: 200, body };
  }

  mute(rawBody: unknown): ApiResponse {
    const request = parseMuteRequest(rawBody);
    if (!request.ok) return badRequest(request.error);
    this.write((store) => store.mute(request.value.groupKey));
    const body: NotificationMuteResponse = { groupKey: request.value.groupKey, muted: true };
    return { status: 200, body };
  }

  unmute(rawBody: unknown): ApiResponse {
    const request = parseMuteRequest(rawBody);
    if (!request.ok) return badRequest(request.error);
    this.write((store) => store.unmute(request.value.groupKey));
    const body: NotificationMuteResponse = { groupKey: request.value.groupKey, muted: false };
    return { status: 200, body };
  }

  private writeOne(
    rawId: string,
    write: (store: NotificationStore, id: number) => boolean,
  ): ApiResponse {
    const id = parseId(rawId);
    if (id === null) return badRequest("notification id must be a positive integer");
    if (!existsSync(this.dbPath)) return NOT_FOUND;
    const notification = this.write((store) => (write(store, id) ? store.getById(id) : null));
    if (!notification) return NOT_FOUND;
    const body: NotificationWriteResponse = { notification };
    return { status: 200, body };
  }
}
