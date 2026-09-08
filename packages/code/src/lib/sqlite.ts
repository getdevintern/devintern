import type { Database } from "bun:sqlite";

/** Default wait before a contended SQLite write fails with `SQLITE_BUSY`. */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Configure one connection to the shared worker state database.
 *
 * `busy_timeout` is connection-local, so every reader and writer needs it.
 * WAL is persistent database state and is initialized only by writable
 * connections: readonly dashboard connections must never try to mutate the
 * database's journal mode. `synchronous` is also connection-local and only
 * affects writes performed by this connection.
 *
 * @param db - Newly opened SQLite connection
 * @param options - Whether the connection was opened readonly
 */
export function configureSqliteConnection(
  db: Database,
  options: { readonly?: boolean } = {},
): void {
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  if (options.readonly) {
    return;
  }
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
}
