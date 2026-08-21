/**
 * Run retry
 *
 * The Support Dashboard's "retry this run" action. A retry re-invokes the same
 * underlying flow support would run by hand — `devintern <TASK> --force` — as
 * a detached subprocess of the dashboard server, so the CLI's own lock,
 * entitlement, and worktree handling apply unchanged.
 *
 * Every trigger is audited in the queue database (`run_retry_audit`): who
 * retried, when, and the original run id. Only retriable runs (failed,
 * escalated, or abandoned terminal states with a task key) may be retried;
 * succeeded/deferred runs and runs without a ticket are rejected up front.
 */

import { Database } from "bun:sqlite";
import { basename } from "path";

import type { RunRecord, RunStatus } from "./run-recorder";
import { prepareQueueDbDirectory } from "./webhook-queue";

/** Terminal, non-success statuses a support engineer can re-run. */
export const RETRIABLE_RUN_STATUSES: readonly RunStatus[] = ["failed", "escalated", "abandoned"];

/** Why a run cannot currently be retried ("eligible" when it can). */
export interface RetryEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Whether a run is eligible for a dashboard retry.
 *
 * Eligible: a terminal failed/escalated/abandoned run that belongs to a task
 * key (there must be something to re-invoke the CLI with). `deferred` is not
 * eligible — the worker already scheduled its own retry; `in_progress` and
 * `succeeded` are never eligible; PR mentions without a task key have no CLI
 * entry point to force.
 *
 * Automation runs (origin `scheduled`/`manual` with an automation id) are
 * eligible only as an automation re-run: their `taskKey` is the markdown
 * occurrence file's stem, which has no meaning as a tracker key — forcing
 * `devintern <stem>` would 404 against the tracker. Such runs report
 * `kind: "automation"` so the retry handler re-triggers the automation
 * instead. Estimation sweeps re-run on their schedule, not by hand.
 */
export type RetryKind = "task" | "automation";

export interface RetryEligibility {
  eligible: boolean;
  /** How the retry must be dispatched (task-key force run vs automation re-run). */
  kind?: RetryKind;
  reason?: string;
}

export function isRunRetriable(
  run: Pick<RunRecord, "status" | "taskKey" | "automationId"> & { origin?: RunRecord["origin"] },
): RetryEligibility {
  if (run.automationId) {
    if (run.origin === "estimate") {
      return { eligible: false, reason: "estimation sweeps re-run on their schedule" };
    }
    if (RETRIABLE_RUN_STATUSES.includes(run.status)) {
      return { eligible: true, kind: "automation" };
    }
    return notRetriableByStatus(run.status);
  }
  if (!run.taskKey) {
    return { eligible: false, reason: "this run has no task key to re-run" };
  }
  if (RETRIABLE_RUN_STATUSES.includes(run.status)) {
    return { eligible: true, kind: "task" };
  }
  return notRetriableByStatus(run.status);
}

/** Status-specific refusal for a run that is terminal but not re-runnable. */
function notRetriableByStatus(status: RunStatus): RetryEligibility {
  switch (status) {
    case "succeeded":
      return { eligible: false, reason: "this run already succeeded" };
    case "in_progress":
      return { eligible: false, reason: "this run is still in progress" };
    case "deferred":
      return {
        eligible: false,
        reason: "this run is deferred and will be retried automatically",
      };
    default:
      return { eligible: false, reason: `runs in status "${status}" cannot be retried` };
  }
}

/** Optional audit identity supplied by an embedding application. */
export interface RetryActor {
  email: string | null;
}

/** One audited retry attempt against an original run. */
export interface RunRetryAuditEntry {
  id: number;
  runId: number;
  taskKey?: string;
  actor: string;
  action: "triggered" | "scheduled" | "failed";
  command?: string;
  pid?: number;
  message?: string;
  createdAt: number;
}

interface AuditRow {
  id: number;
  run_id: number;
  task_key: string | null;
  actor: string;
  action: string;
  command: string | null;
  pid: number | null;
  message: string | null;
  created_at: number;
}

function rowToEntry(row: AuditRow): RunRetryAuditEntry {
  return {
    id: row.id,
    runId: row.run_id,
    taskKey: row.task_key ?? undefined,
    actor: row.actor,
    action:
      row.action === "failed" ? "failed" : row.action === "scheduled" ? "scheduled" : "triggered",
    command: row.command ?? undefined,
    pid: row.pid ?? undefined,
    message: row.message ?? undefined,
    createdAt: row.created_at,
  };
}

const MAX_AUDIT_ROWS = 200;

/**
 * SQLite-backed audit trail for dashboard retries, stored alongside the rest
 * of the worker state in `queue.db`. Opened read-write and lazily: reads fall
 * back to an empty trail while the table does not exist yet.
 */
export class RunRetryAuditStore {
  private db: Database | null = null;

  constructor(private dbPath: string) {}

  private ensureDb(): Database {
    if (this.db) {
      return this.db;
    }
    prepareQueueDbDirectory(this.dbPath);
    this.db = new Database(this.dbPath);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS run_retry_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        task_key TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        command TEXT,
        pid INTEGER,
        message TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_run_retry_audit_run_id ON run_retry_audit(run_id)");
    return this.db;
  }

  /** Record one retry trigger (or spawn failure). */
  record(entry: Omit<RunRetryAuditEntry, "id" | "createdAt"> & { createdAt?: number }): void {
    const db = this.ensureDb();
    db.run(
      `INSERT INTO run_retry_audit (run_id, task_key, actor, action, command, pid, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.runId,
        entry.taskKey ?? null,
        entry.actor,
        entry.action,
        entry.command ?? null,
        entry.pid ?? null,
        entry.message ?? null,
        entry.createdAt ?? Date.now(),
      ],
    );
  }

  /** List recent retries for a run, most recent first. */
  listForRun(runId: number): RunRetryAuditEntry[] {
    // Read through a transient read-only connection when nothing has been
    // written from this process yet; do not cache it, or a later write would
    // fail against the read-only handle.
    let tempDb: Database | null = null;
    try {
      if (this.db === null) {
        tempDb = this.openReadonly();
      }
      const db = this.db ?? tempDb;
      if (!db) {
        return [];
      }
      const rows = db
        .query(
          `SELECT * FROM run_retry_audit WHERE run_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ${MAX_AUDIT_ROWS}`,
        )
        .all(runId) as AuditRow[];
      return rows.map(rowToEntry);
    } catch {
      // Missing DB file or table (DB created by an older version).
      return [];
    } finally {
      tempDb?.close();
    }
  }

  private openReadonly(): Database {
    const conn = new Database(this.dbPath, { readonly: true });
    conn.run("PRAGMA busy_timeout = 5000");
    return conn;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export interface SpawnedRetryProcess {
  pid?: number;
  /** Human-readable command line used for the audit log. */
  command: string;
}

/** A dashboard-scheduled retry waiting for (or being run by) the worker. */
export interface ScheduledRetry {
  id: number;
  taskKey: string;
  runId?: number;
  team?: string;
  repo?: string;
  actor: string;
  status: "pending" | "running" | "done" | "failed";
  message?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

interface ScheduledRetryRow {
  id: number;
  task_key: string;
  run_id: number | null;
  team: string | null;
  repo: string | null;
  actor: string;
  status: string;
  message: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function rowToScheduledRetry(row: ScheduledRetryRow): ScheduledRetry {
  return {
    id: row.id,
    taskKey: row.task_key,
    runId: row.run_id ?? undefined,
    team: row.team ?? undefined,
    repo: row.repo ?? undefined,
    actor: row.actor,
    status: row.status as ScheduledRetry["status"],
    message: row.message ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

/**
 * Durable queue of dashboard-scheduled retries, stored in the workspace DB
 * (`scheduled_retries` table). The dashboard handler inserts a pending row;
 * the worker's retry acquirer drains rows through the normal fleet pipeline
 * (routing, per-repo worktree, env, repo lock) instead of the dashboard
 * spawning a bare CLI subprocess from the workspace home.
 */
export class ScheduledRetryStore {
  private db: Database | null = null;

  constructor(private dbPath: string) {}

  private ensureDb(): Database {
    if (this.db) {
      return this.db;
    }
    prepareQueueDbDirectory(this.dbPath);
    this.db = new Database(this.dbPath);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_retries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_key TEXT NOT NULL,
        run_id INTEGER,
        team TEXT,
        repo TEXT,
        actor TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        message TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      )
    `);
    const columns = this.db.query("PRAGMA table_info(scheduled_retries)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "team")) {
      this.db.run("ALTER TABLE scheduled_retries ADD COLUMN team TEXT");
    }
    if (!columns.some((column) => column.name === "repo")) {
      this.db.run("ALTER TABLE scheduled_retries ADD COLUMN repo TEXT");
    }
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_scheduled_retries_status ON scheduled_retries(status)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_scheduled_retries_task ON scheduled_retries(task_key)",
    );
    return this.db;
  }

  /**
   * Schedule a retry; refuses while an active (pending/running) row already
   * exists for the task, so double-clicks cannot double-run.
   */
  schedule(entry: {
    taskKey: string;
    runId?: number;
    team?: string;
    repo?: string;
    actor: string;
    createdAt?: number;
  }): {
    scheduled: boolean;
    reason?: string;
  } {
    const db = this.ensureDb();
    if (this.hasActive(entry.taskKey, entry.team)) {
      return { scheduled: false, reason: "a retry is already scheduled or running" };
    }
    db.run(
      `INSERT INTO scheduled_retries (task_key, run_id, team, repo, actor, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [
        entry.taskKey,
        entry.runId ?? null,
        entry.team ?? null,
        entry.repo ?? null,
        entry.actor,
        entry.createdAt ?? Date.now(),
      ],
    );
    return { scheduled: true };
  }

  /** Whether a pending or running retry exists for the task. */
  hasActive(taskKey: string, team?: string): boolean {
    try {
      const row = this.ensureDb()
        .query(
          "SELECT 1 AS one FROM scheduled_retries WHERE task_key = ? AND COALESCE(team, '') = ? AND status IN ('pending', 'running') LIMIT 1",
        )
        .get(taskKey, team ?? "");
      return row !== null;
    } catch {
      return false;
    }
  }

  /**
   * Claim the oldest pending retry atomically (safe against concurrent
   * claimers): the subquery only matches a still-pending row.
   */
  claimNext(): ScheduledRetry | null {
    const db = this.ensureDb();
    const row = db
      .query(
        `UPDATE scheduled_retries
         SET status = 'running', started_at = ?
         WHERE id = (
           SELECT id FROM scheduled_retries WHERE status = 'pending'
           ORDER BY created_at ASC, id ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get(Date.now()) as ScheduledRetryRow | null;
    return row ? rowToScheduledRetry(row) : null;
  }

  /** Mark a claimed retry finished (`done` or `failed` with a message). */
  finish(id: number, outcome: "done" | "failed", message?: string): void {
    this.ensureDb().run(
      `UPDATE scheduled_retries
       SET status = ?, message = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [outcome, message ?? null, Date.now(), id],
    );
  }

  /** Return a claimed retry to the queue (the repo was busy; try next tick). */
  requeue(id: number): void {
    this.ensureDb().run(
      `UPDATE scheduled_retries
       SET status = 'pending', started_at = NULL
       WHERE id = ? AND status = 'running'`,
      [id],
    );
  }

  /**
   * Settle every row left `running` by a dead worker (startup orphan
   * recovery). Rows are marked failed rather than requeued: the orphaned run
   * itself already gets graceful-shutdown feedback, and silently re-running a
   * forced retry on every worker restart could loop. Returns the settled rows
   * for logging.
   */
  failRunning(message: string): ScheduledRetry[] {
    const db = this.ensureDb();
    const rows = db
      .query(
        `UPDATE scheduled_retries
         SET status = 'failed', message = ?, finished_at = ?
         WHERE status = 'running'
         RETURNING *`,
      )
      .all(message, Date.now()) as ScheduledRetryRow[];
    return rows.map(rowToScheduledRetry);
  }

  /** Whether any pending retry exists (worker startup diagnostics). */
  hasPending(): boolean {
    try {
      const row = this.ensureDb()
        .query("SELECT 1 AS one FROM scheduled_retries WHERE status = 'pending' LIMIT 1")
        .get();
      return row !== null;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/**
 * Spawn `devintern <taskKey> --force` — the exact flow a support engineer
 * runs from the CLI to bypass the retry gate — using the same interpreter and
 * entry script that serve the dashboard. Detached so the HTTP response does
 * not wait for a full agent run; the spawned CLI records its own new run.
 */
export function spawnCliForceRetry(options: {
  taskKey: string;
  workingDir: string;
}): SpawnedRetryProcess {
  const script = process.argv[1];
  if (!script) {
    throw new Error("could not determine the devintern entry point to invoke");
  }
  const args = [script, options.taskKey, "--force"];
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: options.workingDir,
    env: process.env,
    // Outlive the dashboard request/process so long agent runs survive.
    detached: true,
  });
  child.unref();
  const command = `${basename(process.execPath)} devintern ${options.taskKey} --force`;
  return { pid: child.pid, command };
}
