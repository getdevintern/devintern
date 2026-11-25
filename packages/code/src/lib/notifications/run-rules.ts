/**
 * Notification rules evaluated when a run settles (`RunStore.finishRun`) and
 * when ad-hoc work is delegated or gives up.
 *
 * | Kind                | Trigger                                                         | Auto-resolve                              |
 * | ------------------- | --------------------------------------------------------------- | ----------------------------------------- |
 * | `escalated`         | a run finished `escalated`                                      | PR merged/closed, or a later success on the subject |
 * | `retries_exhausted` | a task run failed and nothing retries it automatically          | a later success for the task              |
 * | `automation_broke`  | an automation run failed right after a succeeded run            | the automation's next success             |
 * | `work_spawned`      | a run delegated ad-hoc tasks and/or filed tracker tickets       | (informational; rolls up child progress)  |
 * | `pr_auto_merged`    | an auto-merge run merged a PR (grouped per repo per day)        | (informational)                           |
 *
 * Not notified: ordinary successful runs, deferrals (they retry), failures of
 * origins that run their own attempt budget and escalate when it is spent
 * (PR mentions, CI fixes, conflict resolution, auto-merge, estimation), and
 * automation failures other than the first after a success.
 *
 * Reads go straight to the `runs`, `run_outputs`, `injected_tasks`, and
 * `scheduled_retries` tables of the same database, so this module does not
 * import the stores that call it (no import cycle). A missing table reads as
 * "nothing there".
 */

import { redactText } from "@devintern/utils";
import type { Database } from "bun:sqlite";

import { findInjectedTaskOutputParent, listRunOutputs } from "../state/run-outputs";
import type { TrackerIssueOutput } from "../state/run-outputs";
import { NotificationEmitter, safely } from "./emitter";
import { hasTable } from "./store";
import type { NotificationLink } from "./types";

/** Origins whose watchers retry on their own and escalate once their budget is spent. */
const SELF_RETRYING_ORIGINS: ReadonlySet<string> = new Set([
  "pr_mention",
  "ci_fix",
  "conflict_resolution",
  "auto_merge",
  "estimate",
]);

/** Statuses that end a run for good (deferred runs retry; in-progress runs are live). */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "escalated",
  "abandoned",
]);

/** Ad-hoc task key prefix (`devintern worker add`); see `run-lineage.ts`. */
const AD_HOC_KEY_PREFIX = "local-";
const MAX_CHILDREN = 100;
const MAX_REASON_CHARS = 1_000;

/** The slice of a `runs` row the rules read. */
export interface RunFacts {
  id: number;
  origin: string;
  status: string;
  taskKey?: string;
  repo?: string;
  prNumber?: number;
  prUrl?: string;
  automationId?: string;
  ticketKey?: string;
  ticketUrl?: string;
  outcomeReason?: string;
  startedAt: number;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse a raw `runs` row; null when it lacks the identity columns. */
function toRunFacts(raw: unknown): RunFacts | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = int(row.id);
  const origin = text(row.origin);
  const status = text(row.status);
  if (id === undefined || !origin || !status) return null;
  return {
    id,
    origin,
    status,
    taskKey: text(row.task_key),
    repo: text(row.repo),
    prNumber: int(row.pr_number),
    prUrl: text(row.pr_url),
    automationId: text(row.automation_id),
    ticketKey: text(row.ticket_key),
    ticketUrl: text(row.ticket_url),
    outcomeReason: text(row.outcome_reason),
    startedAt: int(row.started_at) ?? 0,
  };
}

function readRun(db: Database, id: number): RunFacts | null {
  if (!hasTable(db, "runs")) return null;
  return toRunFacts(db.query("SELECT * FROM runs WHERE id = ?").get(id));
}

function latestRunForTask(db: Database, taskKey: string): RunFacts | null {
  if (!hasTable(db, "runs")) return null;
  return toRunFacts(
    db
      .query("SELECT * FROM runs WHERE task_key = ? ORDER BY started_at DESC, id DESC LIMIT 1")
      .get(taskKey),
  );
}

/**
 * What a run is about, for grouping and auto-resolve: the automation, else
 * the task, else the PR, else the run itself.
 */
export function runSubject(
  run: Pick<RunFacts, "id" | "automationId" | "taskKey" | "prUrl">,
): string {
  if (run.automationId) return `automation:${run.automationId}`;
  if (run.taskKey) return `task:${run.taskKey}`;
  if (run.prUrl) return `pr:${run.prUrl}`;
  return `run:${run.id}`;
}

/** Subject of a PR, matching {@link runSubject} for runs without a task or automation. */
export function prSubject(prUrl: string): string {
  return `pr:${prUrl}`;
}

/**
 * Reduce an outcome reason to a stable cause so repeats of one problem share
 * a group: "a/b.md matches deny pattern a/**" and "a/c.md matches deny
 * pattern a/**" are one cause. Numbers, URLs, SHAs, and paths are masked.
 */
export function normalizeCause(reason: string | undefined): string {
  if (!reason?.trim()) return "unknown";
  const deny = /matches deny pattern\s+(\S+)/i.exec(reason);
  if (deny) return `matches deny pattern ${deny[1]}`;
  return (
    reason
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "<url>")
      .replace(/\S*\/\S*/g, "<path>")
      .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
      .replace(/\d+/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "unknown"
  );
}

/** "Run #871 (onboarding-improvements)". */
function runLabel(run: RunFacts): string {
  const name = run.automationId ?? run.taskKey;
  return name ? `Run #${run.id} (${name})` : `Run #${run.id}`;
}

function prLabel(run: RunFacts): string {
  if (run.prNumber === undefined) return run.repo ? `${run.repo} PR` : "pull request";
  return run.repo ? `${run.repo}#${run.prNumber}` : `PR #${run.prNumber}`;
}

function runLinks(run: RunFacts): NotificationLink[] {
  return [
    { label: `Run #${run.id}`, runId: run.id },
    ...(run.prUrl ? [{ label: prLabel(run), url: run.prUrl }] : []),
    ...(run.ticketUrl
      ? [{ label: run.ticketKey ?? run.taskKey ?? "Ticket", url: run.ticketUrl }]
      : []),
  ];
}

function reasonText(reason: string | undefined): string | undefined {
  return reason ? redactText(reason).slice(0, MAX_REASON_CHARS) : undefined;
}

/** Local calendar day (`YYYY-MM-DD`) for per-day groups. */
export function localDay(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// escalated / retries_exhausted / automation_broke / pr_auto_merged
// ---------------------------------------------------------------------------

function emitEscalated(emitter: NotificationEmitter, run: RunFacts): void {
  const reason = reasonText(run.outcomeReason);
  const base = {
    kind: "escalated" as const,
    severity: "high" as const,
    runId: run.id,
    repo: run.repo,
    subject: runSubject(run),
    links: runLinks(run),
  };
  if (run.origin === "auto_merge") {
    const cause = normalizeCause(run.outcomeReason);
    emitter.emit({
      ...base,
      groupKey: `escalated:auto_merge:${run.repo ?? "unknown"}:${cause}`,
      title: `Auto-merge left ${prLabel(run)} open: ${cause}`,
      groupTitle: (count) =>
        count === 1
          ? `Auto-merge left ${prLabel(run)} open: ${cause}`
          : `Auto-merge escalated ${count} times: ${cause}`,
      body: reason ? `${prLabel(run)}: ${reason}` : undefined,
      appendLinks: true,
    });
    return;
  }
  emitter.emit({
    ...base,
    groupKey: `escalated:${run.origin}:${base.subject}`,
    title: `${runLabel(run)} escalated and needs a human`,
    body: reason,
  });
}

/** Whether a dashboard retry is queued for the task (it will run again). */
function hasPendingScheduledRetry(db: Database, taskKey: string): boolean {
  if (!hasTable(db, "scheduled_retries")) return false;
  return (
    db
      .query(
        "SELECT 1 AS one FROM scheduled_retries WHERE task_key = ? AND status = 'pending' LIMIT 1",
      )
      .get(taskKey) !== null
  );
}

/**
 * Whether a failed run is the last word for its task: nothing will retry it
 * automatically.
 */
export function isRetryExhausted(db: Database, run: RunFacts): boolean {
  if (run.status !== "failed" || !run.taskKey) return false;
  if (SELF_RETRYING_ORIGINS.has(run.origin)) return false;
  // Automations re-run on their schedule; a broken one is `automation_broke`.
  if (run.automationId) return false;
  return !hasPendingScheduledRetry(db, run.taskKey);
}

function emitRetriesExhausted(
  emitter: NotificationEmitter,
  run: RunFacts | null,
  taskKey: string,
  reason: string | undefined,
): void {
  emitter.emit({
    kind: "retries_exhausted",
    severity: "high",
    groupKey: `retries_exhausted:task:${taskKey}`,
    runId: run?.id,
    repo: run?.repo,
    subject: `task:${taskKey}`,
    title: `${taskKey} failed and will not be retried automatically`,
    body: reasonText(reason),
    links: run ? runLinks(run) : [{ label: taskKey, taskKey }],
  });
}

/** Status of the automation's settled run just before this one. */
function previousAutomationStatus(db: Database, run: RunFacts): string | undefined {
  const row = db
    .query(
      `SELECT status FROM runs
       WHERE automation_id = ? AND id != ?
         AND status IN ('succeeded', 'failed', 'escalated', 'abandoned')
         AND (started_at < ? OR (started_at = ? AND id < ?))
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(run.automationId ?? "", run.id, run.startedAt, run.startedAt, run.id) as {
    status: unknown;
  } | null;
  return text(row?.status);
}

function emitAutomationBroke(emitter: NotificationEmitter, db: Database, run: RunFacts): void {
  if (run.status !== "failed" || !run.automationId) return;
  if (previousAutomationStatus(db, run) !== "succeeded") return;
  emitter.emit({
    kind: "automation_broke",
    severity: "high",
    groupKey: `automation_broke:${run.automationId}`,
    runId: run.id,
    repo: run.repo,
    subject: runSubject(run),
    title: `Automation ${run.automationId} broke: run #${run.id} failed after a successful run`,
    body: reasonText(run.outcomeReason),
    links: runLinks(run),
  });
}

function emitAutoMerged(emitter: NotificationEmitter, run: RunFacts, now: number): void {
  if (run.origin !== "auto_merge" || run.status !== "succeeded") return;
  const repo = run.repo ?? "unknown";
  emitter.emit({
    kind: "pr_auto_merged",
    severity: "normal",
    groupKey: `pr_auto_merged:${repo}:${localDay(now)}`,
    runId: run.id,
    repo: run.repo,
    title: `Auto-merged ${prLabel(run)}`,
    groupTitle: (count) =>
      count === 1 ? `Auto-merged ${prLabel(run)}` : `Auto-merged ${count} PRs in ${repo} today`,
    links: run.prUrl ? [{ label: prLabel(run), url: run.prUrl, runId: run.id }] : runLinks(run),
    appendLinks: true,
  });
}

/** A success closes what was open about its subject. */
function resolveOnSuccess(emitter: NotificationEmitter, run: RunFacts): void {
  if (run.status !== "succeeded") return;
  emitter.resolve({
    kinds: ["escalated", "retries_exhausted", "automation_broke"],
    subject: runSubject(run),
  });
}

// ---------------------------------------------------------------------------
// work_spawned and its rollup
// ---------------------------------------------------------------------------

/** One delegated ad-hoc task and where it stands. */
export interface SpawnedChild {
  taskKey: string;
  title?: string;
  /** Queue status, when the row still exists. */
  queueStatus?: string;
  latestRun?: RunFacts;
}

type ChildState = "pending" | "pr_open" | "done" | "failed" | "escalated";

function childState(child: SpawnedChild): ChildState {
  const run = child.latestRun;
  if (child.queueStatus === "failed" || child.queueStatus === "cancelled") return "failed";
  if (!run || !SETTLED_STATUSES.has(run.status)) {
    return child.queueStatus === "done" ? "done" : "pending";
  }
  if (run.status === "succeeded") return run.prUrl ? "pr_open" : "done";
  if (run.status === "escalated") return "escalated";
  return "failed";
}

interface InjectedChildRow {
  id: number;
  task_key: string;
  title: string;
  status: string;
  parent_run_id: number | null;
}

/** Ad-hoc tasks a run delegated: queue rows, plus outputs records that outlived pruning. */
export function spawnedChildren(db: Database, parentRunId: number): SpawnedChild[] {
  const byKey = new Map<string, SpawnedChild>();
  const hasQueue = hasTable(db, "injected_tasks");
  if (hasQueue) {
    const rows = db
      .query(
        `SELECT id, task_key, title, status, parent_run_id FROM injected_tasks
         WHERE parent_run_id = ? ORDER BY id LIMIT ${MAX_CHILDREN}`,
      )
      .all(parentRunId) as InjectedChildRow[];
    for (const row of rows) {
      byKey.set(row.task_key, { taskKey: row.task_key, title: row.title, queueStatus: row.status });
    }
  }
  if (hasTable(db, "run_outputs")) {
    for (const output of listRunOutputs(db, parentRunId)) {
      const record = output.record;
      if (record.kind !== "injected_task" || byKey.has(record.taskKey)) continue;
      // Agent-written record: trust ad-hoc keys only, and never one the queue
      // attributes to another run (same rule as run lineage).
      if (!record.taskKey.startsWith(AD_HOC_KEY_PREFIX) || byKey.size >= MAX_CHILDREN) continue;
      const row = hasQueue
        ? (db
            .query(
              "SELECT id, task_key, title, status, parent_run_id FROM injected_tasks WHERE task_key = ?",
            )
            .get(record.taskKey) as InjectedChildRow | null)
        : null;
      if (row && row.parent_run_id !== parentRunId) continue;
      byKey.set(record.taskKey, {
        taskKey: record.taskKey,
        ...((row?.title ?? record.title) ? { title: row?.title ?? record.title } : {}),
        ...(row ? { queueStatus: row.status } : {}),
      });
    }
  }
  return [...byKey.values()].map((child) => {
    const latestRun = latestRunForTask(db, child.taskKey);
    return latestRun ? { ...child, latestRun } : child;
  });
}

function filedTickets(db: Database, parentRunId: number): TrackerIssueOutput[] {
  if (!hasTable(db, "run_outputs")) return [];
  return listRunOutputs(db, parentRunId)
    .map((output) => output.record)
    .filter((record): record is TrackerIssueOutput => record.kind === "tracker_issue");
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** Title, rollup body, and links of a `work_spawned` notification. */
export function describeSpawnedWork(
  parent: RunFacts,
  children: readonly SpawnedChild[],
  tickets: readonly TrackerIssueOutput[],
): { title: string; body?: string; links: NotificationLink[] } {
  const parts: string[] = [];
  if (children.length > 0) parts.push(`delegated ${plural(children.length, "task")}`);
  if (tickets.length > 0) parts.push(`filed ${plural(tickets.length, "ticket")}`);
  const title = `${runLabel(parent)} ${parts.join(" and ")}`;

  const lines: string[] = [];
  if (children.length > 0) {
    const counts: Record<ChildState, number> = {
      pending: 0,
      pr_open: 0,
      done: 0,
      failed: 0,
      escalated: 0,
    };
    for (const child of children) counts[childState(child)] += 1;
    const settled = children.length - counts.pending;
    const detail = [
      counts.pr_open > 0 ? `${plural(counts.pr_open, "PR")} open` : "",
      counts.done > 0 ? `${counts.done} done` : "",
      counts.escalated > 0 ? `${counts.escalated} escalated` : "",
      counts.failed > 0 ? `${counts.failed} failed` : "",
    ].filter(Boolean);
    lines.push(
      `${settled}/${children.length} finished${detail.length > 0 ? `: ${detail.join(", ")}` : ""}`,
    );
  }
  if (tickets.length > 0) lines.push(`Filed: ${tickets.map((ticket) => ticket.key).join(", ")}`);

  const links: NotificationLink[] = [{ label: `Run #${parent.id}`, runId: parent.id }];
  for (const child of children) {
    const run = child.latestRun;
    links.push({
      label: child.title ? `${child.taskKey}: ${child.title}` : child.taskKey,
      taskKey: child.taskKey,
      ...(run?.prUrl ? { url: run.prUrl } : {}),
      ...(run ? { runId: run.id } : {}),
    });
  }
  for (const ticket of tickets) {
    links.push({
      label: ticket.title ? `${ticket.key}: ${ticket.title}` : ticket.key,
      taskKey: ticket.key,
      ...(ticket.url ? { url: ticket.url } : {}),
    });
  }
  return { title, ...(lines.length > 0 ? { body: lines.join("\n") } : {}), links };
}

function workSpawnedGroup(parentRunId: number): string {
  return `work_spawned:run:${parentRunId}`;
}

type SpawnSync =
  /** The parent settled: create (or refresh) its notification. */
  | { mode: "parent_settled" }
  /** A child settled: update an open notification; resurface when it failed. */
  | { mode: "child_settled"; failed: boolean }
  /** A task was delegated after the parent settled: create or resurface. */
  | { mode: "task_added" };

function syncWorkSpawned(
  emitter: NotificationEmitter,
  db: Database,
  parent: RunFacts,
  sync: SpawnSync,
): void {
  if (!SETTLED_STATUSES.has(parent.status)) return;
  const children = spawnedChildren(db, parent.id);
  const tickets = filedTickets(db, parent.id);
  if (children.length === 0 && tickets.length === 0) return;
  const view = describeSpawnedWork(parent, children, tickets);
  const groupKey = workSpawnedGroup(parent.id);
  if (sync.mode === "child_settled") {
    emitter.update(groupKey, view, { resurface: sync.failed });
    return;
  }
  if (sync.mode === "task_added" && emitter.update(groupKey, view, { resurface: true })) return;
  emitter.emit({
    kind: "work_spawned",
    severity: "normal",
    groupKey,
    runId: parent.id,
    repo: parent.repo,
    subject: `run:${parent.id}`,
    ...view,
  });
}

/** The run that delegated an ad-hoc task (queue row first, outputs fallback). */
function delegatingRunId(db: Database, run: RunFacts): number | undefined {
  const taskKey = run.taskKey;
  if (!taskKey) return undefined;
  if (hasTable(db, "injected_tasks")) {
    const row = db
      .query("SELECT parent_run_id FROM injected_tasks WHERE task_key = ? LIMIT 1")
      .get(taskKey) as { parent_run_id: number | null } | null;
    if (row) return row.parent_run_id ?? undefined;
  }
  if (run.origin !== "local" || !taskKey.startsWith(AD_HOC_KEY_PREFIX)) return undefined;
  return hasTable(db, "run_outputs") ? findInjectedTaskOutputParent(db, taskKey) : undefined;
}

function rollUpToParent(emitter: NotificationEmitter, db: Database, child: RunFacts): void {
  if (!SETTLED_STATUSES.has(child.status)) return;
  const parentId = delegatingRunId(db, child);
  if (parentId === undefined || parentId === child.id) return;
  const parent = readRun(db, parentId);
  if (!parent) return;
  syncWorkSpawned(emitter, db, parent, {
    mode: "child_settled",
    failed: child.status === "failed" || child.status === "escalated",
  });
}

// ---------------------------------------------------------------------------
// Entry points (never throw)
// ---------------------------------------------------------------------------

/**
 * Evaluate every run-finish rule for a run that just settled.
 *
 * @param db - Writable connection holding `runs` (and the notification tables)
 * @param runId - The settled run
 * @param now - Clock (tests)
 */
export function notifyRunFinished(db: Database, runId: number, now: () => number = Date.now): void {
  safely("run-finish", () => {
    const run = readRun(db, runId);
    if (!run || run.status === "in_progress") return;
    const emitter = new NotificationEmitter(db, now);
    if (run.status === "escalated") safely("escalated", () => emitEscalated(emitter, run));
    if (isRetryExhausted(db, run) && run.taskKey) {
      const taskKey = run.taskKey;
      safely("retries-exhausted", () =>
        emitRetriesExhausted(emitter, run, taskKey, run.outcomeReason),
      );
    }
    safely("automation-broke", () => emitAutomationBroke(emitter, db, run));
    safely("auto-merged", () => emitAutoMerged(emitter, run, now()));
    safely("resolve", () => resolveOnSuccess(emitter, run));
    if (SETTLED_STATUSES.has(run.status)) {
      safely("work-spawned", () => syncWorkSpawned(emitter, db, run, { mode: "parent_settled" }));
    }
    safely("rollup", () => rollUpToParent(emitter, db, run));
  });
}

/**
 * A task was delegated with a parent run: refresh the parent's
 * `work_spawned` notification when the parent already settled (a parent
 * still running reports everything when it finishes).
 *
 * @param db - Writable workspace DB connection
 * @param parentRunId - The delegating run
 */
export function notifyDelegatedTaskAdded(
  db: Database,
  parentRunId: number,
  now: () => number = Date.now,
): void {
  safely("task-added", () => {
    const parent = readRun(db, parentRunId);
    if (!parent) return;
    syncWorkSpawned(new NotificationEmitter(db, now), db, parent, { mode: "task_added" });
  });
}

/**
 * An ad-hoc task was settled `failed` without a failed run (its deferral
 * budget ran out): nothing will retry it.
 *
 * @param db - Writable workspace DB connection
 * @param taskKey - The ad-hoc task
 * @param message - Why it was given up
 */
export function notifyInjectedTaskExhausted(
  db: Database,
  taskKey: string,
  message: string | undefined,
  now: () => number = Date.now,
): void {
  safely("injected-exhausted", () => {
    const emitter = new NotificationEmitter(db, now);
    const latest = latestRunForTask(db, taskKey);
    emitRetriesExhausted(emitter, latest, taskKey, message ?? latest?.outcomeReason);
    if (latest) {
      const parentId = delegatingRunId(db, latest);
      const parent = parentId !== undefined ? readRun(db, parentId) : null;
      if (parent) {
        syncWorkSpawned(emitter, db, parent, { mode: "child_settled", failed: true });
      }
    }
  });
}
