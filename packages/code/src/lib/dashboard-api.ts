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
import {
  isRunRetriable,
  resolveDashboardActor,
  RunRetryAuditStore,
  spawnCliForceRetry,
} from "./run-retry";
import type { RetryActor, RunRetryAuditEntry, SpawnedRetryProcess } from "./run-retry";
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
  /**
   * How long a triggered retry blocks further retries of its task
   * (tests); defaults to {@link INFLIGHT_RETRY_TTL_MS}.
   */
  inflightRetryTtlMs?: number;
}

interface Stores {
  runs: RunStore;
  state: WorkerState;
  queue: WebhookQueue;
}

/** Retry metadata embedded in a run-detail response. */
export interface RunRetryInfo {
  eligible: boolean;
  reason?: string;
  /** Recent dashboard retries of this run, most recent first. */
  audit: RunRetryAuditEntry[];
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
  /** Lazy read-write connection for the retry audit trail. */
  private retryAuditStore: RunRetryAuditStore | null = null;
  /**
   * Task keys with a dashboard-triggered retry in flight (task key → claimed
   * at). The spawned CLI needs a moment to create its run row, so claims are
   * held until the TTL lapses rather than released with the HTTP response.
   */
  private inflightRetries = new Map<string, number>();
  private inflightRetryTtlMs: number;

  constructor(options: DashboardDataOptions = {}) {
    this.dbPath = options.dbPath ?? resolveQueueDbPath();
    this.workingDir = options.workingDir ?? process.cwd();
    this.inflightRetryTtlMs = options.inflightRetryTtlMs ?? INFLIGHT_RETRY_TTL_MS;
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

  listRuns(filter: {
    taskKey?: string;
    status?: RunStatus;
    origin?: RunOrigin;
    limit: number;
    offset: number;
  }): { runs: RunRecord[]; total: number } {
    return this.read({ runs: [], total: 0 }, (stores) => ({
      runs: stores.runs.listRuns(filter),
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

  /** Eligibility plus audit history for a run's retry action. */
  getRetryInfo(runId: number): RunRetryInfo | null {
    const detail = this.getRunDetail(runId);
    if (!detail) {
      return null;
    }
    const eligibility = isRunRetriable(detail.run);
    return {
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      audit: this.getRetryAuditStore().listForRun(runId),
    };
  }

  /** True while a dashboard-triggered retry for the task is in flight. */
  hasInflightRetry(taskKey: string): boolean {
    this.pruneInflightRetries();
    return this.inflightRetries.has(taskKey);
  }

  getRetryAuditStore(): RunRetryAuditStore {
    if (!this.retryAuditStore) {
      this.retryAuditStore = new RunRetryAuditStore(this.dbPath);
    }
    return this.retryAuditStore;
  }

  /** Claim the retry slot for a task; false when one is already held. */
  claimRetry(taskKey: string): boolean {
    this.pruneInflightRetries();
    if (this.inflightRetries.has(taskKey)) {
      return false;
    }
    this.inflightRetries.set(taskKey, Date.now());
    return true;
  }

  private pruneInflightRetries(now = Date.now()): void {
    for (const [taskKey, claimedAt] of this.inflightRetries) {
      if (now - claimedAt > this.inflightRetryTtlMs) {
        this.inflightRetries.delete(taskKey);
      }
    }
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
    this.retryAuditStore?.close();
    this.retryAuditStore = null;
  }
}

function badRequest(message: string): ApiResponse {
  return { status: 400, body: { error: message } };
}

function conflict(message: string): ApiResponse {
  return { status: 409, body: { error: message } };
}

function forbidden(message: string): ApiResponse {
  return { status: 403, body: { error: message } };
}

/**
 * Injectable collaborators for {@link handleRetryRun}, so tests can fake the
 * signed-in user and the spawned process.
 */
export interface RetryHandlerDeps {
  /** Resolve the acting support engineer; null = not signed in. */
  resolveActor?: (workingDir: string) => Promise<RetryActor | null>;
  /** Start the CLI retry flow for a task. */
  spawn?: (taskKey: string, workingDir: string) => SpawnedRetryProcess;
  /**
   * Authorized support-role emails. When non-empty, only these may trigger a
   * retry from the dashboard; when empty, any signed-in devintern user can.
   */
  allowedEmails?: readonly string[];
}

/**
 * Parse the comma-separated allowlist of authorized support roles
 * (`DASHBOARD_RETRY_EMAILS`).
 */
export function resolveAllowedRetryEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DASHBOARD_RETRY_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** How long a triggered retry blocks further retries of the same task. */
const INFLIGHT_RETRY_TTL_MS = 60_000;

/**
 * `POST /api/runs/:id/retry` — re-run this run's task via the same flow as
 * `devintern <TASK> --force`.
 *
 * Safeguards, in order:
 * 1. the run must exist,
 * 2. it must be eligible (failed/escalated/abandoned with a task key),
 * 3. the caller must be signed in (and on the support-role allowlist when
 *    `DASHBOARD_RETRY_EMAILS` is configured),
 * 4. no other retry may be in flight for the task (dashboard or worker — an
 *    `in_progress` run for the same task key also blocks).
 *
 * Returns 202 once the CLI subprocess has been detached; the new attempt then
 * shows up in the run list like any other run.
 *
 * @param data - Dashboard data source (also owns the in-flight guard)
 * @param idParam - Raw id path segment
 * @param deps - Injected collaborator overrides (tests)
 */
export async function handleRetryRun(
  data: DashboardData,
  idParam: string,
  deps: RetryHandlerDeps = {},
): Promise<ApiResponse> {
  const id = parseInt(idParam, 10);
  if (!Number.isFinite(id) || String(id) !== idParam) {
    return badRequest("run id must be an integer");
  }

  const detail = data.getRunDetail(id);
  if (!detail) {
    return { status: 404, body: { error: `run ${id} not found` } };
  }
  const run = detail.run;

  const eligibility = isRunRetriable(run);
  if (!eligibility.eligible || !run.taskKey) {
    return conflict(`not retriable: ${eligibility.reason ?? "unknown reason"}`);
  }
  const taskKey = run.taskKey;

  const actor =
    (await deps.resolveActor?.(data.workingDir)) ?? (await resolveDashboardActor(data.workingDir));
  if (!actor) {
    return forbidden("sign in first with `devintern login` to retry runs");
  }

  const allowedEmails = deps.allowedEmails ?? resolveAllowedRetryEmails();
  const actorEmail = actor.email?.toLowerCase();
  if (
    allowedEmails.length > 0 &&
    (!actorEmail || !allowedEmails.some((entry) => entry.toLowerCase() === actorEmail))
  ) {
    return forbidden(`${actor.email ?? "this user"} is not authorized to retry runs`);
  }

  // Concurrent retries: another dashboard retry for this task, or a live run
  // for the task (the worker records one as soon as it picks the ticket up).
  if (data.hasInflightRetry(taskKey)) {
    return conflict(`a retry of ${taskKey} was just triggered and is starting`);
  }
  const activeRun = data
    .listRuns({ taskKey, limit: MAX_LIMIT, offset: 0 })
    .runs.find((candidate) => candidate.status === "in_progress" && candidate.id !== run.id);
  if (activeRun) {
    return conflict(
      `${taskKey} already has a run in progress (run ${activeRun.id}); wait for it to finish`,
    );
  }

  if (!data.claimRetry(taskKey)) {
    return conflict(`a retry of ${taskKey} was just triggered and is starting`);
  }

  let spawned: SpawnedRetryProcess;
  try {
    spawned = deps.spawn
      ? deps.spawn(taskKey, data.workingDir)
      : spawnCliForceRetry({ taskKey, workingDir: data.workingDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    data.getRetryAuditStore().record({
      runId: id,
      taskKey,
      actor: actor.email ?? "unknown",
      action: "failed",
      message,
    });
    return { status: 500, body: { error: `could not start the retry: ${message}` } };
  }

  data.getRetryAuditStore().record({
    runId: id,
    taskKey,
    actor: actor.email ?? "unknown",
    action: "triggered",
    command: spawned.command,
    pid: spawned.pid,
  });

  return {
    status: 202,
    body: {
      status: "triggered",
      runId: id,
      taskKey,
      pid: spawned.pid,
      command: spawned.command,
    },
  };
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
 * `GET /api/runs/:id` — a run with its stages in insertion order and its
 * retry action metadata (eligibility + audit trail).
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
  const eligibility = isRunRetriable(detail.run);
  const retry: RunRetryInfo = {
    eligible: eligibility.eligible,
    reason: eligibility.reason,
    audit: data.getRetryAuditStore().listForRun(id),
  };
  return { status: 200, body: { run: detail.run, stages: detail.stages, retry } };
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
