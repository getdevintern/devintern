/**
 * Database resolution for the local observability dashboard.
 *
 * The dashboard reads two different kinds of state, and they do not always
 * live in the same file:
 *
 * - Run history (runs, stats, agent PRs, artifacts, retry audit) belongs to
 *   whoever recorded the run. A direct `devintern TASK` run writes to the
 *   project-scoped `<project>/.devintern-code/queue.db`; a workspace worker
 *   writes to `<workspace>/state/queue.db` via `WEBHOOK_QUEUE_DB`.
 * - Durable queue counts (ad-hoc `worker add` tasks and scheduled retries)
 *   belong to the worker's shared queue database, which is the workspace DB
 *   whenever a workspace is configured.
 *
 * A standalone `devintern dashboard` must therefore keep reading its run
 * history from the project-scoped DB (so local runs stay visible when a
 * workspace also exists) while counting queue work in the workspace DB.
 *
 * Kept separate from `dashboard-api.ts` so both the API defaults and the
 * standalone command share one rule.
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "fs";
import { basename, join, resolve } from "path";

import { configureSqliteConnection } from "../state/sqlite";
import { readRelayQueueStats, resolveQueueDbPath, WebhookQueue } from "../state/webhook-queue";
import { hasWorkspace, resolveWorkspaceDir, workspaceDbPath } from "../workspace/paths";

/**
 * Resolve a `--workspace` argument to the workspace `workspace.toml` path.
 *
 * Accepts either the config file itself (must be a regular file named
 * `workspace.toml`) or the workspace directory containing it, so
 * `--workspace ~/.devintern` cannot silently fall back to the project-scoped
 * queue DB. Returns null when the argument points at neither.
 *
 * @param input - Path passed on the command line (relative to cwd)
 */
export function resolveWorkspaceArgPath(input: string): string | null {
  const resolved = resolve(input.trim());
  try {
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const candidate = join(resolved, "workspace.toml");
      return statSync(candidate).isFile() ? candidate : null;
    }
    if (!stat.isFile() || basename(resolved) !== "workspace.toml") {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Resolve the database that owns run history.
 *
 * Preserves the pre-workspace behavior: the same project-scoped DB a direct
 * CLI run writes. An explicit `WEBHOOK_QUEUE_DB` (worker-embedded dashboard,
 * or a user pin) still wins through {@linkcode resolveQueueDbPath}.
 *
 * @param projectDir - Directory the project-scoped DB resolves from
 */
export function resolveDashboardHistoryDbPath(projectDir: string = process.cwd()): string {
  return resolveQueueDbPath(projectDir);
}

/**
 * Resolve the database holding the durable work queues the dashboard counts.
 *
 * Defaulting a standalone `devintern dashboard` to the project-scoped
 * `.devintern-code/queue.db` left the injected/retry status counters at zero
 * even while work was pending, so prefer the workspace DB whenever a
 * workspace is configured. No workspace (legacy single-project layouts) keeps
 * the old project-scoped resolution. An explicit `WEBHOOK_QUEUE_DB` still
 * wins.
 *
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`)
 * @param projectDir - Directory the legacy project-scoped DB resolves from
 */
export function resolveDashboardQueueDbPath(
  workspaceDir: string = resolveWorkspaceDir(),
  projectDir: string = process.cwd(),
): string {
  if (!process.env.WEBHOOK_QUEUE_DB && hasWorkspace(workspaceDir)) {
    return workspaceDbPath(workspaceDir);
  }
  return resolveQueueDbPath(projectDir);
}

const EMPTY_QUEUE_STATUS_COUNTS = { pending: 0, running: 0 };

/**
 * Count `pending`/`running` rows in one durable queue table without changing it.
 *
 * Dashboard GETs must stay read-only (standalone `devintern dashboard` "reads
 * the local history without changing it"), so this never creates the directory,
 * database, schema, or indexes: it checks that the file exists first, then opens
 * `bun:sqlite` with `readonly: true` and closes it again. A missing table
 * (database written by an older version) degrades to zeros.
 *
 * @param dbPath - Shared worker state database
 * @param table - Queue table to count (fixed identifiers only)
 */
export function readDashboardQueueStatuses(
  dbPath: string,
  table: "injected_tasks" | "scheduled_retries",
): { pending: number; running: number } {
  if (!existsSync(dbPath)) {
    return { ...EMPTY_QUEUE_STATUS_COUNTS };
  }
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    configureSqliteConnection(db, { readonly: true });
    const rows = db
      .query(
        `SELECT status, COUNT(*) AS count FROM ${table}
         WHERE status IN ('pending', 'running')
         GROUP BY status`,
      )
      .all() as Array<{ status: string; count: number }>;
    const counts = { ...EMPTY_QUEUE_STATUS_COUNTS };
    for (const row of rows) {
      // Aggregate read: ignore an unrecognized status group instead of throwing.
      if (row.status === "pending") counts.pending = row.count;
      else if (row.status === "running") counts.running = row.count;
    }
    return counts;
  } catch {
    // Missing table, locked/corrupt DB, or a file removed between check and open.
    return { ...EMPTY_QUEUE_STATUS_COUNTS };
  } finally {
    db?.close();
  }
}

/**
 * Relay counts from both databases when they differ.
 *
 * A workspace worker writes `webhook_events` to the workspace DB, but
 * `devintern webhook serve` (and a direct CLI run) writes them to the
 * project-scoped DB. Those producers are disjoint, so summing cannot
 * double-count; when both paths point at the same file the queue DB alone is
 * read to avoid counting the same rows twice.
 *
 * @param dbPath - Run-history database (project scoped)
 * @param queueDbPath - Durable queue database (workspace DB when configured)
 */
export function readDashboardRelayStats(
  dbPath: string,
  queueDbPath: string,
): { pending: number; processing: number; failed: number } {
  const queueStats = readRelayQueueStats(queueDbPath);
  if (resolve(dbPath) === resolve(queueDbPath)) {
    return queueStats;
  }
  const historyStats = readRelayQueueStats(dbPath);
  return {
    pending: queueStats.pending + historyStats.pending,
    processing: queueStats.processing + historyStats.processing,
    failed: queueStats.failed + historyStats.failed,
  };
}

/** Persisted harness failover state as read from `webhook_meta`. */
export interface DashboardFailoverState {
  /** Harness name → limit-until epoch ms (may already be in the past). */
  rateLimits: Record<string, number>;
  /** Persisted active harness, when one was recorded (and readable). */
  activeHarness: string | null;
  /** Most recent usage-limit hit per harness, kept after its window elapses. */
  lastLimits: Record<string, { hitAt: number; untilMs: number }>;
}

/**
 * Read the persisted harness failover state without changing it.
 *
 * Same read-only contract as {@link readDashboardQueueStatuses}: a missing
 * file is reported as `null` (state unknown) instead of creating a database.
 * A corrupt active-harness row degrades to `null` without discarding the
 * per-row tolerant rate-limit windows.
 *
 * @param dbPath - Database the worker persists failover state into
 * @returns The persisted state, or null when the database cannot be read
 */
export function readDashboardFailoverState(dbPath: string): DashboardFailoverState | null {
  if (!existsSync(dbPath)) {
    return null;
  }
  let queue: WebhookQueue | null = null;
  try {
    queue = new WebhookQueue({ dbPath, readonly: true });
    const rateLimits = queue.getAllRateLimits();
    let activeHarness: string | null = null;
    try {
      activeHarness = queue.getActiveHarness();
    } catch {
      activeHarness = null;
    }
    let lastLimits: DashboardFailoverState["lastLimits"] = {};
    try {
      lastLimits = queue.getAllLastLimits();
    } catch {
      lastLimits = {};
    }
    return { rateLimits, activeHarness, lastLimits };
  } catch {
    // Missing webhook_meta table (older DB), locked or corrupt file.
    return null;
  } finally {
    queue?.close();
  }
}
