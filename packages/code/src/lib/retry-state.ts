/**
 * Retry state
 *
 * Durable record of "this task's last attempt was reported incomplete",
 * persisted in the shared `.devintern-code/queue.db` (previously a loose
 * `incomplete-task-description.txt` under the output directory, which was
 * per-machine and wiped with /tmp).
 *
 * The retry gate (lib/retry-gate.ts) compares the stored description hash
 * and reported-at timestamp against the ticket's current description and
 * comments to decide whether a re-run is warranted.
 *
 * Every call is best-effort: a storage error must never block a run, so
 * reads return null and writes swallow failures (the gate fails open).
 */

import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

import { resolveQueueDbPath } from "./webhook-queue";

export interface RetryState {
  taskKey: string;
  tracker?: string;
  descriptionHash: string;
  /** Epoch ms when the incomplete-implementation comment was posted. */
  reportedAt: number;
  /** Number of attempts that ended incomplete since the last success. */
  attemptCount: number;
}

/** Stable hash of a task description for change detection. */
export function hashDescription(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * SQLite-backed store for per-task retry state.
 */
export class RetryStateStore {
  private db: Database;

  /**
   * Open (or create) the retry-state table in the queue database.
   *
   * @param dbPath - Database path (defaults to the shared queue DB)
   */
  constructor(dbPath: string = resolveQueueDbPath()) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    // The webhook queue / run store may hold connections to the same file.
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_retry_state (
        task_key TEXT PRIMARY KEY,
        tracker TEXT,
        description_hash TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 1
      )
    `);
  }

  /**
   * Record that an attempt ended incomplete (called right after the
   * incomplete-implementation comment is posted to the tracker).
   *
   * @param taskKey - Task key
   * @param tracker - Tracker type (informational)
   * @param description - Task description text at the time of the attempt
   */
  recordIncompleteAttempt(taskKey: string, tracker: string, description: string): void {
    this.db.run(
      `INSERT INTO task_retry_state (task_key, tracker, description_hash, reported_at, attempt_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(task_key) DO UPDATE SET
         tracker = excluded.tracker,
         description_hash = excluded.description_hash,
         reported_at = excluded.reported_at,
         attempt_count = task_retry_state.attempt_count + 1`,
      [taskKey, tracker, hashDescription(description), Date.now()],
    );
  }

  /**
   * Fetch retry state for a task.
   *
   * @param taskKey - Task key
   * @returns The state, or null when no incomplete attempt is on record
   */
  getRetryState(taskKey: string): RetryState | null {
    const row = this.db
      .query(
        `SELECT task_key, tracker, description_hash, reported_at, attempt_count
         FROM task_retry_state WHERE task_key = ?`,
      )
      .get(taskKey) as {
      task_key: string;
      tracker: string | null;
      description_hash: string;
      reported_at: number;
      attempt_count: number;
    } | null;

    if (!row) {
      return null;
    }
    return {
      taskKey: row.task_key,
      tracker: row.tracker ?? undefined,
      descriptionHash: row.description_hash,
      reportedAt: row.reported_at,
      attemptCount: row.attempt_count,
    };
  }

  /**
   * Clear retry state (called when a run completes successfully, so a later
   * reopen of the ticket starts fresh).
   *
   * @param taskKey - Task key
   */
  clearRetryState(taskKey: string): void {
    this.db.run(`DELETE FROM task_retry_state WHERE task_key = ?`, [taskKey]);
  }

  /** Close the database connection (tests). */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Module-level best-effort helpers (mirror run-recorder.ts): storage problems
// log at most a warning and never propagate.
// ---------------------------------------------------------------------------

let store: RetryStateStore | null = null;

function getStore(): RetryStateStore {
  if (!store) {
    store = new RetryStateStore();
  }
  return store;
}

/** Best-effort {@link RetryStateStore.recordIncompleteAttempt}. */
export function recordIncompleteAttempt(
  taskKey: string,
  tracker: string,
  description: string,
): void {
  try {
    getStore().recordIncompleteAttempt(taskKey, tracker, description);
  } catch (error) {
    console.warn(`⚠️  Failed to record retry state: ${(error as Error).message}`);
  }
}

/** Best-effort {@link RetryStateStore.getRetryState}; errors read as "no state". */
export function getRetryState(taskKey: string): RetryState | null {
  try {
    return getStore().getRetryState(taskKey);
  } catch {
    return null;
  }
}

/** Best-effort {@link RetryStateStore.clearRetryState}. */
export function clearRetryState(taskKey: string): void {
  try {
    getStore().clearRetryState(taskKey);
  } catch {
    // Fail open: stale retry state costs at most one skipped run, and the
    // description-hash comparison still unlocks on any edit.
  }
}
