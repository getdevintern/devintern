/**
 * Dashboard API
 *
 * Read-only JSON handlers over the worker's SQLite state (run records, agent
 * PRs, cursors, queue counts). Pure functions over a lazily opened read-only
 * database so they are testable without HTTP; `dashboard-server.ts` maps them
 * to routes.
 *
 * The database may not exist yet (fresh install, worker never run) or may
 * predate some tables (older versions). Every handler degrades to an empty
 * state instead of failing, so the dashboard always renders.
 */

import { LockManager } from "./lock-manager";
import { RunStore } from "./run-recorder";
import type { RunOrigin, RunRecord, RunStageRecord, RunStats, RunStatus } from "./run-recorder";
import { resolveQueueDbPath, WebhookQueue } from "./webhook-queue";
import { WorkerState } from "./worker-state";
import type { Cursor } from "./worker-state";

const RUN_STATUSES: RunStatus[] = [
  "in_progress",
  "succeeded",
  "failed",
  "deferred",
  "escalated",
  "abandoned",
];
const RUN_ORIGINS: RunOrigin[] = ["task", "pr_mention", "conflict_resolution", "scheduled"];

const STATS_WINDOWS: Record<string, number | null> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  all: null,
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Name of the worker daemon's lock file (see `startWorker`). */
const WORKER_LOCK_FILE = ".worker.lock";

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface DashboardDataOptions {
  dbPath?: string;
  /** Project root used to locate the worker lock file. */
  workingDir?: string;
}

interface Stores {
  runs: RunStore;
  state: WorkerState;
  queue: WebhookQueue;
}

/**
 * Lazily opened read-only view over the worker's SQLite database.
 *
 * Stores are opened on first successful access and cached; while the database
 * file does not exist yet, every read returns an empty state and the next
 * request retries (the worker may create the file at any moment).
 */
export class DashboardData {
  readonly dbPath: string;
  readonly workingDir: string;
  private stores: Stores | null = null;

  constructor(options: DashboardDataOptions = {}) {
    this.dbPath = options.dbPath ?? resolveQueueDbPath();
    this.workingDir = options.workingDir ?? process.cwd();
  }

  /** Open (or reuse) the read-only stores; null while the DB file is missing. */
  private ensureStores(): Stores | null {
    if (this.stores) {
      return this.stores;
    }
    try {
      this.stores = {
        runs: new RunStore(this.dbPath, { readonly: true }),
        state: new WorkerState(this.dbPath, { readonly: true }),
        queue: new WebhookQueue({ dbPath: this.dbPath, readonly: true }),
      };
      return this.stores;
    } catch {
      return null;
    }
  }

  /** Run a store read, mapping missing-DB/missing-table errors to a fallback. */
  private read<T>(fallback: T, query: (stores: Stores) => T): T {
    const stores = this.ensureStores();
    if (!stores) {
      return fallback;
    }
    try {
      return query(stores);
    } catch {
      // Table missing (DB created by an older version) or transient error.
      return fallback;
    }
  }

  /** Whether the database file has been opened successfully. */
  get dbMissing(): boolean {
    return this.ensureStores() === null;
  }

  /**
   * List runs for `/api/runs`.
   *
   * Task descriptions are stripped here: they are polled every few seconds
   * and would multiply the payload dozens of times; run detail serves them.
   */
  listRuns(filter: {
    taskKey?: string;
    status?: RunStatus;
    origin?: RunOrigin;
    limit: number;
    offset: number;
  }): { runs: RunRecord[]; total: number } {
    return this.read({ runs: [], total: 0 }, (stores) => ({
      runs: stores.runs.listRuns(filter).map((run) => ({ ...run, taskDescription: undefined })),
      total: stores.runs.countFilteredRuns(filter),
    }));
  }

  getRunDetail(id: number): { run: RunRecord; stages: RunStageRecord[] } | null {
    return this.read(null, (stores) => {
      const run = stores.runs.getRun(id);
      if (!run) {
        return null;
      }
      return { run, stages: stores.runs.listStages(id) };
    });
  }

  getStats(windowMs: number | null): RunStats | null {
    return this.read(null, (stores) => stores.runs.getStats(windowMs));
  }

  getQueueStats(): { pending: number; processing: number; failed: number } {
    return this.read({ pending: 0, processing: 0, failed: 0 }, (stores) => stores.queue.getStats());
  }

  getAgentPrCounts(): { open: number; closed: number } {
    return this.read({ open: 0, closed: 0 }, (stores) => stores.state.countAgentPrs());
  }

  getCursors(): Cursor[] {
    return this.read([], (stores) => stores.state.listCursors());
  }

  /** Close the underlying SQLite connections (tests, shutdown). */
  close(): void {
    if (this.stores) {
      this.stores.runs.close();
      this.stores.state.close();
      this.stores.queue.close();
      this.stores = null;
    }
  }
}

function badRequest(message: string): ApiResponse {
  return { status: 400, body: { error: message } };
}

/**
 * `GET /api/runs` — paginated run list with optional filters.
 *
 * @param data - Dashboard data source
 * @param params - Query params: `limit`, `offset`, `status`, `origin`, `taskKey`
 */
export function handleRuns(data: DashboardData, params: URLSearchParams): ApiResponse {
  const rawLimit = params.get("limit");
  const rawOffset = params.get("offset");
  const limit = rawLimit === null ? DEFAULT_LIMIT : parseInt(rawLimit, 10);
  const offset = rawOffset === null ? 0 : parseInt(rawOffset, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) {
    return badRequest(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  if (!Number.isFinite(offset) || offset < 0) {
    return badRequest("offset must be a non-negative integer");
  }

  const status = params.get("status") ?? undefined;
  if (status !== undefined && !RUN_STATUSES.includes(status as RunStatus)) {
    return badRequest(`status must be one of: ${RUN_STATUSES.join(", ")}`);
  }
  const origin = params.get("origin") ?? undefined;
  if (origin !== undefined && !RUN_ORIGINS.includes(origin as RunOrigin)) {
    return badRequest(`origin must be one of: ${RUN_ORIGINS.join(", ")}`);
  }

  const result = data.listRuns({
    taskKey: params.get("taskKey") ?? undefined,
    status: status as RunStatus | undefined,
    origin: origin as RunOrigin | undefined,
    limit,
    offset,
  });
  return { status: 200, body: result };
}

/**
 * `GET /api/runs/:id` — a run with its stages in insertion order.
 *
 * @param data - Dashboard data source
 * @param idParam - Raw id path segment
 */
export function handleRunDetail(data: DashboardData, idParam: string): ApiResponse {
  const id = parseInt(idParam, 10);
  if (!Number.isFinite(id) || String(id) !== idParam) {
    return badRequest("run id must be an integer");
  }
  const detail = data.getRunDetail(id);
  if (!detail) {
    return { status: 404, body: { error: `run ${id} not found` } };
  }
  return { status: 200, body: detail };
}

/**
 * `GET /api/stats` — aggregate run statistics over a time window.
 *
 * @param data - Dashboard data source
 * @param params - Query params: `window` (7d | 30d | 90d | all, default 30d)
 */
export function handleStats(data: DashboardData, params: URLSearchParams): ApiResponse {
  const window = params.get("window") ?? "30d";
  if (!(window in STATS_WINDOWS)) {
    return badRequest(`window must be one of: ${Object.keys(STATS_WINDOWS).join(", ")}`);
  }
  const stats = data.getStats(STATS_WINDOWS[window] ?? null);
  return { status: 200, body: { window, stats } };
}

/**
 * `GET /api/worker` — worker liveness, queue counts, agent PRs, poll cursors.
 *
 * @param data - Dashboard data source
 */
export function handleWorkerStatus(data: DashboardData): ApiResponse {
  const lock = LockManager.readLockStatus(data.workingDir, WORKER_LOCK_FILE);
  return {
    status: 200,
    body: {
      worker:
        lock === null ? null : { running: lock.running, pid: lock.pid, startedAt: lock.startedAt },
      queue: data.getQueueStats(),
      agentPrs: data.getAgentPrCounts(),
      cursors: data.getCursors().map((cursor) => ({
        source: cursor.source,
        cursorValue: cursor.cursorValue,
        updatedAt: cursor.updatedAt,
      })),
      dbPath: data.dbPath,
      dbMissing: data.dbMissing,
    },
  };
}
