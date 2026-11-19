/**
 * Queued (not yet started) work for the dashboard's Overview: ad-hoc tasks
 * from `devintern worker add`, dashboard-scheduled retries, webhook
 * deliveries the worker has persisted but not picked up, automation
 * occurrences waiting for a free slot (they have no run row until admitted),
 * and PR jobs (review replies, conflict resolution, CI fixes, auto-merge
 * checks) waiting in the worker's supervisor for a slot or for their PR.
 *
 * Rows that are already running are deliberately left out: they own a run
 * row and show up under "Active work" instead. Every reader here follows the
 * dashboard's read-only GET contract (see `dashboard-db.ts`): a missing file
 * or table degrades to an empty list and nothing is ever created.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { resolve } from "path";

import type { InjectedTask } from "../state/injected-tasks";
import type { RunRecord } from "../state/run-recorder";
import { configureSqliteConnection } from "../state/sqlite";
import { WebhookQueue } from "../state/webhook-queue";
import type { WebhookEvent } from "../state/webhook-queue";
import type { ApiResponse, DashboardData } from "./dashboard-api";
import type { DashboardAutomationView } from "./dashboard-automation-view";
import type { JobKind, QueuedJobSnapshot, QueuedJobWaitReason } from "../worker/supervisor";
import { deriveTaskTitle } from "./task-title";

/** Where a queued item came from. */
export type QueuedWorkKind = "ad-hoc" | "retry" | "webhook" | "automation" | "pr-job";

/** One queued item as served by `GET /api/queue`. */
export interface QueuedWorkItem {
  /** Stable across polls: `<kind>:<row id>`. */
  id: string;
  kind: QueuedWorkKind;
  /** Human title: the ad-hoc title, the retried task's title, or the event summary. */
  title: string;
  taskKey?: string;
  repo?: string;
  /** Who enqueued it (`local:add`, the dashboard user, ...). */
  actor?: string;
  createdAt: number;
  /** Earliest pickup time while backing off after a deferral. */
  notBefore?: number;
  /** Consecutive deferrals of an ad-hoc task. */
  deferCount?: number;
  /** Last status message recorded on the row (e.g. the deferral reason). */
  message?: string;
  /** Retry: the run being retried. */
  runId?: number;
  /** Webhook: provider event type (`issue_comment`, `gitlab:note`, ...). */
  eventType?: string;
  /** Webhook: the pull/merge request the event targets. */
  prNumber?: number;
  prUrl?: string;
  /** Webhook: processing attempts so far. */
  attempts?: number;
  lastError?: string;
  /** Automation: the scheduled job waiting for a slot (its dashboard id). */
  automationId?: string;
  /** PR job: the worker job kind (`conflict`, `auto_merge`, `review`, `ci_fix`). */
  jobKind?: JobKind;
  /**
   * PR job: what it waits on — `exclusive` (another job on the same PR is
   * running), `repo` (the repository's per-repo limit), or `global`.
   */
  waitingOn?: QueuedJobWaitReason;
  /** Ad-hoc: task keys this task depends on. */
  dependsOn?: string[];
  /** Ad-hoc: how it waits on {@link dependsOn} (`merged` or `stacked`). */
  dependencyMode?: "merged" | "stacked";
  /** Ad-hoc: `waiting` or `blocked` on a dependency; unset once claimable. */
  dependencyState?: "waiting" | "blocked";
  /** Ad-hoc: why, naming the dependency (`local-foo PR #12 not merged`). */
  dependencyReason?: string;
}

/** A recently cancelled ad-hoc task (audit trail; it will not run). */
export interface CancelledTaskItem {
  /** Stable across polls: `ad-hoc:<row id>`. */
  id: string;
  taskKey: string;
  title: string;
  repo: string;
  createdAt: number;
  /** When it was cancelled (epoch ms). */
  cancelledAt?: number;
  /** `cli` (`worker cancel`) or `dashboard`. */
  cancelledBy?: "cli" | "dashboard";
  cancelReason?: string;
}

export interface QueuedWorkResponse {
  items: QueuedWorkItem[];
  /** Every pending item, including those beyond the per-source limit. */
  total: number;
  /** Most recently cancelled ad-hoc tasks, newest first. */
  cancelled: CancelledTaskItem[];
}

/** Recently cancelled ad-hoc tasks served next to the queue. */
export const CANCELLED_TASK_LIMIT = 10;

/** Map a cancelled ad-hoc row to its audit item. */
export function injectedTaskToCancelledItem(task: InjectedTask): CancelledTaskItem {
  return {
    id: `ad-hoc:${task.id}`,
    taskKey: task.taskKey,
    title: task.title,
    repo: task.repo,
    createdAt: task.createdAt,
    cancelledAt: task.finishedAt,
    cancelledBy: task.cancelledBy,
    cancelReason: task.cancelReason,
  };
}

/** Rows read per source; the Overview shows a short list, not the whole backlog. */
export const QUEUED_SOURCE_LIMIT = 50;

/**
 * Map a pending ad-hoc row to its queued item. The prompt body is never
 * served: the queue lists what will run and where, not the prompt itself.
 */
export function injectedTaskToQueuedItem(task: InjectedTask): QueuedWorkItem {
  return {
    id: `ad-hoc:${task.id}`,
    kind: "ad-hoc",
    title: task.title,
    taskKey: task.taskKey,
    repo: task.repo,
    actor: task.actor,
    createdAt: task.createdAt,
    notBefore: task.notBefore,
    deferCount: task.deferCount > 0 ? task.deferCount : undefined,
    message: task.message,
    ...(task.dependsOn.length > 0
      ? {
          dependsOn: task.dependsOn,
          dependencyMode: task.dependencyMode ?? "merged",
          dependencyState: task.dependencyState,
          dependencyReason: task.dependencyReason,
        }
      : {}),
  };
}

/** One-line dependency status of a queued item (`waiting: local-foo PR #12 not merged`). */
export function queuedDependencyStatus(item: QueuedWorkItem): string | undefined {
  if (!item.dependsOn?.length) return undefined;
  if (item.dependencyState && item.dependencyReason) {
    return `${item.dependencyState}: ${item.dependencyReason}`;
  }
  return `dependencies satisfied (${item.dependsOn.join(", ")})`;
}

/** A pending `scheduled_retries` row, as far as the Overview needs it. */
export interface PendingRetry {
  id: number;
  taskKey: string;
  runId?: number;
  team?: string;
  repo?: string;
  actor: string;
  message?: string;
  createdAt: number;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one `scheduled_retries` row; null when a required column is unusable. */
function parsePendingRetryRow(row: unknown): PendingRetry | null {
  if (!isRecord(row)) return null;
  const id = optionalNumber(row.id);
  const taskKey = optionalText(row.task_key);
  const createdAt = optionalNumber(row.created_at);
  if (id === undefined || taskKey === undefined || createdAt === undefined) return null;
  return {
    id,
    taskKey,
    runId: optionalNumber(row.run_id),
    team: optionalText(row.team),
    repo: optionalText(row.repo),
    actor: optionalText(row.actor) ?? "unknown",
    message: optionalText(row.message),
    createdAt,
  };
}

/**
 * Pending dashboard retries, oldest first (the order the acquirer claims them).
 *
 * @param dbPath - Durable queue database
 * @param limit - Maximum rows to return
 */
export function readPendingRetries(dbPath: string, limit = QUEUED_SOURCE_LIMIT): PendingRetry[] {
  if (!existsSync(dbPath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    configureSqliteConnection(db, { readonly: true });
    const rows = db
      .query(
        `SELECT * FROM scheduled_retries WHERE status = 'pending'
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(limit);
    return rows.map(parsePendingRetryRow).filter((row): row is PendingRetry => row !== null);
  } catch {
    // Missing table (older DB), locked/corrupt DB, or a file removed meanwhile.
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Pending webhook deliveries from one database, oldest first.
 *
 * @param dbPath - Database holding `webhook_events`
 */
export function readPendingWebhookEvents(dbPath: string): WebhookEvent[] {
  if (!existsSync(dbPath)) return [];
  let queue: WebhookQueue | null = null;
  try {
    queue = new WebhookQueue({ dbPath, readonly: true });
    return queue.getPendingEvents().filter((event) => event.status === "pending");
  } catch {
    return [];
  } finally {
    queue?.close();
  }
}

/** What a webhook payload says about the work it will trigger. */
interface WebhookSummary {
  title: string;
  repo?: string;
  prNumber?: number;
  prUrl?: string;
}

function parsePayload(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function field(record: unknown, key: string): unknown {
  return isRecord(record) ? record[key] : undefined;
}

/**
 * Summarize a persisted webhook payload. Payload shapes are provider-defined,
 * so every field is optional and an unknown shape still yields a title.
 *
 * @param eventType - Stored event type
 * @param payload - Stored JSON payload
 */
export function summarizeWebhookEvent(eventType: string, payload: string): WebhookSummary {
  const body = parsePayload(payload);
  if (eventType.startsWith("gitlab:")) {
    const target = field(body, "target");
    const number = optionalNumber(field(target, "changeNumber"));
    const kind = eventType.slice("gitlab:".length).replaceAll("_", " ");
    return {
      title: number !== undefined ? `GitLab ${kind} on !${number}` : `GitLab ${kind}`,
      repo: optionalText(field(target, "projectPath")),
      prNumber: number,
      prUrl: optionalText(field(target, "webUrl")),
    };
  }
  const repo = optionalText(field(field(body, "repository"), "full_name"));
  if (eventType === "pull_request_review") {
    const pr = field(body, "pull_request");
    const number = optionalNumber(field(pr, "number"));
    const prTitle = optionalText(field(pr, "title"));
    const reviewer = optionalText(field(field(field(body, "review"), "user"), "login"));
    const head = number !== undefined ? `Review on PR #${number}` : "PR review";
    return {
      title: [head, prTitle].filter(Boolean).join(": ") + (reviewer ? ` (by ${reviewer})` : ""),
      repo,
      prNumber: number,
      prUrl: optionalText(field(pr, "html_url")),
    };
  }
  if (eventType === "issue_comment") {
    const issue = field(body, "issue");
    const number = optionalNumber(field(issue, "number"));
    const issueTitle = optionalText(field(issue, "title"));
    const author = optionalText(field(field(field(body, "comment"), "user"), "login"));
    const head = number !== undefined ? `Comment on #${number}` : "PR comment";
    return {
      title: [head, issueTitle].filter(Boolean).join(": ") + (author ? ` (by ${author})` : ""),
      repo,
      prNumber: number,
      prUrl: optionalText(field(issue, "html_url")),
    };
  }
  return { title: eventType.replaceAll("_", " "), repo };
}

/** Map a pending webhook delivery to its queued item. */
export function webhookEventToQueuedItem(event: WebhookEvent): QueuedWorkItem {
  const summary = summarizeWebhookEvent(event.eventType, event.payload);
  return {
    id: `webhook:${event.id}`,
    kind: "webhook",
    title: summary.title,
    repo: summary.repo,
    createdAt: event.createdAt,
    eventType: event.eventType,
    prNumber: summary.prNumber,
    prUrl: summary.prUrl,
    attempts: event.attempts > 0 ? event.attempts : undefined,
    lastError: event.lastError,
  };
}

/** When an item becomes claimable: its creation, or the end of a backoff. */
export function queuedEligibleAt(item: QueuedWorkItem): number {
  return Math.max(item.createdAt, item.notBefore ?? 0);
}

/** Sources {@link collectQueuedWork} reads from; injected so tests can stub them. */
export interface QueuedWorkSources {
  /** Run-history database (may also hold webhook deliveries). */
  dbPath: string;
  /** Durable queue database. */
  queueDbPath: string;
  /** Pending ad-hoc rows in pickup order; may throw when the DB is missing. */
  listInjected: (limit: number) => InjectedTask[];
  /** The run a retry re-runs, for its title and repo. */
  lookupRun: (id: number) => Pick<RunRecord, "taskDescription" | "repo"> | null;
  /** Pending count across every queue, beyond the listed rows. */
  pendingTotal: number;
  /** Scheduled jobs on this worker, for occurrences still waiting for a slot. */
  listAutomations?: () => DashboardAutomationView[];
  /** Recently cancelled ad-hoc rows, newest first; may throw when the DB is missing. */
  listCancelled?: (limit: number) => InjectedTask[];
  /** Jobs waiting in the worker's in-process supervisor (embedded dashboard only). */
  listSupervisorJobs?: () => QueuedJobSnapshot[];
}

const PR_JOB_TITLES: Partial<Record<JobKind, string>> = {
  review: "Review feedback",
  conflict: "Conflict resolution",
  ci_fix: "CI fix",
  auto_merge: "Auto-merge check",
};

/** Human wait reason for a queued PR job. */
export function prJobWaitMessage(waitingOn: QueuedJobWaitReason): string {
  switch (waitingOn) {
    case "exclusive":
      return "Waiting for another job on this pull request to finish";
    case "repo":
      return "Waiting for a free slot on this repository (max_concurrency_per_repo)";
    case "global":
      return "Waiting for a free worker slot (max_concurrency)";
  }
}

/**
 * Map a supervisor job still waiting to start to a queued item when it is PR
 * work (a `pr_worktree` job, or any job held back by an exclusive key);
 * `null` for anything else (tasks and automations have their own rows).
 */
export function supervisorJobToQueuedItem(job: QueuedJobSnapshot): QueuedWorkItem | null {
  if (job.checkoutClass !== "pr_worktree" && job.exclusiveKey === undefined) return null;
  const what = PR_JOB_TITLES[job.kind] ?? job.kind.replaceAll("_", " ");
  const target = job.label ?? job.exclusiveKey;
  const prNumber = target ? Number(/[#!](\d+)$/.exec(target)?.[1]) : Number.NaN;
  return {
    id: `pr-job:${job.id}`,
    kind: "pr-job",
    title: target ? `${what} on ${target}` : what,
    repo: job.repo,
    actor: job.source,
    createdAt: job.enqueuedAt,
    ...(Number.isFinite(prNumber) ? { prNumber } : {}),
    message: prJobWaitMessage(job.waitingOn),
    jobKind: job.kind,
    waitingOn: job.waitingOn,
  };
}

/**
 * Map an automation occurrence that holds its lease but has not been admitted
 * yet (no run row exists) to a queued item; `null` for anything else.
 */
export function waitingAutomationToQueuedItem(
  automation: DashboardAutomationView,
): QueuedWorkItem | null {
  const activity = automation.activity;
  if (activity?.state !== "waiting") return null;
  return {
    id: `automation:${automation.id}`,
    kind: "automation",
    title: automation.title ?? automation.id,
    repo: automation.repo,
    actor: activity.trigger === "manual" ? "Run now" : "schedule",
    createdAt: activity.since,
    message: activity.reason,
    automationId: automation.id,
  };
}

function retryToQueuedItem(
  retry: PendingRetry,
  lookupRun: QueuedWorkSources["lookupRun"],
): QueuedWorkItem {
  const run = retry.runId !== undefined ? lookupRun(retry.runId) : null;
  return {
    id: `retry:${retry.id}`,
    kind: "retry",
    title: deriveTaskTitle(run?.taskDescription) ?? retry.taskKey,
    taskKey: retry.taskKey,
    repo: retry.repo ?? run?.repo,
    actor: retry.actor,
    createdAt: retry.createdAt,
    message: retry.message,
    runId: retry.runId,
  };
}

/**
 * Pending work the worker has not started yet (`GET /api/queue`), in the
 * order it becomes claimable.
 *
 * @param sources - Databases and lookups to read from
 */
export function collectQueuedWork(sources: QueuedWorkSources): QueuedWorkResponse {
  let adHoc: QueuedWorkItem[] = [];
  try {
    adHoc = sources.listInjected(QUEUED_SOURCE_LIMIT).map(injectedTaskToQueuedItem);
  } catch {
    // Missing DB or table: no ad-hoc work queued.
  }
  const retries = readPendingRetries(sources.queueDbPath).map((retry) =>
    retryToQueuedItem(retry, sources.lookupRun),
  );
  // Same disjoint-producer rule as the relay counts: read both DBs unless they coincide.
  const webhookDbs =
    resolve(sources.dbPath) === resolve(sources.queueDbPath)
      ? [sources.queueDbPath]
      : [sources.queueDbPath, sources.dbPath];
  const webhooks = webhookDbs
    .flatMap((path) => readPendingWebhookEvents(path))
    .slice(0, QUEUED_SOURCE_LIMIT)
    .map(webhookEventToQueuedItem);
  let automations: QueuedWorkItem[] = [];
  try {
    automations = (sources.listAutomations?.() ?? [])
      .map(waitingAutomationToQueuedItem)
      .filter((item): item is QueuedWorkItem => item !== null);
  } catch {
    // The scheduler catalog is best-effort here: the queue still lists the rest.
  }
  let prJobs: QueuedWorkItem[] = [];
  try {
    prJobs = (sources.listSupervisorJobs?.() ?? [])
      .map(supervisorJobToQueuedItem)
      .filter((item): item is QueuedWorkItem => item !== null);
  } catch {
    // Best-effort like the automation catalog.
  }
  const items = [...adHoc, ...retries, ...webhooks, ...automations, ...prJobs].sort(
    (a, b) => queuedEligibleAt(a) - queuedEligibleAt(b),
  );
  let cancelled: CancelledTaskItem[] = [];
  try {
    cancelled = (sources.listCancelled?.(CANCELLED_TASK_LIMIT) ?? []).map(
      injectedTaskToCancelledItem,
    );
  } catch {
    // Missing DB or table: nothing cancelled yet.
  }
  // Waiting automations and supervisor jobs are not counted by the durable
  // queues behind pendingTotal.
  return {
    items,
    total: Math.max(items.length, sources.pendingTotal + automations.length + prJobs.length),
    cancelled,
  };
}

/**
 * `GET /api/queue` — pending ad-hoc tasks, retries, and webhook deliveries.
 *
 * @param data - Dashboard data source
 */
export function handleQueuedWork(data: DashboardData): ApiResponse {
  const stats = data.getQueueStats();
  const body = collectQueuedWork({
    dbPath: data.dbPath,
    queueDbPath: data.queueDbPath,
    listInjected: (limit) => data.getInjectedTaskReadStore().listPending(limit),
    lookupRun: (id) => data.getRunDetail(id)?.run ?? null,
    pendingTotal: stats.pending + stats.injected.pending + stats.retries.pending,
    listAutomations: () => data.getAutomations(),
    listCancelled: (limit) => data.getInjectedTaskReadStore().listRecentlyCancelled(limit),
    listSupervisorJobs: () => data.getSupervisorQueuedJobs(),
  });
  return { status: 200, body };
}
