/**
 * Estimation state
 *
 * Durable record of the tracker task `updated` timestamp captured *after* the
 * last estimation wrote its field and comment. The re-estimation gate in
 * lib/cli/run.ts compares the task's current `updated` against this value.
 *
 * The estimation comment's edit timestamp is not a reliable baseline:
 * Asana stories expose only `created_at` (so a comment update is invisible),
 * and `--skip-comments` writes no comment at all. Persisting the source task
 * timestamp makes the gate independent of tracker comment semantics.
 *
 * Every call is best-effort: storage problems log at most a warning and read
 * as "no state", so estimation still works with an ephemeral or read-only DB.
 */

import { Database } from "bun:sqlite";
import { configureSqliteConnection } from "./sqlite";
import { prepareQueueDbDirectory, resolveQueueDbPath } from "./webhook-queue";

export interface EstimationState {
  taskKey: string;
  tracker?: string;
  /** Tracker task `updated` value read after the estimation writes. */
  taskUpdated: string;
  /** Epoch ms when the estimate completed. */
  estimatedAt: number;
}

/** Inputs for {@link needsEstimation}. */
export interface EstimationGateInput {
  /** Task `updated` from the tracker. */
  taskUpdated: string;
  /** Timestamp of an existing estimation comment, if one exists. */
  commentUpdated?: string;
  /** Durable post-write baseline from {@link getEstimationState}, if any. */
  stateUpdated?: string;
  /** Tracker type that wrote the durable baseline, when known. */
  stateTracker?: string;
  /** Active tracker type for this sweep; scopes the durable baseline. */
  tracker?: string;
  /** Whether this sweep runs with `--skip-comments`. */
  skipComments: boolean;
}

/** Pick the later of two tracker timestamps, ignoring missing values. */
function latestTimestamp(a: string, b: string | undefined): string {
  if (!b) return a;
  return new Date(b) > new Date(a) ? b : a;
}

/**
 * Decide whether a task must be (re-)estimated.
 *
 * The durable state is authoritative because it records the task's `updated`
 * after the previous estimation writes. The comment timestamp is only a
 * fallback for tasks estimated before that state existed; on Asana it is the
 * comment's creation time, which the task's own field write always outruns.
 *
 * With comments enabled, a missing comment means the previous estimate skipped
 * it (or it was deleted), so estimate once to recreate it rather than trusting
 * a stale baseline. Invalid timestamps fail open (estimate) instead of
 * silently skipping forever.
 *
 * Durable state is scoped to the tracker that wrote it: bare numeric task keys
 * (GitHub, GitLab, Azure DevOps) collide across trackers in the same project,
 * so a row from another tracker must read as absent.
 *
 * @param input - Tracker, comment, and durable-state timestamps
 * @returns True when the sweep should invoke the estimation agent
 */
export function needsEstimation(input: EstimationGateInput): boolean {
  const { taskUpdated, commentUpdated, skipComments } = input;
  const stateApplies =
    input.tracker === undefined ||
    (input.stateTracker !== undefined && input.stateTracker === input.tracker);
  const stateUpdated = stateApplies ? input.stateUpdated : undefined;

  const baseline = commentUpdated
    ? latestTimestamp(commentUpdated, stateUpdated)
    : skipComments
      ? stateUpdated
      : undefined;

  if (!baseline) return true;

  const taskTime = new Date(taskUpdated).getTime();
  const baselineTime = new Date(baseline).getTime();
  if (!Number.isFinite(taskTime) || !Number.isFinite(baselineTime)) return true;

  return taskTime > baselineTime;
}

/**
 * SQLite-backed store for per-task estimation state.
 */
export class EstimationStateStore {
  private db: Database;

  /**
   * Open (or create) the estimation-state table in the queue database.
   *
   * @param dbPath - Database path (defaults to the shared queue DB)
   */
  constructor(dbPath: string = resolveQueueDbPath()) {
    prepareQueueDbDirectory(dbPath);

    this.db = new Database(dbPath);
    configureSqliteConnection(this.db);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_estimation_state (
        task_key TEXT PRIMARY KEY,
        tracker TEXT,
        task_updated TEXT NOT NULL,
        estimated_at INTEGER NOT NULL
      )
    `);
  }

  /**
   * Record the task timestamp that the next sweep should treat as estimated.
   *
   * @param taskKey - Task key
   * @param tracker - Tracker type (informational)
   * @param taskUpdated - Tracker task `updated` read after the estimation writes
   */
  recordEstimate(taskKey: string, tracker: string, taskUpdated: string): void {
    this.db.run(
      `INSERT INTO task_estimation_state (task_key, tracker, task_updated, estimated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_key) DO UPDATE SET
         tracker = excluded.tracker,
         task_updated = excluded.task_updated,
         estimated_at = excluded.estimated_at`,
      [taskKey, tracker, taskUpdated, Date.now()],
    );
  }

  /**
   * Fetch the last recorded estimation baseline for a task.
   *
   * @param taskKey - Task key
   * @returns The state, or null when the task was never estimated
   */
  getEstimationState(taskKey: string): EstimationState | null {
    const row = this.db
      .query(
        `SELECT task_key, tracker, task_updated, estimated_at
         FROM task_estimation_state WHERE task_key = ?`,
      )
      .get(taskKey) as {
      task_key: string;
      tracker: string | null;
      task_updated: string;
      estimated_at: number;
    } | null;

    if (!row) {
      return null;
    }
    return {
      taskKey: row.task_key,
      tracker: row.tracker ?? undefined,
      taskUpdated: row.task_updated,
      estimatedAt: row.estimated_at,
    };
  }

  /**
   * Clear state (used when the estimation is invalidated explicitly).
   *
   * @param taskKey - Task key
   */
  clearEstimationState(taskKey: string): void {
    this.db.run(`DELETE FROM task_estimation_state WHERE task_key = ?`, [taskKey]);
  }

  /** Close the database connection (tests). */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Module-level best-effort helpers (mirror retry-state.ts): storage problems
// must never block an estimation sweep.
// ---------------------------------------------------------------------------

let store: EstimationStateStore | null = null;

function getStore(): EstimationStateStore {
  if (!store) {
    store = new EstimationStateStore();
  }
  return store;
}

/** Best-effort {@link EstimationStateStore.recordEstimate}. */
export function recordEstimation(taskKey: string, tracker: string, taskUpdated: string): void {
  try {
    getStore().recordEstimate(taskKey, tracker, taskUpdated);
  } catch (error) {
    console.warn(`⚠️  Failed to record estimation state: ${(error as Error).message}`);
  }
}

/** Best-effort {@link EstimationStateStore.getEstimationState}; errors read as "no state". */
export function getEstimationState(taskKey: string): EstimationState | null {
  try {
    return getStore().getEstimationState(taskKey);
  } catch {
    return null;
  }
}

/** Best-effort {@link EstimationStateStore.clearEstimationState}. */
export function clearEstimationState(taskKey: string): void {
  try {
    getStore().clearEstimationState(taskKey);
  } catch {
    // Fail open: a stale row costs at most one skipped estimation, and any
    // task edit still moves the tracker's `updated` past the stored baseline.
  }
}

/**
 * Settle the durable baseline after an estimation attempt.
 *
 * Only a run that actually wrote the tracker (story-points field and/or
 * estimation comment) may record a baseline. Recording one for a run that
 * wrote nothing would make every later sweep compare the unchanged task
 * `updated` against that baseline and skip forever, even after the missing
 * field or settings are fixed. Clearing instead forces a retry next sweep.
 *
 * @param taskKey - Task key
 * @param tracker - Active tracker type
 * @param wroteTracker - Whether the estimation wrote the field or comment
 * @param taskUpdated - Tracker task `updated` read after the writes
 */
export function settleEstimationBaseline(
  taskKey: string,
  tracker: string,
  wroteTracker: boolean,
  taskUpdated: string,
): void {
  if (wroteTracker) {
    recordEstimation(taskKey, tracker, taskUpdated);
  } else {
    clearEstimationState(taskKey);
  }
}
