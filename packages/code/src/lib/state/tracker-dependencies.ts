/**
 * Dependency-gate state for tracker tickets with native blockers
 * (`tracker_dependencies` in the workspace DB).
 *
 * One row per `(team, task_key)` ticket the worker gated:
 * - `state` / `reason`: why the ticket is not being picked up yet
 *   (`waiting` / `blocked`), `NULL` once it may start. `worker queue` and the
 *   dashboard list rows with a state.
 * - `stacked_on`: the blocker ticket whose unmerged branch the ticket's most
 *   recent stacked run was stacked on. Set by the task subprocess once its
 *   pipeline targets that base (see {@link recordTrackerStackedOn}), and never
 *   cleared by a later unstacked verdict, because the ticket's branch and PR
 *   keep targeting that base. Dependents of this ticket read it (see
 *   `readLocalDependencyFacts`) so a merge into that branch counts only once the
 *   base merged too, the same rule ad-hoc tasks follow via
 *   `injected_tasks.stacked_on`.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

import type { DependencyMode } from "../dependencies/gate";
import { configureSqliteConnection } from "./sqlite";

/** Table name, shared with the read-only readers. */
export const TRACKER_DEPENDENCIES_TABLE = "tracker_dependencies";

/** A tracker ticket held back by its blockers. */
export interface TrackerDependencyWait {
  taskKey: string;
  /** Team that polled the ticket; empty in single-tracker workspaces. */
  team?: string;
  tracker: string;
  /** Repo the ticket routed to. */
  repo?: string;
  dependsOn: string[];
  dependencyMode: DependencyMode;
  state: "waiting" | "blocked";
  reason: string;
  /** Blocker ticket a stacked run branched from, once recorded. */
  stackedOn?: string;
  /** When the ticket entered its current state (epoch ms). */
  since: number;
}

/** One gate verdict for {@link TrackerDependencyStore.record}. */
export interface TrackerDependencyVerdict {
  taskKey: string;
  team?: string;
  tracker: string;
  repo?: string;
  dependsOn: readonly string[];
  dependencyMode: DependencyMode;
  /** `null` when the ticket may start. */
  state: "waiting" | "blocked" | null;
  reason: string | null;
}

function ensureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ${TRACKER_DEPENDENCIES_TABLE} (
      task_key TEXT NOT NULL,
      team TEXT NOT NULL DEFAULT '',
      tracker TEXT NOT NULL,
      repo TEXT,
      depends_on TEXT NOT NULL DEFAULT '[]',
      dependency_mode TEXT NOT NULL,
      state TEXT,
      reason TEXT,
      stacked_on TEXT,
      since INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (task_key, team)
    )
  `);
}

function parseKeys(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

function toWait(row: Record<string, unknown>): TrackerDependencyWait | null {
  const state = row.state;
  if (state !== "waiting" && state !== "blocked") return null;
  if (typeof row.task_key !== "string" || typeof row.since !== "number") return null;
  return {
    taskKey: row.task_key,
    team: typeof row.team === "string" && row.team !== "" ? row.team : undefined,
    tracker: typeof row.tracker === "string" ? row.tracker : "",
    repo: typeof row.repo === "string" && row.repo !== "" ? row.repo : undefined,
    dependsOn: parseKeys(row.depends_on),
    dependencyMode: row.dependency_mode === "stacked" ? "stacked" : "merged",
    state,
    reason: typeof row.reason === "string" ? row.reason : "",
    ...(typeof row.stacked_on === "string" && row.stacked_on !== ""
      ? { stackedOn: row.stacked_on }
      : {}),
    since: row.since,
  };
}

/** Read/write store; opened by the worker's tracker dependency gate. */
export class TrackerDependencyStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    configureSqliteConnection(this.db);
    ensureSchema(this.db);
  }

  /** The open connection, for reading dependency facts in the same DB. */
  connection(): Database {
    return this.db;
  }

  /**
   * Persist a gate verdict.
   *
   * @returns Whether the state or reason changed (callers log only then)
   */
  record(verdict: TrackerDependencyVerdict, now = Date.now()): boolean {
    const team = verdict.team ?? "";
    const previous = this.db
      .query(
        `SELECT state, reason FROM ${TRACKER_DEPENDENCIES_TABLE} WHERE task_key = ? AND team = ?`,
      )
      .get(verdict.taskKey, team) as { state: string | null; reason: string | null } | null;
    const changed =
      !previous || previous.state !== verdict.state || previous.reason !== verdict.reason;
    const stateChanged = !previous || previous.state !== verdict.state;
    this.db
      .query(
        `INSERT INTO ${TRACKER_DEPENDENCIES_TABLE}
           (task_key, team, tracker, repo, depends_on, dependency_mode, state, reason, since, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_key, team) DO UPDATE SET
           tracker = excluded.tracker,
           repo = excluded.repo,
           depends_on = excluded.depends_on,
           dependency_mode = excluded.dependency_mode,
           state = excluded.state,
           reason = excluded.reason,
           since = CASE WHEN ? THEN excluded.since ELSE since END,
           updated_at = excluded.updated_at`,
      )
      .run(
        verdict.taskKey,
        team,
        verdict.tracker,
        verdict.repo ?? null,
        JSON.stringify(verdict.dependsOn),
        verdict.dependencyMode,
        verdict.state,
        verdict.reason,
        now,
        now,
        stateChanged ? 1 : 0,
      );
    return changed;
  }

  /** Record the blocker ticket a starting run is stacked on. */
  setStackedOn(taskKey: string, team: string | undefined, stackedOn: string): void {
    this.db
      .query(
        `UPDATE ${TRACKER_DEPENDENCIES_TABLE} SET stacked_on = ?, updated_at = ?
         WHERE task_key = ? AND team = ?`,
      )
      .run(stackedOn, Date.now(), taskKey, team ?? "");
  }

  /**
   * Clear the wait state of a ticket that no longer has blockers. Its
   * `stacked_on` is kept: an earlier stacked run's PR still targets that base.
   */
  clear(taskKey: string, team: string | undefined): void {
    this.db
      .query(
        `UPDATE ${TRACKER_DEPENDENCIES_TABLE} SET state = NULL, reason = NULL, updated_at = ?
         WHERE task_key = ? AND team = ? AND state IS NOT NULL`,
      )
      .run(Date.now(), taskKey, team ?? "");
  }

  /**
   * Clear waits of one team's tickets the poll query no longer returns
   * (closed, reassigned, ...), so the queue view does not list them forever.
   */
  clearWaitsExcept(team: string | undefined, polledKeys: ReadonlySet<string>): void {
    const rows = this.db
      .query(
        `SELECT task_key FROM ${TRACKER_DEPENDENCIES_TABLE} WHERE team = ? AND state IS NOT NULL`,
      )
      .all(team ?? "") as Array<{ task_key: string }>;
    for (const row of rows) {
      if (!polledKeys.has(row.task_key)) this.clear(row.task_key, team);
    }
  }

  /** Tickets currently held back, oldest first. */
  listWaiting(limit = 100): TrackerDependencyWait[] {
    return listWaits(this.db, limit);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Record, from a tracker ticket's task subprocess, the blocker whose branch
 * the run actually targets. Only the pipeline knows this: an explicit
 * `Target branch:` or a base missing on the remote drops the stack the
 * worker's gate proposed. Updates the row the gate wrote; a missing row (a run
 * the gate did not stack) is left alone.
 */
export function recordTrackerStackedOn(
  dbPath: string,
  taskKey: string,
  team: string | undefined,
  stackedOn: string,
): void {
  if (!existsSync(dbPath)) return;
  const store = new TrackerDependencyStore(dbPath);
  try {
    store.setStackedOn(taskKey, team, stackedOn);
  } finally {
    store.close();
  }
}

function listWaits(db: Database, limit: number): TrackerDependencyWait[] {
  const rows = db
    .query(
      `SELECT * FROM ${TRACKER_DEPENDENCIES_TABLE} WHERE state IS NOT NULL
       ORDER BY since ASC, task_key ASC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(toWait).filter((wait): wait is TrackerDependencyWait => wait !== null);
}

/**
 * Read-only listing for the dashboard and `worker queue`: a missing DB or
 * table reads as no waits, and nothing is created.
 */
export function readTrackerDependencyWaits(dbPath: string, limit = 100): TrackerDependencyWait[] {
  if (!existsSync(dbPath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    configureSqliteConnection(db, { readonly: true });
    return listWaits(db, limit);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
