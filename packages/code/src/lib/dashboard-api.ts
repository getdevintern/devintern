/**
 * Dashboard API
 *
 * Read-only JSON handlers over the worker's local state (SQLite run records,
 * agent PRs, cursors, queue counts, plus the tailed worker capture files).
 * Pure functions over a lazily opened read-only database so they are testable
 * without HTTP; `dashboard-server.ts` maps them to routes.
 *
 * The database may not exist yet (fresh install, worker never run) or may
 * predate some tables (older versions). Every handler degrades to an empty
 * state instead of failing, so the dashboard always renders.
 */

import { LockManager } from "./lock-manager";
import type { LockStatus } from "./lock-manager";
import type {
  AutomationScheduleStatus,
  DashboardAutomationActions,
  ManualTriggerOutcome,
} from "./automation-acquirer";
import { loadStandaloneAutomationActions } from "./automation-manual";
import { RunStore } from "./run-recorder";
import type { RunOrigin, RunRecord, RunStageRecord, RunStats, RunStatus } from "./run-recorder";
import {
  isRunRetriable,
  resolveDashboardActor,
  RunRetryAuditStore,
  ScheduledRetryStore,
  spawnCliForceRetry,
} from "./run-retry";
import type { RetryActor, RunRetryAuditEntry, SpawnedRetryProcess } from "./run-retry";
import { readWorkerLogs } from "./worker-logs";
import type { LogEntry, WorkerLogLevel, WorkerLogsResult } from "./worker-logs";
import { resolveQueueDbPath, WebhookQueue } from "./webhook-queue";
import { resolveWorkspaceDir } from "./workspace/paths";
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
const RUN_ORIGINS: RunOrigin[] = [
  "task",
  "pr_mention",
  "conflict_resolution",
  "scheduled",
  "estimate",
  "manual",
];

const STATS_WINDOWS: Record<string, number | null> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  all: null,
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const LOG_LEVELS: (WorkerLogLevel | "all")[] = ["all", "info", "warn", "error"];
const DEFAULT_LOG_LIMIT = 500;
const MAX_LOG_LIMIT = 1000;

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
   * How a retry is executed. `spawn` (default) starts a detached CLI
   * subprocess — correct for a standalone `devintern dashboard` running
   * inside a repo. `schedule` inserts a row into the workspace DB that the
   * workspace worker drains through its normal fleet pipeline (routing,
   * per-repo worktree, env, repo lock); used when the dashboard runs
   * alongside the fleet worker.
   */
  retryMode?: "spawn" | "schedule";
  /**
   * How long a triggered retry blocks further retries of its task
   * (tests); defaults to {@link INFLIGHT_RETRY_TTL_MS}.
   */
  inflightRetryTtlMs?: number;
  /**
   * How long a triggered manual automation run blocks further triggers of
   * the automation; defaults to {@link INFLIGHT_RETRY_TTL_MS}.
   */
  inflightAutomationTtlMs?: number;
  /**
   * Automation listing/triggering overrides. The workspace worker passes its
   * in-process scheduler so manual runs ride the exact scheduled pipeline;
   * when omitted, a standalone dashboard falls back to the project's own
   * `.devintern-code/automations.toml` (spawn path).
   */
  automationActions?: DashboardAutomationActions;
  /** Directories to search for worker capture files (primary first). */
  logDirs?: string[];
  /** Tail window per capture file; tests shrink this for truncation cases. */
  maxLogBytesPerFile?: number;
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

/** A log entry extended with the latest matching run, when one exists. */
export interface EnrichedLogEntry extends LogEntry {
  runId?: number;
  runStatus?: RunStatus;
}

/** Worker liveness as reported by `GET /api/worker`. */
export type WorkerLiveness = "running" | "stopped" | "unknown";

export interface WorkerStatusView {
  status: WorkerLiveness;
  pid?: number;
  startedAt?: string;
  /** Lock file the status was read from; absent when undeterminable. */
  lockFile?: string;
}

/** One open agent PR as served by `GET /api/agent-prs`. */
export interface OpenAgentPrView {
  repo: string;
  prNumber: number;
  prUrl: string;
  branch?: string;
  taskKey?: string;
  ticketUrl?: string;
  createdAt: number;
  updatedAt: number;
}

/** One configured scheduled automation as served by `GET /api/automations`. */
export interface DashboardAutomationView {
  id: string;
  enabled: boolean;
  /** Cron expression or interval as configured (`0 9 * * 1`, `6h`). */
  schedule?: string;
  repo?: string;
  /** The prompt executed per occurrence. */
  prompt: string;
  /** Next scheduled occurrence (epoch ms), when the scheduler registered it. */
  nextDueAt?: number;
  /** Most recent run of this automation (any origin), description stripped. */
  lastRun?: RunRecord;
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
  readonly retryMode: "spawn" | "schedule";
  private readonly logDirs: string[];
  private readonly maxLogBytesPerFile: number | undefined;
  private stores: Stores | null = null;
  /** Lazy read-write connection for the retry audit trail. */
  private retryAuditStore: RunRetryAuditStore | null = null;
  /** Lazy read-write connection for scheduled retries (schedule mode). */
  private scheduledRetryStore: ScheduledRetryStore | null = null;
  /**
   * Task keys with a dashboard-triggered retry in flight (task key → claimed
   * at). The spawned CLI needs a moment to create its run row, so claims are
   * held until the TTL lapses rather than released with the HTTP response.
   */
  private inflightRetries = new Map<string, number>();
  private inflightRetryTtlMs: number;
  /**
   * Automation ids with a dashboard-triggered manual run in flight (same
   * TTL rationale as {@linkcode inflightRetries}).
   */
  private inflightAutomationRuns = new Map<string, number>();
  private inflightAutomationTtlMs: number;
  /** Automation listing/triggering; lazily defaults to the standalone spawn path. */
  private automationActions: DashboardAutomationActions | null = null;
  private automationActionsOverride?: DashboardAutomationActions;

  constructor(options: DashboardDataOptions = {}) {
    this.dbPath = options.dbPath ?? resolveQueueDbPath();
    this.workingDir = options.workingDir ?? process.cwd();
    this.retryMode = options.retryMode ?? "spawn";
    this.inflightRetryTtlMs = options.inflightRetryTtlMs ?? INFLIGHT_RETRY_TTL_MS;
    this.inflightAutomationTtlMs = options.inflightAutomationTtlMs ?? INFLIGHT_RETRY_TTL_MS;
    this.automationActionsOverride = options.automationActions;
    if (options.logDirs !== undefined) {
      // Explicit dirs keep tests hermetic; the workspace home is not probed.
      this.logDirs = options.logDirs;
    } else {
      const dirs = [this.workingDir];
      const workspaceDir = resolveWorkspaceDir();
      if (!dirs.includes(workspaceDir)) {
        // Standalone `devintern dashboard` often runs outside the workspace
        // home where the daemon's service definition drops its capture files.
        dirs.push(workspaceDir);
      }
      this.logDirs = dirs;
    }
    this.maxLogBytesPerFile = options.maxLogBytesPerFile;
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
    automationId?: string;
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

  /** Store backing the schedule mode of the retry action. */
  getScheduledRetryStore(): ScheduledRetryStore {
    if (!this.scheduledRetryStore) {
      this.scheduledRetryStore = new ScheduledRetryStore(this.dbPath);
    }
    return this.scheduledRetryStore;
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
    for (const [automationId, claimedAt] of this.inflightAutomationRuns) {
      if (now - claimedAt > this.inflightAutomationTtlMs) {
        this.inflightAutomationRuns.delete(automationId);
      }
    }
  }

  /** Automation listing/triggering, defaulting to the standalone spawn path. */
  getAutomationActions(): DashboardAutomationActions {
    if (!this.automationActions) {
      // Standalone dashboards (spawn mode) read the project's own automation
      // config; a worker-embedded dashboard without an in-process scheduler
      // has none to offer (workspace [[automations]] would need the fleet
      // pipeline), so it serves an empty catalog rather than a wrong one.
      this.automationActions =
        this.automationActionsOverride ??
        (this.retryMode === "spawn"
          ? loadStandaloneAutomationActions(this.workingDir)
          : EMPTY_AUTOMATION_ACTIONS);
    }
    return this.automationActions;
  }

  /**
   * Dashboard catalog of configured automations with their schedule state and
   * most recent run (any origin) — the "Run now" view's backing data.
   */
  getAutomations(): DashboardAutomationView[] {
    let statuses: AutomationScheduleStatus[];
    try {
      statuses = this.getAutomationActions().list();
    } catch {
      return [];
    }
    return statuses.map((status) => {
      const lastRun = this.read(
        undefined,
        (stores) => stores.runs.listRuns({ automationId: status.id, limit: 1, offset: 0 })[0],
      );
      return {
        id: status.id,
        enabled: status.enabled,
        schedule: status.cron ?? status.interval,
        repo: status.repo,
        prompt: status.prompt,
        nextDueAt: status.nextDueAt,
        lastRun: lastRun ? { ...lastRun, taskDescription: undefined } : undefined,
      };
    });
  }

  /** True while a dashboard-triggered manual run for the automation is starting. */
  hasInflightAutomationRun(automationId: string): boolean {
    this.pruneInflightRetries();
    return this.inflightAutomationRuns.has(automationId);
  }

  /** Claim the manual-run slot for an automation; false when one is already held. */
  claimAutomationRun(automationId: string): boolean {
    this.pruneInflightRetries();
    if (this.inflightAutomationRuns.has(automationId)) {
      return false;
    }
    this.inflightAutomationRuns.set(automationId, Date.now());
    return true;
  }

  /** Give the manual-run slot back (the trigger failed; retry immediately). */
  releaseAutomationRun(automationId: string): void {
    this.inflightAutomationRuns.delete(automationId);
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

  /**
   * Open agent-created PRs with their GitHub URLs (`GET /api/agent-prs`).
   * Ticket links are frozen in the registry by the worker at PR-creation
   * time (from the tracker configured then), so they survive tracker
   * switches and stay correct even when this dashboard process runs
   * without tracker configuration.
   */
  getOpenAgentPrs(): OpenAgentPrView[] {
    return this.read([], (stores) =>
      stores.state.listOpenAgentPrs().map((pr) => ({
        repo: pr.repo,
        prNumber: pr.prNumber,
        prUrl: `https://github.com/${pr.repo}/pull/${pr.prNumber}`,
        branch: pr.branch,
        taskKey: pr.taskKey,
        ticketUrl: pr.ticketUrl,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
      })),
    );
  }

  getCursors(): Cursor[] {
    return this.read([], (stores) => stores.state.listCursors());
  }

  /**
   * Tail the worker's capture files and link entries to their latest run.
   * File reads are bounded (see `readWorkerLogs`); a missing DB only skips
   * the run enrichment, never breaks the response.
   */
  getWorkerLogs(
    filter: { limit?: number; level?: WorkerLogLevel | "all" } = {},
  ): WorkerLogsResult & {
    entries: EnrichedLogEntry[];
  } {
    const result = readWorkerLogs({
      dirs: this.logDirs,
      limit: filter.limit,
      level: filter.level,
      maxBytesPerFile: this.maxLogBytesPerFile,
    });
    const keys = [
      ...new Set(result.entries.flatMap((entry) => (entry.taskKey ? [entry.taskKey] : []))),
    ];
    // One batched lookup for all keys (see RunStore.latestRunByTaskKey) —
    // per-key queries here would mean up to MAX_LOG_LIMIT queries per poll.
    const runsByKey = this.read<Map<string, { id: number; status: RunStatus | undefined }>>(
      new Map(),
      (stores) => {
        const latest = stores.runs.latestRunByTaskKey(keys);
        const trimmed = new Map<string, { id: number; status: RunStatus | undefined }>();
        for (const [key, run] of latest) {
          trimmed.set(key, { id: run.id, status: run.status });
        }
        return trimmed;
      },
    );
    if (runsByKey.size === 0) {
      return { ...result, entries: result.entries };
    }
    return {
      ...result,
      entries: result.entries.map((entry): EnrichedLogEntry => {
        const linkedRun = entry.taskKey ? runsByKey.get(entry.taskKey) : undefined;
        if (!linkedRun) {
          return entry;
        }
        return { ...entry, runId: linkedRun.id, runStatus: linkedRun.status };
      }),
    };
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
    this.scheduledRetryStore?.close();
    this.scheduledRetryStore = null;
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

/** No-automation bridge for worker-embedded dashboards whose worker runs none. */
const EMPTY_AUTOMATION_ACTIONS: DashboardAutomationActions = {
  list: () => [],
  trigger: async () => ({ ok: false, reason: "no automations are configured" }),
};

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
 * `POST /api/runs/:id/retry` — re-run this run's task.
 *
 * Safeguards, in order:
 * 1. the run must exist,
 * 2. it must be eligible (failed/escalated/abandoned with a task key),
 * 3. the caller must be signed in (and on the support-role allowlist when
 *    `DASHBOARD_RETRY_EMAILS` is configured),
 * 4. no other retry may be in flight for the task (dashboard or worker — an
 *    `in_progress` run for the same task key also blocks).
 *
 * Two execution modes, picked by the server options:
 * - `schedule` (workspace worker): inserts a `pending` row into the
 *   `scheduled_retries` table; the worker drains it through the normal fleet
 *   pipeline (routing, per-repo worktree, env, repo lock) with `--force`.
 * - `spawn` (standalone dashboard, default): spawns `devintern <TASK>
 *   --force` as a detached subprocess of the dashboard server.
 *
 * Returns 202 once the retry is queued; the new attempt then shows up in the
 * run list like any other run.
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
  if (data.retryMode === "schedule") {
    if (data.getScheduledRetryStore().hasActive(taskKey)) {
      return conflict(`a retry of ${taskKey} is already scheduled or running`);
    }
  } else if (data.hasInflightRetry(taskKey)) {
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

  if (data.retryMode === "schedule") {
    const store = data.getScheduledRetryStore();
    const scheduled = store.schedule({ taskKey, runId: id, actor: actor.email ?? "unknown" });
    if (!scheduled.scheduled) {
      return conflict(`a retry of ${taskKey} is already scheduled or running`);
    }
    data.getRetryAuditStore().record({
      runId: id,
      taskKey,
      actor: actor.email ?? "unknown",
      action: "scheduled",
      message: "queued for the worker",
    });
    return {
      status: 202,
      body: {
        status: "scheduled",
        runId: id,
        taskKey,
      },
    };
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
 * Injectable collaborators for {@link handleRunAutomation}, so tests can fake
 * the signed-in user and the manual-run trigger.
 */
export interface AutomationRunDeps {
  /** Resolve the acting user; null = not signed in. */
  resolveActor?: (workingDir: string) => Promise<RetryActor | null>;
  /** Start one manual run of the automation. */
  trigger?: (automationId: string) => Promise<ManualTriggerOutcome>;
  /**
   * Authorized emails. When non-empty, only these may trigger manual runs
   * from the dashboard; when empty, any signed-in devintern user can.
   */
  allowedEmails?: readonly string[];
}

/**
 * Parse the comma-separated allowlist of emails allowed to trigger manual
 * automation runs (`DASHBOARD_AUTOMATION_EMAILS`).
 */
export function resolveAllowedAutomationEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DASHBOARD_AUTOMATION_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * `GET /api/automations` — configured scheduled automations with their
 * schedule state, next occurrence, and most recent run.
 *
 * @param data - Dashboard data source
 */
export function handleAutomations(data: DashboardData): ApiResponse {
  return { status: 200, body: { automations: data.getAutomations() } };
}

/**
 * `POST /api/automations/:id/run` — dashboard "Run now": trigger one manual
 * run of a scheduled automation through the same pipeline a scheduled run
 * uses (worker-embedded dashboard) or the standalone spawn path.
 *
 * Safeguards, in order:
 * 1. the automation must be configured,
 * 2. the caller must be signed in (and on the `DASHBOARD_AUTOMATION_EMAILS`
 *    allowlist when configured),
 * 3. the automation must be enabled — a disabled automation is refused with
 *    a message instead of silently running,
 * 4. no run of the automation may be in progress (dashboard or worker), and
 *    a second rapid trigger is debounced by an in-flight claim,
 * 5. the trigger itself re-validates overlap (schedule lease, busy repo) and
 *    surfaces the reason on refusal.
 *
 * Returns 202 once the run started; it then shows up in the run list with
 * origin `manual` and the automation's id.
 *
 * @param data - Dashboard data source (owns the in-flight guard)
 * @param idParam - Raw automation id path segment
 * @param deps - Injected collaborator overrides (tests)
 */
export async function handleRunAutomation(
  data: DashboardData,
  idParam: string,
  deps: AutomationRunDeps = {},
): Promise<ApiResponse> {
  let automationId: string;
  try {
    automationId = decodeURIComponent(idParam).trim();
  } catch {
    return badRequest("invalid automation id");
  }
  if (!automationId) {
    return badRequest("automation id is required");
  }

  const automations = data.getAutomations();
  const automation = automations.find((item) => item.id === automationId);
  if (!automation) {
    return { status: 404, body: { error: `automation "${automationId}" not found` } };
  }

  const actor =
    (await deps.resolveActor?.(data.workingDir)) ?? (await resolveDashboardActor(data.workingDir));
  if (!actor) {
    return forbidden("sign in first with `devintern login` to trigger automations");
  }

  const allowedEmails = deps.allowedEmails ?? resolveAllowedAutomationEmails();
  const actorEmail = actor.email?.toLowerCase();
  if (
    allowedEmails.length > 0 &&
    (!actorEmail || !allowedEmails.some((entry) => entry.toLowerCase() === actorEmail))
  ) {
    return forbidden(`${actor.email ?? "this user"} is not authorized to trigger automations`);
  }

  if (!automation.enabled) {
    return conflict(`automation "${automationId}" is disabled; enable it in the config first`);
  }

  const activeRun = data.listRuns({ automationId, status: "in_progress", limit: 1, offset: 0 })
    .runs[0];
  if (activeRun) {
    return conflict(
      `automation "${automationId}" already has a run in progress (run ${activeRun.id}); wait for it to finish`,
    );
  }

  // Standalone spawn mode: the spawned CLI needs a moment to create its run
  // row, so rapid repeat triggers are debounced until the TTL lapses. The
  // worker-embedded dashboard relies on the automation's schedule lease.
  if (data.retryMode === "spawn" && !data.claimAutomationRun(automationId)) {
    return conflict(`a manual run of "${automationId}" was just triggered and is starting`);
  }

  const trigger = deps.trigger ?? ((id: string) => data.getAutomationActions().trigger(id));
  let outcome: ManualTriggerOutcome;
  try {
    outcome = await trigger(automationId);
  } catch (error) {
    data.releaseAutomationRun(automationId);
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, body: { error: `could not start the run: ${message}` } };
  }
  if (!outcome.ok) {
    data.releaseAutomationRun(automationId);
    return conflict(outcome.reason);
  }

  return {
    status: 202,
    body: {
      status: "triggered",
      automationId,
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
 * Resolve worker liveness from the daemon's lock file.
 *
 * The worker writes `.worker.lock` under `.devintern-code/` of its working
 * directory (simple mode) or directly into the workspace home (fleet mode),
 * so both locations are consulted. A readable lock with a dead pid (a stale
 * lock left behind by a crashed worker) must not shadow a live lock in the
 * other location: the live lock wins, and `stopped` is only reported when
 * every readable lock belongs to a dead process. When no readable lock file
 * exists in either location, liveness is `unknown`: the worker may be
 * running elsewhere, and claiming "stopped" would be wrong.
 *
 * @param workingDir - Project root the dashboard was started from
 */
function resolveWorkerStatus(workingDir: string): WorkerStatusView {
  const locks = [
    LockManager.readLockStatus(workingDir, WORKER_LOCK_FILE),
    LockManager.readLockStatus(resolveWorkspaceDir(), WORKER_LOCK_FILE, { plainDir: true }),
  ].filter((lock): lock is LockStatus => lock !== null);
  if (locks.length === 0) {
    return { status: "unknown" };
  }
  // A live lock beats a stale one regardless of which location it sits in.
  const lock = locks.find((candidate) => candidate.running) ?? locks[0];
  return {
    status: lock.running ? "running" : "stopped",
    pid: lock.pid,
    startedAt: lock.startedAt,
    lockFile: lock.path,
  };
}

/**
 * `GET /api/worker` — worker liveness, queue counts, agent PRs, poll cursors.
 *
 * @param data - Dashboard data source
 */
export function handleWorkerStatus(data: DashboardData): ApiResponse {
  return {
    status: 200,
    body: {
      worker: resolveWorkerStatus(data.workingDir),
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

/**
 * `GET /api/agent-prs` — open agent-created PRs with GitHub links.
 *
 * The registry is reconciled with GitHub by the worker's review polling, so
 * PRs merged or closed outside the worker drop out within one poll cycle.
 *
 * @param data - Dashboard data source
 */
export function handleAgentPrs(data: DashboardData): ApiResponse {
  return { status: 200, body: { prs: data.getOpenAgentPrs() } };
}

/**
 * `GET /api/logs` — the most recent worker log entries, tailed from the
 * capture files with an entry-count bound.
 *
 * @param data - Dashboard data source
 * @param params - Query params: `limit` (1..1000, default 500) and
 *                 `level` (all | info | warn | error, default all)
 */
export function handleLogs(data: DashboardData, params: URLSearchParams): ApiResponse {
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? DEFAULT_LOG_LIMIT : parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
    return badRequest(`limit must be between 1 and ${MAX_LOG_LIMIT}`);
  }
  const rawLevel = params.get("level") ?? "all";
  if (!LOG_LEVELS.includes(rawLevel as WorkerLogLevel | "all")) {
    return badRequest(`level must be one of: ${LOG_LEVELS.join(", ")}`);
  }
  return {
    status: 200,
    body: data.getWorkerLogs({ limit, level: rawLevel as WorkerLogLevel | "all" }),
  };
}
