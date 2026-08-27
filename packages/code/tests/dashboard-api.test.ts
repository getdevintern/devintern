import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  DashboardData,
  handleRuns,
  handleRunDetail,
  handleStats,
  handleWorkerStatus,
} from "../src/lib/dashboard-api";
import { RunStore } from "../src/lib/run-recorder";
import type { RunStats } from "../src/lib/run-recorder";
import { WebhookQueue } from "../src/lib/webhook-queue";
import { WorkerState } from "../src/lib/worker-state";
import { startDashboardServer } from "../src/dashboard-server";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("dashboard API", () => {
  let dir: string;
  let dbPath: string;
  let data: DashboardData;

  beforeEach(() => {
    dir = join(tmpdir(), `dash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    data = new DashboardData({ dbPath, workingDir: dir });
  });

  afterEach(() => {
    data.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed a finished run and return its id. */
  function seedRun(
    store: RunStore,
    options: {
      taskKey?: string;
      origin?: "task" | "pr_mention" | "scheduled";
      harness?: string;
      status?: "succeeded" | "failed" | "escalated" | "abandoned" | "deferred";
      prUrl?: string;
    } = {},
  ): number {
    const id = store.createRun({
      origin: options.origin ?? "task",
      taskKey: options.taskKey,
      tracker: "jira",
      harness: options.harness ?? "claude-code",
    });
    if (options.prUrl) {
      store.setRunPr(id, { url: options.prUrl });
    }
    if (options.status) {
      store.finishRun(id, options.status);
    }
    return id;
  }

  test("handleRuns paginates and filters", () => {
    const store = new RunStore(dbPath);
    seedRun(store, { taskKey: "PROJ-1", status: "succeeded" });
    seedRun(store, { taskKey: "PROJ-2", status: "failed" });
    seedRun(store, { origin: "pr_mention", status: "succeeded" });
    seedRun(store, { origin: "scheduled", status: "succeeded" });
    store.close();

    const all = handleRuns(data, new URLSearchParams());
    expect(all.status).toBe(200);
    expect((all.body as { total: number }).total).toBe(4);

    const paged = handleRuns(data, new URLSearchParams("limit=2&offset=2"));
    expect((paged.body as { runs: unknown[] }).runs.length).toBe(2);
    expect((paged.body as { total: number }).total).toBe(4);

    const failed = handleRuns(data, new URLSearchParams("status=failed"));
    const failedBody = failed.body as { runs: { taskKey?: string }[]; total: number };
    expect(failedBody.total).toBe(1);
    expect(failedBody.runs[0].taskKey).toBe("PROJ-2");

    const mentions = handleRuns(data, new URLSearchParams("origin=pr_mention"));
    expect((mentions.body as { total: number }).total).toBe(1);

    const scheduled = handleRuns(data, new URLSearchParams("origin=scheduled"));
    expect((scheduled.body as { total: number }).total).toBe(1);

    const byKey = handleRuns(data, new URLSearchParams("taskKey=PROJ-1"));
    expect((byKey.body as { total: number }).total).toBe(1);
  });

  test("handleRuns rejects invalid params", () => {
    expect(handleRuns(data, new URLSearchParams("limit=0")).status).toBe(400);
    expect(handleRuns(data, new URLSearchParams("limit=9999")).status).toBe(400);
    expect(handleRuns(data, new URLSearchParams("offset=-1")).status).toBe(400);
    expect(handleRuns(data, new URLSearchParams("status=bogus")).status).toBe(400);
    expect(handleRuns(data, new URLSearchParams("origin=bogus")).status).toBe(400);
  });

  test("handleRuns omits stage detail blobs (list is run rows only)", () => {
    const store = new RunStore(dbPath);
    const id = seedRun(store, { taskKey: "PROJ-1" });
    store.addStage(id, "implementation", "succeeded", "did things", '{"huge":"blob"}');
    store.close();

    const response = handleRuns(data, new URLSearchParams());
    const body = response.body as { runs: Record<string, unknown>[] };
    expect(body.runs[0].detail).toBeUndefined();
    expect(body.runs[0].stages).toBeUndefined();
  });

  test("handleRunDetail returns run with stages in order, 404 when absent", () => {
    const store = new RunStore(dbPath);
    const id = seedRun(store, { taskKey: "PROJ-1" });
    store.addStage(id, "feasibility", "succeeded", "clear enough");
    store.addStage(id, "implementation", "succeeded", "implemented", '{"files":3}');
    store.finishRun(id, "succeeded");
    store.close();

    const response = handleRunDetail(data, String(id));
    expect(response.status).toBe(200);
    const body = response.body as {
      run: { taskKey?: string };
      stages: { stage: string; detail?: string }[];
    };
    expect(body.run.taskKey).toBe("PROJ-1");
    expect(body.stages.map((s) => s.stage)).toEqual(["feasibility", "implementation", "outcome"]);
    expect(body.stages[1].detail).toBe('{"files":3}');

    expect(handleRunDetail(data, "99999").status).toBe(404);
    expect(handleRunDetail(data, "abc").status).toBe(400);
  });

  test("handleStats computes rates over terminal runs only", () => {
    const store = new RunStore(dbPath);
    seedRun(store, { status: "succeeded", prUrl: "https://github.com/a/b/pull/1" });
    seedRun(store, { status: "succeeded", prUrl: "https://github.com/a/b/pull/2" });
    seedRun(store, { status: "failed" });
    seedRun(store, { status: "escalated" });
    seedRun(store, { status: "deferred" }); // excluded from rate denominators
    seedRun(store, {}); // in_progress — excluded from rate denominators
    store.close();

    const response = handleStats(data, new URLSearchParams("window=7d"));
    expect(response.status).toBe(200);
    const body = response.body as { window: string; stats: RunStats };
    expect(body.window).toBe("7d");
    expect(body.stats.totals.runs).toBe(6);
    expect(body.stats.totals.byStatus.succeeded).toBe(2);
    expect(body.stats.successRate).toBeCloseTo(2 / 4);
    expect(body.stats.escalationRate).toBeCloseTo(1 / 4);
    expect(body.stats.byOrigin.task).toBe(6);
    expect(body.stats.medianDurationMs).not.toBeNull();
    expect(body.stats.runsPerWeek.length).toBe(1);
    expect(body.stats.runsPerWeek[0].count).toBe(6);

    const harness = body.stats.byHarness.find((h) => h.harness === "claude-code");
    expect(harness?.runs).toBe(6);
    expect(harness?.succeeded).toBe(2);
    expect(harness?.failed).toBe(1);
    expect(harness?.escalated).toBe(1);
  });

  test("handleStats respects the window and rejects invalid ones", () => {
    const store = new RunStore(dbPath);
    const oldId = seedRun(store, { status: "succeeded" });
    // Age the run out of the 7d window.
    // @ts-expect-error - accessing private db for test fixture aging
    store.db.run(`UPDATE runs SET started_at = ? WHERE id = ?`, [Date.now() - 2 * WEEK_MS, oldId]);
    store.close();

    const week = handleStats(data, new URLSearchParams("window=7d"));
    expect((week.body as { stats: RunStats }).stats.totals.runs).toBe(0);

    const all = handleStats(data, new URLSearchParams("window=all"));
    expect((all.body as { stats: RunStats }).stats.totals.runs).toBe(1);

    expect(handleStats(data, new URLSearchParams("window=1y")).status).toBe(400);
  });

  test("handleWorkerStatus reports lock, queue, agent PRs, and cursors", () => {
    const state = new WorkerState(dbPath);
    state.recordAgentPr({ repo: "acme/webapp", prNumber: 7 });
    state.recordAgentPr({ repo: "acme/webapp", prNumber: 8 });
    state.markAgentPrClosed("acme/webapp", 8);
    state.setCursor("jira", "2026-07-01T00:00:00Z");
    state.close();
    const queue = new WebhookQueue({ dbPath });
    queue.enqueue("issue_comment", { hello: true });
    queue.close();

    // Live worker lock (this test process's pid).
    const configDir = join(dir, ".devintern-code");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const response = handleWorkerStatus(data);
    const body = response.body as {
      worker: { running: boolean; pid: number } | null;
      queue: { pending: number };
      agentPrs: { open: number; closed: number };
      cursors: { source: string }[];
      dbMissing: boolean;
    };
    expect(body.worker?.running).toBe(true);
    expect(body.worker?.pid).toBe(process.pid);
    expect(body.queue.pending).toBe(1);
    expect(body.agentPrs).toEqual({ open: 1, closed: 1 });
    expect(body.cursors.map((c) => c.source)).toEqual(["jira"]);
    expect(body.dbMissing).toBe(false);

    // Dead pid → not running.
    writeFileSync(
      join(configDir, ".worker.lock"),
      JSON.stringify({ pid: 999999999, timestamp: new Date().toISOString() }),
    );
    const dead = handleWorkerStatus(data);
    expect((dead.body as { worker: { running: boolean } }).worker.running).toBe(false);
  });

  test("worker status without a lock file reports no worker", () => {
    // Give the empty-DB path something to read gracefully too.
    const response = handleWorkerStatus(data);
    const body = response.body as { worker: unknown; dbMissing: boolean };
    expect(body.worker).toBeNull();
    expect(body.dbMissing).toBe(true);
  });

  test("all handlers return empty states when the DB does not exist", () => {
    const runs = handleRuns(data, new URLSearchParams());
    expect(runs.status).toBe(200);
    expect(runs.body).toEqual({ runs: [], total: 0 });

    expect(handleRunDetail(data, "1").status).toBe(404);

    const stats = handleStats(data, new URLSearchParams());
    expect(stats.status).toBe(200);
    expect((stats.body as { stats: RunStats | null }).stats).toBeNull();
  });

  test("data source picks up a DB created after the first request", () => {
    expect((handleRuns(data, new URLSearchParams()).body as { total: number }).total).toBe(0);

    const store = new RunStore(dbPath);
    seedRun(store, { taskKey: "PROJ-9", status: "succeeded" });
    store.close();

    expect((handleRuns(data, new URLSearchParams()).body as { total: number }).total).toBe(1);
  });
});

describe("dashboard server", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `dash-srv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("serves the JSON API end-to-end", async () => {
    const store = new RunStore(dbPath);
    const id = store.createRun({ origin: "task", taskKey: "PROJ-1", harness: "claude-code" });
    store.finishRun(id, "succeeded");
    store.close();

    const server = startDashboardServer({ port: 0, dbPath, workingDir: dir });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(200);

      const runs = (await (await fetch(`${base}/api/runs`)).json()) as { total: number };
      expect(runs.total).toBe(1);

      const detail = await fetch(`${base}/api/runs/${id}`);
      expect(detail.status).toBe(200);

      const worker = (await (await fetch(`${base}/api/worker`)).json()) as { worker: unknown };
      expect(worker.worker).toBeNull();

      const missing = await fetch(`${base}/api/nope`);
      expect(missing.status).toBe(404);

      const post = await fetch(`${base}/api/runs`, { method: "POST" });
      expect(post.status).toBe(405);
    } finally {
      server.stop(true);
    }
  });

  test("POST /api/runs/:id/retry triggers the CLI flow end-to-end", async () => {
    const store = new RunStore(dbPath);
    const id = store.createRun({ origin: "task", taskKey: "PROJ-9" });
    store.finishRun(id, "failed");
    store.close();

    const spawned: string[] = [];
    const server = startDashboardServer({
      port: 0,
      dbPath,
      workingDir: dir,
      retryDeps: {
        resolveActor: async () => ({ email: "sup@example.com" }),
        spawn: (taskKey: string) => {
          spawned.push(taskKey);
          return { pid: 1234, command: `bun devintern ${taskKey} --force` };
        },
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      // GET exposes retry metadata on the detail payload.
      const detail = (await (await fetch(`${base}/api/runs/${id}`)).json()) as {
        retry: { eligible: boolean; audit: unknown[] };
      };
      expect(detail.retry.eligible).toBe(true);
      expect(detail.retry.audit).toEqual([]);

      const response = await fetch(`${base}/api/runs/${id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as { status: string; taskKey?: string; pid?: number };
      expect(body.status).toBe("triggered");
      expect(body.taskKey).toBe("PROJ-9");
      expect(body.pid).toBe(1234);
      expect(spawned).toEqual(["PROJ-9"]);

      // The audit entry is now visible on the detail payload.
      const after = (await (await fetch(`${base}/api/runs/${id}`)).json()) as {
        retry: { audit: { action: string }[] };
      };
      expect(after.retry.audit.map((entry) => entry.action)).toEqual(["triggered"]);

      // A second POST immediately afterwards hits the in-flight guard.
      const repeat = await fetch(`${base}/api/runs/${id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(repeat.status).toBe(409);

      // Unauthorized requests are refused before anything spawns.
      const deniedId = (() => {
        const s = new RunStore(dbPath);
        const failed = s.createRun({ origin: "task", taskKey: "PROJ-10" });
        s.finishRun(failed, "failed");
        s.close();
        return failed;
      })();
      const noAuth = startDashboardServer({
        port: 0,
        dbPath,
        workingDir: dir,
        retryDeps: { resolveActor: async () => null, spawn: () => ({ command: "" }) },
      });
      try {
        const denied = await fetch(`http://127.0.0.1:${noAuth.port}/api/runs/${deniedId}/retry`, {
          method: "POST",
        });
        expect(denied.status).toBe(403);
      } finally {
        noAuth.stop(true);
      }

      // GET is not allowed on the retry route.
      const wrongMethod = await fetch(`${base}/api/runs/${id}/retry`);
      expect(wrongMethod.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
