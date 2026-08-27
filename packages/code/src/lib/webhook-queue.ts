/**
 * Webhook Queue with SQLite Persistence
 *
 * Provides durable storage for webhook events to ensure resilience
 * against server crashes. Events are persisted before processing
 * and only removed after successful completion.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

import { findConfigDir } from "@devintern/utils";

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
  /**
   * Path of a pre-relocation queue database. When the target `dbPath` does not
   * exist yet but this legacy file does, it is copied over once so pending
   * events and rate-limit state survive the move out of /tmp.
   */
  legacyDbPath?: string;
  /**
   * Open the DB read-only without creating dirs/tables or migrating (dashboard
   * reads alongside a live worker; throws when the file does not exist).
   */
  readonly?: boolean;
}

/** Old default location; /tmp is wiped on reboot so durable state cannot live there. */
export const LEGACY_DB_PATH = "/tmp/devintern-webhooks/queue.db";

/** How long processed-event ids are retained for dedupe (90 days). */
const PROCESSED_EVENTS_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export const DEFAULT_MAX_RETRIES = 3;

export type BaseSyncEventStatus = "pending" | "completed" | "failed";

export interface BaseSyncEvent {
  externalId: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  headObservedAt: number;
  attempts: number;
  status: BaseSyncEventStatus;
  lastError?: string;
}

/**
 * Resolve the queue database path: `WEBHOOK_QUEUE_DB` env override, otherwise
 * `queue.db` inside the nearest `.devintern-code` directory so queue state,
 * cursors, and run records persist across reboots.
 *
 * The config directory is searched upwards from `projectDir` (same traversal
 * as `.env` resolution), so running from a subdirectory of the project reuses
 * the project's database instead of creating a stray one next to the cwd.
 *
 * @param projectDir - Directory to search from (defaults to the current working directory)
 */
export function resolveQueueDbPath(projectDir: string = process.cwd()): string {
  if (process.env.WEBHOOK_QUEUE_DB) {
    return process.env.WEBHOOK_QUEUE_DB;
  }

  const configDir = findConfigDir({ configDirName: ".devintern-code", startDir: projectDir });
  return join(configDir ?? join(projectDir, ".devintern-code"), "queue.db");
}

/** Local ignore pattern for the state database, at any depth. */
const QUEUE_DB_IGNORE_PATTERN = "**/.devintern-code/queue.db*";

/**
 * Keep the state database out of git without touching the project's committed
 * `.gitignore`, using the per-clone `.git/info/exclude`.
 *
 * Projects initialised before `.devintern-code/*` was ignored wholesale leave
 * `queue.db` untracked-but-visible, where `git add -A` sweeps it into the
 * implementation commit and `git clean` deletes it mid-run. Best-effort: any
 * failure (not a repo, read-only .git) is ignored.
 */
function ensureDbIgnored(dbPath: string): void {
  try {
    const dir = dirname(dbPath);

    // Already covered by a .gitignore (or a previous run of this helper).
    const check = spawnSync("git", ["check-ignore", "-q", dbPath], { cwd: dir });
    if (check.status !== 1) {
      return; // 0 = ignored, 128 = not a git repository
    }

    const gitDir = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
    });
    if (gitDir.status !== 0) {
      return;
    }

    const excludeFile = join(resolve(dir, gitDir.stdout.trim()), "info", "exclude");
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (existing.includes(QUEUE_DB_IGNORE_PATTERN)) {
      return;
    }

    mkdirSync(dirname(excludeFile), { recursive: true });
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(
      excludeFile,
      `${separator}\n# @devintern/code local state (not committed)\n${QUEUE_DB_IGNORE_PATTERN}\n`,
    );
  } catch {
    // Ignoring the database is a convenience, never a requirement.
  }
}

/**
 * Create the state database's directory and keep the database itself out of
 * git. Shared by every store that opens `queue.db` for writing.
 *
 * @param dbPath - Path of the database file about to be opened
 */
export function prepareQueueDbDirectory(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  ensureDbIgnored(dbPath);
}

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
    const dbPath = config.dbPath || resolveQueueDbPath();
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.verbose = config.verbose ?? false;

    if (config.readonly) {
      this.db = new Database(dbPath, { readonly: true });
      this.db.run("PRAGMA busy_timeout = 5000");
      return;
    }

    prepareQueueDbDirectory(dbPath);

    this.migrateLegacyDb(dbPath, config.legacyDbPath);

    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  /**
   * One-time copy of a legacy queue database (e.g. the old /tmp location) to
   * the new path, so pending events and rate-limit state are not lost.
   */
  private migrateLegacyDb(dbPath: string, legacyDbPath?: string): void {
    if (
      !legacyDbPath ||
      legacyDbPath === dbPath ||
      existsSync(dbPath) ||
      !existsSync(legacyDbPath)
    ) {
      return;
    }
    copyFileSync(legacyDbPath, dbPath);
    // Carry over WAL/SHM companions if a previous process left them behind.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${legacyDbPath}${suffix}`)) {
        copyFileSync(`${legacyDbPath}${suffix}`, `${dbPath}${suffix}`);
      }
    }
    if (this.verbose) {
      console.log(`[WebhookQueue] Migrated legacy queue database from ${legacyDbPath}`);
    }
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

    // Provider delivery/comment ids already handled. Retention here is
    // independent of the events table (completed event rows are deleted;
    // dedupe state must outlive them).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS processed_events (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        processed_at INTEGER NOT NULL,
        PRIMARY KEY (source, external_id)
      )
    `);

    // Durable base-branch advancement events. This is deliberately separate
    // from webhook_events: eligibility is discovered by polling, deferrals do
    // not consume attempts, and the deterministic id is also the eventual
    // processed_events key.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS base_sync_events (
        external_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        head_observed_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        updated_at INTEGER NOT NULL
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

  /**
   * Check whether a provider-issued event id was already handled.
   *
   * @param source - Event origin (e.g. `github`)
   * @param externalId - Provider delivery/comment/review id
   */
  hasProcessed(source: string, externalId: string): boolean {
    const row = this.db
      .query(`SELECT 1 FROM processed_events WHERE source = ? AND external_id = ?`)
      .get(source, externalId);
    return row !== null && row !== undefined;
  }

  /**
   * Record a provider-issued event id as handled (idempotent).
   *
   * @param source - Event origin (e.g. `github`)
   * @param externalId - Provider delivery/comment/review id
   */
  markProcessed(source: string, externalId: string): void {
    this.db.run(
      `INSERT INTO processed_events (source, external_id, processed_at) VALUES (?, ?, ?)
       ON CONFLICT(source, external_id) DO NOTHING`,
      [source, externalId, Date.now()],
    );
  }

  /** Release a provisional processed marker when work was deferred before execution. */
  unmarkProcessed(source: string, externalId: string): void {
    this.db.run(`DELETE FROM processed_events WHERE source = ? AND external_id = ?`, [
      source,
      externalId,
    ]);
  }

  /** Configured retry ceiling, shared by webhook and base-sync work. */
  getMaxRetries(): number {
    return this.maxRetries;
  }

  /**
   * Create or observe a deterministic base-sync event. Head changes reset only
   * its quiet timer; a new base atomically supersedes older pending work for
   * the same PR.
   */
  observeBaseSyncEvent(input: {
    externalId: string;
    repo: string;
    prNumber: number;
    baseSha: string;
    headSha: string;
    now?: number;
  }): BaseSyncEvent {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      this.db.run(
        `DELETE FROM base_sync_events
         WHERE repo = ? AND pr_number = ? AND status = 'pending' AND external_id <> ?`,
        [input.repo, input.prNumber, input.externalId],
      );
      this.db.run(
        `INSERT INTO base_sync_events
           (external_id, repo, pr_number, base_sha, head_sha, head_observed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           head_sha = excluded.head_sha,
           head_observed_at = CASE
             WHEN base_sync_events.head_sha <> excluded.head_sha THEN excluded.head_observed_at
             ELSE base_sync_events.head_observed_at
           END,
           updated_at = excluded.updated_at`,
        [input.externalId, input.repo, input.prNumber, input.baseSha, input.headSha, now, now],
      );
      return this.getBaseSyncEvent(input.externalId)!;
    })();
  }

  /** Load durable retry and head-stability state for a base-sync event. */
  getBaseSyncEvent(externalId: string): BaseSyncEvent | null {
    const row = this.db
      .query(`SELECT * FROM base_sync_events WHERE external_id = ?`)
      .get(externalId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      externalId: row.external_id as string,
      repo: row.repo as string,
      prNumber: row.pr_number as number,
      baseSha: row.base_sha as string,
      headSha: row.head_sha as string,
      headObservedAt: row.head_observed_at as number,
      attempts: row.attempts as number,
      status: row.status as BaseSyncEventStatus,
      lastError: (row.last_error as string | null) ?? undefined,
    };
  }

  /** Consume one real execution attempt. Eligibility deferrals never call this. */
  beginBaseSyncAttempt(externalId: string): number {
    this.db.run(
      `UPDATE base_sync_events SET attempts = attempts + 1, updated_at = ? WHERE external_id = ?`,
      [Date.now(), externalId],
    );
    return this.getBaseSyncEvent(externalId)?.attempts ?? 0;
  }

  /** Undo a tentative attempt when the resolver detects concurrent branch movement. */
  deferBaseSyncAttempt(externalId: string): void {
    this.db.run(
      `UPDATE base_sync_events
       SET attempts = MAX(0, attempts - 1), updated_at = ? WHERE external_id = ?`,
      [Date.now(), externalId],
    );
  }

  /** Persist a retryable failure, or terminally exhaust the event. */
  failBaseSyncEvent(externalId: string, error: string): boolean {
    const event = this.getBaseSyncEvent(externalId);
    if (!event) return false;
    const exhausted = event.attempts >= this.maxRetries;
    this.db.run(
      `UPDATE base_sync_events SET status = ?, last_error = ?, updated_at = ? WHERE external_id = ?`,
      [exhausted ? "failed" : "pending", error, Date.now(), externalId],
    );
    return exhausted;
  }

  /** Mark a success/safe skip terminal and publish the canonical dedupe key. */
  completeBaseSyncEvent(source: string, externalId: string): void {
    this.db.transaction(() => {
      this.db.run(
        `UPDATE base_sync_events SET status = 'completed', updated_at = ? WHERE external_id = ?`,
        [Date.now(), externalId],
      );
      this.markProcessed(source, externalId);
    })();
  }

  /** Mark an exhausted event processed so restarts cannot revive it. */
  exhaustBaseSyncEvent(source: string, externalId: string, error: string): void {
    this.db.transaction(() => {
      this.db.run(
        `UPDATE base_sync_events SET status = 'failed', last_error = ?, updated_at = ? WHERE external_id = ?`,
        [error, Date.now(), externalId],
      );
      this.markProcessed(source, externalId);
    })();
  }

  /** Explicit operator retry for an exhausted base-SHA event. */
  resetBaseSyncEvent(source: string, externalId: string): void {
    this.db.transaction(() => {
      this.db.run(
        `UPDATE base_sync_events
         SET status = 'pending', attempts = 0, last_error = NULL,
             head_observed_at = ?, updated_at = ?
         WHERE external_id = ?`,
        [Date.now(), Date.now(), externalId],
      );
      this.db.run(`DELETE FROM processed_events WHERE source = ? AND external_id = ?`, [
        source,
        externalId,
      ]);
    })();
  }

  /**
   * Delete expired processed ids and their terminal base-sync event rows.
   * Pending base-sync work is retained regardless of age.
   *
   * @param maxAgeMs - Maximum age before deletion (default 90 days)
   * @returns Number of rows deleted
   */
  cleanupProcessedEvents(maxAgeMs = PROCESSED_EVENTS_MAX_AGE_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    return this.db.transaction(() => {
      const result = this.db.run(`DELETE FROM processed_events WHERE processed_at < ?`, [cutoff]);
      this.db.run(
        `DELETE FROM base_sync_events
         WHERE status IN ('completed', 'failed') AND updated_at < ?`,
        [cutoff],
      );
      return result.changes;
    })();
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
