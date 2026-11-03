import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  makeBeforeAcquirersStart,
  recoverOrphanedInjectedTasks,
  recoverOrphanedWorkspaceRuns,
  scheduleOrphanPickups,
  startInjectedTaskSweeper,
} from "../src/lib/workspace/workspace-worker";
import { RunStore } from "../src/lib/state/run-recorder";
import type { RunRecord } from "../src/lib/state/run-recorder";
import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { BASE_WORKTREE_NAME } from "../src/lib/workspace/repo-manager";
import type { WorkspaceConfig } from "../src/lib/workspace/config";

describe("recoverOrphanedWorkspaceRuns", () => {
  let workspaceDir: string;
  let dbPath: string;
  let store: RunStore;
  const savedEnv = { ...process.env };

  function workspaceConfig(): WorkspaceConfig {
    return {
      workspace: {},
      defaults: { tracker: "jira", pollIntervalSeconds: 60 },
      repos: [{ name: "web-app", remote: "https://github.com/acme/web-app.git", env: {} }],
      routing: [],
      automations: [],
    } as unknown as WorkspaceConfig;
  }

  beforeEach(() => {
    workspaceDir = join(
      tmpdir(),
      `orphan-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const baseWorktree = join(workspaceDir, "worktrees", "web-app", BASE_WORKTREE_NAME);
    mkdirSync(join(baseWorktree, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(baseWorktree, ".devintern-code", "settings.json"),
      JSON.stringify({
        jira: { projects: { PROJ: { inProgressStatus: "In Progress", todoStatus: "To Do" } } },
      }),
    );
    dbPath = join(workspaceDir, "state", "queue.db");
    store = new RunStore(dbPath);
  });

  /** Seed a terminal local run with a recorded branch and implementation report. */
  function seedResumableLocalRun(
    taskKey: string,
    options: { branch?: string; report?: string | null } = {},
  ): number {
    const branch = options.branch ?? `feature/${taskKey}`;
    const runId = store.createRun({
      origin: "local",
      taskKey,
      tracker: "local",
      repo: "web-app",
      branch,
    });
    const report = options.report === undefined ? "prior implementation report" : options.report;
    if (report !== null) {
      store.addStage(runId, "implementation", "succeeded", undefined, JSON.stringify({ report }));
    }
    store.finishRun(
      runId,
      "failed",
      "worker stopped cleanly; interruption feedback already handled",
    );
    return runId;
  }

  function claimInjected(injected: InjectedTaskStore, taskKey: string): number {
    injected.enqueue({
      taskKey,
      repo: "web-app",
      title: taskKey,
      body: "",
      taskFile: join(workspaceDir, "injected", `${taskKey}.md`),
    });
    return injected.claimNext()!.id;
  }

  afterEach(() => {
    process.env = { ...savedEnv };
    store.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("reaps orphans and degrades to reap-only when tracker credentials are missing", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;

    store.createRun({ origin: "task", taskKey: "PROJ-1", tracker: "jira" });

    // Recovery runs before acquirers in the real startup path; missing
    // tracker credentials must never fail the worker start.
    await recoverOrphanedWorkspaceRuns({
      config: workspaceConfig(),
      workspaceDir,
      dbPath,
    });

    const runs = store.listRuns({ taskKey: "PROJ-1" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.outcomeReason).toContain("orphaned");
  });

  test("leaves terminal history untouched", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;

    const done = store.createRun({ origin: "task", taskKey: "PROJ-2" });
    store.finishRun(done, "succeeded");

    await recoverOrphanedWorkspaceRuns({
      config: workspaceConfig(),
      workspaceDir,
      dbPath,
    });

    expect(store.getRun(done)?.status).toBe("succeeded");
    expect(store.getRun(done)?.outcomeReason).toBeUndefined();
  });

  test("reaps interrupted error-monitor runs without treating them as Jira tickets", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    const runId = store.createRun({
      origin: "error_monitor",
      taskKey: "devintern-public-devintern-a",
      tracker: "sentry",
    });

    try {
      await recoverOrphanedWorkspaceRuns({ config: workspaceConfig(), workspaceDir, dbPath });
    } finally {
      console.warn = originalWarn;
    }

    expect(store.getRun(runId)?.status).toBe("failed");
    expect(warnings.some((warning) => warning.includes("JIRA"))).toBe(false);
    expect(warnings.some((warning) => warning.includes("recover"))).toBe(false);
  });

  test("settles scheduled retries left running by the previous worker", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;

    const retryStore = new ScheduledRetryStore(dbPath);
    retryStore.schedule({ taskKey: "PROJ-1", actor: "sup@example.com" });
    retryStore.schedule({ taskKey: "PROJ-2", actor: "sup@example.com" });
    retryStore.claimNext(); // PROJ-1 → running
    retryStore.claimNext(); // PROJ-2 → running

    await recoverOrphanedWorkspaceRuns({
      config: workspaceConfig(),
      workspaceDir,
      dbPath,
    });

    // Both rows were settled, so the dashboard's per-task guard unblocks and
    // the operator can schedule again.
    expect(retryStore.hasActive("PROJ-1")).toBe(false);
    expect(retryStore.hasActive("PROJ-2")).toBe(false);
    expect(retryStore.hasPending()).toBe(false);

    // Sanity: a fresh schedule is accepted after recovery.
    expect(retryStore.schedule({ taskKey: "PROJ-1", actor: "sup@example.com" }).scheduled).toBe(
      true,
    );
    retryStore.close();
  });

  test("does not settle injected running rows before the singleton lock is held", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;
    const injected = new InjectedTaskStore(dbPath);
    injected.enqueue({
      taskKey: "local-race",
      repo: "web-app",
      title: "race",
      body: "",
      taskFile: join(workspaceDir, "injected", "local-race.md"),
    });
    const claimed = injected.claimNext()!;
    injected.close();

    // `recoverOrphanedWorkspaceRuns` runs before lock acquisition; a second
    // worker losing the lock race must not touch the live worker's rows.
    await recoverOrphanedWorkspaceRuns({ config: workspaceConfig(), workspaceDir, dbPath });

    const after = new InjectedTaskStore(dbPath);
    try {
      expect(after.getById(claimed.id)?.status).toBe("running");
    } finally {
      after.close();
    }
  });

  test("makeBeforeAcquirersStart fails non-resumable injected rows and chains the caller hook", async () => {
    const injected = new InjectedTaskStore(dbPath);
    injected.enqueue({
      taskKey: "local-post-lock",
      repo: "web-app",
      title: "post-lock",
      body: "",
      taskFile: join(workspaceDir, "injected", "local-post-lock.md"),
    });
    const claimed = injected.claimNext()!;

    const order: string[] = [];
    await makeBeforeAcquirersStart(injected, {
      next: () => {
        order.push("caller");
      },
    })();

    expect(order).toEqual(["caller"]);
    expect(injected.getById(claimed.id)?.status).toBe("failed");
    expect(injected.getById(claimed.id)?.message).toBe(
      "worker restarted while this task was running",
    );
    injected.close();
  });

  test("auto-resumes a running injected row whose prior local run is resumable", async () => {
    const runId = seedResumableLocalRun("local-resume");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-resume");

    const logs: string[] = [];
    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      warn: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    });

    const after = injected.getById(claimedId)!;
    expect(after.status).toBe("pending");
    expect(after.autoResumeCount).toBe(1);
    expect(logs.join("\n")).toContain("auto-resuming interrupted injected task local-resume");
    expect(logs.join("\n")).toContain(`run #${runId}`);
    expect(logs.join("\n")).toContain("branch 'feature/local-resume'");
    injected.close();
  });

  test("still fails a running injected row with no prior local run", async () => {
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-no-run");

    await recoverOrphanedInjectedTasks(injected, { runStore: store, branchExists: () => true });

    const after = injected.getById(claimedId)!;
    expect(after.status).toBe("failed");
    expect(after.message).toBe("worker restarted while this task was running");
    expect(after.autoResumeCount).toBe(0);
    injected.close();
  });

  test("still fails a running injected row whose prior run recorded no report", async () => {
    seedResumableLocalRun("local-no-report", { report: null });
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-no-report");

    await recoverOrphanedInjectedTasks(injected, { runStore: store, branchExists: () => true });

    expect(injected.getById(claimedId)?.status).toBe("failed");
    expect(injected.getById(claimedId)?.message).toBe(
      "worker restarted while this task was running",
    );
    injected.close();
  });

  test("still fails a running injected row when the recorded branch is gone", async () => {
    seedResumableLocalRun("local-branch-gone");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-branch-gone");

    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => false,
    });

    expect(injected.getById(claimedId)?.status).toBe("failed");
    expect(injected.getById(claimedId)?.message).toBe(
      "worker restarted while this task was running",
    );
    injected.close();
  });

  test("bounds automatic resumes across restarts and preserves manual --resume", async () => {
    const runId = seedResumableLocalRun("local-budget");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-budget");

    // First restart: the row is auto-resumed.
    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      maxAutoResumes: 1,
    });
    expect(injected.getById(claimedId)?.status).toBe("pending");
    expect(injected.getById(claimedId)?.autoResumeCount).toBe(1);

    // The replacement run is claimed, then the worker restarts again.
    expect(injected.claimNext()?.id).toBe(claimedId);
    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      maxAutoResumes: 1,
    });

    const exhausted = injected.getById(claimedId)!;
    expect(exhausted.status).toBe("failed");
    expect(exhausted.autoResumeCount).toBe(1);
    expect(exhausted.message).toContain(`run #${runId}`);
    expect(exhausted.message).toContain("devintern worker add --resume local-budget");
    expect(exhausted.message).toContain("Re-queue");

    // The manual path still works after the automatic budget is exhausted, and
    // a fresh explicit retry grants a fresh automatic budget.
    const revived = injected.requeueSettled("local-budget")!;
    expect(revived.status).toBe("pending");
    expect(revived.autoResumeCount).toBe(0);
    injected.close();
  });

  test("auto-resume limit 0 keeps the explicit failure path", async () => {
    seedResumableLocalRun("local-disabled");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-disabled");

    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      maxAutoResumes: 0,
    });

    const after = injected.getById(claimedId)!;
    expect(after.status).toBe("failed");
    expect(after.message).toContain("devintern worker add --resume local-disabled");
    injected.close();
  });

  test("the periodic sweeper prunes settled rows and their prompt files", async () => {
    const injected = new InjectedTaskStore(dbPath);
    const promptFile = join(workspaceDir, "injected", "sweep.md");
    mkdirSync(join(workspaceDir, "injected"), { recursive: true });
    writeFileSync(promptFile, "sensitive");
    injected.enqueue({
      taskKey: "local-sweep",
      repo: "web-app",
      title: "sweep",
      body: "",
      taskFile: promptFile,
    });
    injected.finish(injected.claimNext()!.id, "done");

    const timer = startInjectedTaskSweeper(injected, 0, 10);
    try {
      for (let attempt = 0; attempt < 100 && injected.list().length > 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(injected.list()).toHaveLength(0);
      expect(existsSync(promptFile)).toBe(false);
    } finally {
      clearInterval(timer);
      injected.close();
    }
  });
});

describe("scheduleOrphanPickups", () => {
  let workspaceDir: string;
  let dbPath: string;

  function run(overrides: Partial<RunRecord>): RunRecord {
    return {
      id: 1,
      origin: "task",
      taskKey: "PROJ-1",
      status: "failed",
      startedAt: Date.now(),
      ...overrides,
    } as RunRecord;
  }

  beforeEach(() => {
    workspaceDir = join(
      tmpdir(),
      `orphan-pickup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    dbPath = join(workspaceDir, "state", "queue.db");
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("queues a retry for each resumable run, preserving routing context", () => {
    const store = new ScheduledRetryStore(dbPath);
    const queued = scheduleOrphanPickups(store, [
      run({ id: 7, taskKey: "PROJ-1", branch: "feature/proj-1", repo: "api", team: "platform" }),
      run({ id: 8, taskKey: "PROJ-2", branch: "feature/proj-2", repo: "web" }),
      run({ id: 9, taskKey: undefined }),
    ]);

    expect(queued).toBe(2);
    const first = store.claimNext();
    const second = store.claimNext();
    expect(first?.taskKey).toBe("PROJ-1");
    expect(first?.runId).toBe(7);
    expect(first?.team).toBe("platform");
    expect(first?.repo).toBe("api");
    expect(second?.taskKey).toBe("PROJ-2");
    expect(second?.repo).toBe("web");
    store.close();
  });

  test("does not double-queue a task that already has an active retry", () => {
    const store = new ScheduledRetryStore(dbPath);
    store.schedule({ taskKey: "PROJ-1", actor: "sup@example.com" });

    const queued = scheduleOrphanPickups(store, [
      run({ id: 7, taskKey: "PROJ-1", branch: "feature/proj-1" }),
    ]);

    expect(queued).toBe(0);
    store.close();
  });
});
