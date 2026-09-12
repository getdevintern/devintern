import { GitLabReviewPollingAcquirer } from "../src/lib/acquirers/gitlab-review-polling";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { RepoConfig } from "../src/lib/workspace/config";
import { applyWorkspaceConfig } from "../src/lib/workspace/config-reload";
import {
  buildFleetEventAcquirers,
  createFleetTaskExecutor,
  createWorkspaceTaskAcquirer,
  errorMonitorTaskArgs,
  fleetTaskArgs,
  resolveWorkspaceAutomationContext,
  startWorktreeSweeper,
  sweepAllWorktrees,
} from "../src/lib/workspace/workspace-worker";
import type { FleetTask, RepoManagerLike } from "../src/lib/workspace/workspace-worker";
import { createRepoRunLock, openWorkspaceState } from "../src/lib/workspace/state";
import type { WorkspaceState } from "../src/lib/workspace/state";
import type { ChangeDetector } from "../src/lib/acquirers/change-detector";
import { createTaskSupervisor, JobNotStartedError } from "../src/lib/worker/supervisor";
import { toRoutableTask } from "../src/lib/workspace/router";
import { CiFailureWatcherAcquirer } from "../src/lib/acquirers/ci-failure-watcher";
import { GitLabReviewsClient } from "../src/lib/code-host/gitlab/reviews";
import { saveRelayState } from "../src/lib/relay/connect";

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

const FRONTEND_ONLY_CONFIG = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
task_query = "status=todo"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"

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

  test("task execution no longer holds the legacy whole-run repo lock", async () => {
    tasks = [{ key: "T-5", updated: "u1", labels: ["backend"] }];
    let lockAvailableDuringRun = false;
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
        const independent = createRepoRunLock("backend", workspaceDir);
        lockAvailableDuringRun = independent.acquire().success;
        independent.release();
        return true;
      },
    });

    await acquirer.tick();
    expect(lockAvailableDuringRun).toBe(true);
  });

  test("the legacy repo lock no longer defers task admission", async () => {
    tasks = [{ key: "T-6", updated: "u1", labels: ["backend"] }];
    const heldLock = createRepoRunLock("backend", workspaceDir);
    expect(heldLock.acquire().success).toBe(true);
    const acquirer = makeAcquirer();

    await acquirer.tick();
    expect(ran.map((run) => run.taskKey)).toEqual(["T-6"]);
    expect(state.workerState.getCursor("markdown")?.cursorValue).toBe("1");
    expect(state.queue.hasProcessed("markdown", "task:T-6:u1")).toBe(true);
    heldLock.release();
  });

  test("a supervisor drain defers a task and rolls back its polling claim", async () => {
    tasks = [{ key: "T-7", updated: "u1", labels: ["backend"] }];
    const supervisor = createTaskSupervisor({ maxConcurrency: 1, maxConcurrencyPerRepo: 1 });
    await supervisor.drain();
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
      supervisor,
      runTask: async () => {
        throw new Error("must not run");
      },
    });

    await acquirer.tick();

    expect(state.workerState.getCursor("markdown")).toBeNull();
    expect(state.queue.hasProcessed("markdown", "task:T-7:u1")).toBe(false);
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

  test("task runs wait for held supervisor slots", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 1, maxConcurrencyPerRepo: 1 });
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
      supervisor,
    });

    let releaseBlocker!: () => void;
    const blocker = supervisor.schedule({
      id: "blocker",
      source: "test",
      kind: "estimation",
      checkoutClass: "workspace",
      run: () =>
        new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        }),
    });
    const routable = toRoutableTask({ key: "T-C1", labels: ["backend"], components: [] });
    const running = executor("T-C1", routable);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(agentStarted).toBe(false);
    expect(repoManager.calls).not.toContain("worktree:backend:T-C1");

    releaseBlocker();
    await Promise.all([blocker, running]);
    expect(agentStarted).toBe(true);
  });

  test("two same-repository tasks overlap when the per-repo cap is two", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 2, maxConcurrencyPerRepo: 2 });
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = createFleetTaskExecutor({
      config: CONFIG,
      workspaceDir,
      skips: state.skips,
      repoManager,
      supervisor,
      runTask: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return true;
      },
    });
    const routable = toRoutableTask({ key: "T", labels: ["backend"], components: [] });

    const first = executor("T-1", routable);
    const second = executor("T-2", routable);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peak).toBe(2);

    release();
    await Promise.all([first, second]);
  });

  test("without an injected supervisor, a focused executor uses config limits", async () => {
    const executor = createFleetTaskExecutor({
      config: CONFIG,
      workspaceDir,
      skips: state.skips,
      repoManager,
      runTask: async () => true,
    });
    const routable = toRoutableTask({ key: "T-C2", labels: ["backend"], components: [] });
    const result = await executor("T-C2", routable);
    expect(result).toBe(true);
    expect(repoManager.calls).toContain("worktree:backend:T-C2");
  });

  test("a persisted retry repo bypasses lossy task-key-only rerouting", async () => {
    const executor = createFleetTaskExecutor(
      {
        config: CONFIG,
        workspaceDir,
        skips: state.skips,
        repoManager,
        runTask: async () => true,
      },
      { repo: "frontend", extraArgs: ["--force"] },
    );
    const result = await executor(
      "T-RETRY",
      toRoutableTask({ key: "T-RETRY", labels: [], components: [] }),
    );
    expect(result).toBe(true);
    expect(repoManager.calls).toContain("worktree:frontend:T-RETRY");
  });

  test("an error-monitor executor marks the subprocess origin and skips feasibility", async () => {
    let observed: { args: string[]; env: Record<string, string | undefined> } | undefined;
    const executor = createFleetTaskExecutor(
      {
        config: CONFIG,
        workspaceDir,
        skips: state.skips,
        repoManager,
        runTask: async (_taskKey, args, options) => {
          observed = { args, env: options.env };
          return true;
        },
      },
      {
        repo: "backend",
        runOrigin: "error_monitor",
        extraArgs: errorMonitorTaskArgs(CONFIG),
      },
    );

    await executor(
      "/workspace/error-fixes/SENTRY-1.md",
      toRoutableTask({ key: "issue:1001", labels: [], components: [] }),
    );

    expect(observed?.env.DEVINTERN_RUN_ORIGIN).toBe("error_monitor");
    expect(observed?.args).toContain("--skip-clarity-check");
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

  test("error monitor runs skip the redundant feasibility assessment", () => {
    expect(errorMonitorTaskArgs(CONFIG)).toEqual([
      "--create-pr",
      "--auto-review",
      "--skip-clarity-check",
    ]);
    const alreadySkipped = {
      ...CONFIG,
      defaults: {
        ...CONFIG.defaults,
        workerTaskArgs: "--create-pr --skip-clarity-check",
      },
    };
    expect(errorMonitorTaskArgs(alreadySkipped)).toEqual(["--create-pr", "--skip-clarity-check"]);
  });
});

describe("buildFleetEventAcquirers", () => {
  test.each(["review", "conflict"])(
    "GitLab %s does not prepare checkout before supervisor admission",
    async (kind) => {
      const workspaceDir = join(tmpdir(), `ws-gitlab-supervision-${crypto.randomUUID()}`);
      mkdirSync(workspaceDir, { recursive: true });
      const state = openWorkspaceState(workspaceDir);
      const config = parseWorkspaceConfig(`
[workspace]
conflict_resolution = "auto"
[defaults]
tracker = "markdown"
[[repos]]
name = "gitlab"
remote = "https://gitlab.com/acme/widgets.git"
[repos.env]
DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST = "true"
GITLAB_CODE_HOST_TOKEN = "test-token"
GITLAB_CODE_HOST_URL = "https://gitlab.com"
GITLAB_CODE_HOST_CA_FILE = ""
GITLAB_CODE_HOST_PROXY = ""
`);
      state.workerState.recordAgentChangeRequest({
        provider: "gitlab",
        instanceUrl: "https://gitlab.com",
        projectPath: "acme/widgets",
        projectId: "42",
        number: 17,
        webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
      });
      const snapshot = spyOn(GitLabReviewsClient.prototype, "getPollingSnapshot").mockResolvedValue(
        {
          state: "opened",
          headSha: "head",
          baseSha: "base",
          sourceBranch: "feature",
          targetBranch: "main",
          webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
          mergeability: kind === "conflict" ? "conflicts" : "mergeable",
          assignedReviewerIds: [8],
          feedback: [
            {
              discussionId: "d",
              noteId: 1,
              author: { id: 8, username: "reviewer" },
              createdAt: new Date(Date.now() + 1000).toISOString(),
            },
          ],
        },
      );
      const manager = new FakeRepoManager(workspaceDir);
      const scheduled: string[] = [];
      try {
        const acquirers = await buildFleetEventAcquirers({
          config,
          workspaceDir,
          state,
          repoManager: manager,
          searchTasks: async () => ({ tasks: [] }),
          query: "",
          intervalSeconds: 60,
          supervisor: {
            async schedule(request) {
              scheduled.push(request.kind);
              throw new JobNotStartedError();
            },
            updateLimits() {},
            async drain() {},
          },
        });
        await (
          acquirers.find(
            (a) => a instanceof GitLabReviewPollingAcquirer,
          ) as GitLabReviewPollingAcquirer
        ).tick();
        expect(scheduled).toEqual([kind]);
        expect(manager.calls).toEqual([]);
      } finally {
        snapshot.mockRestore();
        state.close();
        rmSync(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  test.each(["closed", "repair"])(
    "GitLab CI keeps same-project MR identities separate: %s",
    async (scenario) => {
      const workspaceDir = join(tmpdir(), `ws-gitlab-ci-${crypto.randomUUID()}`);
      mkdirSync(workspaceDir, { recursive: true });
      const state = openWorkspaceState(workspaceDir);
      const config = parseWorkspaceConfig(`
[workspace]
ci_failure_fix = true
[defaults]
tracker = "markdown"
[[repos]]
name = "gitlab"
remote = "https://gitlab.com/acme/widgets.git"
[repos.env]
DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST = "true"
GITLAB_CODE_HOST_TOKEN = "test-token"
GITLAB_CODE_HOST_URL = "https://gitlab.com"
GITLAB_CODE_HOST_CA_FILE = ""
GITLAB_CODE_HOST_PROXY = ""
`);
      for (const number of [17, 18]) {
        state.workerState.recordAgentChangeRequest({
          provider: "gitlab",
          instanceUrl: "https://gitlab.com",
          projectId: "42",
          projectPath: "acme/widgets",
          number,
          webUrl: `https://gitlab.com/acme/widgets/-/merge_requests/${number}`,
        });
      }
      const fetched: number[] = [];
      const getChange = spyOn(GitLabReviewsClient.prototype, "getChangeRequest").mockImplementation(
        async (_project, number) => {
          fetched.push(number);
          return {
            number,
            title: `MR ${number}`,
            state: scenario === "closed" && number === 17 ? "closed" : "opened",
            head: { ref: `fix-${number}`, sha: "shared-head-sha" },
            base: { ref: "main", sha: "base" },
            mergeability: "mergeable",
            webUrl: `https://gitlab.com/acme/widgets/-/merge_requests/${number}`,
          };
        },
      );
      const getCi = spyOn(GitLabReviewsClient.prototype, "getCiSnapshot").mockResolvedValue({
        state: scenario === "repair" ? "failure" : "success",
        failures:
          scenario === "repair"
            ? [{ externalId: "job:42:123", name: "test", conclusion: "failure" }]
            : [],
        jobIds: [123],
      });
      const getLogs = spyOn(GitLabReviewsClient.prototype, "getJobTraces").mockResolvedValue(
        "test failed",
      );
      const scheduled: string[] = [];
      try {
        const acquirers = await buildFleetEventAcquirers({
          config,
          workspaceDir,
          state,
          repoManager: new FakeRepoManager(workspaceDir),
          searchTasks: async () => ({ tasks: [] }),
          query: "status=todo",
          intervalSeconds: 60,
          supervisor: {
            async schedule(request) {
              scheduled.push(request.label ?? "");
              throw new JobNotStartedError();
            },
            updateLimits() {},
            async drain() {},
          },
        });
        const watcher = acquirers.find((item) => item instanceof CiFailureWatcherAcquirer);
        expect(watcher).toBeInstanceOf(CiFailureWatcherAcquirer);
        await (watcher as CiFailureWatcherAcquirer).tick();
        if (scenario === "closed") {
          expect(
            state.workerState.listOpenAgentChangeRequests().map((mr) => mr.changeNumber),
          ).toEqual([18]);
          expect(scheduled).toEqual([]);
        } else {
          // Same SHA deliberately prevents the head guard from masking incorrect MR selection.
          expect(fetched).toEqual([17, 17, 18, 18]);
          expect(scheduled).toEqual(["acme/widgets!17", "acme/widgets!18"]);
          expect(
            state.workerState.getCiFixState("https://gitlab.com:acme/widgets", 17)
              .consecutiveFailures,
          ).toBe(0);
        }
      } finally {
        getChange.mockRestore();
        getCi.mockRestore();
        getLogs.mockRestore();
        state.close();
        rmSync(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  test("legacy relay registration still selects token-only auth and the hosted alias", async () => {
    const workspaceDir = join(
      tmpdir(),
      `ws-relay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    const state = openWorkspaceState(workspaceDir);
    const repoManager = new FakeRepoManager(workspaceDir);
    const savedToken = process.env.GITHUB_TOKEN;
    const savedAppId = process.env.GITHUB_APP_ID;
    const savedAppKey = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    const savedAuthMode = process.env.DEVINTERN_GITHUB_AUTH_MODE;
    const savedAliases = process.env.GITHUB_BOT_ALIASES;
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = "/tmp/custom-app.pem";
    saveRelayState(
      {
        relayUrl: "https://relay.test",
        customerId: "customer-1",
        connectedAt: new Date(0).toISOString(),
        registrations: [
          { kind: "repo", key: "acme/backend", createdAt: Date.now(), lastEventAt: null },
        ],
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
      expect(process.env.DEVINTERN_GITHUB_AUTH_MODE).toBe("token-only");
      expect(process.env.GITHUB_BOT_ALIASES?.split(",")).toContain("devintern-ai");
    } finally {
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedToken;
      if (savedAppId === undefined) delete process.env.GITHUB_APP_ID;
      else process.env.GITHUB_APP_ID = savedAppId;
      if (savedAppKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
      else process.env.GITHUB_APP_PRIVATE_KEY_PATH = savedAppKey;
      if (savedAuthMode === undefined) delete process.env.DEVINTERN_GITHUB_AUTH_MODE;
      else process.env.DEVINTERN_GITHUB_AUTH_MODE = savedAuthMode;
      if (savedAliases === undefined) delete process.env.GITHUB_BOT_ALIASES;
      else process.env.GITHUB_BOT_ALIASES = savedAliases;
      state.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("reconciles mention sweeps when repos are added or removed while running", async () => {
    const workspaceDir = join(
      tmpdir(),
      `ws-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    const state = openWorkspaceState(workspaceDir);
    const repoManager = new FakeRepoManager(workspaceDir);
    const savedToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";

    // No GitHub remotes yet: review poller idles, zero mention sweeps.
    const nonGithub = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"

[[repos]]
name = "gitlab"
remote = "https://gitlab.com/acme/gitlab.git"

[[repos]]
name = "forgejo"
remote = "https://forgejo.example/acme/forgejo.git"
`);

    // Block all network access: reconciliation starts new sweeps eagerly,
    // and their initial poll must not reach api.github.com in tests.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network disabled in tests");
    }) as unknown as typeof fetch;

    try {
      const intervalUpdaters: Array<(seconds: number) => void> = [];
      const hooksOut: {
        hooks?: import("../src/lib/workspace/workspace-worker").FleetEventReloadHooks;
      } = {};
      const acquirers = await buildFleetEventAcquirers({
        config: nonGithub,
        workspaceDir,
        state,
        repoManager,
        searchTasks: async () => ({ tasks: [] }),
        query: "status=todo",
        intervalSeconds: 60,
        intervalUpdaters,
        reloadHooksOut: hooksOut,
      });

      expect(acquirers.map((acquirer) => acquirer.name)).toEqual([
        "poll:reviews",
        "poll:ci-failures",
      ]);
      expect(hooksOut.hooks?.mentionSweepRepos()).toEqual([]);

      // Live reload adds two GitHub repos; reconciling attaches their sweeps
      // without a restart.
      applyWorkspaceConfig(nonGithub, CONFIG);
      hooksOut.hooks?.reconcileMentionSweeps();
      expect(hooksOut.hooks?.mentionSweepRepos()).toEqual(["acme/backend", "acme/frontend"]);
      expect(intervalUpdaters.length).toBeGreaterThanOrEqual(2);

      // Removing a repo stops its sweep on the next reload.
      applyWorkspaceConfig(nonGithub, FRONTEND_ONLY_CONFIG);
      hooksOut.hooks?.reconcileMentionSweeps();
      expect(hooksOut.hooks?.mentionSweepRepos()).toEqual(["acme/frontend"]);
    } finally {
      globalThis.fetch = originalFetch;
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedToken;
      state.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("resolveWorkspaceAutomationContext", () => {
  test("prepares the repository without the legacy whole-run lock", async () => {
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
    );

    expect(context?.repo).toBe("backend");
    expect(repoManager.calls).toContain("base:backend");
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

  test("startWorktreeSweeper reads live repos and TTL on every pass", async () => {
    const { swept, repoManager } = fakeSweeper({});
    let repos = [REPOS[0]!];
    let ttlDays = 7;
    const timer = startWorktreeSweeper(
      () => repos,
      repoManager,
      () => ttlDays,
      10,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      repos = [REPOS[1]!];
      ttlDays = 3;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(swept).toContainEqual({ repo: "backend", ttlDays: 7 });
      expect(swept).toContainEqual({ repo: "frontend", ttlDays: 3 });
    } finally {
      clearInterval(timer);
    }
  });
});
