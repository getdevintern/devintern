import { ArtifactStore } from "../src/lib/artifacts/store";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  DashboardData,
  handleAgentPrs,
  handleLogs,
  handleRuns,
  handleRunDetail,
  handleStats,
  handleWorkerStatus,
} from "../src/lib/observability/dashboard-api";
import {
  resolveDashboardHistoryDbPath,
  resolveDashboardQueueDbPath,
  resolveWorkspaceArgPath,
} from "../src/lib/observability/dashboard-db";
import { RunStore } from "../src/lib/state/run-recorder";
import type { RunStats } from "../src/lib/state/run-recorder";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { isLoopbackDashboardHost, startDashboardServer } from "../src/dashboard-server";
import { workspaceConfigPath, workspaceDbPath } from "../src/lib/workspace/paths";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("dashboard API", () => {
  let dir: string;
  let workspaceDir: string;
  let dbPath: string;
  let data: DashboardData;
  let savedWorkspaceDir: string | undefined;

  beforeEach(() => {
    dir = join(tmpdir(), `dash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspaceDir = join(tmpdir(), `dash-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    // Pin the workspace home so the worker-status workspace fallback cannot
    // see a developer's real ~/.devintern lock file.
    savedWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    dbPath = join(dir, "queue.db");
    data = new DashboardData({ dbPath, workingDir: dir });
  });

  afterEach(() => {
    data.close();
    if (savedWorkspaceDir === undefined) {
      delete process.env.DEVINTERN_WORKSPACE_DIR;
    } else {
      process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceDir;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("activity includes older active runs, bounded recent history, and short task previews", () => {
    const store = new RunStore(dbPath);
    try {
      const active = store.createRun({ origin: "task", taskKey: "ACTIVE-1" });
      store.setRunTicket(active, { description: "# Fix the login\n\nLong description" });
      store.startStep(active, "custom-check");
      for (let i = 0; i < 105; i++) {
        const id = store.createRun({ origin: "scheduled" });
        store.finishRun(id, "succeeded");
      }
      const result = data.getTaskActivity();
      expect(result.runs).toHaveLength(101);
      expect(result.runs.find((run) => run.id === active)).toMatchObject({
        step: "custom-check",
        stepActive: true,
        taskTitle: "Fix the login",
        taskDescription: undefined,
      });
      expect(result.recentLimit).toBe(100);
    } finally {
      store.close();
    }
  });

  test("activity task titles skip a leading frontmatter block", () => {
    const store = new RunStore(dbPath);
    try {
      const withHeading = store.createRun({ origin: "local", taskKey: "local-a" });
      store.setRunTicket(withHeading, {
        description:
          "---\nkey: local-a\ncreated_at: 2026-01-01\n---\n\n# Cover the review poll\n\nBody",
      });
      const withTitle = store.createRun({ origin: "local", taskKey: "local-b" });
      store.setRunTicket(withTitle, {
        description: '---\nkey: local-b\ntitle: "Add retries"\n---\n# Ignored heading\n',
      });
      const metaOnly = store.createRun({ origin: "local", taskKey: "local-c" });
      store.setRunTicket(metaOnly, { description: "---\nkey: local-c\n---\n" });
      const titles = new Map(
        data.getTaskActivity().runs.map((r) => [r.id, (r as { taskTitle?: string }).taskTitle]),
      );
      expect(titles.get(withHeading)).toBe("Cover the review poll");
      expect(titles.get(withTitle)).toBe("Add retries");
      expect(titles.get(metaOnly)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  /** Seed a finished run and return its id. */
  function seedRun(
    store: RunStore,
    options: {
      taskKey?: string;
      origin?: "task" | "pr_mention" | "scheduled";
      automationId?: string;
      harness?: string;
      status?: "succeeded" | "failed" | "escalated" | "abandoned" | "deferred";
      prUrl?: string;
    } = {},
  ): number {
    const id = store.createRun({
      origin: options.origin ?? "task",
      taskKey: options.taskKey,
      automationId: options.automationId,
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

    const estimate = handleRuns(data, new URLSearchParams("origin=estimate"));
    expect((estimate.body as { total: number }).total).toBe(0);

    const byKey = handleRuns(data, new URLSearchParams("taskKey=PROJ-1"));
    expect((byKey.body as { total: number }).total).toBe(1);
  });

  test("handleRuns filters by automationId", () => {
    const store = new RunStore(dbPath);
    seedRun(store, { origin: "scheduled", automationId: "nightly", status: "succeeded" });
    seedRun(store, { origin: "scheduled", automationId: "nightly", status: "failed" });
    seedRun(store, { origin: "scheduled", automationId: "weekly", status: "succeeded" });
    seedRun(store, { taskKey: "PROJ-1", status: "succeeded" });
    store.close();

    const nightly = handleRuns(data, new URLSearchParams("automationId=nightly"));
    const body = nightly.body as { runs: { automationId?: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.runs.every((run) => run.automationId === "nightly")).toBe(true);

    const none = handleRuns(data, new URLSearchParams("automationId=missing"));
    expect((none.body as { total: number }).total).toBe(0);
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

  test("run detail includes the ticket description snapshot; the runs list strips it", () => {
    const store = new RunStore(dbPath);
    const id = store.createRun({
      origin: "task",
      taskKey: "PROJ-2",
      tracker: "jira",
      ticketUrl: "https://acme.atlassian.net/browse/PROJ-2",
    });
    store.setRunTicket(id, { description: "# Task\n\nBuild the thing." });
    store.close();

    const detail = handleRunDetail(data, String(id));
    const detailBody = detail.body as { run: { taskDescription?: string } };
    expect(detailBody.run.taskDescription).toBe("# Task\n\nBuild the thing.");

    const listed = handleRuns(data, new URLSearchParams({ limit: "10" }));
    const listBody = listed.body as { runs: { taskDescription?: string }[] };
    expect(listBody.runs[0].taskDescription).toBeUndefined();
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
      worker: { status: string; pid: number; lockFile?: string };
      queue: { pending: number };
      agentPrs: { open: number; closed: number };
      cursors: { source: string }[];
      dbMissing: boolean;
    };
    expect(body.worker.status).toBe("running");
    expect(body.worker.pid).toBe(process.pid);
    expect(body.worker.lockFile).toContain(join(".devintern-code", ".worker.lock"));
    expect(body.queue.pending).toBe(1);
    expect(body.agentPrs).toEqual({ open: 1, closed: 1 });
    expect(body.cursors.map((c) => c.source)).toEqual(["jira"]);
    expect(body.dbMissing).toBe(false);

    // Dead pid → stopped (a stale lock is determinable, not unknown).
    writeFileSync(
      join(configDir, ".worker.lock"),
      JSON.stringify({ pid: 999999999, timestamp: new Date().toISOString() }),
    );
    const dead = handleWorkerStatus(data);
    expect((dead.body as { worker: { status: string } }).worker.status).toBe("stopped");
  });

  test("worker status counts ad-hoc tasks and scheduled retries alongside relay work", () => {
    const injected = new InjectedTaskStore(dbPath);
    for (const key of ["local-one", "local-two", "local-three"]) {
      injected.enqueue({
        taskKey: key,
        repo: "acme/webapp",
        title: key,
        body: "",
        taskFile: join(dir, `${key}.md`),
      });
    }
    // Oldest row becomes running, then settles `done`; the next stays running
    // and the last remains pending. The settled row must not be counted.
    const doneTask = injected.claimNext();
    expect(doneTask?.taskKey).toBe("local-one");
    injected.finish(doneTask!.id, "done");
    expect(injected.claimNext()?.taskKey).toBe("local-two");
    injected.close();

    const retries = new ScheduledRetryStore(dbPath);
    // A retry that already ran and failed must not be counted either.
    expect(retries.schedule({ taskKey: "PROJ-1", actor: "tester" }).scheduled).toBe(true);
    const failedRetry = retries.claimNext();
    expect(failedRetry?.taskKey).toBe("PROJ-1");
    retries.finish(failedRetry!.id, "failed", "boom");
    // One retry stays running, one stays pending.
    expect(retries.schedule({ taskKey: "PROJ-2", actor: "tester" }).scheduled).toBe(true);
    expect(retries.claimNext()?.taskKey).toBe("PROJ-2");
    expect(retries.schedule({ taskKey: "PROJ-3", actor: "tester" }).scheduled).toBe(true);
    retries.close();

    const queue = new WebhookQueue({ dbPath });
    queue.enqueue("issue_comment", { hello: true });
    queue.close();

    const body = handleWorkerStatus(data).body as {
      queue: {
        pending: number;
        processing: number;
        failed: number;
        injected: { pending: number; running: number };
        retries: { pending: number; running: number };
      };
    };
    expect(body.queue.pending).toBe(1);
    expect(body.queue.injected).toEqual({ pending: 1, running: 1 });
    expect(body.queue.retries).toEqual({ pending: 1, running: 1 });

    // Settle every remaining row: with no active work left, any settled row
    // leaking into the counts would show up here (row order cannot mask it).
    const drainedInjected = new InjectedTaskStore(dbPath);
    drainedInjected.failRunning("settled");
    const lastInjected = drainedInjected.claimNext();
    if (lastInjected) drainedInjected.finish(lastInjected.id, "done");
    drainedInjected.close();

    const drainedRetries = new ScheduledRetryStore(dbPath);
    drainedRetries.failRunning("settled");
    const lastRetry = drainedRetries.claimNext();
    if (lastRetry) drainedRetries.finish(lastRetry.id, "done");
    drainedRetries.close();

    const settled = handleWorkerStatus(data).body as {
      queue: {
        injected: { pending: number; running: number };
        retries: { pending: number; running: number };
      };
    };
    expect(settled.queue.injected).toEqual({ pending: 0, running: 0 });
    expect(settled.queue.retries).toEqual({ pending: 0, running: 0 });
  });

  test("counts workspace queue work without moving project-scoped run history", () => {
    const savedQueueDb = process.env.WEBHOOK_QUEUE_DB;
    delete process.env.WEBHOOK_QUEUE_DB;
    const projectDb = join(dir, ".devintern-code", "queue.db");
    try {
      // A direct `devintern TASK` run lands in the project DB even when the
      // user also has a workspace worker.
      mkdirSync(join(dir, ".devintern-code"), { recursive: true });
      const runs = new RunStore(projectDb);
      const runId = runs.createRun({ origin: "task", taskKey: "PROJ-LOCAL" });
      runs.finishRun(runId, "succeeded");
      runs.close();

      writeFileSync(workspaceConfigPath(workspaceDir), "");
      const workspaceDb = workspaceDbPath(workspaceDir);
      const injected = new InjectedTaskStore(workspaceDb);
      const retries = new ScheduledRetryStore(workspaceDb);
      try {
        injected.enqueue({
          taskKey: "local-one",
          repo: "acme/webapp",
          title: "local-one",
          body: "",
          taskFile: join(workspaceDir, "local-one.md"),
        });
        expect(retries.schedule({ taskKey: "PROJ-1", actor: "tester" }).scheduled).toBe(true);

        const defaulted = new DashboardData({ workingDir: dir, logDirs: [] });
        try {
          // History stays project scoped; the local run is still visible.
          expect(defaulted.dbPath).toBe(projectDb);
          expect(defaulted.queueDbPath).toBe(workspaceDb);
          expect(
            defaulted.listRuns({ taskKey: "PROJ-LOCAL", limit: 10, offset: 0 }).runs.length,
          ).toBe(1);
          expect(defaulted.getQueueStats()).toMatchObject({
            injected: { pending: 1, running: 0 },
            retries: { pending: 1, running: 0 },
          });
        } finally {
          defaulted.close();
        }
      } finally {
        injected.close();
        retries.close();
      }
    } finally {
      if (savedQueueDb === undefined) {
        delete process.env.WEBHOOK_QUEUE_DB;
      } else {
        process.env.WEBHOOK_QUEUE_DB = savedQueueDb;
      }
    }
  });

  test("counts relay deliveries in the queue database, not the history database", () => {
    // Split the two connections the way a standalone dashboard does: history
    // stays project scoped, while the workspace worker's webhook events land in
    // the queue DB. The history DB has no webhook events, so reading it would
    // report zero pending deliveries.
    const historyDb = join(dir, "history.db");
    const queueDb = join(dir, "workspace-state", "queue.db");
    mkdirSync(join(dir, "workspace-state"), { recursive: true });
    const runs = new RunStore(historyDb);
    const runId = runs.createRun({ origin: "task", taskKey: "PROJ-HIST" });
    runs.finishRun(runId, "succeeded");
    runs.close();
    const queue = new WebhookQueue({ dbPath: queueDb });
    queue.enqueue("issue_comment", { hello: "workspace" });
    queue.close();

    const scoped = new DashboardData({
      dbPath: historyDb,
      queueDbPath: queueDb,
      workingDir: dir,
      logDirs: [],
    });
    try {
      expect(scoped.dbPath).not.toBe(scoped.queueDbPath);
      expect(scoped.getQueueStats()).toMatchObject({
        pending: 1,
        processing: 0,
        failed: 0,
      });
    } finally {
      scoped.close();
    }
  });

  test("sums relay deliveries written by a project-scoped webhook serve with workspace deliveries", () => {
    // `devintern webhook serve` writes to the project-scoped DB while the
    // workspace worker writes to the workspace DB. Both producers are
    // disjoint, so the dashboard must report their pending relays together.
    const historyDb = join(dir, "project-state", "queue.db");
    const queueDb = join(dir, "workspace-state", "queue.db");
    mkdirSync(join(dir, "project-state"), { recursive: true });
    mkdirSync(join(dir, "workspace-state"), { recursive: true });
    const projectQueue = new WebhookQueue({ dbPath: historyDb });
    projectQueue.enqueue("issue_comment", { hello: "project" });
    projectQueue.close();
    const workspaceQueue = new WebhookQueue({ dbPath: queueDb });
    workspaceQueue.enqueue("issue_comment", { hello: "workspace" });
    workspaceQueue.close();

    const scoped = new DashboardData({
      dbPath: historyDb,
      queueDbPath: queueDb,
      workingDir: dir,
      logDirs: [],
    });
    try {
      expect(scoped.getQueueStats()).toMatchObject({
        pending: 2,
        processing: 0,
        failed: 0,
      });
    } finally {
      scoped.close();
    }
  });

  test("resolves the --workspace argument from the config file or its directory", () => {
    const ws = join(dir, "arg-workspace");
    mkdirSync(ws, { recursive: true });
    const config = workspaceConfigPath(ws);
    writeFileSync(config, "");

    // A directory means the workspace home; the file inside it is used.
    expect(resolveWorkspaceArgPath(ws)).toBe(config);
    expect(resolveWorkspaceArgPath(config)).toBe(config);

    // Anything else must not silently fall back to the project-scoped DB.
    expect(resolveWorkspaceArgPath(join(dir, "missing.toml"))).toBeNull();
    const otherFile = join(dir, "other.toml");
    writeFileSync(otherFile, "");
    expect(resolveWorkspaceArgPath(otherFile)).toBeNull();
    const emptyDir = join(dir, "no-config");
    mkdirSync(emptyDir, { recursive: true });
    expect(resolveWorkspaceArgPath(emptyDir)).toBeNull();
  });

  test("keeps both databases project scoped without a workspace and follows a configured one", () => {
    const savedQueueDb = process.env.WEBHOOK_QUEUE_DB;
    delete process.env.WEBHOOK_QUEUE_DB;
    try {
      const projectDb = join(dir, ".devintern-code", "queue.db");
      // No workspace: history and queue counts share the legacy project DB.
      expect(resolveDashboardHistoryDbPath(dir)).toBe(projectDb);
      expect(resolveDashboardQueueDbPath(workspaceDir, dir)).toBe(projectDb);
      // Once a workspace is configured, only the queue DB follows it; run
      // history remains the same project-scoped DB as a direct CLI run.
      writeFileSync(workspaceConfigPath(workspaceDir), "");
      expect(resolveDashboardHistoryDbPath(dir)).toBe(projectDb);
      expect(resolveDashboardQueueDbPath(workspaceDir, dir)).toBe(workspaceDbPath(workspaceDir));
      // An explicit env pin (worker-embedded dashboard) always wins.
      const pinned = join(dir, "pinned.db");
      process.env.WEBHOOK_QUEUE_DB = pinned;
      expect(resolveDashboardHistoryDbPath(dir)).toBe(pinned);
      expect(resolveDashboardQueueDbPath(workspaceDir, dir)).toBe(pinned);
    } finally {
      if (savedQueueDb === undefined) {
        delete process.env.WEBHOOK_QUEUE_DB;
      } else {
        process.env.WEBHOOK_QUEUE_DB = savedQueueDb;
      }
    }
  });

  test("follows a non-default workspace config for queue counts", async () => {
    const savedQueueDb = process.env.WEBHOOK_QUEUE_DB;
    delete process.env.WEBHOOK_QUEUE_DB;
    const customWorkspace = join(dir, "custom-workspace");
    try {
      mkdirSync(customWorkspace, { recursive: true });
      writeFileSync(workspaceConfigPath(customWorkspace), "");
      const customDb = workspaceDbPath(customWorkspace);
      expect(resolveDashboardQueueDbPath(customWorkspace, dir)).toBe(customDb);

      const injected = new InjectedTaskStore(customDb);
      injected.enqueue({
        taskKey: "local-custom",
        repo: "acme/webapp",
        title: "local-custom",
        body: "",
        taskFile: join(customWorkspace, "local-custom.md"),
      });
      injected.close();

      // The worker draining that queue holds the custom workspace's lock, not
      // the default workspace home's.
      writeFileSync(
        join(customWorkspace, ".worker.lock"),
        JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
      );

      const server = startDashboardServer({
        port: 0,
        workingDir: dir,
        workspaceDir: customWorkspace,
        queueDbPath: resolveDashboardQueueDbPath(customWorkspace, dir),
        logDirs: [],
      });
      try {
        const body = (await (await fetch(`http://127.0.0.1:${server.port}/api/worker`)).json()) as {
          worker: { status: string; pid: number; lockFile?: string };
          queue: { injected: { pending: number; running: number } };
        };
        // Proves the --workspace value reaches the API through the server
        // options, not just the resolver, and covers liveness as well as counts.
        expect(body.queue.injected).toEqual({ pending: 1, running: 0 });
        expect(body.worker.status).toBe("running");
        expect(body.worker.pid).toBe(process.pid);
        expect(body.worker.lockFile).toBe(join(customWorkspace, ".worker.lock"));
      } finally {
        server.stop();
      }
    } finally {
      if (savedQueueDb === undefined) {
        delete process.env.WEBHOOK_QUEUE_DB;
      } else {
        process.env.WEBHOOK_QUEUE_DB = savedQueueDb;
      }
    }
  });

  test("an explicit dbPath keeps one-database behavior for embeddings", () => {
    const runs = new RunStore(dbPath);
    runs.close();
    const injected = new InjectedTaskStore(dbPath);
    injected.enqueue({
      taskKey: "local-one",
      repo: "acme/webapp",
      title: "local-one",
      body: "",
      taskFile: join(dir, "local-one.md"),
    });
    injected.close();

    const explicit = new DashboardData({ dbPath, workingDir: dir, logDirs: [] });
    try {
      expect(explicit.dbPath).toBe(dbPath);
      expect(explicit.queueDbPath).toBe(dbPath);
      expect(explicit.getQueueStats().injected).toEqual({ pending: 1, running: 0 });
    } finally {
      explicit.close();
    }
  });

  test("worker queue counts are zero and do not create a missing database", () => {
    expect(existsSync(dbPath)).toBe(false);

    const body = handleWorkerStatus(data).body as {
      queue: {
        pending: number;
        processing: number;
        failed: number;
        injected: { pending: number; running: number };
        retries: { pending: number; running: number };
      };
    };
    expect(body.queue).toEqual({
      pending: 0,
      processing: 0,
      failed: 0,
      injected: { pending: 0, running: 0 },
      retries: { pending: 0, running: 0 },
    });
    // The GET must stay read-only: no directory, database, or schema creation.
    expect(existsSync(dbPath)).toBe(false);
  });

  test("run detail does not create a missing workspace queue database", () => {
    const historyDb = join(dir, "history.db");
    const missingQueueDb = join(dir, "workspace-state", "queue.db");
    const runs = new RunStore(historyDb);
    const runId = runs.createRun({ origin: "local", taskKey: "local-missing" });
    runs.finishRun(runId, "failed");
    runs.close();
    expect(existsSync(missingQueueDb)).toBe(false);

    const scoped = new DashboardData({
      dbPath: historyDb,
      queueDbPath: missingQueueDb,
      workingDir: dir,
      logDirs: [],
    });
    try {
      const response = handleRunDetail(scoped, String(runId));
      expect(response.status).toBe(200);
      // Eligibility reads the ad-hoc row read-only; it must not create the
      // workspace state directory, database, or schema just by being viewed.
      expect(existsSync(missingQueueDb)).toBe(false);
      expect(existsSync(join(dir, "workspace-state"))).toBe(false);
    } finally {
      scoped.close();
    }
  });

  test("a fresh project with only workspace queue data is not reported as missing a database", () => {
    const missingHistoryDb = join(dir, "history-missing.db");
    const workspaceQueueDb = join(dir, "workspace-state", "queue.db");
    const injected = new InjectedTaskStore(workspaceQueueDb);
    injected.enqueue({
      taskKey: "local-fresh",
      repo: "acme/webapp",
      title: "local-fresh",
      body: "",
      taskFile: join(dir, "local-fresh.md"),
    });
    injected.close();

    const scoped = new DashboardData({
      dbPath: missingHistoryDb,
      queueDbPath: workspaceQueueDb,
      workingDir: dir,
      logDirs: [],
    });
    try {
      const body = handleWorkerStatus(scoped).body as {
        dbMissing: boolean;
        queueDbMissing: boolean;
        queue: { injected: { pending: number; running: number } };
      };
      // History DB absent, but the workspace queue DB is recording work: the
      // status strip must not pair "no database yet" with "1 queued".
      expect(body.dbMissing).toBe(true);
      expect(body.queueDbMissing).toBe(false);
      expect(body.queue.injected).toEqual({ pending: 1, running: 0 });
    } finally {
      scoped.close();
    }
  });

  test("worker liveness falls back to the workspace home lock (fleet mode)", () => {
    // The fleet daemon locks the workspace home directly, without nesting
    // .devintern-code/ — a dashboard started from a repo checkout must still
    // see it.
    writeFileSync(
      join(workspaceDir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const body = handleWorkerStatus(data).body as {
      worker: { status: string; pid: number; lockFile?: string };
    };
    expect(body.worker.status).toBe("running");
    expect(body.worker.pid).toBe(process.pid);
    expect(body.worker.lockFile).toBe(join(workspaceDir, ".worker.lock"));
  });

  test("a stale project-dir lock does not shadow a live workspace lock", () => {
    // A crashed worker leaves a lock whose pid is dead. If the current worker
    // (fleet mode) has since taken the workspace-home lock, the stale lock
    // must not win just because it was checked first.
    const configDir = join(dir, ".devintern-code");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, ".worker.lock"),
      JSON.stringify({ pid: 999999999, timestamp: "2026-08-26T06:03:49.220Z" }),
    );
    writeFileSync(
      join(workspaceDir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const body = handleWorkerStatus(data).body as {
      worker: { status: string; pid: number; lockFile?: string };
    };
    expect(body.worker.status).toBe("running");
    expect(body.worker.pid).toBe(process.pid);
    expect(body.worker.lockFile).toBe(join(workspaceDir, ".worker.lock"));
  });

  test("stopped is reported when every readable lock is stale", () => {
    const configDir = join(dir, ".devintern-code");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, ".worker.lock"),
      JSON.stringify({ pid: 999999999, timestamp: "2026-08-26T06:03:49.220Z" }),
    );
    writeFileSync(
      join(workspaceDir, ".worker.lock"),
      JSON.stringify({ pid: 999999998, timestamp: "2026-08-26T06:03:49.220Z" }),
    );

    const body = handleWorkerStatus(data).body as { worker: { status: string } };
    expect(body.worker.status).toBe("stopped");
  });

  test("worker status without any lock file is unknown, not stopped", () => {
    // Give the empty-DB path something to read gracefully too.
    const response = handleWorkerStatus(data);
    const body = response.body as { worker: { status: string }; dbMissing: boolean };
    // The worker may run against a different directory than this dashboard,
    // so a missing lock file must not be reported as "stopped".
    expect(body.worker.status).toBe("unknown");
    expect(body.dbMissing).toBe(true);
  });

  test("handleAgentPrs lists open PRs with links and drops closed ones", () => {
    const state = new WorkerState(dbPath);
    // The worker freezes the ticket link at PR-creation time from the tracker
    // configured then; the dashboard only replays it, so no tracker env is
    // needed here (and switching trackers cannot break existing links).
    state.recordAgentPr({
      repo: "acme/webapp",
      prNumber: 7,
      branch: "feature/dev-1",
      taskKey: "DEV-1",
      ticketUrl: "https://acme.atlassian.net/browse/DEV-1",
    });
    state.recordAgentChangeRequest(
      {
        provider: "gitlab",
        instanceUrl: "https://git.example.test",
        projectId: "23",
        projectPath: "acme/platform/api",
        number: 11,
        webUrl: "https://git.example.test/acme/platform/api/-/merge_requests/11",
      },
      { taskKey: "DEV-3" },
    );
    state.recordAgentPr({ repo: "acme/webapp", prNumber: 8, taskKey: "DEV-2" });
    state.markAgentPrClosed("acme/webapp", 8);
    state.close();

    const response = handleAgentPrs(data);
    expect(response.status).toBe(200);
    const body = response.body as {
      prs: {
        repo: string;
        prNumber: number;
        prUrl: string;
        branch?: string;
        taskKey?: string;
        ticketUrl?: string;
      }[];
    };
    expect(body.prs).toHaveLength(2);
    expect(body.prs[0]).toMatchObject({
      repo: "acme/webapp",
      prNumber: 7,
      prUrl: "https://github.com/acme/webapp/pull/7",
      branch: "feature/dev-1",
      taskKey: "DEV-1",
      ticketUrl: "https://acme.atlassian.net/browse/DEV-1",
    });
    expect(body.prs[1]).toMatchObject({
      provider: "gitlab",
      instanceUrl: "https://git.example.test",
      projectId: "23",
      projectPath: "acme/platform/api",
      repo: "acme/platform/api",
      prNumber: 11,
      prUrl: "https://git.example.test/acme/platform/api/-/merge_requests/11",
    });
  });

  test("handleAgentPrs degrades to an empty list without a database", () => {
    const response = handleAgentPrs(data);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ prs: [] });
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

describe("logs endpoint", () => {
  let dir: string;
  let logDir: string;
  let dbPath: string;
  let data: DashboardData;

  beforeEach(() => {
    dir = join(tmpdir(), `dash-logs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    logDir = join(dir, "capture");
    mkdirSync(logDir, { recursive: true });
    dbPath = join(dir, "queue.db");
    data = new DashboardData({ dbPath, workingDir: dir, logDirs: [logDir] });
  });

  afterEach(() => {
    data.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("handleLogs rejects invalid params", () => {
    expect(handleLogs(data, new URLSearchParams("limit=0")).status).toBe(400);
    expect(handleLogs(data, new URLSearchParams("limit=9999")).status).toBe(400);
    expect(handleLogs(data, new URLSearchParams("level=trace")).status).toBe(400);
  });

  test("returns an empty state when no capture files exist", () => {
    const response = handleLogs(data, new URLSearchParams());
    expect(response.status).toBe(200);
    const body = response.body as { available: boolean; entries: unknown[]; truncated: boolean };
    expect(body.available).toBe(false);
    expect(body.entries).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  test("tails entries, redacts secrets, and links runs by task key", () => {
    const store = new RunStore(dbPath);
    const runId = store.createRun({ origin: "task", taskKey: "DEV-42", harness: "claude-code" });
    store.finishRun(runId, "failed");
    store.close();

    writeFileSync(
      join(logDir, "worker.stdout.log"),
      "\x1b[31m❌ DEV-42 run failed\x1b[0m\nplain info line\n",
      "utf8",
    );
    writeFileSync(
      join(logDir, "worker.stderr.log"),
      "retry with WEBHOOK_SECRET=hunter2 super-secret ignored\n",
      "utf8",
    );

    const response = handleLogs(data, new URLSearchParams());
    expect(response.status).toBe(200);
    const body = response.body as {
      available: boolean;
      entries: { message: string; level: string; taskKey?: string | null; runId?: number }[];
      sources: { exists: boolean }[];
    };
    expect(body.available).toBe(true);
    expect(body.entries.length).toBe(3);

    const failed = body.entries.find((entry) => entry.message === "❌ DEV-42 run failed");
    expect(failed?.level).toBe("error");
    expect(failed?.taskKey).toBe("DEV-42");
    expect(failed?.runId).toBe(runId);

    const secretLine = body.entries.find((entry) => entry.message.includes("WEBHOOK_SECRET="));
    expect(secretLine).toBeDefined();
    expect(secretLine?.message.includes("hunter2")).toBe(false);

    expect(body.sources.every((source) => source.exists)).toBe(true);
  });

  test("serves /api/logs end-to-end and degrades without files", async () => {
    const server = startDashboardServer({ port: 0, dbPath, workingDir: dir, logDirs: [logDir] });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const logs = (await (await fetch(`${base}/api/logs`)).json()) as { available: boolean };
      expect(logs.available).toBe(false);
      const bad = await fetch(`${base}/api/logs?level=nope`);
      expect(bad.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});

describe("dashboard server", () => {
  let dir: string;
  let workspaceDir: string;
  let dbPath: string;
  let savedWorkspaceDir: string | undefined;

  beforeEach(() => {
    dir = join(tmpdir(), `dash-srv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspaceDir = join(
      tmpdir(),
      `dash-srv-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    savedWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    if (savedWorkspaceDir === undefined) {
      delete process.env.DEVINTERN_WORKSPACE_DIR;
    } else {
      process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceDir;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("accepts only explicit loopback bind hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackDashboardHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "192.168.1.20", "dashboard.example.com"]) {
      expect(isLoopbackDashboardHost(host)).toBe(false);
      expect(() => startDashboardServer({ host, port: 0 })).toThrow("is not loopback");
    }
  });

  test("serves the JSON API end-to-end", async () => {
    const store = new RunStore(dbPath);
    const id = store.createRun({ origin: "task", taskKey: "PROJ-1", harness: "claude-code" });
    store.finishRun(id, "succeeded");
    const state = new WorkerState(dbPath);
    state.recordAgentPr({ repo: "acme/webapp", prNumber: 7, taskKey: "DEV-1" });
    state.close();
    store.close();

    const server = startDashboardServer({ port: 0, dbPath, workingDir: dir });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(200);

      const runs = (await (await fetch(`${base}/api/runs`)).json()) as { total: number };
      expect(runs.total).toBe(1);
      const activity = await fetch(`${base}/api/task-activity`);
      expect(activity.status).toBe(200);
      expect(await activity.json()).toMatchObject({
        runs: [{ id, status: "succeeded", stepActive: false }],
        recentLimit: 100,
      });

      const detail = await fetch(`${base}/api/runs/${id}`);
      expect(detail.status).toBe(200);

      const harnessLogs = await fetch(`${base}/api/runs/${id}/harness-logs`);
      expect(harnessLogs.status).toBe(200);

      const worker = (await (await fetch(`${base}/api/worker`)).json()) as {
        worker: { status: string };
      };
      expect(worker.worker.status).toBe("unknown");

      const agentPrs = (await (await fetch(`${base}/api/agent-prs`)).json()) as {
        prs: { prUrl: string }[];
      };
      expect(agentPrs.prs.map((pr) => pr.prUrl)).toEqual(["https://github.com/acme/webapp/pull/7"]);

      const missing = await fetch(`${base}/api/nope`);
      expect(missing.status).toBe(404);

      const post = await fetch(`${base}/api/runs`, { method: "POST" });
      expect(post.status).toBe(405);
    } finally {
      server.stop(true);
    }
  });

  test("serves task artifacts end-to-end", async () => {
    const outputDir = join(dir, "output");
    const savedOutputDir = process.env.DEVINTERN_OUTPUT_DIR;
    process.env.DEVINTERN_OUTPUT_DIR = outputDir;

    mkdirSync(join(outputDir, "proj-2"), { recursive: true });
    writeFileSync(
      join(outputDir, "proj-2", "verify-prompt.txt"),
      "token=ghp_abcdefghijklmnopqrstuvwxyz\n",
    );

    const store = new RunStore(dbPath);
    const id = store.createRun({ origin: "task", taskKey: "PROJ-2" });
    store.close();

    const artifacts = new ArtifactStore(dbPath);
    const artifact = artifacts.add(
      {
        key: "verify",
        path: join(outputDir, "proj-2", "verify-prompt.txt"),
        title: "Verification",
        kind: "verification",
        mediaType: "text/plain",
      },
      { scope: `run-${id}`, runId: id, step: "verify", iteration: 1 },
      [outputDir],
    );
    artifacts.close();

    const server = startDashboardServer({ port: 0, dbPath, workingDir: dir });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const listRes = await fetch(`${base}/api/runs/${id}/artifacts`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { artifacts: { name: string }[] };
      expect(list.artifacts.map((file) => file.name)).toEqual(["verify-prompt.txt"]);

      const detail = (await (await fetch(`${base}/api/runs/${id}`)).json()) as {
        artifacts: { name: string }[];
      };
      expect(detail.artifacts.map((file) => file.name)).toEqual(["verify-prompt.txt"]);

      const contentRes = await fetch(`${base}/api/runs/${id}/artifacts/${artifact.id}`);
      expect(contentRes.status).toBe(200);
      const content = (await contentRes.json()) as { content: string };
      expect(content.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");

      const missing = await fetch(`${base}/api/runs/${id}/artifacts/nope.txt`);
      expect(missing.status).toBe(404);
    } finally {
      server.stop(true);
      if (savedOutputDir === undefined) delete process.env.DEVINTERN_OUTPUT_DIR;
      else process.env.DEVINTERN_OUTPUT_DIR = savedOutputDir;
    }
  });

  test("handleWorkerStatus surfaces the working-window snapshot when provided", () => {
    const snapshot = {
      enabled: true,
      pickupAllowed: false,
      active: ["22:00-06:00"],
      blocked: [],
      timezone: "UTC",
      catchUpMissed: true,
      manualRequested: false,
      nextChange: { at: Date.UTC(2026, 5, 16, 22, 0), kind: "open" as const },
    };
    const scheduled = new DashboardData({
      dbPath,
      workingDir: dir,
      scheduleSnapshot: () => snapshot,
    });
    const response = handleWorkerStatus(scheduled);
    scheduled.close();
    expect((response.body as { schedule: unknown }).schedule).toEqual(snapshot);

    // Without a provider (standalone dashboard), the field is null.
    const plain = new DashboardData({ dbPath, workingDir: dir });
    const bare = handleWorkerStatus(plain);
    plain.close();
    expect((bare.body as { schedule: unknown }).schedule).toBeNull();
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

      // Loopback requests do not depend on a CLI sign-in session.
      const localId = (() => {
        const s = new RunStore(dbPath);
        const failed = s.createRun({ origin: "task", taskKey: "PROJ-10" });
        s.finishRun(failed, "failed");
        s.close();
        return failed;
      })();
      const noSession = startDashboardServer({
        port: 0,
        dbPath,
        workingDir: dir,
        retryDeps: { resolveActor: async () => null, spawn: () => ({ command: "" }) },
      });
      try {
        const local = await fetch(`http://127.0.0.1:${noSession.port}/api/runs/${localId}/retry`, {
          method: "POST",
        });
        expect(local.status).toBe(202);
      } finally {
        noSession.stop(true);
      }

      // GET is not allowed on the retry route.
      const wrongMethod = await fetch(`${base}/api/runs/${id}/retry`);
      expect(wrongMethod.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
