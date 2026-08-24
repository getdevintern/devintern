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
import { extractAgentUsage, mergeAgentUsages } from "@devintern/agent-harness";
import type { AgentUsage, MergedAgentUsage } from "@devintern/agent-harness";
import { prepareQueueDbDirectory, resolveQueueDbPath } from "./webhook-queue";

export type RunOrigin = "task" | "pr_mention";

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
  /**
   * True when the run was started by the unattended worker (polling, relay,
   * webhook, mention, or workspace paths) rather than a manual CLI run.
   */
  unattended?: boolean;
}

/**
 * Normalized token/cost usage persisted with one run. Null means the
 * provider (or extraction) did not supply the value — never zero.
 */
export interface RunUsage {
  /** Where usage numbers came from ("mixed" when sessions disagree). */
  source: MergedAgentUsage["source"] | null;
  /** False when any session's accounting was partial or missing entirely. */
  complete: boolean;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  /** Known cost for the whole run in `costCurrency` (USD unless stated). */
  costUsd: number | null;
  costCurrency: string | null;
  /** Number of agent sessions attributable to this run. */
  sessionCount: number;
  /** Sessions that yielded no usage signal at all (unknown exposure). */
  sessionsWithoutUsage: number;
}

export interface RunRecord extends RunMeta {
  id: number;
  /** 1-based attempt number for the task (null-ish for pr_mention runs). */
  attempt?: number;
  prUrl?: string;
  status: RunStatus;
  outcomeReason?: string;
  startedAt: number;
  finishedAt?: number;
  usage?: RunUsage | null;
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
  /** Known spend for this harness in USD; null when no run reported cost. */
  spendUsd: number | null;
  /** Runs in this harness with usage but unknown cost (never counted as $0). */
  runsWithUnknownCost: number;
}

/** Aggregate token/cost usage over a stats window. */
export interface RunStatsUsage {
  /** Sum of known per-category tokens; categories never inferred. */
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  /** Known reported spend in USD; null when nothing is priced. */
  knownSpendUsd: number | null;
  currency: "USD";
  /** Runs with at least one usage-bearing session. */
  runsWithUsage: number;
  /** Terminal-ish runs without usage data (unknown exposure). */
  runsWithoutUsage: number;
  /** Runs whose sessions had partial accounting or unpriced models. */
  runsWithIncompleteUsage: number;
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
  usage: RunStatsUsage;
}

/** Statuses that no longer change (excluded: in_progress and deferred-for-retry). */
const TERMINAL_STATUSES: RunStatus[] = ["succeeded", "failed", "escalated", "abandoned"];

/**
 * Additive usage/cost columns, applied idempotently on every open. All are
 * nullable: historical rows (and runs whose harness reported nothing) keep
 * unknown usage rather than zeros.
 */
const USAGE_SCHEMA_MIGRATIONS: { column: string; decl: string }[] = [
  { column: "unattended", decl: "INTEGER" },
  { column: "usage_source", decl: "TEXT" },
  { column: "usage_complete", decl: "INTEGER" },
  { column: "model", decl: "TEXT" },
  { column: "input_tokens", decl: "INTEGER" },
  { column: "output_tokens", decl: "INTEGER" },
  { column: "cached_input_tokens", decl: "INTEGER" },
  { column: "reasoning_tokens", decl: "INTEGER" },
  { column: "total_tokens", decl: "INTEGER" },
  { column: "cost_usd", decl: "REAL" },
  { column: "cost_currency", decl: "TEXT" },
  { column: "session_count", decl: "INTEGER" },
  { column: "sessions_without_usage", decl: "INTEGER" },
];

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

/** Sum two optional numbers; null survives when both sides are null. */
function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return a + b;
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
        attempt INTEGER
      )
    `);

    // Additive migration for databases created before the attempt column.
    const columns = this.db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const hasColumn = (name: string): boolean => columns.some((c) => c.name === name);
    if (!hasColumn("attempt")) {
      this.db.run("ALTER TABLE runs ADD COLUMN attempt INTEGER");
    }

    // Additive usage/cost migration (DEV-78). Nullable columns keep
    // pre-migration rows readable with unknown (null) usage.
    for (const statement of USAGE_SCHEMA_MIGRATIONS) {
      if (!hasColumn(statement.column)) {
        this.db.run(`ALTER TABLE runs ADD COLUMN ${statement.column} ${statement.decl}`);
      }
    }

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
    const attempt = meta.taskKey ? this.countRuns(meta.taskKey) + 1 : null;
    const result = this.db.run(
      `INSERT INTO runs (origin, task_key, tracker, harness, branch, repo, pr_number, status, started_at, attempt, unattended)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)`,
      [
        meta.origin,
        meta.taskKey ?? null,
        meta.tracker ?? null,
        meta.harness ?? null,
        meta.branch ?? null,
        meta.repo ?? null,
        meta.prNumber ?? null,
        Date.now(),
        attempt,
        meta.unattended === true ? 1 : null,
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
   * Persist normalized token/cost usage for a run (one row per run; the
   * latest call wins). Null fields stay null — never coerced to zero.
   *
   * @param runId - Run id
   * @param usage - Merged usage across all sessions attributable to the run
   */
  recordRunUsage(runId: number, usage: RunUsage): void {
    this.db.run(
      `UPDATE runs SET
         usage_source = ?,
         usage_complete = ?,
         model = ?,
         input_tokens = ?,
         output_tokens = ?,
         cached_input_tokens = ?,
         reasoning_tokens = ?,
         total_tokens = ?,
         cost_usd = ?,
         cost_currency = ?,
         session_count = ?,
         sessions_without_usage = ?
       WHERE id = ?`,
      [
        usage.source ?? null,
        usage.complete === undefined ? null : usage.complete ? 1 : 0,
        usage.model ?? null,
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.cachedInputTokens ?? null,
        usage.reasoningTokens ?? null,
        usage.totalTokens ?? null,
        usage.costUsd ?? null,
        usage.costCurrency ?? null,
        usage.sessionCount ?? null,
        usage.sessionsWithoutUsage ?? null,
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
        `SELECT origin, harness, status, pr_url, started_at, finished_at,
                input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
                total_tokens, cost_usd, usage_complete, session_count
         FROM runs WHERE started_at >= ? ORDER BY started_at ASC`,
      )
      .all(since) as {
      origin: RunOrigin;
      harness: string | null;
      status: RunStatus;
      pr_url: string | null;
      started_at: number;
      finished_at: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_input_tokens: number | null;
      reasoning_tokens: number | null;
      total_tokens: number | null;
      cost_usd: number | null;
      usage_complete: number | null;
      session_count: number | null;
    }[];

    const byStatus: Record<RunStatus, number> = {
      in_progress: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      escalated: 0,
      abandoned: 0,
    };
    const byOrigin: Record<RunOrigin, number> = { task: 0, pr_mention: 0 };
    const weekCounts = new Map<string, number>();
    const harnesses = new Map<
      string,
      {
        runs: number;
        byStatus: Map<RunStatus, number>;
        durations: number[];
        spendUsd: number;
        pricedRuns: number;
        unknownCostRuns: number;
      }
    >();
    const durations: number[] = [];

    // Usage aggregation: known values sum; categories are never inferred.
    const tokens = {
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      cachedInputTokens: null as number | null,
      reasoningTokens: null as number | null,
      totalTokens: null as number | null,
    };
    let knownSpendUsd: number | null = null;
    let runsWithUsage = 0;
    let runsWithoutUsage = 0;
    let runsWithIncompleteUsage = 0;

    for (const row of rows) {
      byStatus[row.status] += 1;
      byOrigin[row.origin] += 1;

      const week = weekStartIso(row.started_at);
      weekCounts.set(week, (weekCounts.get(week) ?? 0) + 1);

      const harnessKey = row.harness ?? "unknown";
      let harness = harnesses.get(harnessKey);
      if (!harness) {
        harness = {
          runs: 0,
          byStatus: new Map(),
          durations: [],
          spendUsd: 0,
          pricedRuns: 0,
          unknownCostRuns: 0,
        };
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

      // --- per-run usage ---
      const hasUsage =
        row.session_count !== null &&
        row.session_count > 0 &&
        (row.input_tokens !== null ||
          row.output_tokens !== null ||
          row.total_tokens !== null ||
          row.cost_usd !== null);
      if (hasUsage) {
        runsWithUsage += 1;
      } else if (row.finished_at !== null) {
        runsWithoutUsage += 1;
      }
      if (hasUsage && row.usage_complete === 0) {
        runsWithIncompleteUsage += 1;
      }

      tokens.inputTokens = sumNullable(tokens.inputTokens, row.input_tokens);
      tokens.outputTokens = sumNullable(tokens.outputTokens, row.output_tokens);
      tokens.cachedInputTokens = sumNullable(tokens.cachedInputTokens, row.cached_input_tokens);
      tokens.reasoningTokens = sumNullable(tokens.reasoningTokens, row.reasoning_tokens);
      tokens.totalTokens = sumNullable(tokens.totalTokens, row.total_tokens);

      if (typeof row.cost_usd === "number") {
        knownSpendUsd = (knownSpendUsd ?? 0) + row.cost_usd;
        harness.spendUsd += row.cost_usd;
        harness.pricedRuns += 1;
      } else if (hasUsage) {
        // Usage without a computable cost is unknown exposure — never $0.
        harness.unknownCostRuns += 1;
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
          spendUsd: data.pricedRuns > 0 ? data.spendUsd : null,
          runsWithUnknownCost: data.unknownCostRuns,
        })),
      byOrigin,
      usage: {
        ...tokens,
        knownSpendUsd,
        currency: "USD",
        runsWithUsage,
        runsWithoutUsage,
        runsWithIncompleteUsage,
      },
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
    const usage = this.rowToUsage(row);
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
      unattended: row.unattended === 1 ? true : undefined,
      usage,
    };
  }

  /**
   * Map usage columns to a {@link RunUsage}. Rows from before the migration
   * have all-null columns and surface `usage: null` so the dashboard can
   * distinguish "no data" from zeros.
   */
  private rowToUsage(row: Record<string, unknown>): RunUsage | null {
    if (
      row.usage_source === undefined ||
      (row.session_count === null &&
        row.input_tokens === null &&
        row.output_tokens === null &&
        row.cost_usd === null)
    ) {
      return null;
    }
    return {
      source: (row.usage_source as RunUsage["source"] | null) ?? null,
      complete: row.usage_complete === 1,
      model: (row.model as string | null) ?? null,
      inputTokens: (row.input_tokens as number | null) ?? null,
      outputTokens: (row.output_tokens as number | null) ?? null,
      cachedInputTokens: (row.cached_input_tokens as number | null) ?? null,
      reasoningTokens: (row.reasoning_tokens as number | null) ?? null,
      totalTokens: (row.total_tokens as number | null) ?? null,
      costUsd: (row.cost_usd as number | null) ?? null,
      costCurrency: (row.cost_currency as string | null) ?? null,
      sessionCount: (row.session_count as number | null) ?? 0,
      sessionsWithoutUsage: (row.sessions_without_usage as number | null) ?? 0,
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
/** Agent sessions recorded for the current run (implementation, feasibility, reviews). */
let currentSessions: (AgentUsage | null)[] = [];

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
    currentSessions = [];
  } catch (error) {
    currentRunId = null;
    currentSessions = [];
    warnOnce("begin", error);
  }
}

/**
 * Attribute one finished agent session to the current run (best-effort).
 *
 * Called after every harness spawn in the pipeline — implementation,
 * feasibility, auto-review, change-request sessions. Usage is merged at
 * {@link endRun} time so multi-session runs record one normalized total
 * without double counting session artifacts.
 *
 * @param usage - Extracted usage, or `null` when the harness reported nothing
 */
export function recordAgentSession(usage: AgentUsage | null): void {
  if (currentStore === null || currentRunId === null) {
    return;
  }
  currentSessions.push(usage);
}

/**
 * Extract normalized usage from a finished session's captured output and
 * attribute it to the current run. Never throws — extraction/persistence
 * failures must not affect the agent run.
 *
 * @param harness - Harness id (e.g. "claude-code")
 * @param stdout - Captured session stdout
 * @param stderr - Captured session stderr
 */
export function recordSessionOutput(harness: string, stdout: string, stderr: string): void {
  if (currentStore === null || currentRunId === null) {
    return;
  }
  try {
    const usage = extractAgentUsage({ harness, stdout, stderr });
    currentSessions.push(usage);
  } catch {
    // Best-effort by contract.
  }
}

/**
 * Merge the run's agent-session usage into a persisted {@link RunUsage}.
 *
 * Cost rule: a run's cost is reported only when every agent session
 * properly reported its own provider-computed cost. Anything less stays
 * unknown — never estimated, never fabricated.
 */
function buildRunUsage(): RunUsage | null {
  if (currentSessions.length === 0) {
    return null;
  }
  const merged = mergeAgentUsages(currentSessions);
  if (!merged) {
    return null;
  }

  const allReportedCost =
    merged.sessionsWithoutUsage === 0 &&
    currentSessions.every((session) => session !== null && session.reportedCost !== null);
  const costUsd = allReportedCost ? merged.reportedCost : null;

  return {
    source: merged.source,
    complete: merged.complete && allReportedCost && !merged.mixedModels,
    model: merged.model,
    inputTokens: merged.inputTokens,
    outputTokens: merged.outputTokens,
    cachedInputTokens: merged.cachedInputTokens,
    reasoningTokens: merged.reasoningTokens,
    totalTokens: merged.totalTokens,
    costUsd,
    costCurrency: costUsd === null ? null : (merged.costCurrency ?? "USD"),
    sessionCount: merged.sessions,
    sessionsWithoutUsage: merged.sessionsWithoutUsage,
  };
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
 * Finish the current run and clear the context (no-op when no run is active).
 *
 * Usage from every session attributed to the run is merged and persisted
 * before the terminal status is written.
 *
 * @param status - Terminal status
 * @param reason - Optional human-readable reason
 */
export function endRun(status: Exclude<RunStatus, "in_progress">, reason?: string): void {
  if (currentStore === null || currentRunId === null) {
    currentSessions = [];
    return;
  }
  const usage = buildRunUsage();
  try {
    if (usage) {
      currentStore.recordRunUsage(currentRunId, usage);
    }
  } catch (error) {
    warnOnce("usage", error);
  }
  try {
    currentStore.finishRun(currentRunId, status, reason);
  } catch (error) {
    warnOnce("end", error);
  } finally {
    currentRunId = null;
    currentSessions = [];
  }
}

/** Test hook: drop the ambient recorder context between scenarios. */
export function resetRunRecorderForTests(): void {
  if (currentStore) {
    try {
      currentStore.close();
    } catch {
      // Already closed.
    }
  }
  currentStore = null;
  currentRunId = null;
  currentSessions = [];
}
