/**
 * Delivery bookkeeping in the workspace `queue.db`, so a worker restart never
 * re-sends what it already delivered and never floods a channel with backlog.
 *
 * - `notification_delivery_channels`: per channel, when delivery started
 *   (older notifications are never sent), the last tick that had the channel
 *   configured, and the last digest.
 * - `notification_delivery_ticks`: when the dispatcher last ticked, so a
 *   channel that was removed and later re-added is told apart from a worker
 *   that was simply stopped.
 * - `notification_deliveries`: per channel and notification row, the count
 *   last handled (sent, skipped by filters, routed to the digest, or failed)
 *   and whether the resolve message went out.
 * - `notification_delivery_groups`: per channel and group key, when a message
 *   last went out (the rate limit).
 */

import type { Database } from "bun:sqlite";

import {
  optionalNumber,
  optionalString,
  parseRowObject,
  requireNumber,
} from "../../state/row-parse";
import { hasTable } from "../store";

/** How a notification's latest count was handled on a channel. */
export type DeliveryStatus = "sent" | "skipped" | "digest" | "failed";

export interface ChannelState {
  since: number;
  lastDigestDay?: string;
  lastDigestAt?: number;
}

export interface DeliveryRecord {
  deliveredCount: number;
  status: DeliveryStatus;
  resolvedSent: boolean;
}

/** Create the delivery tables (idempotent). */
export function initDeliverySchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_delivery_channels (
      channel TEXT PRIMARY KEY,
      since INTEGER NOT NULL,
      last_active_at INTEGER,
      last_digest_day TEXT,
      last_digest_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_delivery_ticks (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_tick_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      channel TEXT NOT NULL,
      notification_id INTEGER NOT NULL,
      delivered_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_sent INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      PRIMARY KEY (channel, notification_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_delivery_groups (
      channel TEXT NOT NULL,
      group_key TEXT NOT NULL,
      last_sent_at INTEGER NOT NULL,
      PRIMARY KEY (channel, group_key)
    )
  `);
}

/** Delivery bookkeeping over one writable connection. */
export class DeliveryStateStore {
  constructor(private readonly db: Database) {
    initDeliverySchema(db);
  }

  /** When the previous dispatcher tick ran, if ever. */
  lastTickAt(): number | undefined {
    const raw = this.db
      .query("SELECT last_tick_at FROM notification_delivery_ticks WHERE id = 1")
      .get();
    if (!raw) return undefined;
    return requireNumber(
      parseRowObject(raw, "notification_delivery_ticks row"),
      "last_tick_at",
      "notification_delivery_ticks row",
    );
  }

  recordTick(at: number): void {
    this.db.run(
      `INSERT INTO notification_delivery_ticks (id, last_tick_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_tick_at = excluded.last_tick_at`,
      [at],
    );
  }

  /**
   * Mark the channel configured at `now`. A channel that missed an earlier
   * tick (removed or `enabled = false`, then turned back on) restarts with
   * `since = now` and no digest window, so what it missed is not sent, right
   * away or in the next digest. A stopped worker ticks nothing, so a restart
   * still catches up.
   */
  activate(channel: string, now: number, previousTickAt: number | undefined): void {
    // SQLite evaluates every SET expression against the old row, so all three
    // CASEs see the same pre-update `last_active_at`.
    const missedTick = "last_active_at IS NOT NULL AND ?4 IS NOT NULL AND last_active_at < ?4";
    this.db.run(
      `INSERT INTO notification_delivery_channels (channel, since, last_active_at) VALUES (?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         since = CASE WHEN ${missedTick} THEN excluded.since ELSE since END,
         last_digest_day = CASE WHEN ${missedTick} THEN NULL ELSE last_digest_day END,
         last_digest_at = CASE WHEN ${missedTick} THEN NULL ELSE last_digest_at END,
         last_active_at = excluded.last_active_at`,
      [channel, now, now, previousTickAt ?? null],
    );
  }

  /** The channel's state, created with `since = now` on first sight. */
  channel(channel: string, now: number): ChannelState {
    this.db.run(
      "INSERT INTO notification_delivery_channels (channel, since) VALUES (?, ?) ON CONFLICT(channel) DO NOTHING",
      [channel, now],
    );
    const row = parseRowObject(
      this.db.query("SELECT * FROM notification_delivery_channels WHERE channel = ?").get(channel),
      "notification_delivery_channels row",
    );
    const context = "notification_delivery_channels row";
    const lastDigestDay = optionalString(row, "last_digest_day", context);
    const lastDigestAt = optionalNumber(row, "last_digest_at", context);
    return {
      since: requireNumber(row, "since", context),
      ...(lastDigestDay !== undefined ? { lastDigestDay } : {}),
      ...(lastDigestAt !== undefined ? { lastDigestAt } : {}),
    };
  }

  /**
   * Forget the digest window of a channel ticked without `digest_time`, so
   * adding it back later starts a fresh window instead of reporting the gap.
   */
  clearDigest(channel: string): void {
    this.db.run(
      "UPDATE notification_delivery_channels SET last_digest_day = NULL, last_digest_at = NULL WHERE channel = ? AND last_digest_at IS NOT NULL",
      [channel],
    );
  }

  recordDigest(channel: string, day: string, at: number): void {
    this.db.run(
      "UPDATE notification_delivery_channels SET last_digest_day = ?, last_digest_at = ? WHERE channel = ?",
      [day, at, channel],
    );
  }

  record(
    channel: string,
    notificationId: number,
    entry: { count: number; status: DeliveryStatus; now: number; error?: string },
  ): void {
    this.db.run(
      `INSERT INTO notification_deliveries
         (channel, notification_id, delivered_count, status, updated_at, error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, notification_id) DO UPDATE SET
         delivered_count = excluded.delivered_count,
         -- A row once sent stays "sent" so its resolve message can follow.
         status = CASE WHEN notification_deliveries.status = 'sent' AND excluded.status <> 'sent'
                       THEN 'sent' ELSE excluded.status END,
         updated_at = excluded.updated_at,
         error = excluded.error`,
      [channel, notificationId, entry.count, entry.status, entry.now, entry.error ?? null],
    );
  }

  get(channel: string, notificationId: number): DeliveryRecord | null {
    const raw = this.db
      .query(
        "SELECT delivered_count, status, resolved_sent FROM notification_deliveries WHERE channel = ? AND notification_id = ?",
      )
      .get(channel, notificationId);
    if (!raw) return null;
    const row = parseRowObject(raw, "notification_deliveries row");
    const status = row.status;
    return {
      deliveredCount: requireNumber(row, "delivered_count", "notification_deliveries row"),
      status: status === "sent" || status === "skipped" || status === "digest" ? status : "failed",
      resolvedSent: row.resolved_sent === 1,
    };
  }

  markResolvedSent(channel: string, notificationId: number): void {
    this.db.run(
      "UPDATE notification_deliveries SET resolved_sent = 1 WHERE channel = ? AND notification_id = ?",
      [channel, notificationId],
    );
  }

  lastSentAt(channel: string, groupKey: string): number | undefined {
    const raw = this.db
      .query(
        "SELECT last_sent_at FROM notification_delivery_groups WHERE channel = ? AND group_key = ?",
      )
      .get(channel, groupKey);
    if (!raw) return undefined;
    return requireNumber(
      parseRowObject(raw, "notification_delivery_groups row"),
      "last_sent_at",
      "notification_delivery_groups row",
    );
  }

  recordSent(channel: string, groupKey: string, at: number): void {
    this.db.run(
      `INSERT INTO notification_delivery_groups (channel, group_key, last_sent_at) VALUES (?, ?, ?)
       ON CONFLICT(channel, group_key) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
      [channel, groupKey, at],
    );
  }

  /**
   * Drop bookkeeping for notifications that no longer exist and rate-limit
   * entries older than `olderThanMs`.
   *
   * @returns Rows deleted
   */
  prune(now: number, olderThanMs: number): number {
    let deleted = 0;
    if (hasTable(this.db, "notifications")) {
      deleted += this.db.run(
        "DELETE FROM notification_deliveries WHERE notification_id NOT IN (SELECT id FROM notifications)",
      ).changes;
    }
    deleted += this.db.run("DELETE FROM notification_delivery_groups WHERE last_sent_at < ?", [
      now - olderThanMs,
    ]).changes;
    return deleted;
  }
}
