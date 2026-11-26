/**
 * `runs` / `run_stages` schema and its additive migrations (see
 * `run-recorder.ts`). Idempotent: every column added after the first release
 * is added only when missing.
 */

import type { Database } from "bun:sqlite";

import { initRunOutputsSchema } from "./run-outputs";

/**
 * Create the run-record tables, indexes, and missing columns.
 *
 * @param db - Writable queue-database connection
 */
export function initRunsSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT NOT NULL,
      task_key TEXT,
      tracker TEXT,
      team TEXT,
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
      task_description TEXT,
      queue_claim TEXT,
      clean_stop INTEGER NOT NULL DEFAULT 0,
      pr_failure TEXT,
      outcome_class TEXT,
      failure_stage TEXT,
      failure_cause TEXT,
      work_status TEXT,
      work_ref TEXT
    )
  `);

  // Additive migration for databases created before the attempt column.
  const columns = db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "attempt")) {
    db.run("ALTER TABLE runs ADD COLUMN attempt INTEGER");
  }
  if (!columns.some((c) => c.name === "team")) {
    db.run("ALTER TABLE runs ADD COLUMN team TEXT");
  }
  if (!columns.some((c) => c.name === "automation_id")) {
    db.run("ALTER TABLE runs ADD COLUMN automation_id TEXT");
  }
  if (!columns.some((c) => c.name === "ticket_key")) {
    db.run("ALTER TABLE runs ADD COLUMN ticket_key TEXT");
  }
  if (!columns.some((c) => c.name === "ticket_url")) {
    db.run("ALTER TABLE runs ADD COLUMN ticket_url TEXT");
  }
  if (!columns.some((c) => c.name === "task_description")) {
    db.run("ALTER TABLE runs ADD COLUMN task_description TEXT");
  }
  if (!columns.some((c) => c.name === "clean_stop")) {
    db.run("ALTER TABLE runs ADD COLUMN clean_stop INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((c) => c.name === "step")) {
    db.run("ALTER TABLE runs ADD COLUMN step TEXT");
  }
  if (!columns.some((c) => c.name === "step_started_at")) {
    db.run("ALTER TABLE runs ADD COLUMN step_started_at INTEGER");
  }
  if (!columns.some((c) => c.name === "step_active")) {
    db.run("ALTER TABLE runs ADD COLUMN step_active INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((c) => c.name === "queue_claim")) {
    db.run("ALTER TABLE runs ADD COLUMN queue_claim TEXT");
  }
  if (!columns.some((c) => c.name === "pr_failure")) {
    db.run("ALTER TABLE runs ADD COLUMN pr_failure TEXT");
  }
  if (!columns.some((c) => c.name === "outcome_class")) {
    db.transaction(() => {
      db.run("ALTER TABLE runs ADD COLUMN outcome_class TEXT");
      // One-time best-effort backfill: an escalated auto-merge run is the
      // merge gate holding a PR for a human, never a breakage. Everything
      // else recorded before classification stays unclassified.
      db.run(
        `UPDATE runs SET outcome_class = 'review_hold'
         WHERE status = 'escalated' AND origin = 'auto_merge'`,
      );
    })();
  }
  for (const column of ["failure_stage", "failure_cause", "work_status", "work_ref"]) {
    if (!columns.some((c) => c.name === column)) {
      db.run(`ALTER TABLE runs ADD COLUMN ${column} TEXT`);
    }
  }
  // Not unique: one queue claim can produce several runs when the worker changes harnesses.
  db.run("CREATE INDEX IF NOT EXISTS idx_runs_queue_claim ON runs(queue_claim)");
  db.run("CREATE INDEX IF NOT EXISTS idx_runs_automation_id ON runs(automation_id)");

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_runs_task_key ON runs(task_key)
  `);

  db.run(`
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

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_run_stages_run_id ON run_stages(run_id)
  `);
  initRunOutputsSchema(db);
}
