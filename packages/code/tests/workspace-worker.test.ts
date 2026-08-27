import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { RepoConfig } from "../src/lib/workspace/config";
import {
  buildFleetEventAcquirers,
  createWorkspaceTaskAcquirer,
  fleetTaskArgs,
  resolveWorkspaceAutomationContext,
} from "../src/lib/workspace/workspace-worker";
import type { FleetTask, RepoManagerLike } from "../src/lib/workspace/workspace-worker";
import { createRepoRunLock, openWorkspaceState } from "../src/lib/workspace/state";
import type { WorkspaceState } from "../src/lib/workspace/state";
import type { ChangeDetector } from "../src/lib/change-detector";
import { RunStore } from "../src/lib/run-recorder";
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

describe("coordinated execution trigger on ambiguous routing", () => {
  const HINTED_CONFIG = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
task_query = "status=todo"

[[repos]]
name = "shared-config"
remote = "git@github.com:acme/shared-config.git"
  [repos.hints]
  purpose = "Shared feature flags"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
  [repos.hints]
  purpose = "API service"
  depends_on = ["shared-config"]

[[routing.rules]]
repo = "shared-config"
labels = ["flags"]

[[routing.rules]]
repo = "backend"
labels = ["backend"]
`);

  let workspaceDir: string;
  let state: WorkspaceState;
  let repoManager: FakeRepoManager;
  let runs: RunStore;
  let ranRepos: string[];
  let runResult: boolean;

  beforeEach(() => {
    workspaceDir = join(
      tmpdir(),
      `ws-coord-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    state = openWorkspaceState(workspaceDir);
    repoManager = new FakeRepoManager(workspaceDir);
    runs = new RunStore(join(workspaceDir, "state", "queue.db"));
    ranRepos = [];
    runResult = true;
  });

  afterEach(() => {
    state.close();
    runs.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function makeAcquirer(plannerResult: unknown) {
    return createWorkspaceTaskAcquirer({
      config: HINTED_CONFIG,
      workspaceDir,
      workerState: state.workerState,
      queue: state.queue,
      skips: state.skips,
      repoManager,
      detector: alwaysChanged,
      searchTasks: async () => ({
        tasks: [{ key: "T-9", updated: "u1", labels: ["backend", "flags"] }],
      }),
      query: "status=todo",
      intervalSeconds: 3600,
      runTask: async (_taskKey, _args, opts) => {
        const afterWorktrees = opts.cwd.split(/worktrees[\\/]/)[1] ?? "";
        ranRepos.push(afterWorktrees.split(/[\\/]/)[0] ?? "?");
        return runResult;
      },
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
      coordination: {
        coordinationStore: state.coordination,
        runStore: runs,
        planner: async () => plannerResult as never,
      },
    });
  }

  test("an ambiguous task with hinted candidates runs as one coordinated effort", async () => {
    const acquirer = makeAcquirer({
      ok: true,
      entries: [
        {
          repo: "backend",
          rationale: "implements",
          change: "code",
          dependencies: ["shared-config"],
        },
        { repo: "shared-config", rationale: "flag first", change: "flag", dependencies: [] },
      ],
      executionOrder: ["shared-config", "backend"],
    });
    await acquirer.tick();

    // Both planned repos ran through the same single-repo pipeline.
    expect(ranRepos).toEqual(["shared-config", "backend"]);
    // No routing skip was recorded; the effort is tracked in coordination state.
    expect(state.skips.list()).toHaveLength(0);
    const effort = state.coordination.latestForTask("T-9");
    expect(effort?.status).toBe("completed");
    expect(effort?.plan?.executionOrder).toEqual(["shared-config", "backend"]);
  });

  test("a planning failure records an unplanned skip and touches no repository", async () => {
    const acquirer = makeAcquirer({
      ok: false,
      errors: ["Plan selected no repositories; refusing to guess."],
    });
    await acquirer.tick();

    expect(ranRepos).toEqual([]);
    const skips = state.skips.list();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.reason).toBe("unplanned");
    expect(skips[0]?.candidates).toEqual(["backend", "shared-config"]);
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
