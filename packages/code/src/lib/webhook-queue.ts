/**
 * Webhook Queue with SQLite Persistence
 *
 * Provides durable storage for webhook events to ensure resilience
 * against server crashes. Events are persisted before processing
 * and only removed after successful completion.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export type WebhookEventStatus = "pending" | "processing" | "completed" | "failed";

export interface WebhookEvent {
  id: string;
  eventType: string;
  payload: string; // JSON stringified
  status: WebhookEventStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastError?: string;
}

export interface WebhookQueueConfig {
  dbPath: string;
  maxRetries?: number;
  verbose?: boolean;
}

const DEFAULT_DB_PATH = "/tmp/devintern-webhooks/queue.db";
const DEFAULT_MAX_RETRIES = 3;

/**
 * SQLite-backed webhook queue for durable event processing.
 */
export class WebhookQueue {
  private db: Database;
  private maxRetries: number;
  private verbose: boolean;

  /**
   * Open (or create) the SQLite-backed webhook queue database.
   *
   * @param config - Database path, retry limit, and verbosity
   */
  constructor(config: Partial<WebhookQueueConfig> = {}) {
    const dbPath = config.dbPath || DEFAULT_DB_PATH;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.verbose = config.verbose ?? false;

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  /** Create tables and indexes if they do not exist. */
  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      )
    `);

    // Index for finding pending/processing events
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_webhook_events_status
      ON webhook_events(status)
    `);

    // Key/value store for cross-restart state (e.g. per-harness rate limits).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS webhook_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    if (this.verbose) {
      console.log("[WebhookQueue] Database initialized");
    }
  }

  /** Meta key for a harness's rate-limit reset time. */
  private rateLimitKey(harness: string): string {
    return `rate_limit:${harness}`;
  }

  /**
   * Persist the epoch (ms) until which a given agent harness is rate-limited.
   *
   * @param harness - Harness name (e.g. `claude-code`)
   * @param untilMs - Epoch ms when the limit resets
   */
  setRateLimit(harness: string, untilMs: number): void {
    this.db.run(
      `INSERT INTO webhook_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [this.rateLimitKey(harness), String(untilMs)],
    );
  }

  /** Remove a harness's persisted rate-limit, if any. */
  clearRateLimit(harness: string): void {
    this.db.run(`DELETE FROM webhook_meta WHERE key = ?`, [this.rateLimitKey(harness)]);
  }

  /**
   * Read the persisted rate-limit reset epoch for a harness.
   *
   * @param harness - Harness name
   * @returns Epoch ms, or `null` when not rate-limited
   */
  getRateLimit(harness: string): number | null {
    const row = this.db
      .query(`SELECT value FROM webhook_meta WHERE key = ?`)
      .get(this.rateLimitKey(harness)) as { value: string } | undefined;
    if (!row) {
      return null;
    }
    const ms = Number(row.value);
    return Number.isFinite(ms) ? ms : null;
  }

  /** Generate a unique event id (`timestamp-random`). */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Persist a new webhook event as `pending`.
   *
   * @param eventType - GitHub event type string
   * @param payload - Parsed webhook JSON payload
   * @returns Generated event id
   */
  enqueue(eventType: string, payload: unknown): string {
    const id = this.generateId();
    const now = Date.now();
    const payloadStr = JSON.stringify(payload);

    this.db.run(
      `INSERT INTO webhook_events (id, event_type, payload, status, created_at, updated_at, attempts)
       VALUES (?, ?, ?, 'pending', ?, ?, 0)`,
      [id, eventType, payloadStr, now, now],
    );

    if (this.verbose) {
      console.log(`[WebhookQueue] Enqueued event ${id} (${eventType})`);
    }

    return id;
  }

  /**
   * Mark an event as actively processing and increment attempt count.
   *
   * @param id - Event id
   */
  markProcessing(id: string): void {
    const now = Date.now();
    this.db.run(
      `UPDATE webhook_events
       SET status = 'processing', updated_at = ?, attempts = attempts + 1
       WHERE id = ?`,
      [now, id],
    );

    if (this.verbose) {
      console.log(`[WebhookQueue] Event ${id} marked as processing`);
    }
  }

  /**
   * Remove a successfully processed event from the queue.
   *
   * @param id - Event id
   */
  markCompleted(id: string): void {
    this.db.run(`DELETE FROM webhook_events WHERE id = ?`, [id]);

    if (this.verbose) {
      console.log(`[WebhookQueue] Event ${id} completed and removed`);
    }
  }

  /**
   * Revert an event to `pending` without counting a failed attempt.
   *
   * Used when processing is deferred by a global condition (e.g. an agent
   * usage limit) rather than a real task failure — the run that just happened
   * should not count toward the retry limit.
   *
   * @param id - Event id
   */
  requeuePending(id: string): void {
    this.db.run(
      `UPDATE webhook_events
       SET status = 'pending', updated_at = ?, attempts = MAX(0, attempts - 1)
       WHERE id = ?`,
      [Date.now(), id],
    );
  }

  /**
   * Record a processing failure; requeue or mark permanently failed.
   *
   * @param id - Event id
   * @param error - Error message to persist
   */
  markFailed(id: string, error: string): void {
    const now = Date.now();
    const event = this.getEvent(id);

    if (!event) {
      return;
    }

    // Check if we should retry or mark as permanently failed
    if (event.attempts >= this.maxRetries) {
      this.db.run(
        `UPDATE webhook_events
         SET status = 'failed', updated_at = ?, last_error = ?
         WHERE id = ?`,
        [now, error, id],
      );

      if (this.verbose) {
        console.log(
          `[WebhookQueue] Event ${id} permanently failed after ${event.attempts} attempts`,
        );
      }
    } else {
      // Reset to pending for retry
      this.db.run(
        `UPDATE webhook_events
         SET status = 'pending', updated_at = ?, last_error = ?
         WHERE id = ?`,
        [now, error, id],
      );

      if (this.verbose) {
        console.log(
          `[WebhookQueue] Event ${id} marked for retry (attempt ${event.attempts}/${this.maxRetries})`,
        );
      }
    }
  }

  /**
   * Load a single queued event by id.
   *
   * @param id - Event id
   */
  getEvent(id: string): WebhookEvent | null {
    const row = this.db
      .query(
        `SELECT id, event_type, payload, status, created_at, updated_at, attempts, last_error
       FROM webhook_events WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | null;

    if (!row) {
      return null;
    }

    return this.rowToEvent(row);
  }

  /** Return pending and in-flight events ordered by creation time (for recovery). */
  getPendingEvents(): WebhookEvent[] {
    const rows = this.db
      .query(
        `SELECT id, event_type, payload, status, created_at, updated_at, attempts, last_error
       FROM webhook_events
       WHERE status IN ('pending', 'processing')
       ORDER BY created_at ASC`,
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => this.rowToEvent(row));
  }

  /** Return permanently failed events for inspection or manual retry. */
  getFailedEvents(): WebhookEvent[] {
    const rows = this.db
      .query(
        `SELECT id, event_type, payload, status, created_at, updated_at, attempts, last_error
       FROM webhook_events
       WHERE status = 'failed'
       ORDER BY created_at ASC`,
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => this.rowToEvent(row));
  }

  /**
   * Reset a failed event back to `pending` with zero attempts.
   *
   * @param id - Event id
   */
  resetEvent(id: string): void {
    const now = Date.now();
    this.db.run(
      `UPDATE webhook_events
       SET status = 'pending', updated_at = ?, attempts = 0, last_error = NULL
       WHERE id = ?`,
      [now, id],
    );

    if (this.verbose) {
      console.log(`[WebhookQueue] Event ${id} reset to pending`);
    }
  }

  /** Return counts of events grouped by status. */
  getStats(): { pending: number; processing: number; failed: number } {
    const stats = this.db
      .query(`
      SELECT status, COUNT(*) as count
      FROM webhook_events
      GROUP BY status
    `)
      .all() as { status: string; count: number }[];

    const result = { pending: 0, processing: 0, failed: 0 };
    for (const row of stats) {
      if (row.status === "pending") result.pending = row.count;
      if (row.status === "processing") result.processing = row.count;
      if (row.status === "failed") result.failed = row.count;
    }

    return result;
  }

  /**
   * Delete old permanently failed events.
   *
   * @param maxAgeMs - Maximum age before deletion (default 7 days)
   * @returns Number of rows deleted
   */
  cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.run(
      `DELETE FROM webhook_events WHERE status = 'failed' AND updated_at < ?`,
      [cutoff],
    );

    if (this.verbose && result.changes > 0) {
      console.log(`[WebhookQueue] Cleaned up ${result.changes} old failed events`);
    }

    return result.changes;
  }

  /** Map a SQLite row to a {@link WebhookEvent}. */
  private rowToEvent(row: Record<string, unknown>): WebhookEvent {
    return {
      id: row.id as string,
      eventType: row.event_type as string,
      payload: row.payload as string,
      status: row.status as WebhookEventStatus,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      attempts: row.attempts as number,
      lastError: row.last_error as string | undefined,
    };
  }

  /** Close the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }
}
