import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { RepoConfig } from "../src/lib/workspace/config";
import {
  buildFleetEventAcquirers,
  createFleetTaskExecutor,
  createWorkspaceTaskAcquirer,
  fleetTaskArgs,
  resolveWorkspaceAutomationContext,
  startWorktreeSweeper,
  sweepAllWorktrees,
} from "../src/lib/workspace/workspace-worker";
import type { FleetTask, RepoManagerLike } from "../src/lib/workspace/workspace-worker";
import { createRepoRunLock, openWorkspaceState } from "../src/lib/workspace/state";
import type { WorkspaceState } from "../src/lib/workspace/state";
import type { ChangeDetector } from "../src/lib/change-detector";
import { RunCoordinator } from "../src/lib/run-coordinator";
import { toRoutableTask } from "../src/lib/workspace/router";
import { saveRelayState } from "../src/lib/relay-connect";

const CONFIG = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
task_query = "status=todo"
worker_task_args = "--create-pr --auto-review"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"

[[routing.rules]]
repo = "backend"
labels = ["backend"]

[[routing.rules]]
repo = "frontend"
labels = ["frontend"]
`);

class FakeRepoManager implements RepoManagerLike {
  calls: string[] = [];
  worktrees: string[] = [];
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  async ensureBareClone(repo: RepoConfig): Promise<string> {
    this.calls.push(`clone:${repo.name}`);
    return join(this.root, "repos", `${repo.name}.git`);
  }

  async fetch(repoName: string): Promise<void> {
    this.calls.push(`fetch:${repoName}`);
  }

  async ensureBaseWorktree(repo: RepoConfig): Promise<string> {
    const path = join(this.root, "worktrees", repo.name, "base");
    mkdirSync(path, { recursive: true });
    this.calls.push(`base:${repo.name}`);
    return path;
  }

  async createTaskWorktree(repo: RepoConfig, taskKey: string): Promise<string> {
    const path = join(this.root, "worktrees", repo.name, taskKey.toLowerCase());
    mkdirSync(path, { recursive: true });
    this.worktrees.push(path);
    this.calls.push(`worktree:${repo.name}:${taskKey}`);
    return path;
  }

  async removeTaskWorktree(_repoName: string, worktreePath: string): Promise<void> {
    rmSync(worktreePath, { recursive: true, force: true });
    this.calls.push(`remove:${worktreePath}`);
  }

  async sweepStaleWorktrees(): Promise<string[]> {
    return [];
  }
}

const alwaysChanged: ChangeDetector = {
  source: "markdown",
  async changesSince(cursor) {
    return { changed: true, nextCursor: (cursor ? parseInt(cursor, 10) + 1 : 1).toString() };
  },
};

describe("createWorkspaceTaskAcquirer", () => {
  let workspaceDir: string;
  let state: WorkspaceState;
  let repoManager: FakeRepoManager;
  let ran: Array<{
    taskKey: string;
    args: string[];
    cwd: string;
    env: Record<string, string | undefined>;
  }>;
  let runResult: boolean;
  let tasks: FleetTask[];

  const makeAcquirer = () =>
    createWorkspaceTaskAcquirer({
      config: CONFIG,
      workspaceDir,
      workerState: state.workerState,
      queue: state.queue,
      skips: state.skips,
      repoManager,
      detector: alwaysChanged,
      searchTasks: async () => ({ tasks }),
      query: "status=todo",
      intervalSeconds: 3600,
      runTask: async (taskKey, args, opts) => {
        ran.push({ taskKey, args, cwd: opts.cwd, env: opts.env });
        return runResult;
      },
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
    });

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    state = openWorkspaceState(workspaceDir);
    repoManager = new FakeRepoManager(workspaceDir);
    ran = [];
    runResult = true;
    tasks = [];
  });

  afterEach(() => {
    state.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("routed tasks run in their repo's worktree with the composed env", async () => {
    tasks = [{ key: "T-1", updated: "u1", labels: ["backend"] }];
    const acquirer = makeAcquirer();
    await acquirer.tick();

    expect(ran).toHaveLength(1);
    expect(ran[0].taskKey).toBe("T-1");
    expect(ran[0].args).toEqual(["--create-pr", "--auto-review"]);
    expect(ran[0].cwd).toContain(join("worktrees", "backend"));
    expect(ran[0].env.GITHUB_REPO).toBe("acme/backend");
    expect(ran[0].env.WEBHOOK_QUEUE_DB).toBe(join(workspaceDir, "state", "queue.db"));
    expect(ran[0].env.DEVINTERN_RUN_ORIGIN).toBe("worker");

    // Successful run: worktree removed.
    expect(existsSync(ran[0].cwd)).toBe(false);
    expect(repoManager.calls).toContain("clone:backend");
    expect(repoManager.calls).toContain("fetch:backend");
  });

  test("failed runs keep the worktree for debugging", async () => {
    runResult = false;
    tasks = [{ key: "T-2", updated: "u1", labels: ["frontend"] }];
    const acquirer = makeAcquirer();
    await acquirer.tick();

    expect(ran).toHaveLength(1);
    expect(existsSync(ran[0].cwd)).toBe(true);
  });

  test("ambiguous tasks are recorded, not executed, and not retried at the same stamp", async () => {
    tasks = [{ key: "T-3", updated: "u1", labels: ["backend", "frontend"] }];
    const acquirer = makeAcquirer();
    await acquirer.tick();

    expect(ran).toHaveLength(0);
    const skips = state.skips.list();
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toBe("ambiguous");
    expect(skips[0].candidates).toEqual(["backend", "frontend"]);

    // Same updated stamp: deduped, no second skip and still no run.
    await acquirer.tick();
    expect(ran).toHaveLength(0);
    expect(state.skips.list()).toHaveLength(1);

    // The task changes: it re-enters and is re-evaluated.
    tasks = [{ key: "T-3", updated: "u2", labels: ["backend"] }];
    await acquirer.tick();
    expect(ran).toHaveLength(1);
  });

  test("unrouted tasks are recorded with no candidates", async () => {
    tasks = [{ key: "T-4", updated: "u1", labels: ["docs"] }];
    const acquirer = makeAcquirer();
    await acquirer.tick();

    expect(ran).toHaveLength(0);
    expect(state.skips.list()[0]).toMatchObject({ reason: "unrouted", candidates: [] });
  });

  test("the repo run lock is held during execution and released after", async () => {
    tasks = [{ key: "T-5", updated: "u1", labels: ["backend"] }];
    let lockedDuringRun = false;
    const acquirer = createWorkspaceTaskAcquirer({
      config: CONFIG,
      workspaceDir,
      workerState: state.workerState,
      queue: state.queue,
      skips: state.skips,
      repoManager,
      detector: alwaysChanged,
      searchTasks: async () => ({ tasks }),
      query: "status=todo",
      intervalSeconds: 3600,
      runTask: async () => {
        lockedDuringRun = !createRepoRunLock("backend", workspaceDir).acquire().success;
        return true;
      },
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
    });

    await acquirer.tick();
    expect(lockedDuringRun).toBe(true);
    // Released afterwards.
    const after = createRepoRunLock("backend", workspaceDir).acquire();
    expect(after.success).toBe(true);
  });

  test("a task deferred by a busy repo retries on the next poll", async () => {
    tasks = [{ key: "T-6", updated: "u1", labels: ["backend"] }];
    const heldLock = createRepoRunLock("backend", workspaceDir);
    expect(heldLock.acquire().success).toBe(true);
    const acquirer = makeAcquirer();

    await acquirer.tick();
    expect(ran).toHaveLength(0);
    expect(state.workerState.getCursor("markdown")).toBeNull();
    expect(state.queue.hasProcessed("markdown", "task:T-6:u1")).toBe(false);

    heldLock.release();
    await acquirer.tick();
    expect(ran.map((run) => run.taskKey)).toEqual(["T-6"]);
    expect(state.workerState.getCursor("markdown")?.cursorValue).toBe("1");
    expect(state.queue.hasProcessed("markdown", "task:T-6:u1")).toBe(true);
  });
});

describe("createFleetTaskExecutor serialization", () => {
  let workspaceDir: string;
  let state: WorkspaceState;
  let repoManager: FakeRepoManager;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-coord-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    state = openWorkspaceState(workspaceDir);
    repoManager = new FakeRepoManager(workspaceDir);
  });

  afterEach(() => {
    state.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("with a coordinator, task runs wait for held agent slots (account-global limits)", async () => {
    const coordinator = new RunCoordinator();
    let agentStarted = false;
    const executor = createFleetTaskExecutor({
      config: CONFIG,
      workspaceDir,
      skips: state.skips,
      repoManager,
      runTask: async () => {
        agentStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      },
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
      coordinator,
    });

    // A scheduled estimation sweep holds the process-level slot first.
    const releaseEstimation = await coordinator.acquire();
    const routable = toRoutableTask({ key: "T-C1", labels: ["backend"], components: [] });
    const running = executor("T-C1", routable);

    await new Promise((resolve) => setTimeout(resolve, 30));
    // Repo preparation may proceed, but no agent process starts while the
    // estimation sweep holds the account-global slot.
    expect(agentStarted).toBe(false);
    expect(repoManager.calls).toContain("worktree:backend:T-C1");

    releaseEstimation();
    await running;
    expect(agentStarted).toBe(true);
  });

  test("without a coordinator, runs start immediately (unchanged legacy behavior)", async () => {
    const executor = createFleetTaskExecutor({
      config: CONFIG,
      workspaceDir,
      skips: state.skips,
      repoManager,
      runTask: async () => true,
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
    });
    const routable = toRoutableTask({ key: "T-C2", labels: ["backend"], components: [] });
    const result = await executor("T-C2", routable);
    expect(result).toBe(true);
    expect(repoManager.calls).toContain("worktree:backend:T-C2");
  });
});

describe("fleetTaskArgs", () => {
  test("uses worker_task_args from the workspace config", () => {
    expect(fleetTaskArgs(CONFIG)).toEqual(["--create-pr", "--auto-review"]);
  });
  test("defaults to --create-pr when worker_task_args is omitted", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
`);
    expect(fleetTaskArgs(config)).toEqual(["--create-pr"]);
  });
});

describe("buildFleetEventAcquirers", () => {
  test("starts tracker relay without GitHub polling credentials", async () => {
    const workspaceDir = join(
      tmpdir(),
      `ws-relay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    const state = openWorkspaceState(workspaceDir);
    const repoManager = new FakeRepoManager(workspaceDir);
    const savedToken = process.env.GITHUB_TOKEN;
    const savedAppId = process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_APP_ID;
    saveRelayState(
      {
        relayUrl: "https://relay.test",
        customerId: "customer-1",
        connectedAt: new Date(0).toISOString(),
        registrations: [],
        relayToken: "drt_test",
      },
      workspaceDir,
    );

    try {
      const acquirers = await buildFleetEventAcquirers({
        config: CONFIG,
        workspaceDir,
        state,
        repoManager,
        searchTasks: async () => ({ tasks: [] }),
        query: "status=todo",
        intervalSeconds: 60,
      });
      expect(acquirers.map((acquirer) => acquirer.name)).toEqual(["relay"]);
    } finally {
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedToken;
      if (savedAppId === undefined) delete process.env.GITHUB_APP_ID;
      else process.env.GITHUB_APP_ID = savedAppId;
      state.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("resolveWorkspaceAutomationContext", () => {
  test("does not prepare the repository when its run lock is unavailable", async () => {
    const workspaceDir = join(
      tmpdir(),
      `ws-automation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const repoManager = new FakeRepoManager(workspaceDir);
    const context = await resolveWorkspaceAutomationContext(
      {
        id: "scheduled",
        enabled: true,
        prompt: "work",
        interval: "1h",
        intervalMs: 3_600_000,
        repo: "backend",
      },
      CONFIG,
      workspaceDir,
      repoManager,
      () => ({
        acquire: () => ({ success: false, message: "busy" }),
        release() {},
      }),
    );

    expect(context).toBeNull();
    expect(repoManager.calls).toEqual([]);
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("pins occurrence task files to the workspace home", async () => {
    const workspaceDir = join(
      tmpdir(),
      `ws-automation-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const repoManager = new FakeRepoManager(workspaceDir);
    const context = await resolveWorkspaceAutomationContext(
      {
        id: "scheduled",
        enabled: true,
        prompt: "work",
        interval: "1h",
        intervalMs: 3_600_000,
        repo: "backend",
      },
      CONFIG,
      workspaceDir,
      repoManager,
    );

    expect(context?.taskFileDir).toBe(join(workspaceDir, "automations"));
    expect(context?.cwd).toContain(join("worktrees", "backend", "base"));
    rmSync(workspaceDir, { recursive: true, force: true });
  });
});

describe("worktree sweeping", () => {
  const REPOS: RepoConfig[] = [
    { name: "backend", remote: "https://github.com/acme/backend.git", env: {} },
    { name: "frontend", remote: "https://github.com/acme/frontend.git", env: {} },
  ];

  function fakeSweeper(removedPerRepo: Record<string, string[]>) {
    const swept: Array<{ repo: string; ttlDays: number }> = [];
    return {
      swept,
      repoManager: {
        sweepStaleWorktrees: async (repoName: string, ttlDays: number) => {
          swept.push({ repo: repoName, ttlDays });
          return removedPerRepo[repoName] ?? [];
        },
      } as unknown as RepoManagerLike,
    };
  }

  test("sweepAllWorktrees sweeps every repo and counts removals", async () => {
    const { swept, repoManager } = fakeSweeper({ backend: ["/tmp/wt-a", "/tmp/wt-b"] });

    const removed = await sweepAllWorktrees(REPOS, repoManager, 7);

    expect(removed).toBe(2);
    expect(swept).toEqual([
      { repo: "backend", ttlDays: 7 },
      { repo: "frontend", ttlDays: 7 },
    ]);
  });

  test("startWorktreeSweeper sweeps periodically until cleared", async () => {
    const { swept, repoManager } = fakeSweeper({});

    const timer = startWorktreeSweeper(REPOS, repoManager, 7, 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(swept.length).toBeGreaterThanOrEqual(REPOS.length);
      expect(swept.every((entry) => entry.ttlDays === 7)).toBe(true);
    } finally {
      clearInterval(timer);
    }

    const countAfterClear = swept.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(swept.length).toBe(countAfterClear);
  });
});
