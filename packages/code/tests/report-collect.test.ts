import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectDiagnostics } from "../src/lib/report/collect";

let workdir: string;
let previousDb: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "report-collect-"));
  previousDb = process.env.WEBHOOK_QUEUE_DB;
});

afterEach(() => {
  if (previousDb === undefined) delete process.env.WEBHOOK_QUEUE_DB;
  else process.env.WEBHOOK_QUEUE_DB = previousDb;
  rmSync(workdir, { recursive: true, force: true });
});

function createRunDb(taskKey: string, reason: string): string {
  const dir = join(workdir, ".devintern-code");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "queue.db");
  const db = new Database(path);
  db.run(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT NOT NULL,
      task_key TEXT,
      tracker TEXT,
      harness TEXT,
      status TEXT NOT NULL,
      outcome_reason TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE run_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(
    `INSERT INTO runs (origin, task_key, tracker, harness, status, outcome_reason, started_at, finished_at)
     VALUES ('task', ?, 'jira', 'claude-code', 'escalated', ?, 1000, 2000)`,
    [taskKey, reason],
  );
  db.run(
    `INSERT INTO run_stages (run_id, stage, status, summary, created_at)
     VALUES (1, 'implementation', 'succeeded', 'implemented', 1100)`,
  );
  db.run(
    `INSERT INTO run_stages (run_id, stage, status, summary, created_at)
     VALUES (1, 'verify', 'escalated', ?, 1200)`,
    [reason],
  );
  db.close();
  return path;
}

describe("run diagnostics", () => {
  test("collects a failed run and redacts its task key by default", async () => {
    process.env.WEBHOOK_QUEUE_DB = createRunDb(
      "PROJ-123",
      "verify failed for PROJ-123 with ghp_abcdefghijklmnopqrstuvwxyz",
    );
    const collected = await collectDiagnostics({
      cwd: workdir,
      last: true,
      diagnostics: true,
      logs: false,
    });

    expect(collected.taskKey).toBe("PROJ-123");
    expect(collected.context?.run?.status).toBe("escalated");
    expect(collected.context?.run?.failedStep).toBe("verify");
    expect(collected.context?.run?.taskKey).toBeUndefined();
    const serialized = JSON.stringify(collected.context);
    expect(serialized).not.toContain("PROJ-123");
    expect(serialized).not.toContain("ghp_");
  });

  test("includes the task key only when identifiers are shared", async () => {
    process.env.WEBHOOK_QUEUE_DB = createRunDb("PROJ-456", "failed");
    const collected = await collectDiagnostics({
      cwd: workdir,
      last: true,
      diagnostics: true,
      logs: false,
      shareIdentifiers: true,
    });

    expect(collected.context?.run?.taskKey).toBe("PROJ-456");
    expect(collected.context?.run?.reason).toBe("failed");
  });
});
