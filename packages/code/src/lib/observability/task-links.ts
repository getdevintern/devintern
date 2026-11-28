/**
 * Task dependency links for the dashboard: resolve dependency task keys to
 * where an operator can open and retry them, and list the queued tasks a task
 * blocks.
 *
 * A key resolves from the ad-hoc queue (`injected_tasks`), the tracker gate
 * (`tracker_dependencies`, a ticket still held back), and its newest `runs`
 * row. Each read is one batched query for the whole list, so a queue page
 * costs a fixed number of queries however many items it holds. Every read is
 * read-only and best-effort: a missing file, table, or column reads as "not
 * known" and the key is served as `unknown`.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { resolve } from "path";

import type { RunRecord, RunStatus } from "../state/run-recorder";
import { isRunRetriable } from "../state/run-retry";
import type { RetryKind } from "../state/run-retry";
import { configureSqliteConnection } from "../state/sqlite";
import { TRACKER_DEPENDENCIES_TABLE } from "../state/tracker-dependencies";

/** Where a dependency stands, as far as the dashboard can tell. */
export type TaskLinkStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "unknown";

/** One dependency key, resolved. */
export interface TaskLink {
  key: string;
  /** `unknown` when no queue row or run is recorded (e.g. a pruned task). */
  status: TaskLinkStatus;
  /** The key's newest run, when it has one. */
  latestRunId?: number;
  latestRunStatus?: RunStatus;
  /** Queued-work item id (`ad-hoc:<id>`, `tracker:<team>:<key>`) while it waits in the queue. */
  queuedItemId?: string;
  /**
   * Set when `POST /api/runs/<latestRunId>/retry` would re-run or re-queue the
   * key: how that retry dispatches. Unset when it cannot be retried from here.
   */
  retryKind?: RetryKind;
}

/** A queued task that waits on a given task. */
export interface TaskDependent {
  key: string;
  title: string;
  /** Queued-work item id, for opening it in the Overview's queue. */
  queuedItemId: string;
  /** `waiting` or `blocked` on its dependencies; unset once claimable. */
  dependencyState?: "waiting" | "blocked";
  dependencyReason?: string;
  /** Its newest run (an earlier attempt), when it has one. */
  latestRunId?: number;
}

/** Connections the reads use; both may be the same database. */
export interface TaskLinkDatabases {
  /** Holds `runs`. */
  runs: Database | null;
  /** Holds `injected_tasks` and `tracker_dependencies`. */
  queue: Database | null;
}

const RUN_STATUSES: readonly RunStatus[] = [
  "in_progress",
  "succeeded",
  "failed",
  "deferred",
  "escalated",
  "abandoned",
];

const QUEUE_STATUSES: readonly TaskLinkStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
];

/** Most dependents listed on one run page. */
const MAX_DEPENDENTS = 50;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function columns(db: Database, table: string): Set<string> {
  try {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

function parseKeys(raw: unknown): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string" && key !== "")
      : [];
  } catch {
    return [];
  }
}

function placeholders(keys: readonly string[]): string {
  return keys.map(() => "?").join(", ");
}

interface QueueRow {
  id: number;
  status: TaskLinkStatus;
}

function readQueueRows(db: Database | null, keys: readonly string[]): Map<string, QueueRow> {
  const map = new Map<string, QueueRow>();
  if (!db || columns(db, "injected_tasks").size === 0) return map;
  const rows = db
    .query(
      `SELECT id, task_key, status FROM injected_tasks WHERE task_key IN (${placeholders(keys)})`,
    )
    .all(...keys) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const key = text(row.task_key);
    const id = integer(row.id);
    const status = QUEUE_STATUSES.find((candidate) => candidate === row.status);
    if (key && id !== undefined && status) map.set(key, { id, status });
  }
  return map;
}

/** Tracker tickets still held back by their own blockers: queued items of kind `tracker`. */
function readTrackerWaits(db: Database | null, keys: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!db || columns(db, TRACKER_DEPENDENCIES_TABLE).size === 0) return map;
  const rows = db
    .query(
      `SELECT task_key, team FROM ${TRACKER_DEPENDENCIES_TABLE}
       WHERE task_key IN (${placeholders(keys)}) AND state IN ('waiting', 'blocked')
       ORDER BY updated_at DESC`,
    )
    .all(...keys) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const key = text(row.task_key);
    if (key && !map.has(key)) map.set(key, `tracker:${text(row.team) ?? ""}:${key}`);
  }
  return map;
}

type LatestRun = Pick<
  RunRecord,
  "id" | "status" | "taskKey" | "origin" | "automationId" | "branch" | "prUrl" | "prFailure"
>;

/** Newest run per key, in one windowed query. */
function readLatestRuns(db: Database | null, keys: readonly string[]): Map<string, LatestRun> {
  const map = new Map<string, LatestRun>();
  if (!db) return map;
  const available = columns(db, "runs");
  if (!available.has("task_key")) return map;
  const optional = ["origin", "automation_id", "branch", "pr_url", "pr_failure"].filter((name) =>
    available.has(name),
  );
  const extra = optional.map((name) => `, ${name}`).join("");
  const rows = db
    .query(
      `SELECT id, task_key, status${extra} FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY task_key ORDER BY started_at DESC, id DESC
         ) AS rn
         FROM runs WHERE task_key IN (${placeholders(keys)})
       ) WHERE rn = 1`,
    )
    .all(...keys) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const key = text(row.task_key);
    const id = integer(row.id);
    const status = RUN_STATUSES.find((candidate) => candidate === row.status);
    if (!key || id === undefined || !status) continue;
    map.set(key, {
      id,
      status,
      taskKey: key,
      origin: (text(row.origin) ?? "task") as RunRecord["origin"],
      automationId: text(row.automation_id),
      branch: text(row.branch),
      prUrl: text(row.pr_url),
      prFailure: text(row.pr_failure),
    });
  }
  return map;
}

/** Status of a key with no queue row, from its newest run. */
function statusFromRun(status: RunStatus): TaskLinkStatus {
  switch (status) {
    case "in_progress":
      return "running";
    case "succeeded":
      return "done";
    case "deferred":
      return "pending";
    case "failed":
    case "escalated":
    case "abandoned":
      return "failed";
  }
}

/**
 * How the run-detail retry would dispatch for this key, or undefined when it
 * would refuse. Mirrors the retry handler's eligibility rules: the run must be
 * retriable, and an ad-hoc re-queue needs a settled (done/failed) queue row.
 */
function retryKindFor(
  run: LatestRun | undefined,
  row: QueueRow | undefined,
): RetryKind | undefined {
  if (!run) return undefined;
  const eligibility = isRunRetriable(run);
  if (!eligibility.eligible || !eligibility.kind) return undefined;
  if (eligibility.kind === "injected" && row?.status !== "done" && row?.status !== "failed") {
    return undefined;
  }
  return eligibility.kind;
}

/**
 * Resolve dependency keys to their status, newest run, and retry action.
 * Keys that no table knows come back `unknown`.
 *
 * @param dbs - Connections holding the queue and run history
 * @param keys - Dependency task keys (duplicates are resolved once)
 */
export function resolveTaskLinks(
  dbs: TaskLinkDatabases,
  keys: readonly string[],
): Map<string, TaskLink> {
  const unique = [...new Set(keys.filter((key) => key !== ""))];
  const links = new Map<string, TaskLink>();
  if (unique.length === 0) return links;
  const queue = attempt(new Map<string, QueueRow>(), () => readQueueRows(dbs.queue, unique));
  const tracker = attempt(new Map<string, string>(), () => readTrackerWaits(dbs.queue, unique));
  const runs = attempt(new Map<string, LatestRun>(), () => readLatestRuns(dbs.runs, unique));
  for (const key of unique) {
    const row = queue.get(key);
    const run = runs.get(key);
    const trackerItem = row ? undefined : tracker.get(key);
    const status: TaskLinkStatus = row
      ? row.status
      : trackerItem
        ? "pending"
        : run
          ? statusFromRun(run.status)
          : "unknown";
    const queuedItemId = row?.status === "pending" ? `ad-hoc:${row.id}` : trackerItem;
    const retryKind = retryKindFor(run, row);
    links.set(key, {
      key,
      status,
      ...(run ? { latestRunId: run.id, latestRunStatus: run.status } : {}),
      ...(queuedItemId ? { queuedItemId } : {}),
      ...(retryKind ? { retryKind } : {}),
    });
  }
  return links;
}

/**
 * Queued tasks that wait on `taskKey`: pending ad-hoc rows that depend on it
 * (or are stacked on it), and tracker tickets held back by it.
 *
 * @param dbs - Connections holding the queue and run history
 * @param taskKey - The blocking task
 */
export function listTaskDependents(dbs: TaskLinkDatabases, taskKey: string): TaskDependent[] {
  if (!taskKey) return [];
  const dependents: TaskDependent[] = [];
  // `LIKE` narrows the scan; the JSON list is the authority (a `_` in a key is a wildcard).
  const pattern = `%"${taskKey}"%`;
  const queue = dbs.queue;
  if (queue) {
    const available = columns(queue, "injected_tasks");
    if (available.has("depends_on")) {
      const stacked = available.has("stacked_on") ? " OR stacked_on = ?" : "";
      const stateColumns = available.has("dependency_state")
        ? ", dependency_state, dependency_reason"
        : "";
      const rows = attempt(
        [],
        () =>
          queue
            .query(
              `SELECT id, task_key, title, depends_on${stacked ? ", stacked_on" : ""}${stateColumns}
               FROM injected_tasks WHERE status = 'pending' AND (depends_on LIKE ?${stacked})
               ORDER BY created_at ASC, id ASC LIMIT ${MAX_DEPENDENTS * 2}`,
            )
            .all(...(stacked ? [pattern, taskKey] : [pattern])) as Array<Record<string, unknown>>,
      );
      for (const row of rows) {
        const key = text(row.task_key);
        const id = integer(row.id);
        if (!key || id === undefined) continue;
        if (!parseKeys(row.depends_on).includes(taskKey) && text(row.stacked_on) !== taskKey) {
          continue;
        }
        dependents.push({
          key,
          title: text(row.title) ?? key,
          queuedItemId: `ad-hoc:${id}`,
          ...dependencyState(row),
        });
      }
    }
    if (columns(queue, TRACKER_DEPENDENCIES_TABLE).size > 0) {
      const rows = attempt(
        [],
        () =>
          queue
            .query(
              `SELECT task_key, team, depends_on, state AS dependency_state, reason AS dependency_reason
               FROM ${TRACKER_DEPENDENCIES_TABLE}
               WHERE state IN ('waiting', 'blocked') AND (depends_on LIKE ? OR stacked_on = ?)
               ORDER BY since ASC LIMIT ${MAX_DEPENDENTS * 2}`,
            )
            .all(pattern, taskKey) as Array<Record<string, unknown>>,
      );
      for (const row of rows) {
        const key = text(row.task_key);
        if (!key || !parseKeys(row.depends_on).includes(taskKey)) continue;
        dependents.push({
          key,
          title: key,
          queuedItemId: `tracker:${text(row.team) ?? ""}:${key}`,
          ...dependencyState(row),
        });
      }
    }
  }
  const listed = dependents.slice(0, MAX_DEPENDENTS);
  const runs = attempt(new Map<string, LatestRun>(), () =>
    listed.length > 0
      ? readLatestRuns(
          dbs.runs,
          listed.map((dependent) => dependent.key),
        )
      : new Map<string, LatestRun>(),
  );
  return listed.map((dependent) => {
    const run = runs.get(dependent.key);
    return run ? { ...dependent, latestRunId: run.id } : dependent;
  });
}

function dependencyState(
  row: Record<string, unknown>,
): Pick<TaskDependent, "dependencyState" | "dependencyReason"> {
  const state = row.dependency_state;
  if (state !== "waiting" && state !== "blocked") return {};
  const reason = text(row.dependency_reason);
  return { dependencyState: state, ...(reason ? { dependencyReason: reason } : {}) };
}

function attempt<T>(fallback: T, read: () => T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Open read-only connections to the history and queue DBs for one read, and
 * close them after. Missing files read as absent connections (never created).
 *
 * @param historyDbPath - DB holding `runs`
 * @param queueDbPath - Workspace queue DB
 * @param read - The read to run
 */
export function withTaskLinkDatabases<T>(
  historyDbPath: string,
  queueDbPath: string,
  read: (dbs: TaskLinkDatabases) => T,
): T {
  const open = (path: string): Database | null => {
    if (!existsSync(path)) return null;
    try {
      const db = new Database(path, { readonly: true });
      configureSqliteConnection(db, { readonly: true });
      return db;
    } catch {
      return null;
    }
  };
  const runs = open(historyDbPath);
  const shared = resolve(historyDbPath) === resolve(queueDbPath);
  const queue = shared ? runs : open(queueDbPath);
  try {
    return read({ runs, queue });
  } finally {
    if (!shared) queue?.close();
    runs?.close();
  }
}

/**
 * Queued tasks waiting on a run's task (`blocks` of `GET /api/runs/:id`);
 * empty for a run without a task key.
 *
 * @param historyDbPath - DB holding `runs`
 * @param queueDbPath - Workspace queue DB
 * @param taskKey - The run's task key
 */
export function readTaskDependents(
  historyDbPath: string,
  queueDbPath: string,
  taskKey: string | undefined,
): TaskDependent[] {
  if (!taskKey) return [];
  try {
    return withTaskLinkDatabases(historyDbPath, queueDbPath, (dbs) =>
      listTaskDependents(dbs, taskKey),
    );
  } catch {
    return [];
  }
}
