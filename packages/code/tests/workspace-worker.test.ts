import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { RepoConfig } from "../src/lib/workspace/config";
import {
  createWorkspaceTaskAcquirer,
  createFleetTaskExecutor,
  fleetTaskArgs,
} from "../src/lib/workspace/workspace-worker";
import type { FleetTask, RepoManagerLike } from "../src/lib/workspace/workspace-worker";
import { WorkspaceScheduler } from "../src/lib/workspace/scheduler";
import { createRepoRunLock, openWorkspaceState } from "../src/lib/workspace/state";
import type { WorkspaceState } from "../src/lib/workspace/state";
import type { ChangeDetector } from "../src/lib/change-detector";

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
});

describe("fleetTaskArgs", () => {
  test("workspace defaults win over the env default", () => {
    expect(fleetTaskArgs(CONFIG)).toEqual(["--create-pr", "--auto-review"]);
  });
});

describe("parallel fleet execution", () => {
  let workspaceDir: string;
  let state: WorkspaceState;
  let repoManager: FakeRepoManager;
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-par-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    state = openWorkspaceState(workspaceDir);
    repoManager = new FakeRepoManager(workspaceDir);
  });

  afterEach(async () => {
    state.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  interface TrackedRun {
    taskKey: string;
    startedAt: number;
    finishedAt: number;
  }

  /** Build a runTask that records starts immediately; gates hold completion. */
  const trackedRunnerFactory = (
    runs: TrackedRun[],
    gates: Map<string, Promise<void>> = new Map(),
    result = true,
  ) => {
    return async (taskKey: string): Promise<boolean> => {
      runs.push({ taskKey, startedAt: Date.now(), finishedAt: 0 });
      await (gates.get(taskKey) ?? Promise.resolve());
      const run = runs.find((r) => r.taskKey === taskKey && r.finishedAt === 0);
      if (run) {
        run.finishedAt = Date.now();
      }
      return result;
    };
  };

  const makeParallelAcquirer = (options: {
    scheduler: WorkspaceScheduler;
    tasks: FleetTask[];
    runTask: (taskKey: string, args: string[], opts: unknown) => Promise<boolean>;
    repoLock?: (name: string) => ReturnType<typeof createRepoRunLock>;
  }) =>
    createWorkspaceTaskAcquirer({
      config: CONFIG,
      workspaceDir,
      workerState: state.workerState,
      queue: state.queue,
      skips: state.skips,
      repoManager,
      detector: alwaysChanged,
      searchTasks: async () => ({ tasks: options.tasks }),
      query: "status=todo",
      intervalSeconds: 3600,
      scheduler: options.scheduler,
      runTask: options.runTask as never,
      repoLock: options.repoLock ?? ((name) => createRepoRunLock(name, workspaceDir)),
    });

  test("serial default: without a scheduler, tasks still run one at a time", async () => {
    const runs: TrackedRun[] = [];
    const gates = new Map<string, Promise<void>>();
    let releaseFirst!: () => void;
    gates.set(
      "T-1",
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const tasks = [
      { key: "T-1", updated: "u1", labels: ["backend"] },
      { key: "T-2", updated: "u1", labels: ["frontend"] },
    ];
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
      runTask: trackedRunnerFactory(runs, gates),
    });

    const tick = acquirer.tick();
    await delay(10);
    // T-1 holds the single implicit slot; T-2 has not started.
    expect(runs.map((r) => r.taskKey)).toEqual(["T-1"]);
    releaseFirst();
    await tick;
    expect(runs.map((r) => r.taskKey)).toEqual(["T-1", "T-2"]);
  });

  test("parallel mode: tasks for different repos run concurrently", async () => {
    const runs: TrackedRun[] = [];
    const gates = new Map<string, Promise<void>>();
    let releaseBackend!: () => void;
    let releaseFrontend!: () => void;
    gates.set(
      "P-1",
      new Promise<void>((resolve) => {
        releaseBackend = resolve;
      }),
    );
    gates.set(
      "P-2",
      new Promise<void>((resolve) => {
        releaseFrontend = resolve;
      }),
    );
    const tasks = [
      { key: "P-1", updated: "u1", labels: ["backend"] },
      { key: "P-2", updated: "u1", labels: ["frontend"] },
    ];
    const acquirer = makeParallelAcquirer({
      scheduler: new WorkspaceScheduler({ maxConcurrent: 4 }),
      tasks,
      runTask: trackedRunnerFactory(runs, gates) as never,
    });

    const tick = acquirer.tick();
    await delay(10);
    // Both repos are in flight simultaneously.
    expect(runs.map((r) => r.taskKey).sort()).toEqual(["P-1", "P-2"]);
    releaseBackend();
    releaseFrontend();
    await tick;
  });

  test("the global limit caps concurrent runs across repos", async () => {
    const runs: TrackedRun[] = [];
    const gates = new Map<string, Promise<void>>();
    let inFlight = 0;
    let peak = 0;
    let releaseAll!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    for (const key of ["L-1", "L-2", "L-3"]) {
      gates.set(key, barrier);
    }
    const rawRunner = async (taskKey: string): Promise<boolean> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await (gates.get(taskKey) ?? Promise.resolve());
      inFlight--;
      runs.push({ taskKey, startedAt: Date.now(), finishedAt: Date.now() });
      return true;
    };
    const tasks = [
      { key: "L-1", updated: "u1", labels: ["backend"] },
      { key: "L-2", updated: "u1", labels: ["frontend"] },
      { key: "L-3", updated: "u1", labels: ["backend"] },
    ];
    const acquirer = makeParallelAcquirer({
      scheduler: new WorkspaceScheduler({ maxConcurrent: 2 }),
      tasks,
      runTask: rawRunner as never,
    });

    const tick = acquirer.tick();
    await delay(10);
    expect(peak).toBe(2); // limit enforced even with three ready tasks
    releaseAll();
    await tick;
    expect(runs).toHaveLength(3);
  });

  test("same-repo work queues behind an active run instead of overlapping or dropping", async () => {
    const runs: TrackedRun[] = [];
    const gates = new Map<string, Promise<void>>();
    let releaseFirst!: () => void;
    gates.set(
      "S-1",
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const tasks = [
      { key: "S-1", updated: "u1", labels: ["backend"] },
      { key: "S-2", updated: "u1", labels: ["backend"] },
    ];
    const acquirer = makeParallelAcquirer({
      scheduler: new WorkspaceScheduler({ maxConcurrent: 4 }),
      tasks,
      runTask: trackedRunnerFactory(runs, gates) as never,
    });

    const tick = acquirer.tick();
    await delay(10);
    expect(runs.map((r) => r.taskKey)).toEqual(["S-1"]); // S-2 waits in lane

    // While queued, the task is marked processed but not lost.
    expect(state.queue.hasProcessed("markdown", "task:S-2:u1")).toBe(true);

    releaseFirst();
    await tick;
    expect(runs.map((r) => r.taskKey)).toEqual(["S-1", "S-2"]);
  });

  test("cross-process lock contention defers the run without consuming dedupe", async () => {
    const runs: TrackedRun[] = [];
    // Simulate another process holding the backend repo lock.
    const foreignLock = createRepoRunLock("backend", workspaceDir);
    expect(foreignLock.acquire().success).toBe(true);

    const tasks = [
      { key: "C-1", updated: "u1", labels: ["backend"] },
      { key: "C-2", updated: "u1", labels: ["frontend"] },
    ];
    const acquirer = makeParallelAcquirer({
      scheduler: new WorkspaceScheduler({ maxConcurrent: 2, retryDelayMs: 5 }),
      tasks,
      runTask: trackedRunnerFactory(runs) as never,
    });

    const tick = acquirer.tick();
    await delay(20);
    // Contended task deferred; independent repo already ran.
    expect(runs.map((r) => r.taskKey)).toEqual(["C-2"]);
    // Dedupe mark survives deferral... and will be rolled back only if the
    // work is cancelled; while merely waiting it stays.
    expect(state.queue.hasProcessed("markdown", "task:C-1:u1")).toBe(true);

    foreignLock.release(); // other process finishes
    await tick;
    expect(runs.map((r) => r.taskKey)).toEqual(["C-2", "C-1"]);
  }, 10000);

  test("shutdown drain cancels queued tasks and rolls their dedupe marks back", async () => {
    const runs: TrackedRun[] = [];
    const gates = new Map<string, Promise<void>>();
    const releases: Array<() => void> = [];
    gates.set(
      "D-1",
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
    );
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 1 });
    const tasks = [
      { key: "D-1", updated: "u1", labels: ["backend"] },
      { key: "D-2", updated: "u1", labels: ["frontend"] },
    ];
    const acquirer = makeParallelAcquirer({
      scheduler,
      tasks,
      runTask: trackedRunnerFactory(runs, gates) as never,
    });

    const tick = acquirer.tick();
    await delay(10);
    expect(runs.map((r) => r.taskKey)).toEqual(["D-1"]);
    expect(state.queue.hasProcessed("markdown", "task:D-2:u1")).toBe(true);

    // Drain concurrently with the in-flight run finishing.
    const drainPromise = scheduler.drain();
    releases.forEach((release) => release());
    const summary = await drainPromise;
    expect(summary.cancelled).toBe(1);
    expect(summary.drained).toBe(1);
    // The cancelled task's dedupe record was rolled back so the next start
    // re-acquires it.
    expect(state.queue.hasProcessed("markdown", "task:D-2:u1")).toBe(false);

    await tick;
    expect(runs.map((r) => r.taskKey)).toEqual(["D-1"]);
  });

  test("a failed run does not affect concurrent runs in other repos", async () => {
    const runs: string[] = [];
    const tasks = [
      { key: "F-1", updated: "u1", labels: ["backend"] },
      { key: "F-2", updated: "u1", labels: ["frontend"] },
    ];
    const acquirer = makeParallelAcquirer({
      scheduler: new WorkspaceScheduler({ maxConcurrent: 4 }),
      tasks,
      runTask: (async (taskKey: string) => {
        if (taskKey === "F-1") {
          throw new Error("worktree exploded");
        }
        runs.push(taskKey);
        return true;
      }) as never,
    });

    await acquirer.tick();
    expect(runs).toEqual(["F-2"]);
    // Failing task recorded as handled-by-dedupe (retry on next change).
    expect(state.queue.hasProcessed("markdown", "task:F-1:u1")).toBe(true);
    expect(state.queue.hasProcessed("markdown", "task:F-2:u1")).toBe(true);
  });

  test("executor routes through the scheduler when one is provided", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 1 });
    const ran: string[] = [];
    const execute = createFleetTaskExecutor({
      config: CONFIG,
      workspaceDir,
      skips: state.skips,
      repoManager,
      scheduler,
      runTask: (async (taskKey: string) => {
        ran.push(taskKey);
        return true;
      }) as never,
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
    });

    await execute("R-1", { key: "R-1", labels: ["backend"], components: [] });
    expect(ran).toEqual(["R-1"]);

    // Unrouted work bypasses scheduling and records a skip.
    await execute("R-2", { key: "R-2", labels: ["docs"], components: [] });
    expect(ran).toEqual(["R-1"]);
    expect(state.skips.list()).toHaveLength(1);
  });
});
