/**
 * Types mirroring the read-only JSON API served by `devintern dashboard`
 * (packages/code/src/lib/dashboard-api.ts), plus a polling fetch hook.
 * Overview and workspace response types live in `api-overview.ts` and
 * `api-workspace.ts`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type RunOrigin =
  | "task"
  | "error_monitor"
  | "pr_mention"
  | "ci_fix"
  | "conflict_resolution"
  | "auto_merge"
  | "scheduled"
  | "estimate"
  | "manual"
  | "local";

export type RunStatus =
  | "in_progress"
  | "succeeded"
  | "failed"
  | "deferred"
  | "escalated"
  | "abandoned";

export interface RunRecord {
  id: number;
  origin: RunOrigin;
  automationId?: string;
  ticketKey?: string;
  ticketUrl?: string;
  taskDescription?: string;
  /** Short plain-text preview on the activity board. */
  taskTitle?: string;
  taskKey?: string;
  tracker?: string;
  harness?: string;
  branch?: string;
  repo?: string;
  prNumber?: number;
  prUrl?: string;
  status: RunStatus;
  outcomeReason?: string;
  /** 1-based attempt number of this run for its task. */
  attempt?: number;
  step?: string;
  stepStartedAt?: number;
  stepActive?: boolean;
  startedAt: number;
  finishedAt?: number;
}

/** Outcome stages carry the run's terminal status (escalated, deferred, …). */
export type StageStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "deferred"
  | "escalated"
  | "abandoned";

export interface RunStageRecord {
  id: number;
  runId: number;
  stage: "feasibility" | "implementation" | "verify" | "auto_review" | "change_request" | "outcome";
  status: StageStatus;
  summary?: string;
  detail?: string;
  createdAt: number;
}

export interface TaskActivityResponse {
  runs: RunRecord[];
  recentLimit: number;
}

/** `/api/runs` URL for the most recent runs of one automation. */
export function automationRunsUrl(automationId: string, limit = 10): string {
  return scheduledJobRunsUrl({ automationId }, limit);
}

/** Run-list URL for one scheduled job's run filter. */
export function scheduledJobRunsUrl(filter: ScheduledJobRunFilter, limit = 10): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filter.automationId) params.set("automationId", filter.automationId);
  if (filter.origin) params.set("origin", filter.origin);
  return `/api/runs?${params}`;
}

/** Whether a recorded run belongs to a scheduled job's run filter. */
export function runMatchesFilter(run: RunRecord, filter: ScheduledJobRunFilter): boolean {
  return (
    (!filter.automationId || run.automationId === filter.automationId) &&
    (!filter.origin || run.origin === filter.origin)
  );
}

export interface RunsResponse {
  runs: RunRecord[];
  total: number;
}

export interface RunDetailResponse {
  run: RunRecord;
  stages: RunStageRecord[];
  /** Retry action metadata for this run (eligibility + audit trail). */
  retry: RetryInfo;
  /** Per-execution harness transcripts attributed to this run, newest first. */
  harnessLogs: HarnessLogFile[];
  /** Task artifacts under the run's output directory, sorted by path. */
  artifacts: TaskArtifactFile[];
}

/** One durable agent-harness execution transcript under `logs/harness/`. */
export interface HarnessLogFile {
  name: string;
  size: number;
  modifiedAt: number;
  startedAt: number | null;
  origin: string;
  taskKey?: string;
  runId?: number;
  /** 1-based attempt number of the run that produced the log, when known. */
  attempt?: number;
  label?: string;
}

/** Redacted tail of a harness execution log. */
export interface HarnessLogContent {
  name: string;
  content: string;
  truncated: boolean;
  totalBytes: number;
}

/** One immutable registered output, owned by a run and a step execution. */
export interface TaskArtifactFile {
  id: string;
  key: string;
  name: string;
  title: string;
  kind: string;
  mediaType: string;
  step: string;
  iteration: number;
  commitSha?: string;
  createdAt: number;
  size: number;
  available: boolean;
  publication?: {
    status: "published" | "failed" | "skipped";
    commentUrl?: string;
    message?: string;
  };
  upload?: { status: "uploaded" | "failed"; message?: string };
}

export interface TaskArtifactContent {
  name: string;
  content: string | null;
  truncated: boolean;
  totalBytes: number;
}

/** One audited dashboard retry of a run. */
export interface RetryAuditEntry {
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

/** Retry metadata embedded in a run-detail response. */
export interface RetryInfo {
  eligible: boolean;
  /**
   * How the retry dispatches: `task` forces the task key through the CLI,
   * `automation` re-runs the automation that produced the run, and `injected`
   * re-queues the ad-hoc `worker add` row so the branch and prior report are
   * resumed instead of starting over.
   */
  kind?: "task" | "automation" | "injected";
  reason?: string;
  /** Recent dashboard retries of this run, most recent first. */
  audit: RetryAuditEntry[];
}

/**
 * Trigger a retry of a run: the fleet worker drains it through the normal
 * pipeline (`schedule` mode) or the dashboard spawns `devintern <TASK>
 * --force` (`triggered`, standalone dashboard). Resolves with the parsed JSON
 * body regardless of status; callers should branch on `response.ok`.
 */
export async function triggerRunRetry(runId: number): Promise<{
  ok: boolean;
  body: { error?: string; status?: string; command?: string; pid?: number };
}> {
  const response = await fetch(`/api/runs/${runId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    status?: string;
    command?: string;
    pid?: number;
  };
  return { ok: response.ok, body };
}

/** What the user typed in the "Report a problem" form. */
export interface ReportDraft {
  title: string;
  description: string;
  shareIdentifiers: boolean;
}

/** Redacted bug-report payload exactly as it will be sent (opaque to the UI). */
export interface ReportPayload {
  reportId: string;
  title: string;
  description: string;
  [key: string]: unknown;
}

/** `POST /api/runs/:id/report/preview` response: what will be sent. */
export interface ReportPreview {
  previewId: string;
  expiresAt: number;
  runId: number;
  signedIn: boolean;
  /** Anonymous reports need a contact email to submit. */
  contactRequired: boolean;
  destination: string;
  title: string;
  description: string;
  bytes: number;
  attachments: {
    environment: {
      cliVersion: string;
      installKind: string;
      os: string;
      arch: string;
      ci: boolean;
      harness?: string;
      tracker?: string;
      sandbox?: string;
      signedIn: boolean;
    };
    run: {
      id?: number;
      status: string;
      failedStep?: string;
      durationMs?: number;
      stageCount: number;
      hasReason: boolean;
    } | null;
    logs: { source: string; lines: number; bytes: number; truncated: boolean }[];
    evidenceCount: number;
    identifiersShared: boolean;
  };
  omitted: string[];
  payload: ReportPayload;
}

/** `POST /api/reports` outcome. */
export type ReportSubmitResult =
  | { status: "sent"; reportId: string; shortId: string; url?: string; receipt?: string }
  | {
      status: "saved";
      error: string;
      authExpired: boolean;
      savedPath: string;
      retryCommand: string;
    };

/** Read an error message from a JSON error body. */
function errorMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

/**
 * Build the redacted report for a run without sending it. Throws with the
 * server's message on failure.
 */
export async function previewRunReport(runId: number, draft: ReportDraft): Promise<ReportPreview> {
  const response = await fetch(`/api/runs/${runId}/report/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(body, `Preview failed (HTTP ${response.status})`));
  }
  return body as ReportPreview;
}

/**
 * Send a previewed report. A failed delivery that was saved locally resolves
 * with `status: "saved"`; validation errors (missing email, expired preview)
 * throw with the server's message.
 */
export async function submitReport(previewId: string, email?: string): Promise<ReportSubmitResult> {
  const response = await fetch("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(email ? { previewId, email } : { previewId }),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (body !== null && typeof body === "object" && "status" in body) {
    const { status } = body as { status: unknown };
    if (status === "sent" || status === "saved") return body as ReportSubmitResult;
  }
  throw new Error(errorMessage(body, `Send failed (HTTP ${response.status})`));
}

/** One configured scheduled automation as served by `GET /api/automations`. */
export type ScheduledJobKind = "automation" | "estimation" | "conflict_resolution" | "auto_merge";

/** Which recorded runs belong to one scheduled job (`GET /api/runs` filters). */
export interface ScheduledJobRunFilter {
  automationId?: string;
  origin?: RunOrigin;
}

export interface AutomationSchedule {
  id: string;
  /**
   * Job type: a prompt automation, a story-point estimation sweep, or the
   * scheduled conflict-resolution window. Absent (older servers) = automation.
   */
  kind?: ScheduledJobKind;
  /** Display name when it differs from `id` (namespaced ids). */
  title?: string;
  enabled: boolean;
  /** Cron expression or interval as configured (`0 9 * * 1`, `6h`). */
  schedule?: string;
  repo?: string;
  /** The prompt executed per occurrence. */
  prompt: string;
  /** Whether occurrences open a pull request (opt-in; default off). */
  openPr?: boolean;
  /** Per-automation agent harness override; absent inherits the workspace agent. */
  harness?: string;
  /** Per-automation model override; absent keeps the harness default. */
  model?: string;
  /** Per-automation reasoning effort override; absent keeps the harness default. */
  effort?: string;
  /** Next scheduled occurrence (epoch ms). */
  nextDueAt?: number;
  /** Estimation sweeps: tracker query selecting the tickets to estimate. */
  query?: string;
  /** Estimation sweeps: `[[teams]]` name whose tracker the sweep uses. */
  team?: string;
  /** Recorded runs attributed to this job; absent (older servers) = `{ automationId: id }`. */
  runFilter?: ScheduledJobRunFilter;
  /** Most recent run of this automation (any origin). */
  lastRun?: RunRecord;
  /** Occurrence in flight on this worker, including one still waiting for a slot. */
  activity?: AutomationActivity;
}

/**
 * What an occurrence is doing before (or while) its run record exists. A run
 * waiting for a free slot has no run row yet, so this is its only trace.
 */
export interface AutomationActivity {
  /** `waiting`: not admitted yet. `running`: the run's process has started. */
  state: "waiting" | "running";
  /** When the occurrence entered this state (epoch ms). */
  since: number;
  trigger: "scheduled" | "manual";
  /** Why a waiting occurrence has not started yet. */
  reason?: string;
}

export interface AutomationsResponse {
  automations: AutomationSchedule[];
}

/**
 * Trigger a manual "Run now" execution of a scheduled automation. Resolves
 * with the parsed JSON body regardless of status; callers should branch on
 * `response.ok`.
 */
export async function triggerAutomation(automationId: string): Promise<{
  ok: boolean;
  body: { error?: string; status?: string };
}> {
  const response = await fetch(`/api/automations/${encodeURIComponent(automationId)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    status?: string;
  };
  return { ok: response.ok, body };
}

export const TASKS_URL = "/api/tasks";

/** `POST /api/tasks` body: an ad-hoc task (equivalent of `devintern worker add`). */
export interface CreateTaskInput {
  repo: string;
  title: string;
  body: string;
  /** Dedupes a resubmission while the first task is pending/running. */
  idempotencyKey: string;
}

/** `POST /api/tasks` success body (same shape as `worker add --json`). */
export interface CreatedTask {
  id: number;
  taskKey: string;
  repo: string;
  status: string;
  deduplicated: boolean;
}

export type CreateTaskResult = { ok: true; task: CreatedTask } | { ok: false; error: string };

/** Parse the `POST /api/tasks` success body, or null when it has the wrong shape. */
export function parseCreatedTask(value: unknown): CreatedTask | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "number" ||
    typeof record.taskKey !== "string" ||
    typeof record.repo !== "string" ||
    typeof record.status !== "string" ||
    typeof record.deduplicated !== "boolean"
  ) {
    return null;
  }
  return {
    id: record.id,
    taskKey: record.taskKey,
    repo: record.repo,
    status: record.status,
    deduplicated: record.deduplicated,
  };
}

/**
 * Enqueue an ad-hoc task for the workspace worker. Same-origin JSON POST, so
 * it passes the dashboard's Origin/Content-Type guard on write requests.
 */
export async function createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  let response: Response;
  try {
    response = await fetch(TASKS_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `HTTP ${response.status}`;
    return { ok: false, error };
  }
  const task = parseCreatedTask(body);
  return task ? { ok: true, task } : { ok: false, error: "unexpected response from the server" };
}

/** Outcome of `POST /api/tasks/:id/cancel` (same values as `worker cancel --json`). */
export type CancelTaskOutcome =
  | "cancelled"
  | "already_cancelled"
  | "already_started"
  | "already_finished"
  | "not_found";

const CANCEL_OUTCOMES: readonly CancelTaskOutcome[] = [
  "cancelled",
  "already_cancelled",
  "already_started",
  "already_finished",
  "not_found",
];

export type CancelTaskResult =
  | { ok: true; outcome: CancelTaskOutcome; message: string }
  | { ok: false; outcome?: CancelTaskOutcome; error: string };

/** URL of the cancel action for one ad-hoc task key. */
export function cancelTaskUrl(taskKey: string): string {
  return `${TASKS_URL}/${encodeURIComponent(taskKey)}/cancel`;
}

/**
 * Cancel a pending ad-hoc task. Same-origin JSON POST, so it passes the
 * dashboard's Origin/Content-Type write guard. `ok` is true only when the
 * task ends up cancelled (now or earlier).
 */
export async function cancelTask(taskKey: string): Promise<CancelTaskResult> {
  let response: Response;
  try {
    response = await fetch(cancelTaskUrl(taskKey), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const outcome = CANCEL_OUTCOMES.find((value) => value === record.outcome);
  const message = typeof record.message === "string" ? record.message : undefined;
  if (response.ok && outcome) {
    return { ok: true, outcome, message: message ?? `Cancelled ${taskKey}` };
  }
  const error =
    message ?? (typeof record.error === "string" ? record.error : `HTTP ${response.status}`);
  return { ok: false, outcome, error };
}

/** One non-empty local weekday × hour bucket for one origin. */
export interface RunActivityCell {
  origin: RunOrigin;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  hour: number;
  starts: number;
  /** Agent time in this hour; overlapping runs add up. */
  busyMs: number;
}

export interface RunActivity {
  /** IANA timezone the buckets are expressed in. */
  timezone: string;
  cells: RunActivityCell[];
}

export interface StatsResponse {
  window: string;
  /** Worker host timezone (cron automations fire in this zone). */
  hostTimeZone?: string;
  stats: {
    totals: { runs: number; byStatus: Record<RunStatus, number> };
    successRate: number | null;
    escalationRate: number | null;
    runsPerWeek: { weekStart: string; count: number }[];
    medianDurationMs: number | null;
    byHarness: {
      harness: string;
      runs: number;
      succeeded: number;
      failed: number;
      escalated: number;
      medianDurationMs: number | null;
    }[];
    byOrigin: Record<RunOrigin, number>;
    /** Absent from workers older than the activity heatmap. */
    activity?: RunActivity;
  } | null;
}

/** Working-window (quiet hours) status from the worker process. */
export interface ScheduleSnapshot {
  enabled: boolean;
  pickupAllowed: boolean;
  active: string[];
  blocked: string[];
  timezone: string;
  catchUpMissed: boolean;
  manualRequested: boolean;
  nextChange?: { at: number; kind: "open" | "close" };
}

export type WorkerLiveness = "running" | "stopped" | "unknown";

export interface WorkerStatus {
  status: WorkerLiveness;
  pid?: number;
  startedAt?: string;
  /** Lock file the status was read from; absent when it could not be determined. */
  lockFile?: string;
  /**
   * Why the status is `unknown` despite a lock file: the lock owner runs in
   * another PID namespace (e.g. the dashboard runs inside a sandbox), so its
   * pid cannot be verified from here.
   */
  reason?: "pid-namespace";
}

export interface WorkerResponse {
  worker: WorkerStatus;
  queue: {
    /** Relay/webhook deliveries awaiting or inside the normal poll loop. */
    pending: number;
    processing: number;
    failed: number;
    /** Ad-hoc tasks enqueued by `devintern worker add`. */
    injected: { pending: number; running: number };
    /** Retries scheduled by the dashboard's Retry action. */
    retries: { pending: number; running: number };
  };
  agentPrs: { open: number; closed: number };
  schedule?: ScheduleSnapshot | null;
  cursors: { source: string; cursorValue: string; updatedAt: number }[];
  dbPath: string;
  dbMissing: boolean;
  queueDbPath: string;
  /** Whether the durable queue database file is absent. */
  queueDbMissing: boolean;
  /**
   * Health of each automation source in the current config. Absent from
   * older servers; empty (with {@link sourcesError}) when it could not be read.
   */
  sources?: SourceHealth[];
  sourcesError?: string;
}

/** Outcome of the most recent read of an automation source. */
export type SourceHealthStatus = "ok" | "unreadable" | "rate-limited" | "auth-failed";

/** One automation source (an error monitor today) as served by `GET /api/sources`. */
export interface SourceHealth {
  provider: string;
  sourceId: string;
  status: SourceHealthStatus;
  /** Epoch ms of the most recent read attempt. */
  checkedAt: number;
  lastSuccessAt?: number | null;
  consecutiveFailures: number;
  message?: string | null;
  /** When rate-limited, epoch ms after which the worker reads again. */
  retryAfterAt?: number | null;
}

export interface SourcesResponse {
  sources: SourceHealth[];
}

/** Where a queued item came from. */
export type QueuedWorkKind = "ad-hoc" | "retry" | "webhook" | "automation";

/** One pending item from `GET /api/queue`; running rows are active work instead. */
export interface QueuedWorkItem {
  /** Stable across polls: `<kind>:<row id>`. */
  id: string;
  kind: QueuedWorkKind;
  title: string;
  taskKey?: string;
  repo?: string;
  actor?: string;
  createdAt: number;
  /** Earliest pickup time while backing off after a deferral. */
  notBefore?: number;
  deferCount?: number;
  message?: string;
  /** Ad-hoc prompt body, clipped server-side. */
  body?: string;
  bodyTruncated?: boolean;
  /** Retry: the run being retried. */
  runId?: number;
  eventType?: string;
  prNumber?: number;
  prUrl?: string;
  attempts?: number;
  lastError?: string;
  /** Automation: the scheduled job waiting for a slot. */
  automationId?: string;
  /** Ad-hoc: task keys this task depends on. */
  dependsOn?: string[];
  /** Ad-hoc: `merged` (wait for merges) or `stacked` (branch from one unmerged dependency). */
  dependencyMode?: "merged" | "stacked";
  /** Ad-hoc: `waiting` or `blocked` on a dependency; unset once claimable. */
  dependencyState?: "waiting" | "blocked";
  /** Ad-hoc: why, naming the dependency. */
  dependencyReason?: string;
}

/** A recently cancelled ad-hoc task (audit trail; it will not run). */
export interface CancelledTaskItem {
  id: string;
  taskKey: string;
  title: string;
  repo: string;
  createdAt: number;
  cancelledAt?: number;
  /** `cli` (`devintern worker cancel`) or `dashboard`. */
  cancelledBy?: "cli" | "dashboard";
  cancelReason?: string;
}

export interface QueuedWorkResponse {
  /** Pending items in the order they become claimable. */
  items: QueuedWorkItem[];
  /** Every pending item, including any beyond the listed ones. */
  total: number;
  /** Most recently cancelled ad-hoc tasks, newest first (absent on older servers). */
  cancelled?: CancelledTaskItem[];
}

/** One agent-created PR (registry rows reconciled with GitHub by the worker). */
export interface AgentPrRecord {
  provider?: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  branch?: string;
  taskKey?: string;
  ticketUrl?: string;
  /** When the worker saw the PR merged (epoch ms); only in the merged list. */
  mergedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentPrsResponse {
  prs: AgentPrRecord[];
}

export type WorkerLogLevel = "info" | "warn" | "error";

export type LogStream = "out" | "err";

export interface LogEntry {
  index: number;
  timestamp: number | null;
  level: WorkerLogLevel;
  stream: LogStream;
  message: string;
  taskKey?: string | null;
  runId?: number;
  runStatus?: RunStatus;
}

export interface LogSourceInfo {
  path: string;
  stream: LogStream;
  exists: boolean;
  totalBytes: number;
  readBytes: number;
  truncated: boolean;
  error: string;
}

export interface LogsResponse {
  available: boolean;
  entries: LogEntry[];
  sources: LogSourceInfo[];
  truncated: boolean;
}

/** Dashboard API endpoints for the overview and workspace screens. */
export const OVERVIEW_URL = "/api/overview";
export const WORKSPACE_URL = "/api/workspace";

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Fetch a JSON endpoint now and on an interval, pausing while the tab is
 * hidden. Stale responses (superseded by a newer request) are discarded.
 */
export function usePoll<T>(url: string, intervalMs = 5000): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${response.status}`);
        }
        return (await response.json()) as T;
      })
      .then((payload) => {
        if (seq === requestSeq.current) {
          setData(payload);
          setError(null);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (seq === requestSeq.current && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      });
    return controller;
  }, [url]);

  useEffect(() => {
    setLoading(true);
    let controller = load();
    const timer = setInterval(() => {
      if (!document.hidden) {
        controller.abort();
        controller = load();
      }
    }, intervalMs);
    return () => {
      clearInterval(timer);
      controller.abort();
      requestSeq.current += 1; // invalidate in-flight handlers
    };
  }, [load, intervalMs]);

  return { data, error, loading, refresh: () => void load() };
}
