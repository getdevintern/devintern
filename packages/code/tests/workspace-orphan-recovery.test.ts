import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  makeBeforeAcquirersStart,
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
import { Utils } from "../src/lib/utils";

/** Test toggle for the dynamically imported tracker used by recovery. */
let trackerAvailable = false;
const fakeTracker = {
  getTask: async (key: string) => ({ key, status: "In Progress" }),
  postComment: async () => {},
  postIncompleteImplementationComment: async () => {},
  transitionStatus: async () => {},
  extractDescriptionText: () => "",
};

const realTrackerManager = { ...(await import("../src/lib/trackers/manager")) };

// Recovery imports the tracker manager lazily, so this mock is registered
// before the first `recoverOrphanedWorkspaceRuns` call. Existing tests keep
// `trackerAvailable` false to reproduce the missing-credentials path.
mock.module("../src/lib/trackers/manager", () => ({
  ...realTrackerManager,
  TaskTrackerManager: class {
    getClient() {
      if (!trackerAvailable) throw new Error("tracker unavailable");
      return fakeTracker;
    }
  },
}));

// bun shares one module registry across test files, so restore the real
// exports once this file is done.
afterAll(() => {
  mock.module("../src/lib/trackers/manager", () => ({ ...realTrackerManager }));
});

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
    trackerAvailable = false;
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

  /** Turn the base worktree into a real repo so the commit probe can run. */
  function initBaseRepo(): string {
    const baseWorktree = join(workspaceDir, "worktrees", "web-app", BASE_WORKTREE_NAME);
    execSync("git init", { cwd: baseWorktree });
    execSync("git config user.email 'test@test.com'", { cwd: baseWorktree });
    execSync("git config user.name 'Test User'", { cwd: baseWorktree });
    execSync("git add .", { cwd: baseWorktree });
    execSync("git commit -m 'initial'", { cwd: baseWorktree });
    try {
      execSync("git branch -M main", { cwd: baseWorktree });
    } catch {
      // Already on main.
    }
    return baseWorktree;
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

  test("resumes a report-less orphan whose branch has commits ahead of the base", async () => {
    process.env.TASK_TRACKER = "jira";
    trackerAvailable = true;
    const baseWorktree = initBaseRepo();
    execSync("git checkout -b feature/proj-3", { cwd: baseWorktree });
    writeFileSync(join(baseWorktree, "feature.txt"), "landed work\n", "utf8");
    execSync("git add .", { cwd: baseWorktree });
    execSync("git commit -m 'landed work'", { cwd: baseWorktree });
    execSync("git checkout main", { cwd: baseWorktree });

    const runId = store.createRun({
      origin: "task",
      taskKey: "PROJ-3",
      tracker: "jira",
      repo: "web-app",
      branch: "feature/proj-3",
    });

    await recoverOrphanedWorkspaceRuns({ config: workspaceConfig(), workspaceDir, dbPath });

    expect(store.getRun(runId)?.status).toBe("failed");
    const retryStore = new ScheduledRetryStore(dbPath);
    try {
      const claimed = retryStore.claimNext();
      expect(claimed?.taskKey).toBe("PROJ-3");
      expect(claimed?.runId).toBe(runId);
    } finally {
      retryStore.close();
    }
  });

  test("uses the repo's configured default branch for the commit probe", async () => {
    process.env.TASK_TRACKER = "jira";
    trackerAvailable = true;
    const baseWorktree = initBaseRepo();
    // `trunk` is the configured base, one commit ahead of `main`.
    execSync("git checkout -b trunk", { cwd: baseWorktree });
    writeFileSync(join(baseWorktree, "trunk.txt"), "trunk work\n", "utf8");
    execSync("git add . && git commit -m 'trunk work'", { cwd: baseWorktree });
    // The feature branch starts at trunk and adds nothing of its own, so it is
    // not resumable relative to trunk — but looks ahead of `main`.
    execSync("git checkout -b feature/proj-5", { cwd: baseWorktree });
    execSync("git checkout main", { cwd: baseWorktree });

    const config = workspaceConfig();
    config.repos[0] = { ...config.repos[0]!, defaultBranch: "trunk" };
    const runId = store.createRun({
      origin: "task",
      taskKey: "PROJ-5",
      tracker: "jira",
      repo: "web-app",
      branch: "feature/proj-5",
    });

    await recoverOrphanedWorkspaceRuns({ config, workspaceDir, dbPath });

    expect(store.getRun(runId)?.status).toBe("failed");
    const retryStore = new ScheduledRetryStore(dbPath);
    try {
      expect(retryStore.claimNext()).toBeNull();
    } finally {
      retryStore.close();
    }
  });

  test("falls back to cached refs once per repo when the remote is unreachable", async () => {
    process.env.TASK_TRACKER = "jira";
    trackerAvailable = true;
    const baseWorktree = initBaseRepo();
    const headSha = execSync("git rev-parse HEAD", { cwd: baseWorktree, encoding: "utf8" }).trim();
    // Model a fleet bare clone: no usable remote, but origin/HEAD cached.
    execSync("git remote add origin /nonexistent/workspace/repo.git", { cwd: baseWorktree });
    execSync(`git update-ref refs/remotes/origin/main ${headSha}`, { cwd: baseWorktree });
    execSync("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: baseWorktree,
    });
    execSync("git checkout -b feature/proj-6", { cwd: baseWorktree });
    writeFileSync(join(baseWorktree, "feature.txt"), "landed work\n", "utf8");
    execSync("git add . && git commit -m 'landed work'", { cwd: baseWorktree });
    execSync("git checkout main", { cwd: baseWorktree });
    execSync("git checkout -b feature/proj-7", { cwd: baseWorktree });
    writeFileSync(join(baseWorktree, "feature-2.txt"), "more landed work\n", "utf8");
    execSync("git add . && git commit -m 'more landed work'", { cwd: baseWorktree });
    execSync("git checkout main", { cwd: baseWorktree });

    const orphan = (taskKey: string, branch: string) =>
      store.createRun({ origin: "task", taskKey, tracker: "jira", repo: "web-app", branch });
    orphan("PROJ-6", "feature/proj-6");
    orphan("PROJ-7", "feature/proj-7");

    const executeGitCommand = Utils.executeGitCommand;
    const commands: string[] = [];
    Utils.executeGitCommand = async (args, options) => {
      commands.push(args.join(" "));
      if (args[0] === "ls-remote" || args[0] === "fetch" || args[0] === "pull") {
        throw new Error(`unexpected network git command during startup: ${args.join(" ")}`);
      }
      return executeGitCommand(args, options);
    };
    try {
      await recoverOrphanedWorkspaceRuns({ config: workspaceConfig(), workspaceDir, dbPath });
    } finally {
      Utils.executeGitCommand = executeGitCommand;
    }

    // The cached local refs are enough offline: no live name probe (`ls-remote`)
    // runs on startup, so an unreachable remote adds no per-repo wait.
    expect(commands.filter((command) => command.startsWith("ls-remote"))).toHaveLength(0);
    const retryStore = new ScheduledRetryStore(dbPath);
    try {
      expect([retryStore.claimNext()?.taskKey, retryStore.claimNext()?.taskKey]).toEqual([
        "PROJ-7",
        "PROJ-6",
      ]);
    } finally {
      retryStore.close();
    }
  });

  test("does not resume a branch cut from the new default when origin/HEAD is stale", async () => {
    process.env.TASK_TRACKER = "jira";
    trackerAvailable = true;
    const baseWorktree = join(workspaceDir, "worktrees", "web-app", BASE_WORKTREE_NAME);

    // Model a repo that switched its default branch from master to main after
    // this clone recorded origin/HEAD.
    const remoteDir = join(workspaceDir, "remote.git");
    mkdirSync(remoteDir, { recursive: true });
    execSync("git init --bare", { cwd: remoteDir });
    execSync("git init", { cwd: baseWorktree });
    execSync("git config user.email 'test@test.com'", { cwd: baseWorktree });
    execSync("git config user.name 'Test User'", { cwd: baseWorktree });
    writeFileSync(join(baseWorktree, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add . && git commit -m 'initial'", { cwd: baseWorktree });
    execSync("git branch -M master", { cwd: baseWorktree });
    execSync(`git remote add origin ${remoteDir}`, { cwd: baseWorktree });
    execSync("git push origin master", { cwd: baseWorktree });
    // The remote's new default moves past the old one.
    execSync("git checkout -b main", { cwd: baseWorktree });
    writeFileSync(join(baseWorktree, "upstream.txt"), "upstream work\n", "utf8");
    execSync("git add . && git commit -m 'upstream work'", { cwd: baseWorktree });
    execSync("git push origin main", { cwd: baseWorktree });
    execSync("git symbolic-ref HEAD refs/heads/main", { cwd: remoteDir });
    execSync("git fetch origin", { cwd: baseWorktree });
    // A branch cut from origin/main that carries no work of its own.
    execSync("git branch feature/proj-8 origin/main", { cwd: baseWorktree });
    // The cached head still names the old default.
    execSync("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master", {
      cwd: baseWorktree,
    });
    // Give the live resolver the bare clone it uses in the fleet; its remote
    // HEAD is the new default.
    const cloneDir = join(workspaceDir, "repos", "web-app.git");
    mkdirSync(cloneDir, { recursive: true });
    execSync("git init --bare", { cwd: cloneDir });
    execSync(`git remote add origin ${remoteDir}`, { cwd: cloneDir });

    // The trap: the stale cached base makes the empty branch look resumable.
    expect(await Utils.getCachedDefaultBranch({ cwd: baseWorktree })).toBe("master");
    expect(await Utils.hasCommitsAhead("feature/proj-8", "master", { cwd: baseWorktree })).toBe(
      true,
    );
    expect(await Utils.hasCommitsAhead("feature/proj-8", "main", { cwd: baseWorktree })).toBe(
      false,
    );

    const runId = store.createRun({
      origin: "task",
      taskKey: "PROJ-8",
      tracker: "jira",
      repo: "web-app",
      branch: "feature/proj-8",
    });

    await recoverOrphanedWorkspaceRuns({ config: workspaceConfig(), workspaceDir, dbPath });

    // The live default (main) shows no own commits, so the empty branch is not
    // scheduled for pickup; it falls back to the failure/requeue path.
    expect(store.getRun(runId)?.status).toBe("failed");
    const retryStore = new ScheduledRetryStore(dbPath);
    try {
      expect(retryStore.claimNext()).toBeNull();
    } finally {
      retryStore.close();
    }
  });

  test("refreshes a candidate repo once, in parallel, before the commit probe", async () => {
    process.env.TASK_TRACKER = "jira";
    trackerAvailable = true;
    const baseWorktree = initBaseRepo();
    execSync("git checkout -b feature/proj-9", { cwd: baseWorktree });
    writeFileSync(join(baseWorktree, "feature.txt"), "landed work\n", "utf8");
    execSync("git add . && git commit -m 'landed work'", { cwd: baseWorktree });
    execSync("git checkout main", { cwd: baseWorktree });
    // A fleet bare clone exists, so recovery can refresh the refs it probes.
    const cloneDir = join(workspaceDir, "repos", "web-app.git");
    mkdirSync(cloneDir, { recursive: true });
    execSync("git init --bare", { cwd: cloneDir });
    execSync(`git remote add origin ${baseWorktree}`, { cwd: cloneDir });

    const runId = store.createRun({
      origin: "task",
      taskKey: "PROJ-9",
      tracker: "jira",
      repo: "web-app",
      branch: "feature/proj-9",
    });

    const executeGitCommand = Utils.executeGitCommand;
    const fetches: string[] = [];
    Utils.executeGitCommand = async (args, options) => {
      if (args[0] === "fetch") fetches.push(args.join(" "));
      return executeGitCommand(args, options);
    };
    try {
      await recoverOrphanedWorkspaceRuns({ config: workspaceConfig(), workspaceDir, dbPath });
    } finally {
      Utils.executeGitCommand = executeGitCommand;
    }

    // One refresh for the repo, not one per orphan or branch probe.
    expect(fetches).toHaveLength(1);
    const retryStore = new ScheduledRetryStore(dbPath);
    try {
      expect(retryStore.claimNext()?.taskKey).toBe("PROJ-9");
    } finally {
      retryStore.close();
    }
    expect(store.getRun(runId)?.status).toBe("failed");
  });

  test("does not resume a report-less orphan when its repo worktree is missing", async () => {
    process.env.TASK_TRACKER = "jira";
    trackerAvailable = true;

    const runId = store.createRun({
      origin: "task",
      taskKey: "PROJ-4",
      tracker: "jira",
      repo: "missing-repo",
      branch: "feature/proj-4",
    });

    await recoverOrphanedWorkspaceRuns({ config: workspaceConfig(), workspaceDir, dbPath });

    // Without a checkout to inspect, the commit probe must not claim work.
    expect(store.getRun(runId)?.status).toBe("failed");
    const retryStore = new ScheduledRetryStore(dbPath);
    try {
      expect(retryStore.claimNext()).toBeNull();
    } finally {
      retryStore.close();
    }
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

  test("makeBeforeAcquirersStart fails injected running rows and chains the caller hook", async () => {
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
    await makeBeforeAcquirersStart(injected, () => {
      order.push("caller");
    })();

    expect(order).toEqual(["caller"]);
    expect(injected.getById(claimed.id)?.status).toBe("failed");
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
