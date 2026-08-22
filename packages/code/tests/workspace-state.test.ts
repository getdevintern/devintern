import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import {
  createRepoRunLock,
  createWorkspaceLock,
  FleetActivityStore,
  openWorkspaceState,
} from "../src/lib/workspace/state";
import { WebhookQueue } from "../src/lib/webhook-queue";
import { WorkerState } from "../src/lib/worker-state";
import { RunStore } from "../src/lib/run-recorder";

describe("workspace state", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("openWorkspaceState creates the central DB and shares it across stores", () => {
    const state = openWorkspaceState(workspaceDir);
    try {
      expect(state.dbPath).toBe(join(workspaceDir, "state", "queue.db"));
      expect(existsSync(state.dbPath)).toBe(true);

      // Same DB serves worker cursors, dedupe queue, and routing skips.
      state.workerState.setCursor("jira", "2026-07-04T00:00:00Z");
      expect(state.workerState.getCursor("jira")?.cursorValue).toBe("2026-07-04T00:00:00Z");

      state.skips.record({
        taskKey: "BACK-12",
        reason: "ambiguous",
        candidates: ["backend", "frontend"],
        taskUpdated: "2026-07-04T10:00:00Z",
      });
      const skips = state.skips.list();
      expect(skips).toHaveLength(1);
      expect(skips[0].taskKey).toBe("BACK-12");
      expect(skips[0].reason).toBe("ambiguous");
      expect(skips[0].candidates).toEqual(["backend", "frontend"]);
      expect(skips[0].taskUpdated).toBe("2026-07-04T10:00:00Z");
    } finally {
      state.close();
    }
  });

  test("routing skips keep history and expose the latest per task", () => {
    const state = openWorkspaceState(workspaceDir);
    try {
      state.skips.record({ taskKey: "T-1", reason: "unrouted", candidates: [] });
      state.skips.record({
        taskKey: "T-1",
        reason: "ambiguous",
        candidates: ["a", "b"],
        taskUpdated: "2026-07-04T12:00:00Z",
      });
      state.skips.record({ taskKey: "T-2", reason: "unrouted", candidates: [] });

      expect(state.skips.list()).toHaveLength(3);
      const latest = state.skips.latestFor("T-1");
      expect(latest?.reason).toBe("ambiguous");
      expect(latest?.candidates).toEqual(["a", "b"]);
      expect(state.skips.latestFor("T-9")).toBeNull();
    } finally {
      state.close();
    }
  });

  test("workspace lock lives directly in the workspace dir and is exclusive", () => {
    const lock = createWorkspaceLock(workspaceDir);
    const acquired = lock.acquire();
    expect(acquired.success).toBe(true);
    expect(existsSync(join(workspaceDir, ".worker.lock"))).toBe(true);
    // No .devintern-code nesting inside the workspace home.
    expect(existsSync(join(workspaceDir, ".devintern-code"))).toBe(false);

    const second = createWorkspaceLock(workspaceDir).acquire();
    expect(second.success).toBe(false);

    lock.release();
    expect(existsSync(join(workspaceDir, ".worker.lock"))).toBe(false);
  });

  test("repo run locks are independent per repo", () => {
    const backend = createRepoRunLock("backend", workspaceDir);
    const frontend = createRepoRunLock("frontend", workspaceDir);

    expect(backend.acquire().success).toBe(true);
    // A second holder for the same repo is rejected...
    expect(createRepoRunLock("backend", workspaceDir).acquire().success).toBe(false);
    // ...while a different repo is unaffected.
    expect(frontend.acquire().success).toBe(true);

    expect(existsSync(join(workspaceDir, "locks", "backend.run.lock"))).toBe(true);

    backend.release();
    frontend.release();
    expect(createRepoRunLock("backend", workspaceDir).acquire().success).toBe(true);
  });
});

describe("fleet activity store", () => {
  let workspaceDir: string;
  let dbPath: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-act-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    dbPath = join(workspaceDir, "state", "queue.db");
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("save/latest round-trip the per-repo snapshot with aggregate fields", () => {
    const store = new FleetActivityStore(dbPath);
    expect(store.latest()).toBeNull();

    store.save({
      rows: [
        { repo: "backend", status: "running", label: "BACK-1", startedAt: 1234 },
        { repo: "frontend", status: "queued", label: "WEB-2" },
        { repo: "docs", status: "idle" },
      ],
      pid: process.pid,
      maxConcurrency: 4,
      parallel: true,
    });

    const report = store.latest()!;
    expect(report.stale).toBe(false);
    expect(report.pid).toBe(process.pid);
    expect(report.maxConcurrency).toBe(4);
    expect(report.parallel).toBe(true);
    expect(report.rows).toHaveLength(3);
    expect(report.rows[0]).toMatchObject({
      repo: "backend",
      status: "running",
      label: "BACK-1",
      startedAt: 1234,
      stale: false,
    });

    // A snapshot from a dead PID is flagged stale on every row.
    store.save({
      rows: [{ repo: "backend", status: "running", label: "BACK-9", startedAt: 5 }],
      pid: 999999999,
      maxConcurrency: 2,
      parallel: false,
    });
    const staleReport = store.latest()!;
    expect(staleReport.stale).toBe(true);
    expect(staleReport.rows[0].status).toBe("running");
    expect(staleReport.rows[0].stale).toBe(true);

    store.clear();
    expect(store.latest()).toBeNull();
    store.close();
  });

  test("readonly mode reads without creating anything and tolerates missing tables", () => {
    // DB file does not exist yet: opening readonly throws (caller degrades).
    expect(() => new FleetActivityStore(dbPath, { readonly: true })).toThrow();

    const writer = new FleetActivityStore(dbPath);
    writer.close();

    const reader = new FleetActivityStore(dbPath, { readonly: true });
    expect(reader.latest()).toBeNull(); // no rows yet
    reader.close();
  });
});

describe("central DB concurrency", () => {
  let workspaceDir: string;
  let dbPath: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    dbPath = join(workspaceDir, "state", "queue.db");
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("WAL is enabled on the shared database", () => {
    const state = openWorkspaceState(workspaceDir);
    try {
      state.queue.getStats(); // any query proves the connection works
      // journal_mode persists in the database header; verify via a fresh raw
      // connection that it reports WAL.
      const check = new Database(dbPath, { readonly: true });
      const mode = check.query("PRAGMA journal_mode").get() as { journal_mode?: string };
      check.close();
      expect(mode.journal_mode).toBe("wal");
    } finally {
      state.close();
    }
  });

  test("concurrent writers across stores do not lose records or fail with SQLITE_BUSY", async () => {
    const queue = new WebhookQueue({ dbPath });
    const workerState = new WorkerState(dbPath);
    const runs = new RunStore(dbPath);

    const REPOS = ["backend", "frontend", "api"];
    const WRITES_PER_REPO = 12;

    try {
      await Promise.all(
        REPOS.map(async (repo) =>
          Promise.all(
            Array.from({ length: WRITES_PER_REPO }, (_, i) =>
              Promise.resolve().then(() => {
                // Interleave writes across every store from each "repo
                // lane", mirroring parallel fleet execution.
                queue.markProcessed(`poll:${repo}`, `task:T-${i}`);
                workerState.setCursor(`cursor:${repo}`, String(i));
                const runId = runs.createRun({
                  origin: "task",
                  taskKey: `${repo.toUpperCase()}-${i}`,
                  repo,
                });
                runs.finishRun(runId, i % 2 === 0 ? "succeeded" : "failed");
              }),
            ),
          ),
        ),
      );

      // Every write landed exactly once: no lost rows, no SQLITE_BUSY.
      for (const repo of REPOS) {
        const cursor = workerState.getCursor(`cursor:${repo}`);
        // Concurrent same-source writers race; whichever lands last must be
        // one of the written values and the row must exist.
        expect(cursor).not.toBeNull();
        expect(Number(cursor!.cursorValue)).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < WRITES_PER_REPO; i++) {
          expect(queue.hasProcessed(`poll:${repo}`, `task:T-${i}`)).toBe(true);
        }
      }
      expect(runs.countFilteredRuns({})).toBe(REPOS.length * WRITES_PER_REPO);
    } finally {
      queue.close();
      workerState.close();
      runs.close();
    }
  });
});
