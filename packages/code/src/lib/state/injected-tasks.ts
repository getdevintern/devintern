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

import { readLocalDependencyFacts } from "../dependencies/local-facts";
import type { DependencyFacts, DependencyMode } from "../dependencies/gate";
import { isDependencyMode } from "../dependencies/gate";
import { orderStackLinks } from "../dependencies/stack-maintainer";
import type { StackLink } from "../dependencies/stack-maintainer";
import { initInjectedTaskSchema } from "./injected-tasks-schema";
import { prepareQueueDbDirectory } from "./webhook-queue";
import { configureSqliteConnection } from "./sqlite";
import type { RunRecord } from "./run-recorder";

export {
  addAutoResumeColumn,
  addChildPidColumn,
  addChildStartedAtColumn,
} from "./injected-tasks-schema";

export type InjectedTaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/** Terminal statuses: the row will not run again without an explicit re-queue. */
export type SettledInjectedTaskStatus = "done" | "failed" | "cancelled";

/** Who withdrew a pending row (`worker cancel` or the dashboard Cancel action). */
export type InjectedCancelActor = "cli" | "dashboard";

/**
 * Result of {@link InjectedTaskStore.cancel}. Only `cancelled` changed the row;
 * every other outcome left it exactly as it was.
 */
export type InjectedCancelOutcome =
  | "cancelled"
  | "already_cancelled"
  | "already_started"
  | "already_finished"
  | "not_found";

export interface InjectedCancelResult {
  outcome: InjectedCancelOutcome;
  /** The row after the attempt; unset for `not_found`. */
  task?: InjectedTask;
}

/**
 * Why a pending task with dependencies cannot be claimed yet: `waiting` for a
 * dependency to progress, or `blocked` by one that failed or whose PR closed
 * without merging. Unset when the task has no dependencies or is claimable.
 */
export type InjectedDependencyState = "waiting" | "blocked";

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
  /** Task keys (same repo) this task waits on; empty when it has none. */
  dependsOn: string[];
  /** How it waits on {@link dependsOn}; set whenever it has dependencies. */
  dependencyMode?: DependencyMode;
  /** Last gate verdict recorded by the worker (or at enqueue). */
  dependencyState?: InjectedDependencyState;
  /** Human reason for {@link dependencyState}, naming the dependency. */
  dependencyReason?: string;
  createdAt: number;
  startedAt?: number;
  /** When the row settled; for a `cancelled` row, the cancel time. */
  finishedAt?: number;
  /** Who cancelled the row (set only when `status` is `cancelled`). */
  cancelledBy?: InjectedCancelActor;
  /** Optional operator reason given with the cancel. */
  cancelReason?: string;
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
  depends_on?: string | null;
  dependency_mode?: string | null;
  dependency_state?: string | null;
  dependency_reason?: string | null;
  cancelled_by?: string | null;
  cancel_reason?: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/** Decode the stored dependency list; a malformed value reads as none. */
function parseDependsOn(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string" && key !== "")
      : [];
  } catch {
    return [];
  }
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
    dependsOn: parseDependsOn(row.depends_on),
    dependencyMode: isDependencyMode(row.dependency_mode) ? row.dependency_mode : undefined,
    dependencyState:
      row.dependency_state === "waiting" || row.dependency_state === "blocked"
        ? row.dependency_state
        : undefined,
    dependencyReason: row.dependency_reason ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    cancelledBy:
      row.cancelled_by === "cli" || row.cancelled_by === "dashboard" ? row.cancelled_by : undefined,
    cancelReason: row.cancel_reason ?? undefined,
  };
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
  /** Validated dependency keys (callers check existence, repo, and cycles). */
  dependsOn?: string[];
  /** Resolved mode; stored only when {@link dependsOn} is non-empty. */
  dependencyMode?: DependencyMode;
  /** Initial gate verdict, so the queue view explains the wait immediately. */
  dependencyState?: InjectedDependencyState;
  dependencyReason?: string;
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

  /** Database file holding `injected_tasks` (the workspace queue DB, shared with run records). */
  get path(): string {
    return this.dbPath;
  }

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
    initInjectedTaskSchema(this.db);
    return this.db;
  }

  /**
   * Insert a task as `pending` (idempotent while an earlier task with the same
   * key is still active).
   *
   * When `idempotencyKey` matches a `pending`/`running` task, that row is
   * returned and nothing is inserted, so a retried automation cannot create a
   * duplicate. A settled (`done`/`failed`/`cancelled`) row only retains the key as history;
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
           WHERE idempotency_key = ? AND status IN ('done', 'failed', 'cancelled')`,
          [input.idempotencyKey],
        );
      }
      const dependsOn = input.dependsOn?.length ? input.dependsOn : undefined;
      db.query(
        `INSERT INTO injected_tasks
           (task_key, repo, title, body, task_file, idempotency_key, actor, status, created_at,
            depends_on, dependency_mode, dependency_state, dependency_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      ).run(
        input.taskKey,
        input.repo,
        input.title,
        input.body,
        input.taskFile,
        input.idempotencyKey ?? null,
        input.actor ?? "local:add",
        input.createdAt ?? Date.now(),
        dependsOn ? JSON.stringify(dependsOn) : null,
        dependsOn ? (input.dependencyMode ?? "merged") : null,
        dependsOn ? (input.dependencyState ?? null) : null,
        dependsOn ? (input.dependencyReason ?? null) : null,
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
  ): { repo: string; status: SettledInjectedTaskStatus; message?: string } | null {
    const db = this.ensureDb();
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE name = 'pruned_injected_task_outcomes'")
      .get();
    if (!table) return null;
    const row = db
      .query("SELECT repo, status, message FROM pruned_injected_task_outcomes WHERE task_id = ?")
      .get(id) as {
      repo: string;
      status: SettledInjectedTaskStatus;
      message: string | null;
    } | null;
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
   * Withdraw a `pending` row before the worker claims it.
   *
   * One guarded `UPDATE … WHERE status = 'pending'`, so it composes with
   * {@link claimNext}: whichever statement commits first wins, and the loser
   * matches no row. A cancelled row is terminal; it is never claimed, and
   * {@link requeueSettled} refuses it. A repeated cancel keeps the first cancel
   * time, actor, and reason. The prompt file stays until {@link pruneSettled}.
   *
   * @param taskKey - Ad-hoc key (`local-…`) naming the row
   * @param options - Audit actor, optional free-text reason, and clock (tests)
   */
  cancel(
    taskKey: string,
    options: { actor: InjectedCancelActor; reason?: string; now?: number },
  ): InjectedCancelResult {
    const db = this.ensureDb();
    const reason = options.reason?.trim() ? options.reason.trim() : null;
    // `.immediate()` takes the write lock at BEGIN, so no claim, requeue, or
    // recovery in another process can change the row between the guarded
    // UPDATE and the read that explains why it did not match. A row read back
    // as `pending` is therefore impossible, and the outcome is never wrong.
    return db
      .transaction((): InjectedCancelResult => {
        const cancelled = db
          .query(
            `UPDATE injected_tasks
             SET status = 'cancelled', finished_at = ?, cancelled_by = ?, cancel_reason = ?,
                 child_pid = NULL, child_started_at = NULL
             WHERE task_key = ? AND status = 'pending'
             RETURNING *`,
          )
          .get(options.now ?? Date.now(), options.actor, reason, taskKey) as InjectedTaskRow | null;
        if (cancelled) return { outcome: "cancelled", task: rowToInjectedTask(cancelled) };
        const current = this.getByTaskKey(taskKey);
        if (!current) return { outcome: "not_found" };
        switch (current.status) {
          case "cancelled":
            return { outcome: "already_cancelled", task: current };
          case "pending":
          case "running":
            // `pending` cannot be read here (see above); treat it like a claim
            // rather than report a cancel that did not happen.
            return { outcome: "already_started", task: current };
          default:
            return { outcome: "already_finished", task: current };
        }
      })
      .immediate();
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

  /**
   * Repo of each named task key that has a row (any status), for dependency
   * validation at enqueue. Missing keys are absent from the map.
   */
  reposByTaskKey(taskKeys: readonly string[]): Map<string, string> {
    const map = new Map<string, string>();
    const keys = [...new Set(taskKeys)];
    if (keys.length === 0) return map;
    const rows = this.ensureDb()
      .query(
        `SELECT task_key, repo FROM injected_tasks
         WHERE task_key IN (${keys.map(() => "?").join(", ")})`,
      )
      .all(...keys) as Array<{ task_key: string; repo: string }>;
    for (const row of rows) map.set(row.task_key, row.repo);
    return map;
  }

  /** Direct dependencies of one task key (cycle detection); empty when none. */
  dependenciesOf(taskKey: string): string[] {
    const row = this.ensureDb()
      .query("SELECT depends_on FROM injected_tasks WHERE task_key = ?")
      .get(taskKey) as { depends_on: string | null } | null;
    return parseDependsOn(row?.depends_on);
  }

  /** Pending rows that declare dependencies (the acquirer's gate pass). */
  listPendingWithDependencies(): InjectedTask[] {
    const rows = this.ensureDb()
      .query(
        `SELECT * FROM injected_tasks
         WHERE status = 'pending' AND depends_on IS NOT NULL AND depends_on != '[]'
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as InjectedTaskRow[];
    return rows.map(rowToInjectedTask);
  }

  /**
   * Local facts about dependency keys (task row, latest run, agent PR), read
   * from this workspace DB. See `readLocalDependencyFacts`.
   */
  dependencyFacts(taskKeys: readonly string[]): DependencyFacts[] {
    return readLocalDependencyFacts(this.ensureDb(), taskKeys);
  }

  /**
   * Record the gate verdict on a pending row (`null` clears it once claimable).
   * Writes only on change, so an unchanged wait costs no write per tick.
   *
   * @returns Whether the row changed
   */
  setDependencyState(
    id: number,
    state: InjectedDependencyState | null,
    reason: string | null,
  ): boolean {
    const result = this.ensureDb().run(
      `UPDATE injected_tasks SET dependency_state = ?, dependency_reason = ?
       WHERE id = ? AND status = 'pending'
         AND (COALESCE(dependency_state, '') != COALESCE(?, '')
           OR COALESCE(dependency_reason, '') != COALESCE(?, ''))`,
      [state, reason, id, state, reason],
    );
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Record which task a claim stacked this row on (`null`: not stacked, i.e.
   * the PR targets the default branch or an explicit `Target branch:`). Read
   * by dependents: a merged PR of a stacked row landed in its base's branch.
   */
  setStackedOn(id: number, stackedOnTaskKey: string | null): void {
    this.ensureDb().run("UPDATE injected_tasks SET stacked_on = ? WHERE id = ?", [
      stackedOnTaskKey,
      id,
    ]);
  }

  /**
   * Settled (`done`) rows whose PR is stacked on another task's branch (the
   * stacked-PR maintainer's work list), each base before its dependents.
   */
  listStackedLinks(): StackLink[] {
    const rows = this.ensureDb()
      .query(
        `SELECT id, task_key, repo, stacked_on, stack_base_sha, stack_notice FROM injected_tasks
         WHERE status = 'done' AND stacked_on IS NOT NULL AND stacked_on != ''
         ORDER BY finished_at ASC, id ASC`,
      )
      .all() as Array<{
      id: number;
      task_key: string;
      repo: string;
      stacked_on: string;
      stack_base_sha: string | null;
      stack_notice: string | null;
    }>;
    const links = rows.map((row): StackLink => ({
      id: row.id,
      taskKey: row.task_key,
      repo: row.repo,
      stackedOn: row.stacked_on,
      baseHeadSha: row.stack_base_sha ?? undefined,
      notice: row.stack_notice ?? undefined,
    }));
    return orderStackLinks(links);
  }

  /**
   * Record the base head a stacked row's branch is built on (`null` forgets
   * it, e.g. once the row no longer stacks). The next restack strips commits
   * up to this SHA.
   */
  setStackBaseSha(id: number, sha: string | null): void {
    this.ensureDb().run("UPDATE injected_tasks SET stack_base_sha = ? WHERE id = ?", [sha, id]);
  }

  /**
   * Record that the stacked-PR maintainer told the PR why it is blocked
   * (`null` clears it), so the comment is posted once.
   */
  setStackNotice(id: number, notice: string | null): void {
    this.ensureDb().run("UPDATE injected_tasks SET stack_notice = ? WHERE id = ?", [notice, id]);
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

  /**
   * Pending rows in pickup order: rows backing off after a deferral sort by
   * when they become claimable, so the list reads as "what runs next".
   *
   * @param limit - Maximum rows to return
   */
  listPending(limit = 50): InjectedTask[] {
    const rows = this.ensureDb()
      .query(
        `SELECT * FROM injected_tasks WHERE status = 'pending'
         ORDER BY MAX(created_at, COALESCE(not_before, 0)) ASC, id ASC LIMIT ?`,
      )
      .all(limit) as InjectedTaskRow[];
    return rows.map(rowToInjectedTask);
  }

  /**
   * Most recently cancelled rows (dashboard and `worker queue` audit view).
   *
   * @param limit - Maximum rows to return
   */
  listRecentlyCancelled(limit = 10): InjectedTask[] {
    const rows = this.ensureDb()
      .query(
        `SELECT * FROM injected_tasks WHERE status = 'cancelled'
         ORDER BY COALESCE(finished_at, created_at) DESC, id DESC LIMIT ?`,
      )
      .all(limit) as InjectedTaskRow[];
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
   * Delete settled (`done`/`failed`/`cancelled`) rows older than `olderThanMs` so a
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
          `SELECT id, repo, status, COALESCE(message, cancel_reason) AS message, task_file
           FROM injected_tasks
           WHERE status IN ('done', 'failed', 'cancelled')
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
         WHERE status IN ('done', 'failed', 'cancelled')
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
