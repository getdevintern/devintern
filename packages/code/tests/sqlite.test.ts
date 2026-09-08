import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { configureSqliteConnection, SQLITE_BUSY_TIMEOUT_MS } from "../src/lib/sqlite";

describe("configureSqliteConnection", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enables WAL and NORMAL synchronous mode for writable connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-sqlite-"));
    tempDirs.push(dir);
    const db = new Database(join(dir, "state.db"));
    try {
      configureSqliteConnection(db);

      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
      expect(db.query("PRAGMA busy_timeout").get()).toEqual({
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      });
    } finally {
      db.close();
    }
  });

  test("configures readonly connections without trying to change database state", () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-sqlite-readonly-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.db");
    const writer = new Database(dbPath);
    configureSqliteConnection(writer);
    writer.run("CREATE TABLE state (id INTEGER PRIMARY KEY)");
    writer.close();

    const reader = new Database(dbPath, { readonly: true });
    try {
      configureSqliteConnection(reader, { readonly: true });
      expect(reader.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(reader.query("PRAGMA busy_timeout").get()).toEqual({
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      });
    } finally {
      reader.close();
    }
  });
});
