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
import { existsSync, unlinkSync } from "fs";

import { prepareQueueDbDirectory } from "./webhook-queue";
import { configureSqliteConnection } from "./sqlite";
import type { RunRecord } from "./run-recorder";

export type InjectedTaskStatus = "pending" | "running" | "done" | "failed";

/** Time for a waiter to recover a settled outcome after its queue row is pruned. */
const PRUNED_OUTCOME_RECOVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a run finished successfully for the row's current claim.
 *
 * A run that started before the row was claimed predates an explicit
 * `worker add --resume` re-queue; treating it as the current attempt's result
 * would silently drop the operator's re-run.
 */
export function succeededRunCoversClaim(
  run: Pick<RunRecord, "status" | "startedAt"> | undefined,
  claimStartedAt: number | undefined,
): boolean {
  return (
    run?.status === "succeeded" && claimStartedAt !== undefined && run.startedAt >= claimStartedAt
  );
}

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
  /**
   * How many times startup recovery has automatically resumed this row after a
   * worker restart. Persisted so a restart loop cannot re-run the task forever;
   * manual `worker add --resume` / dashboard re-queue is not counted.
   */
  autoResumeCount: number;
  /**
   * Pid of the detached task child most recently spawned for this row. Persisted
   * so startup recovery can refuse to resume while a hard-killed worker's child
   * is still alive and could race the replacement run in the same branch.
   */
  childPid?: number;
  /**
   * When that child was recorded (epoch ms). A recorded pid outlives the process
   * it names — the OS recycles pids and a reboot restarts the table — so the
   * probe compares this with the live process's start time and treats a
   * mismatched (recycled) pid as dead.
   */
  childStartedAt?: number;
  /**
   * Consecutive times a claimed run came back `deferred` (the harness chain
   * could not start or was usage-limited). Persisted so a harness that keeps
   * failing cannot re-run the task forever; reset by an explicit re-queue.
   */
  deferCount: number;
  /** Earliest claim time (epoch ms) after a deferral backoff; unset = now. */
  notBefore?: number;
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
  auto_resume_count: number | null;
  child_pid: number | null;
  child_started_at: number | null;
  defer_count: number | null;
  not_before: number | null;
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
    autoResumeCount: row.auto_resume_count ?? 0,
    childPid: row.child_pid ?? undefined,
    childStartedAt: row.child_started_at ?? undefined,
    deferCount: row.defer_count ?? 0,
    notBefore: row.not_before ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

/**
 * Add the durable auto-resume column to a legacy table.
 *
 * The injected-task DB is shared by the worker, the dashboard, and CLI
 * processes, so two first-upgrades can both observe the column missing and
 * race the `ALTER TABLE`. The loser sees SQLite's duplicate-column error,
 * which means the migration already applied and is safe to ignore; any other
 * failure (locked/corrupt DB) must still surface instead of leaving the store
 * half-migrated.
 */
export function addAutoResumeColumn(db: Database): void {
  try {
    db.run("ALTER TABLE injected_tasks ADD COLUMN auto_resume_count INTEGER NOT NULL DEFAULT 0");
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
}

/**
 * Add the durable child-pid column to a legacy table. Same race rule as
 * {@link addAutoResumeColumn}: a concurrent opener's duplicate-column error
 * means the migration already applied.
 */
export function addChildPidColumn(db: Database): void {
  try {
    db.run("ALTER TABLE injected_tasks ADD COLUMN child_pid INTEGER");
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
}

/**
 * Add the child start-time column to a legacy table. Same race rule as
 * {@link addAutoResumeColumn}.
 */
export function addChildStartedAtColumn(db: Database): void {
  try {
    db.run("ALTER TABLE injected_tasks ADD COLUMN child_started_at INTEGER");
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
}

/**
 * Add a column to a legacy table. Same race rule as
 * {@link addAutoResumeColumn}: a concurrent opener's duplicate-column error
 * means the migration already applied.
 */
function addColumnIfMissing(db: Database, ddl: string): void {
  try {
    db.run(`ALTER TABLE injected_tasks ADD COLUMN ${ddl}`);
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
}

/** Deferral budget and backoff applied by {@link InjectedTaskStore.defer}. */
export interface DeferInjectedTaskOptions {
  /** Settle the row `failed` once this many consecutive deferrals happened. */
  maxDeferrals: number;
  /** Delay before the row may be claimed again, given the new defer count. */
  backoffMs: (deferCount: number) => number;
  /** Message stored on a row that ran out of deferrals. */
  exhaustedMessage: string;
  now?: number;
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

  /**
   * @param dbPath - Database file holding `injected_tasks`
   * @param options - `readonly` opens the file without creating its directory,
   *   schema, or indexes (dashboard GET path); a missing file throws.
   */
  constructor(
    private dbPath: string,
    private options: { readonly?: boolean } = {},
  ) {}

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
    if (this.options.readonly) {
      // Dashboard GETs must not create the file, its directory, or its schema.
      // A missing DB is the caller's "no rows" fallback, not something to fix.
      if (!existsSync(this.dbPath)) {
        throw new Error(`injected-task database does not exist: ${this.dbPath}`);
      }
      this.db = new Database(this.dbPath, { readonly: true });
      configureSqliteConnection(this.db, { readonly: true });
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
        auto_resume_count INTEGER NOT NULL DEFAULT 0,
        child_pid INTEGER,
        child_started_at INTEGER,
        defer_count INTEGER NOT NULL DEFAULT 0,
        not_before INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pruned_injected_task_outcomes (
        task_id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        archived_at INTEGER
      )
    `);
    const outcomeColumns = this.db
      .query("PRAGMA table_info(pruned_injected_task_outcomes)")
      .all() as Array<{ name: string }>;
    if (!outcomeColumns.some((column) => column.name === "archived_at")) {
      try {
        this.db.run("ALTER TABLE pruned_injected_task_outcomes ADD COLUMN archived_at INTEGER");
      } catch (error) {
        if (!/duplicate column name/i.test((error as Error).message)) throw error;
      }
    }
    // Old archives have no prune timestamp; give in-flight waiters one recovery
    // window after upgrade rather than deleting those outcomes immediately.
    this.db.run(
      "UPDATE pruned_injected_task_outcomes SET archived_at = ? WHERE archived_at IS NULL",
      [Date.now()],
    );
    // Older databases predate the durable auto-resume budget; add the column
    // in place instead of requiring a migration step.
    const columns = this.db.query("PRAGMA table_info(injected_tasks)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "auto_resume_count")) {
      addAutoResumeColumn(this.db);
    }
    if (!columns.some((column) => column.name === "child_pid")) {
      addChildPidColumn(this.db);
    }
    if (!columns.some((column) => column.name === "child_started_at")) {
      addChildStartedAtColumn(this.db);
    }
    if (!columns.some((column) => column.name === "defer_count")) {
      addColumnIfMissing(this.db, "defer_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "not_before")) {
      addColumnIfMissing(this.db, "not_before INTEGER");
    }
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

  /** The exact settled outcome retained when a queue row is pruned. */
  getPrunedOutcome(
    id: number,
  ): { repo: string; status: "done" | "failed"; message?: string } | null {
    const db = this.ensureDb();
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE name = 'pruned_injected_task_outcomes'")
      .get();
    if (!table) return null;
    const row = db
      .query("SELECT repo, status, message FROM pruned_injected_task_outcomes WHERE task_id = ?")
      .get(id) as { repo: string; status: "done" | "failed"; message: string | null } | null;
    return row ? { repo: row.repo, status: row.status, message: row.message ?? undefined } : null;
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
   * @param now Claim time; rows backing off until after it are skipped.
   */
  claimNext(excludeIds: readonly number[] = [], now: number = Date.now()): InjectedTask | null {
    const params: number[] = [now, now];
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
           SELECT id FROM injected_tasks
           WHERE status = 'pending' AND (not_before IS NULL OR not_before <= ?)${exclusion}
           ORDER BY created_at ASC, id ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get(...params) as InjectedTaskRow | null;
    return row ? rowToInjectedTask(row) : null;
  }

  /**
   * Record the detached child process spawned for a claimed row. A hard-killed
   * worker leaves this pid behind; startup recovery checks it (and its recorded
   * start time, to detect a recycled pid) before resuming.
   */
  setChildPid(id: number, pid: number, startedAt: number = Date.now()): void {
    this.ensureDb().run(
      `UPDATE injected_tasks
       SET child_pid = ?, child_started_at = ?
       WHERE id = ? AND status = 'running'`,
      [pid, startedAt, id],
    );
  }

  /** Mark a claimed task finished (`done` or `failed` with an optional message). */
  finish(id: number, outcome: "done" | "failed", message?: string): void {
    this.ensureDb().run(
      `UPDATE injected_tasks
       SET status = ?, message = ?, finished_at = ?, child_pid = NULL, child_started_at = NULL
       WHERE id = ? AND status = 'running'`,
      [outcome, message ?? null, Date.now(), id],
    );
  }

  /** Return a claimed task to the queue (the repo was busy; try next tick). */
  requeue(id: number): void {
    this.ensureDb().run(
      `UPDATE injected_tasks
       SET status = 'pending', started_at = NULL, child_pid = NULL, child_started_at = NULL
       WHERE id = ? AND status = 'running'`,
      [id],
    );
  }

  /**
   * Requeue a claimed row whose run was deferred, with backoff, or settle it
   * `failed` once its consecutive-deferral budget is spent.
   *
   * A deferral means the harness chain did not do the work (usage limit or a
   * harness that cannot start). Without a budget, a misclassified failure loops
   * every tick forever, creating a fresh worktree and run record each time.
   *
   * @returns The updated row and whether it was requeued; `null` when the row
   *   is no longer running (a concurrent settle won).
   */
  defer(
    id: number,
    options: DeferInjectedTaskOptions,
  ): { task: InjectedTask; requeued: boolean } | null {
    const db = this.ensureDb();
    const now = options.now ?? Date.now();
    const row = db
      .query("SELECT * FROM injected_tasks WHERE id = ?")
      .get(id) as InjectedTaskRow | null;
    if (!row || row.status !== "running") return null;

    const deferCount = (row.defer_count ?? 0) + 1;
    if (deferCount >= options.maxDeferrals) {
      const failed = db
        .query(
          `UPDATE injected_tasks
           SET status = 'failed', message = ?, finished_at = ?, defer_count = ?,
               not_before = NULL, child_pid = NULL, child_started_at = NULL
           WHERE id = ? AND status = 'running'
           RETURNING *`,
        )
        .get(options.exhaustedMessage, now, deferCount, id) as InjectedTaskRow | null;
      return failed ? { task: rowToInjectedTask(failed), requeued: false } : null;
    }

    const requeued = db
      .query(
        `UPDATE injected_tasks
         SET status = 'pending', started_at = NULL, defer_count = ?, not_before = ?,
             child_pid = NULL, child_started_at = NULL
         WHERE id = ? AND status = 'running'
         RETURNING *`,
      )
      .get(
        deferCount,
        now + Math.max(0, options.backoffMs(deferCount)),
        id,
      ) as InjectedTaskRow | null;
    return requeued ? { task: rowToInjectedTask(requeued), requeued: true } : null;
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
   *
   * An explicit retry also resets the automatic-resume and deferral budgets:
   * the operator has intervened, so a later interruption may be resumed (or a
   * later limit deferred) automatically again.
   *
   * The recorded child pid/start time are intentionally left in place: callers
   * must refuse the re-queue while that process is alive, because the retried
   * run would force-remove the worktree the surviving agent is working in. A
   * re-queue that passes the liveness check overwrites both fields when the next
   * child spawns.
   */
  requeueSettled(taskKey: string): InjectedTask | null {
    const row = this.ensureDb()
      .query(
        `UPDATE injected_tasks
         SET status = 'pending', started_at = NULL, finished_at = NULL, message = NULL,
             auto_resume_count = 0, defer_count = 0, not_before = NULL
         WHERE task_key = ? AND status IN ('done', 'failed')
         RETURNING *`,
      )
      .get(taskKey) as InjectedTaskRow | null;
    return row ? rowToInjectedTask(row) : null;
  }

  /** Every row currently claimed as `running` (startup auto-resume scan). */
  listRunning(): InjectedTask[] {
    const rows = this.ensureDb()
      .query("SELECT * FROM injected_tasks WHERE status = 'running' ORDER BY id ASC")
      .all() as InjectedTaskRow[];
    return rows.map(rowToInjectedTask);
  }

  /**
   * Return an interrupted `running` row to `pending` when its automatic-resume
   * budget allows, otherwise settle it `failed` with an actionable message.
   *
   * The counter is durable on the row, so a restart loop cannot re-run the same
   * task forever. `requeueSettled` (manual `--resume`) does not consume the
   * budget and resets it; this method is the only automatic consumer.
   *
   * @returns The updated row and whether it was resumed; `null` when the row is
   *   no longer running (a concurrent settle won).
   */
  autoResume(
    id: number,
    options: { limit: number; exhaustedMessage: string; now?: number },
  ): { task: InjectedTask; resumed: boolean } | null {
    const db = this.ensureDb();
    const now = options.now ?? Date.now();
    const row = db
      .query("SELECT * FROM injected_tasks WHERE id = ?")
      .get(id) as InjectedTaskRow | null;
    if (!row || row.status !== "running") return null;

    if ((row.auto_resume_count ?? 0) >= options.limit) {
      const failed = db
        .query(
          `UPDATE injected_tasks
           SET status = 'failed', message = ?, finished_at = ?, child_pid = NULL,
               child_started_at = NULL
           WHERE id = ? AND status = 'running'
           RETURNING *`,
        )
        .get(options.exhaustedMessage, now, id) as InjectedTaskRow | null;
      return failed ? { task: rowToInjectedTask(failed), resumed: false } : null;
    }

    const resumed = db
      .query(
        `UPDATE injected_tasks
         SET status = 'pending', started_at = NULL, finished_at = NULL, message = NULL,
             auto_resume_count = auto_resume_count + 1, child_pid = NULL, child_started_at = NULL
         WHERE id = ? AND status = 'running'
         RETURNING *`,
      )
      .get(id) as InjectedTaskRow | null;
    return resumed ? { task: rowToInjectedTask(resumed), resumed: true } : null;
  }

  /**
   * Settle every row left `running` by a dead worker (bulk explicit failure).
   *
   * Startup recovery uses {@link listRunning} + {@link autoResume} instead so a
   * row with a resumable session can return to `pending` under a durable
   * budget. This helper remains for callers that deliberately want the old
   * settle-everything behavior. Returns the settled rows.
   */
  failRunning(message: string): InjectedTask[] {
    const rows = this.ensureDb()
      .query(
        `UPDATE injected_tasks
         SET status = 'failed', message = ?, finished_at = ?, child_pid = NULL,
             child_started_at = NULL
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
    const { settled, result } = db.transaction(() => {
      const settled = db
        .query(
          `SELECT id, repo, status, message, task_file FROM injected_tasks
           WHERE status IN ('done', 'failed')
             AND COALESCE(finished_at, created_at) < ?`,
        )
        .all(cutoff) as Array<{
        id: number;
        repo: string;
        status: string;
        message: string | null;
        task_file: string;
      }>;
      db.run("DELETE FROM pruned_injected_task_outcomes WHERE archived_at < ?", [
        now - PRUNED_OUTCOME_RECOVERY_MS,
      ]);
      const save = db.query(
        "INSERT OR REPLACE INTO pruned_injected_task_outcomes (task_id, repo, status, message, archived_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const row of settled) save.run(row.id, row.repo, row.status, row.message, now);
      const result = db.run(
        `DELETE FROM injected_tasks
         WHERE status IN ('done', 'failed')
           AND COALESCE(finished_at, created_at) < ?`,
        [cutoff],
      );
      return { settled, result };
    })();
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
