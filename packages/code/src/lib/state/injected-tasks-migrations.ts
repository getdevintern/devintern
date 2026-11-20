/** Idempotent column migrations for legacy `injected_tasks` tables. */

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
export function addColumnIfMissing(db: Database, ddl: string): void {
  try {
    db.run(`ALTER TABLE injected_tasks ADD COLUMN ${ddl}`);
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
}
