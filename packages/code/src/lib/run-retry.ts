/**
 * Run retry
 *
 * The Support Dashboard's "retry this run" action. A retry re-invokes the same
 * underlying flow support would run by hand — `devintern <TASK> --force` — as
 * a detached subprocess of the dashboard server, so the CLI's own lock,
 * entitlement, and worktree handling apply unchanged.
 *
 * Every trigger is audited in the queue database (`run_retry_audit`): who
 * retried, when, and the original run id. Only retriable runs (failed,
 * escalated, or abandoned terminal states with a task key) may be retried;
 * succeeded/deferred runs and runs without a ticket are rejected up front.
 */

import { createDefaultSupabaseAuthConfig, getAuthenticatedUser } from "@devintern/auth";
import { Database } from "bun:sqlite";
import { basename, join } from "path";

import { resolveConfigDir } from "@devintern/utils";
import type { RunRecord, RunStatus } from "./run-recorder";
import { prepareQueueDbDirectory } from "./webhook-queue";

/** Terminal, non-success statuses a support engineer can re-run. */
export const RETRIABLE_RUN_STATUSES: readonly RunStatus[] = ["failed", "escalated", "abandoned"];

/** Why a run cannot currently be retried ("eligible" when it can). */
export interface RetryEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Whether a run is eligible for a dashboard retry.
 *
 * Eligible: a terminal failed/escalated/abandoned run that belongs to a task
 * key (there must be something to re-invoke the CLI with). `deferred` is not
 * eligible — the worker already scheduled its own retry; `in_progress` and
 * `succeeded` are never eligible; PR mentions and automations without a task
 * key have no CLI entry point to force.
 */
export function isRunRetriable(run: Pick<RunRecord, "status" | "taskKey">): RetryEligibility {
  if (!run.taskKey) {
    return { eligible: false, reason: "this run has no task key to re-run" };
  }
  if (RETRIABLE_RUN_STATUSES.includes(run.status)) {
    return { eligible: true };
  }
  switch (run.status) {
    case "succeeded":
      return { eligible: false, reason: "this run already succeeded" };
    case "in_progress":
      return { eligible: false, reason: "this run is still in progress" };
    case "deferred":
      return {
        eligible: false,
        reason: "this run is deferred and will be retried automatically",
      };
    default:
      return { eligible: false, reason: `runs in status "${run.status}" cannot be retried` };
  }
}

/** A parsed devintern sign-in session, reduced to what auditing needs. */
export interface RetryActor {
  email: string | null;
}

/**
 * Resolve the acting user from the CLI login session
 * (`.devintern-code/.auth-session.json`). Null when nobody is signed in or
 * the session can no longer be validated.
 */
export async function resolveDashboardActor(
  workingDir: string = process.cwd(),
): Promise<RetryActor | null> {
  try {
    const configDir = resolveConfigDir({
      configDirName: ".devintern-code",
      startDir: workingDir,
    });
    const user = await getAuthenticatedUser(
      createDefaultSupabaseAuthConfig(join(configDir, ".auth-session.json")),
    );
    return user ? { email: user.email } : null;
  } catch {
    // Auth infrastructure unavailable (offline, corrupt session) — treat as
    // signed out; the handler surfaces a sign-in hint.
    return null;
  }
}

/** One audited retry attempt against an original run. */
export interface RunRetryAuditEntry {
  id: number;
  runId: number;
  taskKey?: string;
  actor: string;
  action: "triggered" | "failed";
  command?: string;
  pid?: number;
  message?: string;
  createdAt: number;
}

interface AuditRow {
  id: number;
  run_id: number;
  task_key: string | null;
  actor: string;
  action: string;
  command: string | null;
  pid: number | null;
  message: string | null;
  created_at: number;
}

function rowToEntry(row: AuditRow): RunRetryAuditEntry {
  return {
    id: row.id,
    runId: row.run_id,
    taskKey: row.task_key ?? undefined,
    actor: row.actor,
    action: row.action === "failed" ? "failed" : "triggered",
    command: row.command ?? undefined,
    pid: row.pid ?? undefined,
    message: row.message ?? undefined,
    createdAt: row.created_at,
  };
}

const MAX_AUDIT_ROWS = 200;

/**
 * SQLite-backed audit trail for dashboard retries, stored alongside the rest
 * of the worker state in `queue.db`. Opened read-write and lazily: reads fall
 * back to an empty trail while the table does not exist yet.
 */
export class RunRetryAuditStore {
  private db: Database | null = null;

  constructor(private dbPath: string) {}

  private ensureDb(): Database {
    if (this.db) {
      return this.db;
    }
    prepareQueueDbDirectory(this.dbPath);
    this.db = new Database(this.dbPath);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS run_retry_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        task_key TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        command TEXT,
        pid INTEGER,
        message TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_run_retry_audit_run_id ON run_retry_audit(run_id)");
    return this.db;
  }

  /** Record one retry trigger (or spawn failure). */
  record(entry: Omit<RunRetryAuditEntry, "id" | "createdAt"> & { createdAt?: number }): void {
    const db = this.ensureDb();
    db.run(
      `INSERT INTO run_retry_audit (run_id, task_key, actor, action, command, pid, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.runId,
        entry.taskKey ?? null,
        entry.actor,
        entry.action,
        entry.command ?? null,
        entry.pid ?? null,
        entry.message ?? null,
        entry.createdAt ?? Date.now(),
      ],
    );
  }

  /** List recent retries for a run, most recent first. */
  listForRun(runId: number): RunRetryAuditEntry[] {
    // Read through a transient read-only connection when nothing has been
    // written from this process yet; do not cache it, or a later write would
    // fail against the read-only handle.
    let tempDb: Database | null = null;
    try {
      if (this.db === null) {
        tempDb = this.openReadonly();
      }
      const db = this.db ?? tempDb;
      if (!db) {
        return [];
      }
      const rows = db
        .query(
          `SELECT * FROM run_retry_audit WHERE run_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ${MAX_AUDIT_ROWS}`,
        )
        .all(runId) as AuditRow[];
      return rows.map(rowToEntry);
    } catch {
      // Missing DB file or table (DB created by an older version).
      return [];
    } finally {
      tempDb?.close();
    }
  }

  private openReadonly(): Database {
    const conn = new Database(this.dbPath, { readonly: true });
    conn.run("PRAGMA busy_timeout = 5000");
    return conn;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export interface SpawnedRetryProcess {
  pid?: number;
  /** Human-readable command line used for the audit log. */
  command: string;
}

/**
 * Spawn `devintern <taskKey> --force` — the exact flow a support engineer
 * runs from the CLI to bypass the retry gate — using the same interpreter and
 * entry script that serve the dashboard. Detached so the HTTP response does
 * not wait for a full agent run; the spawned CLI records its own new run.
 */
export function spawnCliForceRetry(options: {
  taskKey: string;
  workingDir: string;
}): SpawnedRetryProcess {
  const script = process.argv[1];
  if (!script) {
    throw new Error("could not determine the devintern entry point to invoke");
  }
  const args = [script, options.taskKey, "--force"];
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: options.workingDir,
    env: process.env,
    // Outlive the dashboard request/process so long agent runs survive.
    detached: true,
  });
  child.unref();
  const command = `${basename(process.execPath)} devintern ${options.taskKey} --force`;
  return { pid: child.pid, command };
}
