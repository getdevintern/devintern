/**
 * Schema and in-place migrations for the `injected_tasks` queue table (and the
 * pruned-outcome archive), applied whenever a writable `InjectedTaskStore`
 * opens its database.
 */

import type { Database } from "bun:sqlite";

/**
 * Add the durable auto-resume column to a legacy table.
 *
 * The injected-task DB is shared by the worker, the dashboard, and CLI
 * processes, so two first-upgrades can both observe the column missing and
 * race the `ALTER TABLE`. The loser sees SQLite's duplicate-column error,
 * which means the migration already applied and is safe to ignore; any other
 * failure (locked/corrupt DB) must still surface instead of leaving the store
 * half-migrated.
 */
export function addAutoResumeColumn(db: Database): void {
  try {
    db.run("ALTER TABLE injected_tasks ADD COLUMN auto_resume_count INTEGER NOT NULL DEFAULT 0");
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
}

/**
 * Add the durable child-pid column to a legacy table. Same race rule as
 * {@link addAutoResumeColumn}: a concurrent opener's duplicate-column error
 * means the migration already applied.
 */
export function addChildPidColumn(db: Database): void {
  try {
    db.run("ALTER TABLE injected_tasks ADD COLUMN child_pid INTEGER");
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
}

/**
 * Add the child start-time column to a legacy table. Same race rule as
 * {@link addAutoResumeColumn}.
 */
export function addChildStartedAtColumn(db: Database): void {
  try {
    db.run("ALTER TABLE injected_tasks ADD COLUMN child_started_at INTEGER");
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
}

/**
 * Add a column to a legacy table. Same race rule as
 * {@link addAutoResumeColumn}: a concurrent opener's duplicate-column error
 * means the migration already applied.
 */
function addColumnIfMissing(db: Database, ddl: string): void {
  try {
    db.run(`ALTER TABLE injected_tasks ADD COLUMN ${ddl}`);
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
}

/**
 * Create the injected-task tables and indexes, and add columns a legacy
 * database is missing. Safe to run concurrently from several processes.
 *
 * @param db - Writable connection to the workspace DB
 */
export function initInjectedTaskSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS injected_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key TEXT NOT NULL,
      repo TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      task_file TEXT NOT NULL,
      idempotency_key TEXT,
      actor TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      auto_resume_count INTEGER NOT NULL DEFAULT 0,
      child_pid INTEGER,
      child_started_at INTEGER,
      defer_count INTEGER NOT NULL DEFAULT 0,
      not_before INTEGER,
      depends_on TEXT,
      dependency_mode TEXT,
      dependency_state TEXT,
      dependency_reason TEXT,
      stacked_on TEXT,
      stack_base_sha TEXT,
      stack_notice TEXT,
      cancelled_by TEXT,
      cancel_reason TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS pruned_injected_task_outcomes (
      task_id INTEGER PRIMARY KEY,
      repo TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      archived_at INTEGER NOT NULL
    )
  `);
  // Older databases predate the durable auto-resume budget; add the column
  // in place instead of requiring a migration step.
  const columns = db.query("PRAGMA table_info(injected_tasks)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "auto_resume_count")) {
    addAutoResumeColumn(db);
  }
  if (!columns.some((column) => column.name === "child_pid")) {
    addChildPidColumn(db);
  }
  if (!columns.some((column) => column.name === "child_started_at")) {
    addChildStartedAtColumn(db);
  }
  if (!columns.some((column) => column.name === "defer_count")) {
    addColumnIfMissing(db, "defer_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "not_before")) {
    addColumnIfMissing(db, "not_before INTEGER");
  }
  for (const name of [
    "depends_on",
    "dependency_mode",
    "dependency_state",
    "dependency_reason",
    "stacked_on",
    "stack_base_sha",
    "stack_notice",
    "cancelled_by",
    "cancel_reason",
  ]) {
    if (!columns.some((column) => column.name === name)) {
      addColumnIfMissing(db, `${name} TEXT`);
    }
  }
  db.run("CREATE INDEX IF NOT EXISTS idx_injected_tasks_status ON injected_tasks(status)");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_injected_tasks_finished_at ON injected_tasks(finished_at)",
  );
  // `task_key` names the worktree/branch, so two rows sharing one key would
  // race the same checkout. Enforce uniqueness; `enqueueNewTask` re-derives a
  // suffixed key when a concurrent caller claims the key first.
  try {
    db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_injected_tasks_task_key ON injected_tasks(task_key)",
    );
  } catch {
    // A DB written before the constraint existed may already hold duplicate
    // keys; keep the store open (with a plain index) rather than fail closed.
    db.run("CREATE INDEX IF NOT EXISTS idx_injected_tasks_task_key ON injected_tasks(task_key)");
  }
  // A partial unique index lets any number of tasks run without an
  // idempotency key while still deduping the ones that carry one.
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_injected_tasks_idempotency
     ON injected_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );
}
