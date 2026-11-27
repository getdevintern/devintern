/**
 * Existence and readability check for a read-only worker state database.
 *
 * `existsSync` is not enough on its own: it also returns false for EACCES and
 * EPERM (a wrong `--workspace`, a sandbox-denied state directory), which must
 * stay an error rather than look like an uninitialized worker.
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "fs";

import { configureSqliteConnection } from "../state/sqlite";

/**
 * Only a genuinely absent file is `missing`; every other read failure is
 * `unreadable`.
 */
export type DatabaseProbe =
  | { kind: "ok" }
  | { kind: "missing"; message: string }
  | { kind: "unreadable"; message: string };

/**
 * Confirm the state database exists and is readable without creating or
 * changing anything. A plain read-only open is used on purpose: unlike
 * `immutable=1` it still sees committed rows in the WAL, and SQLite falls back
 * to a private read-only wal-index when the `-shm` file cannot be written.
 *
 * @param dbPath - `state/queue.db` in the selected workspace
 */
export function probeDatabase(dbPath: string): DatabaseProbe {
  try {
    statSync(dbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "unreadable",
        message: `Cannot read the worker database at ${dbPath}: ${message}`,
      };
    }
    return {
      kind: "missing",
      message:
        `No worker database at ${dbPath}.\n` +
        "   The worker creates it on first start (`devintern worker`); pass --workspace\n" +
        "   or set DEVINTERN_WORKSPACE_DIR if the workspace lives elsewhere.",
    };
  }
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    configureSqliteConnection(db, { readonly: true });
    db.query("SELECT count(*) FROM sqlite_master").get();
    return { kind: "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // SQLite can read a WAL database from a read-only location only while its
    // `-wal`/`-shm` files exist (i.e. while the worker has it open).
    const hint = existsSync(`${dbPath}-wal`)
      ? ""
      : "\n   No -wal file exists next to it: if this directory is read-only (sandbox), SQLite\n" +
        "   cannot open the WAL database until the worker is running. Run the command\n" +
        "   outside the sandbox or start `devintern worker`.";
    return {
      kind: "unreadable",
      message: `Cannot read the worker database at ${dbPath}: ${message}${hint}`,
    };
  } finally {
    db?.close();
  }
}
