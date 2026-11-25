/**
 * Run lineage: which run a run came from, and what work it spawned.
 *
 * Two relations are recorded or derived:
 *
 * - `delegated`: an ad-hoc task enqueued by `devintern worker add` inside an
 *   agent run carries that run as `injected_tasks.parent_run_id`; the run
 *   outputs file also records it in `run_outputs` (kind `injected_task`),
 *   which outlives the settled queue row being pruned.
 * - `follow_up`: a run that acts on a PR opened earlier (CI fix, auto-merge,
 *   conflict resolution, review handling) is derived from the PR it names; its
 *   source is the earliest non-follow-up run on the same PR.
 *
 * Tracker tickets a run filed come from `run_outputs` (kind `tracker_issue`).
 * Every read is best-effort: a missing table (older DB) reads as no lineage.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { resolve } from "path";

import type { InjectedTaskStatus } from "./injected-tasks";
import { findInjectedTaskOutputParent, listRunOutputs } from "./run-outputs";
import { configureSqliteConnection } from "./sqlite";
import type { RunOrigin, RunRecord, RunStatus } from "./run-recorder";

/** How a run relates to its source run. */
export type LineageRelation = "delegated" | "follow_up";

/** The run a run was sourced from. */
export interface RunLineageParent {
  runId: number;
  origin: RunOrigin;
  status: RunStatus;
  relation: LineageRelation;
  automationId?: string;
  taskKey?: string;
  /** PR the follow-up acts on (`follow_up` only). */
  prNumber?: number;
  prUrl?: string;
}

/** An ad-hoc task the run delegated, with its latest run. */
export interface SpawnedDelegatedTask {
  kind: "delegated_task";
  /** `injected_tasks.id`. */
  id: number;
  taskKey: string;
  title?: string;
  /** Queue status; absent once the settled row was pruned. */
  status?: InjectedTaskStatus;
  latestRunId?: number;
  latestRunStatus?: RunStatus;
  prNumber?: number;
  prUrl?: string;
}

/** A tracker ticket the run filed. */
export interface SpawnedTrackerIssue {
  kind: "tracker_issue";
  key: string;
  tracker?: string;
  url?: string;
  title?: string;
}

/** A later run on the PR this run opened. */
export interface SpawnedFollowUpRun {
  kind: "follow_up_run";
  runId: number;
  origin: RunOrigin;
  status: RunStatus;
  startedAt: number;
}

export type SpawnedWork = SpawnedDelegatedTask | SpawnedTrackerIssue | SpawnedFollowUpRun;

/** `lineage` field of the run detail response. */
export interface RunLineage {
  parent: RunLineageParent | null;
  spawned: SpawnedWork[];
}

/** Origins that act on a PR an earlier run opened. */
export const FOLLOW_UP_ORIGINS: readonly RunOrigin[] = [
  "pr_mention",
  "ci_fix",
  "conflict_resolution",
  "auto_merge",
];

const FOLLOW_UP_SQL = FOLLOW_UP_ORIGINS.map((origin) => `'${origin}'`).join(", ");
const MAX_SPAWNED_PER_KIND = 100;
/**
 * Key prefix of ad-hoc tasks (`local-<slug>`). The outputs file is
 * agent-writable, so an `injected_task` record is only trusted for keys of
 * this shape: a forged record cannot claim a tracker run (`PROJ-1`).
 */
const AD_HOC_KEY_PREFIX = "local-";

/** Handles the lineage query reads; both may be the same connection. */
export interface LineageDatabases {
  /** Holds `runs` and `run_outputs`. */
  runs: Database;
  /** Holds `injected_tasks` (the workspace queue DB). */
  queue: Database | null;
}

interface RunRow {
  id: number;
  origin: string;
  status: string;
  automation_id: string | null;
  task_key: string | null;
  pr_number: number | null;
  pr_url: string | null;
  started_at: number;
}

/** Run a read, mapping a missing table or transient error to a fallback. */
function attempt<T>(fallback: T, read: () => T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Read from the queue DB, falling back when it is absent or the read fails. */
function queueRead<T>(dbs: LineageDatabases, fallback: T, read: (queue: Database) => T): T {
  const queue = dbs.queue;
  return queue ? attempt(fallback, () => read(queue)) : fallback;
}

function getRunRow(db: Database, id: number): RunRow | null {
  return attempt(
    null,
    () =>
      db
        .query(
          "SELECT id, origin, status, automation_id, task_key, pr_number, pr_url, started_at FROM runs WHERE id = ?",
        )
        .get(id) as RunRow | null,
  );
}

/** SQL predicate + params matching runs on the same PR as `run`, or null without one. */
function samePr(run: RunRecord): { where: string; params: Array<string | number> } | null {
  if (run.prUrl) return { where: "pr_url = ?", params: [run.prUrl] };
  if (run.repo && run.prNumber !== undefined) {
    return { where: "repo = ? AND pr_number = ?", params: [run.repo, run.prNumber] };
  }
  return null;
}

/** Earliest run on the PR that is not itself a follow-up: the run that opened it. */
function originatingRun(db: Database, run: RunRecord): RunRow | null {
  const pr = samePr(run);
  if (!pr) return null;
  return attempt(
    null,
    () =>
      db
        .query(
          `SELECT id, origin, status, automation_id, task_key, pr_number, pr_url, started_at
           FROM runs WHERE ${pr.where} AND origin NOT IN (${FOLLOW_UP_SQL})
           ORDER BY started_at, id LIMIT 1`,
        )
        .get(...pr.params) as RunRow | null,
  );
}

function toParent(
  row: RunRow,
  relation: LineageRelation,
  pr?: { prNumber?: number; prUrl?: string },
): RunLineageParent {
  return {
    runId: row.id,
    origin: row.origin as RunOrigin,
    status: row.status as RunStatus,
    relation,
    ...(row.automation_id ? { automationId: row.automation_id } : {}),
    ...(row.task_key ? { taskKey: row.task_key } : {}),
    ...(pr?.prNumber !== undefined ? { prNumber: pr.prNumber } : {}),
    ...(pr?.prUrl ? { prUrl: pr.prUrl } : {}),
  };
}

/**
 * The run that delegated this run's ad-hoc task, if any. The queue row is
 * authoritative, including a row with no parent (a task added outside any
 * run); the agent-written outputs record is consulted only for an ad-hoc run
 * (`origin: "local"`, `local-…` key) whose row is absent (pruned). This is the
 * same rule `spawnedTasks` applies, so both sides of a link agree.
 */
function delegatingRunId(
  dbs: LineageDatabases,
  run: RunRecord,
  taskKey: string,
): number | undefined {
  // `null`: the row exists without a parent. `undefined`: no row (or no queue).
  const fromQueue = queueRead<number | null | undefined>(dbs, undefined, (queue) => {
    const row = queue
      .query("SELECT parent_run_id FROM injected_tasks WHERE task_key = ? LIMIT 1")
      .get(taskKey) as { parent_run_id: number | null } | null;
    return row ? row.parent_run_id : undefined;
  });
  if (fromQueue === null) return undefined;
  if (fromQueue !== undefined) return fromQueue;
  if (run.origin !== "local" || !taskKey.startsWith(AD_HOC_KEY_PREFIX)) return undefined;
  return attempt(undefined, () => findInjectedTaskOutputParent(dbs.runs, taskKey));
}

function resolveParent(dbs: LineageDatabases, run: RunRecord): RunLineageParent | null {
  if (run.taskKey) {
    const parentId = delegatingRunId(dbs, run, run.taskKey);
    const parent =
      parentId !== undefined && parentId !== run.id ? getRunRow(dbs.runs, parentId) : null;
    if (parent) return toParent(parent, "delegated");
  }
  if (FOLLOW_UP_ORIGINS.includes(run.origin)) {
    const opener = originatingRun(dbs.runs, run);
    if (opener && opener.id !== run.id) {
      return toParent(opener, "follow_up", { prNumber: run.prNumber, prUrl: run.prUrl });
    }
  }
  return null;
}

interface InjectedRow {
  id: number;
  task_key: string;
  title: string;
  status: string;
}

interface InjectedParentRow extends InjectedRow {
  parent_run_id: number | null;
}

function latestRunFor(db: Database, taskKey: string): Partial<SpawnedDelegatedTask> {
  const row = attempt(
    null,
    () =>
      db
        .query(
          `SELECT id, status, pr_number, pr_url FROM runs WHERE task_key = ?
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(taskKey) as Pick<RunRow, "id" | "status" | "pr_number" | "pr_url"> | null,
  );
  if (!row) return {};
  return {
    latestRunId: row.id,
    latestRunStatus: row.status as RunStatus,
    ...(row.pr_number !== null ? { prNumber: row.pr_number } : {}),
    ...(row.pr_url ? { prUrl: row.pr_url } : {}),
  };
}

function spawnedTasks(dbs: LineageDatabases, runId: number): SpawnedDelegatedTask[] {
  const rows = queueRead<InjectedRow[]>(
    dbs,
    [],
    (queue) =>
      queue
        .query(
          `SELECT id, task_key, title, status FROM injected_tasks
           WHERE parent_run_id = ? ORDER BY id LIMIT ${MAX_SPAWNED_PER_KIND}`,
        )
        .all(runId) as InjectedRow[],
  );
  const byKey = new Map<string, SpawnedDelegatedTask>();
  for (const row of rows) {
    byKey.set(row.task_key, {
      kind: "delegated_task",
      id: row.id,
      taskKey: row.task_key,
      title: row.title,
      status: row.status as InjectedTaskStatus,
    });
  }
  // Outputs records keep the link after a settled queue row is pruned.
  for (const output of attempt([], () => listRunOutputs(dbs.runs, runId))) {
    const record = output.record;
    if (record.kind !== "injected_task" || byKey.has(record.taskKey)) continue;
    // Agent-writable record: only ad-hoc keys, and never one the queue says
    // another run (or no run) delegated.
    if (!record.taskKey.startsWith(AD_HOC_KEY_PREFIX)) continue;
    if (byKey.size >= MAX_SPAWNED_PER_KIND) break;
    const row = queueRead<InjectedParentRow | null>(
      dbs,
      null,
      (queue) =>
        queue
          .query(
            "SELECT id, task_key, title, status, parent_run_id FROM injected_tasks WHERE task_key = ?",
          )
          .get(record.taskKey) as InjectedParentRow | null,
    );
    if (row && (row.parent_run_id !== runId || row.id !== record.id)) continue;
    byKey.set(record.taskKey, {
      kind: "delegated_task",
      id: row?.id ?? record.id,
      taskKey: record.taskKey,
      ...((row?.title ?? record.title) ? { title: row?.title ?? record.title } : {}),
      ...(row ? { status: row.status as InjectedTaskStatus } : {}),
    });
  }
  return [...byKey.values()].map((task) => ({ ...task, ...latestRunFor(dbs.runs, task.taskKey) }));
}

function spawnedTrackerIssues(db: Database, runId: number): SpawnedTrackerIssue[] {
  const issues: SpawnedTrackerIssue[] = [];
  for (const output of attempt([], () => listRunOutputs(db, runId))) {
    const record = output.record;
    if (record.kind !== "tracker_issue") continue;
    issues.push({
      kind: "tracker_issue",
      key: record.key,
      ...(record.tracker ? { tracker: record.tracker } : {}),
      ...(record.url ? { url: record.url } : {}),
      ...(record.title ? { title: record.title } : {}),
    });
  }
  return issues.slice(0, MAX_SPAWNED_PER_KIND);
}

/** Follow-up runs on the PR this run opened (only for the run that opened it). */
function spawnedFollowUps(db: Database, run: RunRecord): SpawnedFollowUpRun[] {
  if (FOLLOW_UP_ORIGINS.includes(run.origin)) return [];
  const pr = samePr(run);
  if (!pr || originatingRun(db, run)?.id !== run.id) return [];
  const rows = attempt(
    [],
    () =>
      db
        .query(
          `SELECT id, origin, status, started_at FROM runs
           WHERE ${pr.where} AND origin IN (${FOLLOW_UP_SQL}) AND id != ?
           ORDER BY started_at, id LIMIT ${MAX_SPAWNED_PER_KIND}`,
        )
        .all(...pr.params, run.id) as Array<
        Pick<RunRow, "id" | "origin" | "status" | "started_at">
      >,
  );
  return rows.map((row) => ({
    kind: "follow_up_run",
    runId: row.id,
    origin: row.origin as RunOrigin,
    status: row.status as RunStatus,
    startedAt: row.started_at,
  }));
}

/**
 * Lineage of one run: its source run and the work it spawned.
 *
 * @param dbs - Connections holding runs/outputs and the injected-task queue
 * @param run - The run to describe
 */
export function computeRunLineage(dbs: LineageDatabases, run: RunRecord): RunLineage {
  return {
    parent: resolveParent(dbs, run),
    spawned: [
      ...spawnedTasks(dbs, run.id),
      ...spawnedTrackerIssues(dbs.runs, run.id),
      ...spawnedFollowUps(dbs.runs, run),
    ],
  };
}

/**
 * Read a run's lineage over read-only connections (dashboard GET path: never
 * creates a file or schema). Missing databases read as no lineage.
 *
 * @param historyDbPath - DB holding `runs` and `run_outputs`
 * @param queueDbPath - Workspace queue DB holding `injected_tasks`
 * @param run - The run to describe
 */
export function readRunLineage(
  historyDbPath: string,
  queueDbPath: string,
  run: RunRecord,
): RunLineage {
  const empty: RunLineage = { parent: null, spawned: [] };
  if (!existsSync(historyDbPath)) return empty;
  let runs: Database | undefined;
  let queue: Database | undefined;
  try {
    runs = new Database(historyDbPath, { readonly: true });
    configureSqliteConnection(runs, { readonly: true });
    if (resolve(queueDbPath) !== resolve(historyDbPath) && existsSync(queueDbPath)) {
      queue = new Database(queueDbPath, { readonly: true });
      configureSqliteConnection(queue, { readonly: true });
    }
    return computeRunLineage(
      { runs, queue: resolve(queueDbPath) === resolve(historyDbPath) ? runs : (queue ?? null) },
      run,
    );
  } catch {
    return empty;
  } finally {
    queue?.close();
    runs?.close();
  }
}
