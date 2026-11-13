import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  recoverOrphanedWorkspaceRuns,
  scheduleOrphanPickups,
  startInjectedTaskSweeper,
  workspaceHasStartupWork,
} from "../src/lib/workspace/workspace-worker";
import {
  createInjectedBranchExistsProbe,
  createInjectedCommitProbe,
  createInjectedStartupRecovery,
  makeBeforeAcquirersStart,
  readProcessStartTime,
  recoverOrphanedInjectedTasks,
} from "../src/lib/workspace/injected-recovery";
import { RunStore } from "../src/lib/state/run-recorder";
import type { RunRecord } from "../src/lib/state/run-recorder";
import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import type { InjectedTask } from "../src/lib/state/injected-tasks";
import { BASE_WORKTREE_NAME, RepoManager } from "../src/lib/workspace/repo-manager";
import type { RepoConfig, WorkspaceConfig } from "../src/lib/workspace/config";
import { workspaceDbPath } from "../src/lib/workspace/paths";
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

  test("leaves a row running while the interrupted child process is still alive", async () => {
    seedResumableLocalRun("local-live-child");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-live-child");
    injected.setChildPid(claimedId, process.pid, readProcessStartTime(process.pid));

    const warnings: string[] = [];
    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
    });

    const after = injected.getById(claimedId)!;
    // That child is the same task and may still finish successfully, so the row
    // stays claimed: failing it here would send the operator's `--resume` at a
    // second branch and PR.
    expect(after.status).toBe("running");
    expect(after.childPid).toBe(process.pid);
    expect(after.autoResumeCount).toBe(0);
    expect(warnings.join("\n")).toContain(`pid ${process.pid}`);
    expect(warnings.join("\n")).toContain("A child that succeeds needs no resume");
    injected.close();
  });

  test("treats a recycled child pid as gone so the row still auto-resumes", async () => {
    seedResumableLocalRun("local-recycled-child");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-recycled-child");
    // The pid is alive (it is this test process) but the recorded spawn time is
    // an hour earlier, so the pid must have been recycled after a reboot.
    injected.setChildPid(claimedId, process.pid, Date.now() - 60 * 60 * 1_000);

    const warnings: string[] = [];
    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
    });

    const after = injected.getById(claimedId)!;
    expect(after.status).toBe("pending");
    expect(after.autoResumeCount).toBe(1);
    expect(after.childPid).toBeUndefined();
    expect(warnings.join("\n")).not.toContain("still running its previous attempt");
    injected.close();
  });

  test("settles a running row done when a run started after the claim succeeded", async () => {
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-succeeded");
    // The run must start after the current claim: that is what proves the
    // attempt this row is waiting on finished, rather than an older run.
    const runId = store.createRun({
      origin: "local",
      taskKey: "local-succeeded",
      tracker: "local",
      repo: "web-app",
      branch: "feature/local-succeeded",
    });
    store.finishRun(runId, "succeeded", "PR opened");

    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      log: () => {},
      warn: () => {},
    });

    const after = injected.getById(claimedId)!;
    expect(after.status).toBe("done");
    expect(after.message).toContain(`run #${runId} already succeeded`);
    injected.close();
  });

  test("does not settle a re-queued done row done on its pre-restart succeeded run", async () => {
    // `worker add --resume` re-queues `done` rows. If the worker crashes after
    // the new claim but before the replacement child starts a run, the latest
    // run is still the old succeeded one; treating it as done would silently
    // drop the operator's explicit re-run.
    const oldRunId = store.createRun({
      origin: "local",
      taskKey: "local-requeued",
      tracker: "local",
      repo: "web-app",
      branch: "feature/local-requeued",
    });
    store.finishRun(oldRunId, "succeeded", "PR opened");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-requeued");
    injected.finish(claimedId, "done", `run #${oldRunId} already succeeded`);

    expect(injected.requeueSettled("local-requeued")?.status).toBe("pending");
    expect(injected.claimNext()?.id).toBe(claimedId);

    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      log: () => {},
      warn: () => {},
    });

    const after = injected.getById(claimedId)!;
    expect(after.status).toBe("failed");
    expect(after.message).toBe("worker restarted while this task was running");
    injected.close();
  });

  test("reaps an un-reaped in_progress run and auto-resumes it", async () => {
    const runId = store.createRun({
      origin: "local",
      taskKey: "local-in-progress",
      tracker: "local",
      repo: "web-app",
      branch: "feature/local-in-progress",
    });
    store.addStage(
      runId,
      "implementation",
      "succeeded",
      undefined,
      JSON.stringify({ report: "prior implementation report" }),
    );
    // Deliberately leave the run `in_progress`: ordering or a failed sweep
    // means the injected hook may see an attempt that was never reaped.
    expect(store.getRun(runId)?.status).toBe("in_progress");

    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-in-progress");

    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
    });

    const after = injected.getById(claimedId)!;
    expect(after.status).toBe("pending");
    expect(after.autoResumeCount).toBe(1);
    expect(store.getRun(runId)?.status).toBe("failed");
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

  test("auto-resumes a report-less row whose branch has landed commits", async () => {
    // A run interrupted before its report was written — or one whose delivery
    // halted after the early success record — has only its commits as evidence.
    seedResumableLocalRun("local-commits-only", { report: null });
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-commits-only");

    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      hasLandedCommits: () => true,
    });

    const after = injected.getById(claimedId)!;
    expect(after.status).toBe("pending");
    expect(after.autoResumeCount).toBe(1);
    injected.close();
  });

  test("fails a report-less row when the commit probe finds no landed work", async () => {
    seedResumableLocalRun("local-empty-branch", { report: null });
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-empty-branch");

    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      hasLandedCommits: () => false,
    });

    expect(injected.getById(claimedId)?.status).toBe("failed");
    expect(injected.getById(claimedId)?.message).toBe(
      "worker restarted while this task was running",
    );
    expect(injected.getById(claimedId)?.autoResumeCount).toBe(0);
    injected.close();
  });

  test("keeps a report-backed row resumable even before it committed", async () => {
    // The report stays authoritative: an interruption between the agent session
    // and the commit is resumed and delivered by the replacement run instead of
    // being discarded because the branch is still empty.
    seedResumableLocalRun("local-report-no-commits");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-report-no-commits");

    await recoverOrphanedInjectedTasks(injected, {
      runStore: store,
      branchExists: () => true,
      hasLandedCommits: () => false,
    });

    const after = injected.getById(claimedId)!;
    expect(after.status).toBe("pending");
    expect(after.autoResumeCount).toBe(1);
    injected.close();
  });

  test("still fails a report-less row when no commit probe is available", async () => {
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

  test("startup work counts a running injected row in an injected-only workspace", () => {
    const injected = new InjectedTaskStore(dbPath);
    const retryQueue = new ScheduledRetryStore(dbPath);
    const config = {
      workspace: {},
      defaults: { tracker: "jira", pollIntervalSeconds: 60 },
      repos: [],
      routing: [],
      automations: [],
      estimations: [],
      errorMonitors: [],
    } as unknown as WorkspaceConfig;

    const claimedId = claimInjected(injected, "local-running-startup");
    // The bug: `hasPending()` alone is false once the row is claimed.
    expect(injected.hasPending()).toBe(false);
    expect(workspaceHasStartupWork(config, retryQueue, injected, false, undefined)).toBe(true);

    injected.finish(claimedId, "done");
    expect(workspaceHasStartupWork(config, retryQueue, injected, false, undefined)).toBe(false);
    injected.close();
    retryQueue.close();
  });

  test("defaults the auto-resume budget to one and honors WORKER_INJECTED_AUTO_RESUME_LIMIT=0", async () => {
    delete process.env.WORKER_INJECTED_AUTO_RESUME_LIMIT;
    seedResumableLocalRun("local-env-default");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-env-default");
    try {
      // No explicit option: the env default (1) applies.
      await recoverOrphanedInjectedTasks(injected, {
        runStore: store,
        branchExists: () => true,
      });
      expect(injected.getById(claimedId)?.status).toBe("pending");
      expect(injected.getById(claimedId)?.autoResumeCount).toBe(1);

      expect(injected.claimNext()?.id).toBe(claimedId);
      await recoverOrphanedInjectedTasks(injected, {
        runStore: store,
        branchExists: () => true,
      });
      expect(injected.getById(claimedId)?.status).toBe("failed");
      expect(injected.getById(claimedId)?.message).toContain(
        "devintern worker add --resume local-env-default",
      );
    } finally {
      injected.close();
    }
  });

  test("WORKER_INJECTED_AUTO_RESUME_LIMIT=0 disables automatic resume", async () => {
    process.env.WORKER_INJECTED_AUTO_RESUME_LIMIT = "0";
    seedResumableLocalRun("local-env-zero");
    const injected = new InjectedTaskStore(dbPath);
    const claimedId = claimInjected(injected, "local-env-zero");
    try {
      await recoverOrphanedInjectedTasks(injected, {
        runStore: store,
        branchExists: () => true,
      });
      const after = injected.getById(claimedId)!;
      expect(after.status).toBe("failed");
      expect(after.autoResumeCount).toBe(0);
      expect(after.message).toContain("devintern worker add --resume local-env-zero");
    } finally {
      injected.close();
    }
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

describe("injected startup recovery (production wiring)", () => {
  let rootDir: string;
  let originDir: string;
  let workspaceDir: string;
  let dbPath: string;
  const savedEnv = { ...process.env };

  function git(cwd: string, command: string): string {
    return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
  }

  function repo(): RepoConfig {
    return {
      name: "backend",
      remote: `file://${originDir}`,
      defaultBranch: "main",
      env: {},
    };
  }

  beforeEach(() => {
    rootDir = join(
      tmpdir(),
      `injected-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    originDir = join(rootDir, "origin");
    workspaceDir = join(rootDir, "workspace");
    mkdirSync(originDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    git(originDir, "init -b main");
    git(originDir, 'config user.name "Fixture User"');
    git(originDir, 'config user.email "fixture@example.com"');
    writeFileSync(join(originDir, "README.md"), "# Fixture\n");
    git(originDir, "add .");
    git(originDir, 'commit -m "Initial commit"');
    dbPath = workspaceDbPath(workspaceDir);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(rootDir, { recursive: true, force: true });
  });

  /** Seed a resumable local run in the workspace DB the production hook opens. */
  function seedResumableRun(
    taskKey: string,
    options: { finish?: boolean; report?: string | null } = {},
  ): void {
    const runStore = new RunStore(dbPath);
    try {
      const runId = runStore.createRun({
        origin: "local",
        taskKey,
        tracker: "local",
        repo: "backend",
        branch: `feature/${taskKey}`,
      });
      const report = options.report === undefined ? "prior implementation report" : options.report;
      if (report !== null) {
        runStore.addStage(
          runId,
          "implementation",
          "succeeded",
          undefined,
          JSON.stringify({ report }),
        );
      }
      if (options.finish !== false) {
        runStore.finishRun(
          runId,
          "failed",
          "worker stopped cleanly; interruption feedback already handled",
        );
      }
    } finally {
      runStore.close();
    }
  }

  function claimInjected(taskKey: string): { store: InjectedTaskStore; id: number } {
    const store = new InjectedTaskStore(dbPath);
    store.enqueue({
      taskKey,
      repo: "backend",
      title: taskKey,
      body: "",
      taskFile: join(workspaceDir, "injected", `${taskKey}.md`),
    });
    return { store, id: store.claimNext()!.id };
  }

  /**
   * Clone the fixture like the injected executor does, without a base worktree.
   *
   * `commit` lands a file on the task branch so the commit probe has evidence to
   * verify, matching a run that committed before the crash.
   */
  async function cloneLikeInjectedRun(
    taskKey?: string,
    options: { commit?: boolean } = {},
  ): Promise<RepoManager> {
    const manager = new RepoManager(workspaceDir);
    await manager.ensureBareClone(repo());
    if (taskKey) {
      const worktree = await manager.createTaskWorktree(repo(), taskKey);
      git(worktree, `checkout -b feature/${taskKey}`);
      if (options.commit) {
        git(worktree, 'config user.name "Fixture User"');
        git(worktree, 'config user.email "fixture@example.com"');
        writeFileSync(join(worktree, "work.txt"), "landed work\n");
        git(worktree, "add .");
        git(worktree, 'commit -m "landed work"');
      }
    }
    return manager;
  }

  const missingTask = { repo: "backend" } as InjectedTask;

  test("branch probe reads the bare clone when no base worktree exists", async () => {
    const manager = await cloneLikeInjectedRun("local-probe");
    // An injected-only workspace never materializes the base worktree.
    expect(existsSync(manager.baseWorktreePath("backend"))).toBe(false);

    const probe = createInjectedBranchExistsProbe(workspaceDir);
    expect(await probe("feature/local-probe", missingTask)).toBe(true);
    expect(await probe("feature/local-missing", missingTask)).toBe(false);
  });

  test("branch probe refuses to resume when the repo cannot be probed", async () => {
    const probe = createInjectedBranchExistsProbe(workspaceDir);
    expect(await probe("feature/anything", missingTask)).toBe(false);
  });

  test("commit probe reads landed work from the bare clone", async () => {
    await cloneLikeInjectedRun("local-commit-ahead", { commit: true });
    await cloneLikeInjectedRun("local-commit-empty");
    const probe = createInjectedCommitProbe(workspaceDir);

    expect(await probe("feature/local-commit-ahead", missingTask)).toBe(true);
    // Same base, no commits of its own: nothing to resume.
    expect(await probe("feature/local-commit-empty", missingTask)).toBe(false);
    expect(await probe("feature/local-never-created", missingTask)).toBe(false);
  });

  test("commit probe refuses to resume when the repo cannot be probed", async () => {
    const probe = createInjectedCommitProbe(workspaceDir);
    expect(await probe("feature/anything", missingTask)).toBe(false);
  });

  test("auto-resumes through the production hook a report-less run with landed commits", async () => {
    seedResumableRun("local-prod-commits", { report: null });
    await cloneLikeInjectedRun("local-prod-commits", { commit: true });
    const { store, id } = claimInjected("local-prod-commits");
    const recovery = createInjectedStartupRecovery(store, workspaceDir);

    try {
      await recovery.hook();
      const after = store.getById(id)!;
      expect(after.status).toBe("pending");
      expect(after.autoResumeCount).toBe(1);
    } finally {
      recovery.close();
      store.close();
    }
  });

  test("fails through the production hook a report-less run with an empty branch", async () => {
    seedResumableRun("local-prod-empty", { report: null });
    await cloneLikeInjectedRun("local-prod-empty");
    const { store, id } = claimInjected("local-prod-empty");
    const recovery = createInjectedStartupRecovery(store, workspaceDir);

    try {
      await recovery.hook();
      const after = store.getById(id)!;
      expect(after.status).toBe("failed");
      expect(after.message).toBe("worker restarted while this task was running");
      expect(after.autoResumeCount).toBe(0);
    } finally {
      recovery.close();
      store.close();
    }
  });

  test("auto-resumes through the production hook when the branch still exists", async () => {
    seedResumableRun("local-prod-resume");
    await cloneLikeInjectedRun("local-prod-resume");
    const { store, id } = claimInjected("local-prod-resume");
    const order: string[] = [];
    const recovery = createInjectedStartupRecovery(store, workspaceDir, () => {
      order.push("caller");
    });

    try {
      await recovery.hook();
      const after = store.getById(id)!;
      expect(after.status).toBe("pending");
      expect(after.autoResumeCount).toBe(1);
      expect(order).toEqual(["caller"]);
    } finally {
      recovery.close();
      store.close();
    }
  });

  test("auto-resumes through the production hook from an un-reaped in_progress run", async () => {
    seedResumableRun("local-prod-in-progress", { finish: false });
    await cloneLikeInjectedRun("local-prod-in-progress");
    const { store, id } = claimInjected("local-prod-in-progress");
    const recovery = createInjectedStartupRecovery(store, workspaceDir);

    try {
      await recovery.hook();
      const after = store.getById(id)!;
      expect(after.status).toBe("pending");
      expect(after.autoResumeCount).toBe(1);
    } finally {
      recovery.close();
      store.close();
    }
  });

  test("fails through the production hook when the recorded branch is gone", async () => {
    seedResumableRun("local-prod-gone");
    // Clone exists but the task branch was never created (or already deleted).
    await cloneLikeInjectedRun();
    const { store, id } = claimInjected("local-prod-gone");
    const recovery = createInjectedStartupRecovery(store, workspaceDir);

    try {
      await recovery.hook();
      const after = store.getById(id)!;
      expect(after.status).toBe("failed");
      expect(after.message).toBe("worker restarted while this task was running");
      expect(after.autoResumeCount).toBe(0);
    } finally {
      recovery.close();
      store.close();
    }
  });

  test("closes its run store on shutdown", () => {
    const closeSpy = spyOn(RunStore.prototype, "close");
    const store = new InjectedTaskStore(dbPath);
    const recovery = createInjectedStartupRecovery(store, workspaceDir);
    try {
      expect(closeSpy).not.toHaveBeenCalled();
      recovery.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
      store.close();
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
