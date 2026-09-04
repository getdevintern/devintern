import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { RepoConfig, TeamConfig } from "../src/lib/workspace/config";
import {
  createFleetTaskExecutor,
  createWorkspaceTaskAcquirer,
} from "../src/lib/workspace/workspace-worker";
import type { FleetTask, RepoManagerLike } from "../src/lib/workspace/workspace-worker";
import { createRepoRunLock, openWorkspaceState } from "../src/lib/workspace/state";
import type { WorkspaceState } from "../src/lib/workspace/state";
import type { ChangeDetector } from "../src/lib/change-detector";
import {
  createFleetRelayTaskDispatcher,
  createFleetTaskEvaluator,
} from "../src/lib/workspace/fleet-events";

/**
 * Multi-team workspaces ([[teams]]): one worker polls several boards/
 * trackers, each with isolated credentials, query, cursor, and routing
 * scope, while sharing repos, locks, and the central DB.
 */

const CONFIG = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"

[[teams]]
name = "platform"
tracker = "jira"
task_query = "labels = devintern"
env_file = "env/platform.env"
  [teams.env]
  TEAM_PIN_TEST = "from-team"
  TEAM_ONLY = "yes"

[[teams]]
name = "growth"
tracker = "jira"
task_query = "labels = growth"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
default_branch = "develop"
  [repos.env]
  REPO_ONLY = "repo"
  TEAM_PIN_TEST = "from-repo"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"

[[routing.rules]]
team = "platform"
repo = "api"
project = "PLAT"

[[routing.rules]]
repo = "web"
labels = ["docs"]
`);

const DEFAULTS_CONFIG = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
task_query = "status=todo"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[routing.rules]]
repo = "backend"
labels = ["backend"]
`);

class FakeRepoManager implements RepoManagerLike {
  calls: string[] = [];
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

/** Always-changed detector bound to an explicit (namespaced) source. */
function detectorFor(source: string): ChangeDetector {
  return {
    source,
    async changesSince(cursor) {
      return { changed: true, nextCursor: String((cursor ? parseInt(cursor, 10) : 0) + 1) };
    },
  };
}

describe("multi-team polling", () => {
  let workspaceDir: string;
  let state: WorkspaceState;
  let repoManager: FakeRepoManager;

  interface RunRecord {
    taskKey: string;
    cwd: string;
    env: Record<string, string | undefined>;
  }

  const makeTeamAcquirer = (options: {
    team?: TeamConfig;
    detectorSource: string;
    tasks: FleetTask[];
    executed: RunRecord[];
    result?: boolean;
  }) =>
    createWorkspaceTaskAcquirer({
      config: CONFIG,
      workspaceDir,
      workerState: state.workerState,
      queue: state.queue,
      skips: state.skips,
      repoManager,
      detector: detectorFor(options.detectorSource),
      searchTasks: async () => ({ tasks: options.tasks }),
      query: options.team?.taskQuery ?? "status=todo",
      intervalSeconds: 3600,
      ...(options.team ? { team: options.team } : {}),
      runTask: async (taskKey, _args, opts) => {
        options.executed.push({ taskKey, cwd: opts.cwd, env: opts.env });
        return options.result ?? true;
      },
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
    });

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-teams-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    state = openWorkspaceState(workspaceDir);
    repoManager = new FakeRepoManager(workspaceDir);
  });

  afterEach(() => {
    state.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("acquirer names carry the team scope", () => {
    const platform = makeTeamAcquirer({
      team: findTeam(CONFIG, "platform"),
      detectorSource: "jira:platform",
      tasks: [],
      executed: [],
    });
    expect(platform.name).toBe("poll:jira:platform");

    const defaults = makeTeamAcquirer({
      detectorSource: "markdown",
      tasks: [],
      executed: [],
    });
    expect(defaults.name).toBe("poll:markdown");
  });

  test("two teams on the same tracker type keep independent cursors", async () => {
    const platformExecuted: RunRecord[] = [];
    const growthExecuted: RunRecord[] = [];

    const platform = makeTeamAcquirer({
      team: findTeam(CONFIG, "platform"),
      detectorSource: "jira:platform",
      tasks: [{ key: "PLAT-1", updated: "u1", labels: [] }],
      executed: platformExecuted,
    });
    const growth = makeTeamAcquirer({
      team: findTeam(CONFIG, "growth"),
      detectorSource: "jira:growth",
      // Growth's own task; the docs label routes it via the unscoped rule.
      tasks: [{ key: "42", updated: "v1", labels: ["docs"] }],
      executed: growthExecuted,
    });

    await platform.tick();
    await growth.tick();
    await platform.tick();

    // Cursors advanced independently under their namespaced sources.
    expect(state.workerState.getCursor("jira:platform")?.cursorValue).toBe("2");
    expect(state.workerState.getCursor("jira:growth")?.cursorValue).toBe("1");
    // The bare tracker source stays untouched.
    expect(state.workerState.getCursor("jira")).toBeNull();

    expect(platformExecuted.map((r) => r.taskKey)).toEqual(["PLAT-1"]);
    expect(growthExecuted.map((r) => r.taskKey)).toEqual(["42"]);
  });

  test("identical tasks across teams do not cross-dedupe", async () => {
    const platformExecuted: RunRecord[] = [];
    const growthExecuted: RunRecord[] = [];
    const sharedTask = (): FleetTask[] => [{ key: "T-1", updated: "same-stamp", labels: ["docs"] }];

    const platform = makeTeamAcquirer({
      team: findTeam(CONFIG, "platform"),
      detectorSource: "jira:platform",
      tasks: sharedTask(),
      executed: platformExecuted,
    });
    const growth = makeTeamAcquirer({
      team: findTeam(CONFIG, "growth"),
      detectorSource: "jira:growth",
      tasks: sharedTask(),
      executed: growthExecuted,
    });

    await platform.tick();
    await growth.tick();
    // Same (key, stamp) again: each team's own dedupe absorbs it.
    await platform.tick();
    await growth.tick();

    expect(platformExecuted.map((r) => r.taskKey)).toEqual(["T-1"]);
    expect(growthExecuted.map((r) => r.taskKey)).toEqual(["T-1"]);

    const platformEvents = state.queue.hasProcessed("jira:platform", "task:T-1:same-stamp");
    const growthEvents = state.queue.hasProcessed("jira:growth", "task:T-1:same-stamp");
    expect(platformEvents).toBe(true);
    expect(growthEvents).toBe(true);
  });

  test("routing is scoped to the acquiring team and skips record the team", async () => {
    const growthExecuted: RunRecord[] = [];
    const growth = makeTeamAcquirer({
      team: findTeam(CONFIG, "growth"),
      detectorSource: "jira:growth",
      tasks: [
        // Matches the platform-scoped rule's project; must NOT route there.
        { key: "PLAT-9", updated: "u1", labels: [] },
        // Unscoped docs rule applies to every team.
        { key: "42", updated: "u1", labels: ["docs"] },
      ],
      executed: growthExecuted,
    });
    await growth.tick();

    // Only the docs task ran; the platform-routed one was skipped for growth.
    expect(growthExecuted.map((r) => r.taskKey)).toEqual(["42"]);

    const skips = state.skips.list().filter((skip) => skip.taskKey === "PLAT-9");
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toBe("unrouted");
    expect(skips[0].team).toBe("growth");
  });

  test("platform tasks route through their team-scoped rule", async () => {
    const executed: RunRecord[] = [];
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "env", "platform.env"),
      "TEAM_FILE_VAR=file\nTASK_TRACKER=trello\n",
    );

    const platform = makeTeamAcquirer({
      team: findTeam(CONFIG, "platform"),
      detectorSource: "jira:platform",
      tasks: [{ key: "PLAT-7", updated: "u1", labels: [] }],
      executed,
    });
    await platform.tick();

    expect(executed).toHaveLength(1);
    expect(executed[0].cwd).toContain(join("worktrees", "api"));

    const env = executed[0].env;
    expect(env.TASK_TRACKER).toBe("jira"); // pinned to the team's tracker...
    expect(env.TEAM_FILE_VAR).toBe("file"); // team env_file layered...
    expect(env.TEAM_ONLY).toBe("yes"); // team inline env applied...
    expect(env.REPO_ONLY).toBe("repo"); // repo env survives...
    expect(env.TEAM_PIN_TEST).toBe("from-team"); // ...and the team wins ties.
    expect(env.GITHUB_REPO).toBe("acme/api"); // repo slug injection intact.
    expect(env.WEBHOOK_QUEUE_DB).toBe(join(workspaceDir, "state", "queue.db"));
  });

  test("a fixed team repo routes every team task without task criteria", async () => {
    const fixed = parseWorkspaceConfig(`
[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT"
repo = "api"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`);
    const executed: RunRecord[] = [];
    const team = fixed.teams[0]!;
    const acquirer = createWorkspaceTaskAcquirer({
      config: fixed,
      workspaceDir,
      workerState: state.workerState,
      queue: state.queue,
      skips: state.skips,
      repoManager,
      detector: detectorFor("jira:platform"),
      searchTasks: async () => ({ tasks: [{ key: "PLAT-8", updated: "u1" }] }),
      query: team.taskQuery!,
      intervalSeconds: 3600,
      team,
      runTask: async (taskKey, _args, opts) => {
        executed.push({ taskKey, cwd: opts.cwd, env: opts.env });
        return true;
      },
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
    });

    await acquirer.tick();
    expect(executed[0]?.cwd).toContain(join("worktrees", "api"));
    expect(state.skips.latestFor("PLAT-8")).toBeNull();
  });

  test("single-defaults behavior is unchanged (regression)", async () => {
    const executed: RunRecord[] = [];
    const acquirer = createWorkspaceTaskAcquirer({
      config: DEFAULTS_CONFIG,
      workspaceDir,
      workerState: state.workerState,
      queue: state.queue,
      skips: state.skips,
      repoManager,
      detector: detectorFor("markdown"),
      searchTasks: async () => ({
        tasks: [
          { key: "T-1", updated: "u1", labels: ["backend"] },
          { key: "T-2", updated: "u1" },
        ],
      }),
      query: "status=todo",
      intervalSeconds: 3600,
      runTask: async (taskKey, args, opts) => {
        executed.push({ taskKey, cwd: opts.cwd, env: opts.env });
        void args;
        return true;
      },
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
    });

    await acquirer.tick();

    expect(acquirer.name).toBe("poll:markdown");
    expect(executed.map((r) => r.taskKey)).toEqual(["T-1", "T-2"]);
    expect(state.workerState.getCursor("markdown")?.cursorValue).toBe("1");
    // A one-repo workspace needs no routing rule, preserving current behavior.
    expect(state.skips.latestFor("T-2")).toBeNull();
  });
});

describe("relay task evaluation across teams", () => {
  let workspaceDir: string;
  let state: WorkspaceState;
  let repoManager: FakeRepoManager;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-relay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    state = openWorkspaceState(workspaceDir);
    repoManager = new FakeRepoManager(workspaceDir);
  });

  afterEach(() => {
    state.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function evaluatorFor(team: TeamConfig | undefined, tasks: FleetTask[], ran: string[]) {
    return createFleetTaskEvaluator({
      query: team?.taskQuery ?? "status=todo",
      searchTasks: async () => ({ tasks }),
      execute: createFleetTaskExecutor({
        config: CONFIG,
        workspaceDir,
        skips: state.skips,
        repoManager,
        ...(team ? { team } : {}),
        runTask: async (taskKey) => {
          ran.push(`${team?.name ?? "defaults"}:${taskKey}`);
          return true;
        },
        repoLock: (name) => createRepoRunLock(name, workspaceDir),
      }),
    });
  }

  test("the relay source selects a unique tracker team", async () => {
    const ran: string[] = [];
    const dispatch = createFleetRelayTaskDispatcher({
      sources: [
        {
          tracker: "jira",
          label: "platform",
          evaluate: evaluatorFor(findTeam(CONFIG, "platform"), [], ran),
        },
        {
          tracker: "linear",
          label: "growth",
          evaluate: evaluatorFor(
            findTeam(CONFIG, "growth"),
            // Growth's query matches; the docs label routes via the
            // unscoped rule to web.
            [{ key: "GROW-1", updated: "u1", labels: ["docs"] }],
            ran,
          ),
        },
      ],
    });

    await dispatch("GROW-1", "linear");
    expect(ran).toEqual(["growth:GROW-1"]);
    // Executed through the owning team's scope.
    const skip = state.skips.latestFor("GROW-1");
    expect(skip).toBeNull();
  });

  test("same-tracker team ambiguity is ignored and left to polling", async () => {
    const ran: string[] = [];
    const shared = (): FleetTask[] => [{ key: "77", updated: "u1", labels: ["docs"] }];
    const dispatch = createFleetRelayTaskDispatcher({
      sources: [
        {
          tracker: "jira",
          label: "platform",
          evaluate: evaluatorFor(findTeam(CONFIG, "platform"), shared(), ran),
        },
        {
          tracker: "jira",
          label: "growth",
          evaluate: evaluatorFor(findTeam(CONFIG, "growth"), shared(), ran),
        },
      ],
    });

    await dispatch("77", "jira");
    expect(ran).toEqual([]);
  });

  test("team-tagged envelopes route overlapping keys only to the exact team", async () => {
    const ran: string[] = [];
    const overlapping: FleetTask[] = [{ key: "PROJ-123", updated: "u1", labels: ["docs"] }];
    const dispatch = createFleetRelayTaskDispatcher({
      sources: [
        {
          tracker: "jira",
          label: "platform",
          evaluate: evaluatorFor(findTeam(CONFIG, "platform"), overlapping, ran),
        },
        {
          tracker: "jira",
          label: "growth",
          evaluate: evaluatorFor(findTeam(CONFIG, "growth"), overlapping, ran),
        },
      ],
    });

    await dispatch("PROJ-123", "jira", "growth");
    expect(ran).toEqual(["growth:PROJ-123"]);
  });

  test("unknown or removed relay teams are skipped safely", async () => {
    const ran: string[] = [];
    const dispatch = createFleetRelayTaskDispatcher({
      sources: [
        {
          tracker: "jira",
          label: "platform",
          evaluate: evaluatorFor(findTeam(CONFIG, "platform"), [], ran),
        },
      ],
    });

    await dispatch("PROJ-123", "jira", "removed");
    expect(ran).toEqual([]);
  });

  test("tasks matching no source are ignored", async () => {
    const ran: string[] = [];
    const dispatch = createFleetRelayTaskDispatcher({
      verbose: false,
      sources: [
        {
          tracker: "jira",
          label: "platform",
          evaluate: evaluatorFor(findTeam(CONFIG, "platform"), [], ran),
        },
        {
          tracker: "linear",
          label: "growth",
          evaluate: evaluatorFor(findTeam(CONFIG, "growth"), [], ran),
        },
      ],
    });

    await dispatch("MISSING-1", "jira");
    expect(ran).toEqual([]);
  });
});

function findTeam(config: typeof CONFIG, name: string): TeamConfig | undefined {
  return config.teams.find((team) => team.name === name);
}
