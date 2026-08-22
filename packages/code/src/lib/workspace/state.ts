/**
 * Central workspace state.
 *
 * Fleet mode keeps all durable worker state in one SQLite database under the
 * workspace home (`~/.devintern/state/queue.db`) instead of a per-repo
 * `.devintern-code/queue.db`. The existing stores are reused as-is — both
 * accept a `dbPath` — so cursors, dedupe, agent PRs, and run records share
 * one file across every repo the worker drives. `agent_prs` and `runs` are
 * already repo-keyed; cursor sources are namespaced strings (the fleet query
 * cursor is tracker-level by design: one query, one detector, one cursor).
 *
 * Routing skips are recorded here too: a task whose routing is ambiguous or
 * unmatched is never guessed at — it is skipped, recorded, and only retried
 * when the task changes again.
 *
 * The fleet's live per-repo activity snapshot (idle / queued / running per
 * configured repo) is persisted here as well so the dashboard and
 * `GET /api/worker` can show what the fleet is doing across restarts.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

import { applySqliteConcurrencyPragmas, WebhookQueue } from "../webhook-queue";
import { LockManager } from "../lock-manager";
import { WorkerState } from "../worker-state";
import { locksDir, resolveWorkspaceDir, workspaceDbPath } from "./paths";

/** Reason a task was not routed to any repo. */
export type RoutingSkipReason = "ambiguous" | "unrouted";

export interface RoutingSkip {
  taskKey: string;
  reason: RoutingSkipReason;
  /** Repo names that matched (empty for `unrouted`). */
  candidates: string[];
  /** Task `updated` stamp the skip was recorded at. */
  taskUpdated?: string;
  createdAt: number;
}

/** Open handles to the central workspace database. */
export interface WorkspaceState {
  workerState: WorkerState;
  queue: WebhookQueue;
  skips: RoutingSkipStore;
  activity: FleetActivityStore;
  dbPath: string;
  close(): void;
}

/**
 * Open (or create) the central workspace state database.
 *
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`)
 * @returns Shared stores backed by `state/queue.db`.
 */
export function openWorkspaceState(workspaceDir: string = resolveWorkspaceDir()): WorkspaceState {
  const dbPath = workspaceDbPath(workspaceDir);
  const workerState = new WorkerState(dbPath);
  const queue = new WebhookQueue({ dbPath });
  const skips = new RoutingSkipStore(dbPath);
  const activity = new FleetActivityStore(dbPath);
  return {
    workerState,
    queue,
    skips,
    activity,
    dbPath,
    close() {
      workerState.close();
      queue.close();
      skips.close();
      activity.close();
    },
  };
}

/**
 * Workspace-wide worker lock: one fleet daemon per workspace.
 *
 * @returns An unacquired {@link LockManager} for `<workspace>/.worker.lock`.
 */
export function createWorkspaceLock(workspaceDir: string = resolveWorkspaceDir()): LockManager {
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }
  return new LockManager(workspaceDir, ".worker.lock", { plainDir: true });
}

/**
 * Per-repo run lock, serializing task runs within one repo while leaving
 * other repos free. The in-process scheduler never overlaps same-repo work;
 * this lock remains the cross-process safety boundary (another worker or a
 * stray run holding the lock makes the scheduler defer, not fail).
 *
 * @returns An unacquired {@link LockManager} for `<workspace>/locks/<repo>.run.lock`.
 */
export function createRepoRunLock(
  repoName: string,
  workspaceDir: string = resolveWorkspaceDir(),
): LockManager {
  const dir = locksDir(workspaceDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return new LockManager(dir, `${repoName}.run.lock`, { plainDir: true });
}

/**
 * SQLite-backed store for routing skips (ambiguous / unrouted tasks).
 */
export class RoutingSkipStore {
  private db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    applySqliteConcurrencyPragmas(this.db);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS routing_skips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        candidates TEXT NOT NULL DEFAULT '[]',
        task_updated TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_routing_skips_task ON routing_skips(task_key)");
  }

  /** Record a skipped task; keeps history so repeated skips stay visible. */
  record(skip: Omit<RoutingSkip, "createdAt">): void {
    this.db
      .query(
        `INSERT INTO routing_skips (task_key, reason, candidates, task_updated, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        skip.taskKey,
        skip.reason,
        JSON.stringify(skip.candidates),
        skip.taskUpdated ?? null,
        Date.now(),
      );
  }

  /** List recorded skips, newest first. */
  list(limit = 100): RoutingSkip[] {
    const rows = this.db
      .query(
        `SELECT task_key, reason, candidates, task_updated, created_at
         FROM routing_skips ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      task_key: string;
      reason: string;
      candidates: string;
      task_updated: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      taskKey: row.task_key,
      reason: row.reason as RoutingSkipReason,
      candidates: JSON.parse(row.candidates) as string[],
      taskUpdated: row.task_updated ?? undefined,
      createdAt: row.created_at,
    }));
  }

  /** Latest skip for a task, or null. */
  latestFor(taskKey: string): RoutingSkip | null {
    const skips = this.list(1000).filter((skip) => skip.taskKey === taskKey);
    return skips[0] ?? null;
  }

  close(): void {
    this.db.close();
  }
}

/** Path helper re-export so callers need one import for state concerns. */
export { workspaceDbPath, locksDir };
export const workspaceLockPath = (workspaceDir: string = resolveWorkspaceDir()): string =>
  join(workspaceDir, ".worker.lock");

/** Per-repo fleet activity persisted for the dashboard / `GET /api/worker`. */
export type FleetRepoStatus = "idle" | "queued" | "running";

export interface FleetActivityRow {
  repo: string;
  status: FleetRepoStatus;
  /** Active task key or PR reference, when known. */
  label?: string;
  /** Epoch ms when the current run started (running rows only). */
  startedAt?: number;
}

export interface FleetActivitySnapshot {
  rows: FleetActivityRow[];
  pid: number;
  maxConcurrency: number;
  parallel: boolean;
}

/** Read-model of a persisted snapshot, as served to the dashboard API. */
export interface FleetActivityReport {
  rows: Array<FleetActivityRow & { stale: boolean }>;
  pid: number;
  maxConcurrency: number;
  parallel: boolean;
  updatedAt: number;
  /** True when the writing process is no longer running (crash/kill). */
  stale: boolean;
}

/**
 * SQLite-backed snapshot of what each configured repo is doing.
 *
 * The worker rewrites the whole table on every scheduler transition (cheap:
 * one row per repo). Rows carry the writer's PID so the dashboard can flag
 * a crashed worker's activity as stale; a clean start clears the table and
 * a graceful shutdown leaves it empty.
 */
export class FleetActivityStore {
  private db: Database;

  constructor(dbPath: string, options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      this.db = new Database(dbPath, { readonly: true });
      applySqliteConcurrencyPragmas(this.db);
      return;
    }

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    applySqliteConcurrencyPragmas(this.db);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS fleet_activity (
        repo TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        label TEXT,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        max_concurrency INTEGER NOT NULL DEFAULT 1,
        parallel INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  /** Atomically replace the activity snapshot. */
  save(snapshot: FleetActivitySnapshot): void {
    const now = Date.now();
    const write = this.db.transaction((snap: FleetActivitySnapshot) => {
      this.db.run("DELETE FROM fleet_activity");
      const insert = this.db.query(
        `INSERT INTO fleet_activity
           (repo, status, label, started_at, updated_at, pid, max_concurrency, parallel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of snap.rows) {
        insert.run(
          row.repo,
          row.status,
          row.label ?? null,
          row.startedAt ?? null,
          now,
          snap.pid,
          snap.maxConcurrency,
          snap.parallel ? 1 : 0,
        );
      }
    });
    write(snapshot);
  }

  /**
   * Read the latest snapshot, or null when the worker never reported
   * (table created by a newer version, or nothing recorded yet).
   */
  latest(): FleetActivityReport | null {
    let rows: Array<{
      repo: string;
      status: string;
      label: string | null;
      started_at: number | null;
      updated_at: number;
      pid: number;
      max_concurrency: number;
      parallel: number;
    }>;
    try {
      rows = this.db
        .query(
          `SELECT repo, status, label, started_at, updated_at, pid, max_concurrency, parallel
           FROM fleet_activity ORDER BY repo ASC`,
        )
        .all() as typeof rows;
    } catch {
      return null;
    }
    if (rows.length === 0) {
      return null;
    }

    // Stale = written by a process that is no longer running (crash or kill).
    const pid = rows[0].pid;
    let stale = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      // EPERM: the process exists but we may not signal it — still alive.
      // Anything else (ESRCH, ...): the writer is gone.
      stale = (error as NodeJS.ErrnoException).code !== "EPERM";
    }

    const report: FleetActivityReport = {
      pid,
      maxConcurrency: rows[0].max_concurrency,
      parallel: rows[0].parallel === 1,
      updatedAt: Math.max(...rows.map((row) => row.updated_at)),
      stale,
      rows: rows.map((row) => ({
        repo: row.repo,
        status: row.status as FleetRepoStatus,
        label: row.label ?? undefined,
        startedAt: row.started_at ?? undefined,
        stale,
      })),
    };
    return report;
  }

  /** Clear all activity rows (clean start / graceful shutdown). */
  clear(): void {
    this.db.run("DELETE FROM fleet_activity");
  }

  close(): void {
    this.db.close();
  }
}
