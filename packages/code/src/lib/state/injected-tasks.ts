/**
 * Durable queue for ad-hoc ("injected") tasks created by `devintern worker add`.
 *
 * A tracker is not required to run a one-off task: the CLI materializes the
 * title/body as a local markdown task file and inserts a `pending` row here.
 * The worker's injected-task acquirer drains rows through the normal fleet
 * pipeline (routing is explicit — the row names its repo), so the task gets a
 * checkout, agent run, and PR exactly like a tracker-sourced task.
 *
 * Rows are persisted in the central workspace DB (`state/queue.db`), so an
 * enqueued task survives worker restarts and is picked up on the next poll.
 * An optional `idempotency_key` makes retried automation enqueue at most one
 * *active* task: while a task with the key is `pending`/`running` a retry
 * reuses it, and once it settles a later enqueue with the same key starts a new
 * occurrence (so a fixed key still drives a recurring job). `task_key` is
 * unique too (it names the branch and worktree), and the worker periodically
 * prunes settled rows and their prompt files, so neither the table nor the
 * injected directory grows without bound over a long-lived daemon.
 */

import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";

import { prepareQueueDbDirectory } from "./webhook-queue";
import { configureSqliteConnection } from "./sqlite";

export type InjectedTaskStatus = "pending" | "running" | "done" | "failed";

/** One ad-hoc task enqueued for a workspace repo. */
export interface InjectedTask {
  id: number;
  /** Generated local key (`local-<slug>`); also the branch name component. */
  taskKey: string;
  /** `[[repos]]` name the task is pinned to. */
  repo: string;
  title: string;
  body: string;
  /** Absolute path of the markdown prompt materialized for this task. */
  taskFile: string;
  idempotencyKey?: string;
  /** Who enqueued it (`local:add` unless overridden). */
  actor: string;
  status: InjectedTaskStatus;
  message?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

interface InjectedTaskRow {
  id: number;
  task_key: string;
  repo: string;
  title: string;
  body: string;
  task_file: string;
  idempotency_key: string | null;
  actor: string;
  status: string;
  message: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function rowToInjectedTask(row: InjectedTaskRow): InjectedTask {
  return {
    id: row.id,
    taskKey: row.task_key,
    repo: row.repo,
    title: row.title,
    body: row.body,
    taskFile: row.task_file,
    idempotencyKey: row.idempotency_key ?? undefined,
    actor: row.actor,
    status: row.status as InjectedTaskStatus,
    message: row.message ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

export interface EnqueueInjectedTaskInput {
  taskKey: string;
  repo: string;
  title: string;
  body: string;
  taskFile: string;
  idempotencyKey?: string;
  actor?: string;
  createdAt?: number;
}

export interface EnqueueInjectedTaskResult {
  task: InjectedTask;
  /** True when the idempotency key matched an existing row (no new task). */
  deduplicated: boolean;
}

/**
 * SQLite-backed queue of injected tasks, stored in the workspace DB.
 */
export class InjectedTaskStore {
  private db: Database | null = null;
  private closed = false;

  constructor(private dbPath: string) {}

  /** Whether `close()` has released this store's connection. */
  isClosed(): boolean {
    return this.closed;
  }

  private ensureDb(): Database {
    // `close()` released the SQLite file. Reopening it here would resurrect the
    // connection after shutdown (e.g. an in-flight task settling through a
    // handle the successor worker already took over), so fail loudly instead of
    // silently recreating the file. `pruneSettled` is the one expected
    // post-close caller and guards against this itself.
    if (this.closed) {
      throw new Error("InjectedTaskStore is closed");
    }
    if (this.db) {
      return this.db;
    }
    prepareQueueDbDirectory(this.dbPath);
    this.db = new Database(this.dbPath);
    configureSqliteConnection(this.db);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS injected_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_key TEXT NOT NULL,
        repo TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        task_file TEXT NOT NULL,
        idempotency_key TEXT,
        actor TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        message TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_injected_tasks_status ON injected_tasks(status)");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_injected_tasks_finished_at ON injected_tasks(finished_at)",
    );
    // `task_key` names the worktree/branch, so two rows sharing one key would
    // race the same checkout. Enforce uniqueness; `enqueueNewTask` re-derives a
    // suffixed key when a concurrent caller claims the key first.
    try {
      this.db.run(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_injected_tasks_task_key ON injected_tasks(task_key)",
      );
    } catch {
      // A DB written before the constraint existed may already hold duplicate
      // keys; keep the store open (with a plain index) rather than fail closed.
      this.db.run(
        "CREATE INDEX IF NOT EXISTS idx_injected_tasks_task_key ON injected_tasks(task_key)",
      );
    }
    // A partial unique index lets any number of tasks run without an
    // idempotency key while still deduping the ones that carry one.
    this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_injected_tasks_idempotency
       ON injected_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL`,
    );
    return this.db;
  }

  /**
   * Insert a task as `pending` (idempotent while an earlier task with the same
   * key is still active).
   *
   * When `idempotencyKey` matches a `pending`/`running` task, that row is
   * returned and nothing is inserted, so a retried automation cannot create a
   * duplicate. A settled (`done`/`failed`) row only retains the key as history;
   * it is released so the key can drive a new occurrence (e.g. a nightly job
   * that must run every night even though the key is fixed).
   */
  enqueue(input: EnqueueInjectedTaskInput): EnqueueInjectedTaskResult {
    const db = this.ensureDb();
    if (input.idempotencyKey) {
      const existing = this.findActiveByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return { task: existing, deduplicated: true };
      }
    }
    try {
      if (input.idempotencyKey) {
        // Release the key from any settled row so the partial unique index
        // admits this new occurrence. A still-active row was handled above.
        db.run(
          `UPDATE injected_tasks SET idempotency_key = NULL
           WHERE idempotency_key = ? AND status IN ('done', 'failed')`,
          [input.idempotencyKey],
        );
      }
      db.query(
        `INSERT INTO injected_tasks
           (task_key, repo, title, body, task_file, idempotency_key, actor, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(
        input.taskKey,
        input.repo,
        input.title,
        input.body,
        input.taskFile,
        input.idempotencyKey ?? null,
        input.actor ?? "local:add",
        input.createdAt ?? Date.now(),
      );
    } catch (error) {
      // A concurrent caller claimed the same idempotency key between the read
      // above and this insert: resolve to their row instead of failing.
      if (input.idempotencyKey) {
        const existing = this.findActiveByIdempotencyKey(input.idempotencyKey);
        if (existing) return { task: existing, deduplicated: true };
      }
      throw error;
    }
    const row = db
      .query("SELECT * FROM injected_tasks WHERE id = last_insert_rowid()")
      .get() as InjectedTaskRow;
    return { task: rowToInjectedTask(row), deduplicated: false };
  }

  /**
   * Look up a `pending`/`running` task by its idempotency key. Settled rows are
   * excluded: they no longer block a new enqueue under the same key.
   */
  findActiveByIdempotencyKey(key: string): InjectedTask | null {
    const row = this.ensureDb()
      .query(
        "SELECT * FROM injected_tasks WHERE idempotency_key = ? AND status IN ('pending', 'running')",
      )
      .get(key) as InjectedTaskRow | null;
    return row ? rowToInjectedTask(row) : null;
  }

  /** Whether any task already uses this generated local key. */
  hasTaskKey(taskKey: string): boolean {
    const row = this.ensureDb()
      .query("SELECT 1 AS one FROM injected_tasks WHERE task_key = ? LIMIT 1")
      .get(taskKey) as { one: number } | null;
    return row !== null;
  }

  /** Load a task by primary key (used by `--wait` polling). */
  getById(id: number): InjectedTask | null {
    const row = this.ensureDb()
      .query("SELECT * FROM injected_tasks WHERE id = ?")
      .get(id) as InjectedTaskRow | null;
    return row ? rowToInjectedTask(row) : null;
  }

  /** Load a task by its unique key (dashboard retry, `worker add --resume`). */
  getByTaskKey(taskKey: string): InjectedTask | null {
    const row = this.ensureDb()
      .query("SELECT * FROM injected_tasks WHERE task_key = ?")
      .get(taskKey) as InjectedTaskRow | null;
    return row ? rowToInjectedTask(row) : null;
  }

  /**
   * Claim the oldest pending task atomically (safe against concurrent
   * claimers): the subquery only matches a still-pending row.
   *
   * @param excludeIds Rows to skip for this drain. A deferred (busy-repo) row
   *   is requeued but must not be re-claimed immediately, or it would starve
   *   newer pending tasks for other repos; callers pass the ids already seen.
   */
  claimNext(excludeIds: readonly number[] = []): InjectedTask | null {
    const params: number[] = [Date.now()];
    let exclusion = "";
    if (excludeIds.length > 0) {
      exclusion = ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})`;
      params.push(...excludeIds);
    }
    const row = this.ensureDb()
      .query(
        `UPDATE injected_tasks
         SET status = 'running', started_at = ?
         WHERE id = (
           SELECT id FROM injected_tasks WHERE status = 'pending'${exclusion}
           ORDER BY created_at ASC, id ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get(...params) as InjectedTaskRow | null;
    return row ? rowToInjectedTask(row) : null;
  }

  /** Mark a claimed task finished (`done` or `failed` with an optional message). */
  finish(id: number, outcome: "done" | "failed", message?: string): void {
    this.ensureDb().run(
      `UPDATE injected_tasks
       SET status = ?, message = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [outcome, message ?? null, Date.now(), id],
    );
  }

  /** Return a claimed task to the queue (the repo was busy; try next tick). */
  requeue(id: number): void {
    this.ensureDb().run(
      `UPDATE injected_tasks
       SET status = 'pending', started_at = NULL
       WHERE id = ? AND status = 'running'`,
      [id],
    );
  }

  /**
   * Return a settled row to the queue after an explicit retry (`worker add
   * --resume`, dashboard "re-queue").
   *
   * The row keeps its `task_key`, so the retried run targets the same
   * `feature/local-<slug>` branch and session pickup can inherit the prior
   * attempt's branch and implementation report. A row that is already
   * pending/running (or disappeared) is left alone: `null` tells the caller the
   * retry did not start.
   */
  requeueSettled(taskKey: string): InjectedTask | null {
    const row = this.ensureDb()
      .query(
        `UPDATE injected_tasks
         SET status = 'pending', started_at = NULL, finished_at = NULL, message = NULL
         WHERE task_key = ? AND status IN ('done', 'failed')
         RETURNING *`,
      )
      .get(taskKey) as InjectedTaskRow | null;
    return row ? rowToInjectedTask(row) : null;
  }

  /**
   * Settle every row left `running` by a dead worker (startup orphan
   * recovery). Rows are failed rather than requeued so an interrupted ad-hoc
   * task is not silently re-run on every restart. Returns the settled rows.
   */
  failRunning(message: string): InjectedTask[] {
    const rows = this.ensureDb()
      .query(
        `UPDATE injected_tasks
         SET status = 'failed', message = ?, finished_at = ?
         WHERE status = 'running'
         RETURNING *`,
      )
      .all(message, Date.now()) as InjectedTaskRow[];
    return rows.map(rowToInjectedTask);
  }

  /** Whether any pending task exists (worker startup diagnostics). */
  hasPending(): boolean {
    const row = this.ensureDb()
      .query("SELECT 1 AS one FROM injected_tasks WHERE status = 'pending' LIMIT 1")
      .get() as { one: number } | null;
    return row !== null;
  }

  /**
   * Delete settled (`done`/`failed`) rows older than `olderThanMs` so a
   * long-lived worker's `injected_tasks` table cannot grow without bound.
   * Runs still in flight are never touched.
   *
   * Each pruned row's `task_file` (the operator's plaintext prompt context) is
   * unlinked too, so disk usage is bounded alongside the table. File names are
   * unique per enqueue, so removing one row's file can never delete a live
   * row's prompt.
   *
   * @param now Overridable clock (tests).
   * @returns The number of rows pruned.
   */
  pruneSettled(olderThanMs: number, now: number = Date.now()): number {
    // The worker's unref'd sweep timer may fire after `close()` during
    // shutdown; reopening the DB then would resurrect the file we just
    // released. Settled rows are already gone, so a closed store is a no-op.
    if (this.closed) return 0;
    const db = this.ensureDb();
    const cutoff = now - olderThanMs;
    // Read the file paths before deleting the rows: after the DELETE the paths
    // are gone and the files would leak forever.
    const settled = db
      .query(
        `SELECT task_file FROM injected_tasks
         WHERE status IN ('done', 'failed')
           AND COALESCE(finished_at, created_at) < ?`,
      )
      .all(cutoff) as Array<{ task_file: string }>;
    if (settled.length === 0) return 0;
    const result = db.run(
      `DELETE FROM injected_tasks
       WHERE status IN ('done', 'failed')
         AND COALESCE(finished_at, created_at) < ?`,
      [cutoff],
    );
    for (const { task_file } of settled) {
      try {
        unlinkSync(task_file);
      } catch {
        // Best-effort: a missing or already-removed file is not an error.
      }
    }
    return Number(result.changes ?? 0);
  }

  /** List tasks, newest first (dashboard/introspection). */
  list(limit = 100): InjectedTask[] {
    const rows = this.ensureDb()
      .query("SELECT * FROM injected_tasks ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as InjectedTaskRow[];
    return rows.map(rowToInjectedTask);
  }

  close(): void {
    this.closed = true;
    this.db?.close();
    this.db = null;
  }
}
