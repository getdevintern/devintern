/**
 * Run Records
 *
 * Structured, queryable record of how each ticket (or PR mention) was
 * handled, persisted in the shared `.devintern-code/queue.db`. One `runs`
 * row per attempt; one `run_stages` row per pipeline stage. Captured from
 * day one because run history cannot be backfilled — today's artifacts are
 * loose files under the output directory.
 *
 * The module-level `beginRun`/`recordRunStage`/`endRun` helpers instrument
 * the (strictly sequential) task pipeline. Every call is best-effort:
 * recording must never fail or slow a run.
 */

import { Database } from "bun:sqlite";
import { prepareQueueDbDirectory, resolveQueueDbPath } from "./webhook-queue";

export type RunOrigin = "task" | "pr_mention" | "conflict_resolution" | "scheduled";

export type RunStatus =
  | "in_progress"
  | "succeeded"
  | "failed"
  | "deferred" // usage limit: will be retried, not a failure
  | "escalated" // handed back to a human
  | "abandoned"; // stopped without implementation (e.g. failed feasibility)

export type RunStage =
  | "feasibility"
  | "implementation"
  | "auto_review"
  | "change_request"
  | "outcome";

export type StageStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  // Outcome stages carry the run's terminal status so an escalated or
  // deferred run is not rendered as a plain failure.
  | "deferred"
  | "escalated"
  | "abandoned";

export interface RunMeta {
  origin: RunOrigin;
  taskKey?: string; // null for pr_mention runs
  tracker?: string;
  harness?: string;
  branch?: string;
  repo?: string;
  prNumber?: number;
  automationId?: string;
  /** Tracker-assigned key of the originating ticket (same as `taskKey`). */
  ticketKey?: string;
  /** Web URL of the originating ticket (derived from tracker config + key). */
  ticketUrl?: string;
  /** Explicit attempt for non-task durable events. */
  attempt?: number;
}

/** Cap persisted ticket descriptions so a huge ticket cannot bloat the DB. */
const MAX_DESCRIPTION_LENGTH = 20_000;

export interface RunRecord extends RunMeta {
  id: number;
  /** 1-based attempt number for the task (null-ish for pr_mention runs). */
  attempt?: number;
  prUrl?: string;
  status: RunStatus;
  outcomeReason?: string;
  startedAt: number;
  finishedAt?: number;
  /** Markdown snapshot of the ticket description captured at run start. */
  taskDescription?: string;
}

export interface RunStageRecord {
  id: number;
  runId: number;
  stage: RunStage;
  status: StageStatus;
  summary?: string;
  detail?: string; // JSON blob
  createdAt: number;
}

/** Cap persisted stage detail so a huge agent transcript cannot bloat the DB. */
const MAX_DETAIL_LENGTH = 50_000;

export interface RunFilter {
  taskKey?: string;
  status?: RunStatus;
  origin?: RunOrigin;
}

export interface RunStatsWeek {
  /** ISO date (Monday, UTC) of the week's start. */
  weekStart: string;
  count: number;
}

export interface RunStatsHarness {
  harness: string;
  runs: number;
  succeeded: number;
  failed: number;
  escalated: number;
  /** Median duration of succeeded runs, or null when none finished. */
  medianDurationMs: number | null;
}

export interface RunStats {
  totals: { runs: number; byStatus: Record<RunStatus, number> };
  /** Fraction of terminal runs that succeeded; null when no terminal runs. */
  successRate: number | null;
  /** Fraction of terminal runs that escalated; null when no terminal runs. */
  escalationRate: number | null;
  runsPerWeek: RunStatsWeek[];
  /** Median duration of succeeded runs with a PR; null when none. */
  medianDurationMs: number | null;
  byHarness: RunStatsHarness[];
  byOrigin: Record<RunOrigin, number>;
}

/** Statuses that no longer change (excluded: in_progress and deferred-for-retry). */
const TERMINAL_STATUSES: RunStatus[] = ["succeeded", "failed", "escalated", "abandoned"];

/** ISO date (UTC) of the Monday starting the week that contains `epochMs`. */
function weekStartIso(epochMs: number): string {
  const date = new Date(epochMs);
  // getUTCDay(): 0 = Sunday; shift so Monday starts the week.
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday),
  );
  return monday.toISOString().slice(0, 10);
}

/** Median of a numeric list, or null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * SQLite-backed store for run records.
 */
export class RunStore {
  private db: Database;

  /**
   * Open (or create) the run-record tables in the queue database.
   *
   * @param dbPath - Database path (defaults to the shared queue DB)
   * @param options - `readonly` opens the DB without creating dirs/tables
   *                  (dashboard reads alongside a live worker; throws when
   *                  the file does not exist)
   */
  constructor(dbPath: string = resolveQueueDbPath(), options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      this.db = new Database(dbPath, { readonly: true });
      this.db.run("PRAGMA busy_timeout = 5000");
      return;
    }

    prepareQueueDbDirectory(dbPath);

    this.db = new Database(dbPath);
    // The webhook queue / worker state may hold connections to the same file.
    this.db.run("PRAGMA busy_timeout = 5000");
    this.initializeSchema();
  }

  /** Create tables if they do not exist. */
  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        origin TEXT NOT NULL,
        task_key TEXT,
        tracker TEXT,
        harness TEXT,
        branch TEXT,
        repo TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        status TEXT NOT NULL DEFAULT 'in_progress',
        outcome_reason TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        attempt INTEGER,
        automation_id TEXT,
        ticket_key TEXT,
        ticket_url TEXT,
        task_description TEXT
      )
    `);

    // Additive migration for databases created before the attempt column.
    const columns = this.db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "attempt")) {
      this.db.run("ALTER TABLE runs ADD COLUMN attempt INTEGER");
    }
    if (!columns.some((c) => c.name === "automation_id")) {
      this.db.run("ALTER TABLE runs ADD COLUMN automation_id TEXT");
    }
    if (!columns.some((c) => c.name === "ticket_key")) {
      this.db.run("ALTER TABLE runs ADD COLUMN ticket_key TEXT");
    }
    if (!columns.some((c) => c.name === "ticket_url")) {
      this.db.run("ALTER TABLE runs ADD COLUMN ticket_url TEXT");
    }
    if (!columns.some((c) => c.name === "task_description")) {
      this.db.run("ALTER TABLE runs ADD COLUMN task_description TEXT");
    }
    this.db.run("CREATE INDEX IF NOT EXISTS idx_runs_automation_id ON runs(automation_id)");

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_runs_task_key ON runs(task_key)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS run_stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_run_stages_run_id ON run_stages(run_id)
    `);
  }

  /**
   * Insert a new run in `in_progress` state.
   *
   * @param meta - Run origin and metadata (task key is nullable for pr_mention)
   * @returns The new run id
   */
  createRun(meta: RunMeta): number {
    const attempt = meta.attempt ?? (meta.taskKey ? this.countRuns(meta.taskKey) + 1 : null);
    const result = this.db.run(
      `INSERT INTO runs (origin, task_key, tracker, harness, branch, repo, pr_number,
       automation_id, ticket_key, ticket_url, status, started_at, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
      [
        meta.origin,
        meta.taskKey ?? null,
        meta.tracker ?? null,
        meta.harness ?? null,
        meta.branch ?? null,
        meta.repo ?? null,
        meta.prNumber ?? null,
        meta.automationId ?? null,
        meta.ticketKey ?? null,
        meta.ticketUrl ?? null,
        Date.now(),
        attempt,
      ],
    );
    return Number(result.lastInsertRowid);
  }

  /** Number of recorded runs (attempts) for a task. */
  countRuns(taskKey: string): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM runs WHERE task_key = ?`).get(taskKey) as {
      n: number;
    };
    return row.n;
  }

  /**
   * Append a stage record to a run.
   *
   * @param runId - Run id from {@link createRun}
   * @param stage - Pipeline stage name
   * @param status - Stage outcome
   * @param summary - One-line human-readable summary
   * @param detail - Structured detail (JSON-stringified), truncated if huge
   */
  addStage(
    runId: number,
    stage: RunStage,
    status: StageStatus,
    summary?: string,
    detail?: string,
  ): void {
    this.db.run(
      `INSERT INTO run_stages (run_id, stage, status, summary, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        runId,
        stage,
        status,
        summary ?? null,
        detail ? detail.slice(0, MAX_DETAIL_LENGTH) : null,
        Date.now(),
      ],
    );
  }

  /**
   * Attach the created PR to a run.
   *
   * @param runId - Run id
   * @param pr - Repo slug, PR number, and URL (all optional)
   */
  setRunPr(runId: number, pr: { repo?: string; prNumber?: number; url?: string }): void {
    this.db.run(
      `UPDATE runs SET
         repo = COALESCE(?, repo),
         pr_number = COALESCE(?, pr_number),
         pr_url = COALESCE(?, pr_url)
       WHERE id = ?`,
      [pr.repo ?? null, pr.prNumber ?? null, pr.url ?? null, runId],
    );
  }

  /**
   * Attach the originating tracker ticket to a run.
   *
   * Fields already set are never clobbered (`COALESCE`), so a late snapshot
   * cannot erase metadata recorded at run start.
   *
   * @param runId - Run id
   * @param ticket - Ticket key, web URL, and/or markdown description
   */
  setRunTicket(runId: number, ticket: { key?: string; url?: string; description?: string }): void {
    const description = ticket.description?.trim() ? ticket.description : null;
    this.db.run(
      `UPDATE runs SET
         ticket_key = COALESCE(?, ticket_key),
         ticket_url = COALESCE(?, ticket_url),
         task_description = COALESCE(?, task_description)
       WHERE id = ?`,
      [
        ticket.key ?? null,
        ticket.url ?? null,
        description?.slice(0, MAX_DESCRIPTION_LENGTH) ?? null,
        runId,
      ],
    );
  }

  /**
   * Mark a run terminal and record an `outcome` stage row.
   *
   * @param runId - Run id
   * @param status - Terminal status
   * @param reason - Optional human-readable reason
   */
  finishRun(runId: number, status: Exclude<RunStatus, "in_progress">, reason?: string): void {
    this.db.run(`UPDATE runs SET status = ?, outcome_reason = ?, finished_at = ? WHERE id = ?`, [
      status,
      reason ?? null,
      Date.now(),
      runId,
    ]);
    this.addStage(runId, "outcome", status, reason);
  }

  /**
   * Fail every `in_progress` run left over from a previous worker process.
   *
   * Only one worker owns a queue database, so any run still `in_progress`
   * when a worker starts was abandoned by a crashed or killed predecessor.
   * A late `finishRun` from an outlived subprocess still wins afterwards —
   * it overwrites the row unconditionally.
   *
   * @returns Number of reaped runs
   */
  reapOrphanedRuns(): number {
    const result = this.db.run(
      `UPDATE runs SET status = 'failed',
         outcome_reason = 'orphaned: worker exited before the run finished',
         finished_at = ?
       WHERE status = 'in_progress'`,
      [Date.now()],
    );
    return result.changes;
  }

  /**
   * Load a run by id.
   *
   * @param id - Run id
   */
  getRun(id: number): RunRecord | null {
    const row = this.db.query(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<
      string,
      unknown
    > | null;
    if (!row) {
      return null;
    }
    return this.rowToRun(row);
  }

  /** Build the WHERE clause and bind params for a {@link RunFilter}. */
  private filterClause(filter: RunFilter): { where: string; params: (string | number)[] } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.taskKey) {
      clauses.push("task_key = ?");
      params.push(filter.taskKey);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.origin) {
      clauses.push("origin = ?");
      params.push(filter.origin);
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  /**
   * List runs, most recent first.
   *
   * @param options - Optional filters, limit (default 100), and offset
   */
  listRuns(options: RunFilter & { limit?: number; offset?: number } = {}): RunRecord[] {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const { where, params } = this.filterClause(options);
    const rows = this.db
      .query(`SELECT * FROM runs ${where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRun(row));
  }

  /**
   * Count runs matching a filter (pagination totals).
   *
   * @param filter - Optional task-key/status/origin filter
   */
  countFilteredRuns(filter: RunFilter = {}): number {
    const { where, params } = this.filterClause(filter);
    const row = this.db.query(`SELECT COUNT(*) AS count FROM runs ${where}`).get(...params) as {
      count: number;
    };
    return row.count;
  }

  /**
   * Aggregate run statistics over a time window.
   *
   * Rates are computed over terminal runs only (in-progress and deferred runs
   * have no outcome yet). Durations use `finished_at - started_at` of
   * succeeded runs — a proxy for ticket-to-PR time, since the schema has no
   * PR-created timestamp.
   *
   * @param windowMs - Include runs started within the last `windowMs`
   *                   milliseconds; `null` for all time
   */
  getStats(windowMs: number | null): RunStats {
    const since = windowMs === null ? 0 : Date.now() - windowMs;
    const rows = this.db
      .query(
        `SELECT origin, harness, status, pr_url, started_at, finished_at
         FROM runs WHERE started_at >= ? ORDER BY started_at ASC`,
      )
      .all(since) as {
      origin: RunOrigin;
      harness: string | null;
      status: RunStatus;
      pr_url: string | null;
      started_at: number;
      finished_at: number | null;
    }[];

    const byStatus: Record<RunStatus, number> = {
      in_progress: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      escalated: 0,
      abandoned: 0,
    };
    const byOrigin: Record<RunOrigin, number> = {
      task: 0,
      pr_mention: 0,
      conflict_resolution: 0,
      scheduled: 0,
    };
    const weekCounts = new Map<string, number>();
    const harnesses = new Map<
      string,
      { runs: number; byStatus: Map<RunStatus, number>; durations: number[] }
    >();
    const durations: number[] = [];

    for (const row of rows) {
      byStatus[row.status] += 1;
      byOrigin[row.origin] = (byOrigin[row.origin] ?? 0) + 1;

      const week = weekStartIso(row.started_at);
      weekCounts.set(week, (weekCounts.get(week) ?? 0) + 1);

      const harnessKey = row.harness ?? "unknown";
      let harness = harnesses.get(harnessKey);
      if (!harness) {
        harness = { runs: 0, byStatus: new Map(), durations: [] };
        harnesses.set(harnessKey, harness);
      }
      harness.runs += 1;
      harness.byStatus.set(row.status, (harness.byStatus.get(row.status) ?? 0) + 1);

      if (row.status === "succeeded" && row.finished_at !== null) {
        const duration = row.finished_at - row.started_at;
        harness.durations.push(duration);
        if (row.pr_url) {
          durations.push(duration);
        }
      }
    }

    const terminal = TERMINAL_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);

    return {
      totals: { runs: rows.length, byStatus },
      successRate: terminal > 0 ? byStatus.succeeded / terminal : null,
      escalationRate: terminal > 0 ? byStatus.escalated / terminal : null,
      runsPerWeek: [...weekCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, count]) => ({ weekStart, count })),
      medianDurationMs: median(durations),
      byHarness: [...harnesses.entries()]
        .sort(([, a], [, b]) => b.runs - a.runs)
        .map(([harness, data]) => ({
          harness,
          runs: data.runs,
          succeeded: data.byStatus.get("succeeded") ?? 0,
          failed: data.byStatus.get("failed") ?? 0,
          escalated: data.byStatus.get("escalated") ?? 0,
          medianDurationMs: median(data.durations),
        })),
      byOrigin,
    };
  }

  /**
   * List a run's stages in insertion order.
   *
   * @param runId - Run id
   */
  listStages(runId: number): RunStageRecord[] {
    const rows = this.db
      .query(`SELECT * FROM run_stages WHERE run_id = ? ORDER BY id ASC`)
      .all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      runId: row.run_id as number,
      stage: row.stage as RunStage,
      status: row.status as StageStatus,
      summary: (row.summary as string | null) ?? undefined,
      detail: (row.detail as string | null) ?? undefined,
      createdAt: row.created_at as number,
    }));
  }

  /** Map a SQLite row to a {@link RunRecord}. */
  private rowToRun(row: Record<string, unknown>): RunRecord {
    return {
      id: row.id as number,
      origin: row.origin as RunOrigin,
      taskKey: (row.task_key as string | null) ?? undefined,
      tracker: (row.tracker as string | null) ?? undefined,
      harness: (row.harness as string | null) ?? undefined,
      branch: (row.branch as string | null) ?? undefined,
      repo: (row.repo as string | null) ?? undefined,
      prNumber: (row.pr_number as number | null) ?? undefined,
      prUrl: (row.pr_url as string | null) ?? undefined,
      status: row.status as RunStatus,
      outcomeReason: (row.outcome_reason as string | null) ?? undefined,
      startedAt: row.started_at as number,
      finishedAt: (row.finished_at as number | null) ?? undefined,
      attempt: (row.attempt as number | null) ?? undefined,
      automationId: (row.automation_id as string | null) ?? undefined,
      ticketKey: (row.ticket_key as string | null) ?? undefined,
      ticketUrl: (row.ticket_url as string | null) ?? undefined,
      taskDescription: (row.task_description as string | null) ?? undefined,
    };
  }

  /** Close the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Module-level current-run context.
//
// Task processing is strictly sequential (CLI lock manager; webhook PQueue
// with concurrency 1), so a single ambient run id is safe and avoids
// threading a recorder through the deeply nested pipeline.
// ---------------------------------------------------------------------------

let currentStore: RunStore | null = null;
let currentRunId: number | null = null;

/** Log a recording failure without ever propagating it into the pipeline. */
function warnOnce(action: string, error: unknown): void {
  console.warn(`⚠️  Run recording (${action}) failed: ${(error as Error).message}`);
}

/**
 * Start recording a run. Replaces any dangling previous context.
 *
 * @param meta - Run origin and metadata
 */
export function beginRun(meta: RunMeta): void {
  try {
    currentStore ??= new RunStore();
    currentRunId = currentStore.createRun(meta);
  } catch (error) {
    currentRunId = null;
    warnOnce("begin", error);
  }
}

/**
 * Record a pipeline stage for the current run (no-op when no run is active).
 *
 * @param stage - Pipeline stage name
 * @param data - Stage outcome, summary, and optional structured detail
 */
export function recordRunStage(
  stage: RunStage,
  data: { status: StageStatus; summary?: string; detail?: unknown },
): void {
  if (currentStore === null || currentRunId === null) {
    return;
  }
  try {
    const detail = data.detail === undefined ? undefined : JSON.stringify(data.detail);
    currentStore.addStage(currentRunId, stage, data.status, data.summary, detail);
  } catch (error) {
    warnOnce(`stage:${stage}`, error);
  }
}

/**
 * Attach the created PR to the current run (no-op when no run is active).
 *
 * @param pr - Repo slug, PR number, and URL
 */
export function recordRunPr(pr: { repo?: string; prNumber?: number; url?: string }): void {
  if (currentStore === null || currentRunId === null) {
    return;
  }
  try {
    currentStore.setRunPr(currentRunId, pr);
  } catch (error) {
    warnOnce("pr", error);
  }
}

/**
 * Attach the originating tracker ticket to the current run (no-op when no run
 * is active). Used to snapshot the ticket's description once task details are
 * formatted, preserving what was asked even if the ticket changes later.
 *
 * @param ticket - Ticket key, web URL, and/or markdown description
 */
export function recordRunTicket(ticket: {
  key?: string;
  url?: string;
  description?: string;
}): void {
  if (currentStore === null || currentRunId === null) {
    return;
  }
  try {
    currentStore.setRunTicket(currentRunId, ticket);
  } catch (error) {
    warnOnce("ticket", error);
  }
}

/**
 * Finish the current run and clear the context (no-op when no run is active).
 *
 * @param status - Terminal status
 * @param reason - Optional human-readable reason
 */
export function endRun(status: Exclude<RunStatus, "in_progress">, reason?: string): void {
  if (currentStore === null || currentRunId === null) {
    return;
  }
  try {
    currentStore.finishRun(currentRunId, status, reason);
  } catch (error) {
    warnOnce("end", error);
  } finally {
    currentRunId = null;
  }
}
