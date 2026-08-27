/**
 * Coordination state for multi-repo (coordinated) task runs.
 *
 * One coordinated effort gets a stable `coordination_id`, one row in
 * `coordinations` (the parent effort, carrying the validated plan), and one
 * row per planned repository in `coordination_runs`. Rows persist every
 * state transition and external side effect (branch pushed, PR URL known)
 * immediately, so an interrupted run resumes from the database without
 * recreating completed branches or duplicating PRs.
 *
 * The store lives in the central workspace SQLite database next to the
 * existing queue/worker/run stores. Both tables are new and additive — no
 * schema of an older version is modified. Per-repository pipeline runs also
 * carry `coordination_id` on the shared `runs` table (additive column in
 * `RunStore`), which is how the dashboard groups a whole effort.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

import type { MultiRepoPlan } from "./plan";

/** Lifecycle of the parent coordinated effort. */
export type CoordinationStatus =
  | "in_progress"
  | "completed" // every planned repo succeeded or was legitimately skipped
  | "partial_failure" // at least one repo failed/blocked; resumable
  | "planning_failed"; // planner could not produce an executable plan

/**
 * Lifecycle of one per-repository run inside a coordinated effort.
 *
 * `blocked` marks a dependent whose prerequisite failed; it is never
 * executed automatically and becomes runnable again on resume once its
 * prerequisites succeed.
 */
export type CoordinationRunStatus =
  | "pending"
  | "in_progress"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked";

export interface CoordinationRecord {
  coordinationId: string;
  taskKey: string;
  tracker?: string;
  status: CoordinationStatus;
  /** The validated {@link MultiRepoPlan} (JSON). */
  plan: MultiRepoPlan | null;
  /** Id of the parent effort's own row in the shared `runs` table. */
  parentRunId?: number;
  /** When sibling-PR reconciliation last succeeded (null = pending/failed). */
  reconciledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoordinationRunRecord {
  id: number;
  coordinationId: string;
  repo: string;
  status: CoordinationRunStatus;
  branch?: string;
  /** GitHub `owner/repo` slug the PR lives in (persisted at harvest time). */
  repoSlug?: string;
  prUrl?: string;
  prNumber?: number;
  dependencies: string[];
  rationale?: string;
  changeSummary?: string;
  /** Why a repo was skipped (e.g. no required diff) or blocked. */
  reason?: string;
  /** Id of the pipeline run in the shared `runs` table, when it ran. */
  runId?: number;
  createdAt: number;
  updatedAt: number;
}

/** Fields that may be updated on a coordination run row (`null` clears). */
export interface CoordinationRunPatch {
  status?: CoordinationRunStatus;
  branch?: string;
  repoSlug?: string;
  prUrl?: string;
  prNumber?: number;
  reason?: string | null;
  runId?: number;
}

/**
 * SQLite-backed store for coordinated efforts.
 *
 * @param dbPath - Database path (the central workspace queue DB).
 * @param options - `readonly` opens the DB without creating dirs/tables
 *   (dashboard reads alongside a live worker; throws when the file is
 *   missing, mirroring the other stores' behavior).
 */
export class CoordinationStore {
  private db: Database;

  constructor(dbPath: string, options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      this.db = new Database(dbPath, { readonly: true });
      this.db.run("PRAGMA busy_timeout = 5000");
      return;
    }

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS coordinations (
        coordination_id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL,
        tracker TEXT,
        status TEXT NOT NULL DEFAULT 'in_progress',
        plan TEXT,
        reconciled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // Additive migrations for databases created before these columns existed.
    const columns = this.db.query("PRAGMA table_info(coordinations)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((c) => c.name === "reconciled_at")) {
      this.db.run("ALTER TABLE coordinations ADD COLUMN reconciled_at INTEGER");
    }
    if (!columns.some((c) => c.name === "parent_run_id")) {
      this.db.run("ALTER TABLE coordinations ADD COLUMN parent_run_id INTEGER");
    }
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_coordinations_task ON coordinations(task_key)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS coordination_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coordination_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        branch TEXT,
        repo_slug TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        depends_on TEXT NOT NULL DEFAULT '[]',
        rationale TEXT,
        change_summary TEXT,
        reason TEXT,
        run_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(coordination_id, repo)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_coordination_runs_coord ON coordination_runs(coordination_id)
    `);
  }

  /**
   * Insert the parent effort row if absent (idempotent for resume).
   *
   * @returns True when a new row was created.
   */
  ensureCoordination(meta: {
    coordinationId: string;
    taskKey: string;
    tracker?: string;
    plan: MultiRepoPlan;
  }): boolean {
    const now = Date.now();
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO coordinations
           (coordination_id, task_key, tracker, status, plan, created_at, updated_at)
         VALUES (?, ?, ?, 'in_progress', ?, ?, ?)`,
      )
      .run(
        meta.coordinationId,
        meta.taskKey,
        meta.tracker ?? null,
        JSON.stringify(meta.plan),
        now,
        now,
      );
    return Number(result.changes) > 0;
  }

  /** Transition the parent effort's status. */
  setCoordinationStatus(coordinationId: string, status: CoordinationStatus): void {
    this.db
      .query(`UPDATE coordinations SET status = ?, updated_at = ? WHERE coordination_id = ?`)
      .run(status, Date.now(), coordinationId);
  }

  /** Mark sibling-PR reconciliation as completed (or reset it to retry). */
  markReconciled(coordinationId: string, reconciled: boolean): void {
    this.db
      .query(`UPDATE coordinations SET reconciled_at = ?, updated_at = ? WHERE coordination_id = ?`)
      .run(reconciled ? Date.now() : null, Date.now(), coordinationId);
  }

  /** Link the parent effort to its own row in the shared `runs` table. */
  setParentRunId(coordinationId: string, runId: number): void {
    this.db
      .query(`UPDATE coordinations SET parent_run_id = ?, updated_at = ? WHERE coordination_id = ?`)
      .run(runId, Date.now(), coordinationId);
  }

  /** Load one coordinated effort by ID, or null. */
  getCoordination(coordinationId: string): CoordinationRecord | null {
    const row = this.db
      .query(`SELECT * FROM coordinations WHERE coordination_id = ?`)
      .get(coordinationId) as Record<string, unknown> | null;
    return row ? this.rowToCoordination(row) : null;
  }

  /** Most recent coordinated effort for a task (resume lookups), or null. */
  latestForTask(taskKey: string): CoordinationRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM coordinations WHERE task_key = ?
         ORDER BY created_at DESC, coordination_id DESC LIMIT 1`,
      )
      .get(taskKey) as Record<string, unknown> | null;
    return row ? this.rowToCoordination(row) : null;
  }

  /** Insert per-repo rows for a plan; existing rows are kept (resume-safe). */
  ensureRuns(plan: MultiRepoPlan): void {
    const now = Date.now();
    const insert = this.db.query(
      `INSERT OR IGNORE INTO coordination_runs
         (coordination_id, repo, status, depends_on, rationale, change_summary, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    );
    for (const entry of plan.entries) {
      insert.run(
        plan.coordinationId,
        entry.repo,
        JSON.stringify(entry.dependencies),
        entry.rationale || null,
        entry.change || null,
        now,
        now,
      );
    }
  }

  /** Apply a partial update to one per-repo run row (no-op when absent). */
  patchRun(coordinationId: string, repo: string, patch: CoordinationRunPatch): void {
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [Date.now()];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.branch !== undefined) {
      sets.push("branch = ?");
      params.push(patch.branch);
    }
    if (patch.repoSlug !== undefined) {
      sets.push("repo_slug = ?");
      params.push(patch.repoSlug);
    }
    if (patch.prUrl !== undefined) {
      sets.push("pr_url = ?");
      params.push(patch.prUrl);
    }
    if (patch.prNumber !== undefined) {
      sets.push("pr_number = ?");
      params.push(patch.prNumber);
    }
    if (patch.reason !== undefined) {
      sets.push("reason = ?");
      params.push(patch.reason);
    }
    if (patch.runId !== undefined) {
      sets.push("run_id = ?");
      params.push(patch.runId);
    }
    params.push(coordinationId, repo);
    this.db
      .query(
        `UPDATE coordination_runs SET ${sets.join(", ")}
         WHERE coordination_id = ? AND repo = ?`,
      )
      .run(...params);
  }

  /** All per-repo run rows for an effort, in deterministic plan order when a plan exists. */
  listRuns(coordinationId: string): CoordinationRunRecord[] {
    const rows = this.db
      .query(`SELECT * FROM coordination_runs WHERE coordination_id = ? ORDER BY id ASC`)
      .all(coordinationId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRun(row));
  }

  /** One per-repo run row, or null. */
  getRun(coordinationId: string, repo: string): CoordinationRunRecord | null {
    const row = this.db
      .query(`SELECT * FROM coordination_runs WHERE coordination_id = ? AND repo = ?`)
      .get(coordinationId, repo) as Record<string, unknown> | null;
    return row ? this.rowToRun(row) : null;
  }

  /** List coordinated efforts, newest first (dashboard). */
  listCoordinations(limit = 50): CoordinationRecord[] {
    const rows = this.db
      .query(`SELECT * FROM coordinations ORDER BY created_at DESC, coordination_id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToCoordination(row));
  }

  private rowToCoordination(row: Record<string, unknown>): CoordinationRecord {
    return {
      coordinationId: row.coordination_id as string,
      taskKey: row.task_key as string,
      tracker: (row.tracker as string | null) ?? undefined,
      status: row.status as CoordinationStatus,
      plan: row.plan ? (JSON.parse(row.plan as string) as MultiRepoPlan) : null,
      parentRunId: (row.parent_run_id as number | null) ?? undefined,
      reconciledAt: (row.reconciled_at as number | null) ?? undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToRun(row: Record<string, unknown>): CoordinationRunRecord {
    return {
      id: row.id as number,
      coordinationId: row.coordination_id as string,
      repo: row.repo as string,
      status: row.status as CoordinationRunStatus,
      branch: (row.branch as string | null) ?? undefined,
      repoSlug: (row.repo_slug as string | null) ?? undefined,
      prUrl: (row.pr_url as string | null) ?? undefined,
      prNumber: (row.pr_number as number | null) ?? undefined,
      dependencies: JSON.parse((row.depends_on as string) ?? "[]") as string[],
      rationale: (row.rationale as string | null) ?? undefined,
      changeSummary: (row.change_summary as string | null) ?? undefined,
      reason: (row.reason as string | null) ?? undefined,
      runId: (row.run_id as number | null) ?? undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  close(): void {
    this.db.close();
  }
}
