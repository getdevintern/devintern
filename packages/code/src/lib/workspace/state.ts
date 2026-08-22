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
 * when the task changes again. Coordinated (multi-repo) planning failures are
 * recorded the same way (`unplanned`).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

import { LockManager } from "../lock-manager";
import { WebhookQueue } from "../webhook-queue";
import { WorkerState } from "../worker-state";
import { CoordinationStore } from "./coordination";
import { locksDir, resolveWorkspaceDir, workspaceDbPath } from "./paths";

/** Reason a task was not routed to any repo. */
export type RoutingSkipReason = "ambiguous" | "unrouted" | "unplanned";

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
  /** Coordinated multi-repo efforts (parent + per-repo run rows). */
  coordination: CoordinationStore;
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
  const coordination = new CoordinationStore(dbPath);
  return {
    workerState,
    queue,
    skips,
    coordination,
    dbPath,
    close() {
      workerState.close();
      queue.close();
      skips.close();
      coordination.close();
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
 * other repos free (parallel-across-repos stays safe to add later).
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
    this.db.run("PRAGMA busy_timeout = 5000");
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
