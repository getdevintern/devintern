import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  DEFAULT_WORKTREES_TTL_DAYS,
  findRepo,
  findTeam,
  loadWorkspaceConfig,
  parseWorkspaceConfig,
} from "../src/lib/workspace/config";
import {
  hasWorkspace,
  locksDir,
  reposDir,
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceDbPath,
  workspaceEnvPath,
  worktreesDir,
} from "../src/lib/workspace/paths";

const VALID_CONFIG = `
[workspace]
worktrees_ttl_days = 3

[defaults]
tracker = "jira"
task_query = "labels = devintern"
worker_task_args = "--create-pr"
default_branch = "main"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
default_branch = "develop"
env_file = "env/backend.env"
  [repos.env]
  GITHUB_REPO = "acme/backend"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"

[[routing.rules]]
repo = "backend"
project = "BACK"
components = ["api"]

[[routing.rules]]
repo = "frontend"
labels = ["frontend", "web"]
`;

describe("parseWorkspaceConfig", () => {
  test("parses a valid config with defaults inheritance", () => {
    const config = parseWorkspaceConfig(VALID_CONFIG);

    expect(config.workspace.worktreesTtlDays).toBe(3);
    expect(config.defaults.tracker).toBe("jira");
    expect(config.defaults.taskQuery).toBe("labels = devintern");
    expect(config.defaults.workerTaskArgs).toBe("--create-pr");

    const backend = findRepo(config, "backend");
    expect(backend?.remote).toBe("git@github.com:acme/backend.git");
    expect(backend?.defaultBranch).toBe("develop");
    expect(backend?.envFile).toBe("env/backend.env");
    expect(backend?.env).toEqual({ GITHUB_REPO: "acme/backend" });

    // frontend has no default_branch of its own: inherits [defaults].
    const frontend = findRepo(config, "frontend");
    expect(frontend?.defaultBranch).toBe("main");
    expect(frontend?.env).toEqual({});

    expect(config.routing).toHaveLength(2);
    expect(config.routing[0]).toEqual({
      repo: "backend",
      project: "BACK",
      components: ["api"],
      labels: [],
    });
  });

  test("applies the default worktrees TTL when [workspace] is omitted", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
`);
    expect(config.workspace.worktreesTtlDays).toBe(DEFAULT_WORKTREES_TTL_DAYS);
    expect(config.repos).toEqual([]);
    expect(config.routing).toEqual([]);
  });

  test("rejects invalid TOML", () => {
    expect(() => parseWorkspaceConfig("[defaults\ntracker=")).toThrow(/Failed to parse/);
  });

  test("requires defaults.tracker", () => {
    expect(() => parseWorkspaceConfig("")).toThrow(/\[defaults\]\.tracker is required/);
  });

  test("rejects a tracker without polling support", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "fossil"
`),
    ).toThrow(/does not support polling/);
  });

  test("rejects duplicate repo names", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"

[[repos]]
name = "backend"
remote = "git@github.com:acme/b.git"
`),
    ).toThrow(/Duplicate repo name "backend"/);
  });

  test("rejects unsafe repo names", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "../escape"
remote = "git@github.com:acme/a.git"
`),
    ).toThrow(/must contain only letters/);
  });

  test("requires repo remote", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
`),
    ).toThrow(/\.remote is required/);
  });

  test("rejects rules referencing unknown repos", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"

[[routing.rules]]
repo = "nope"
project = "BACK"
`),
    ).toThrow(/"nope" does not match any \[\[repos\]\] name/);
  });

  test("rejects rules with no criteria", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"

[[routing.rules]]
repo = "backend"
`),
    ).toThrow(/at least one criterion/);
  });

  test("collects multiple errors into one message", () => {
    let message = "";
    try {
      parseWorkspaceConfig(`
[[repos]]
name = "backend"

[[routing.rules]]
repo = "missing"
`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/tracker is required/);
    expect(message).toMatch(/\.remote is required/);
    expect(message).toMatch(/does not match any/);
  });
});

describe("parseWorkspaceConfig [[teams]]", () => {
  const TEAMS_CONFIG = `
[defaults]
worker_task_args = "--create-pr"
default_branch = "main"

[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT AND labels = devintern"
env_file = "env/platform.env"

[[teams]]
name = "growth"
tracker = "linear"
task_query = "{\\"team\\":{\\"key\\":{\\"eq\\":\\"GROW\\"}}}"
  [teams.env]
  LINEAR_API_KEY = "lin_api_x"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[routing.rules]]
team = "platform"
repo = "api"
project = "PLAT"
`;

  test("parses teams, team env, and team-scoped routing rules", () => {
    const config = parseWorkspaceConfig(TEAMS_CONFIG);

    expect(config.teams).toHaveLength(2);
    expect(config.teams[0]).toEqual({
      name: "platform",
      tracker: "jira",
      taskQuery: "project = PLAT AND labels = devintern",
      envFile: "env/platform.env",
      env: {},
    });
    expect(config.teams[1].env).toEqual({ LINEAR_API_KEY: "lin_api_x" });

    // [defaults].tracker/task_query are optional with teams.
    expect(config.defaults.tracker).toBe("");
    expect(config.routing).toEqual([
      {
        repo: "api",
        team: "platform",
        project: "PLAT",
        components: [],
        labels: [],
      },
    ]);

    expect(findTeam(config, "growth")?.tracker).toBe("linear");
    expect(findTeam(config, "nope")).toBeUndefined();
    expect(findRepo(config, "api")).toBeDefined();
  });

  test("teams inherit tracker and query from [defaults]", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "trello"
task_query = "list:\\"To Do\\""

[[teams]]
name = "board-a"
env_file = "env/a.env"

[[teams]]
name = "board-b"
task_query = "list:\\"Review\\""
`);
    for (const team of config.teams) {
      expect(team.tracker).toBe("trello");
      if (team.name === "board-a") {
        expect(team.taskQuery).toBe('list:"To Do"');
      } else {
        expect(team.taskQuery).toBe('list:"Review"');
      }
    }
  });

  test("rejects duplicate team names", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"
task_query = "x"

[[teams]]
name = "platform"
task_query = "a"

[[teams]]
name = "platform"
task_query = "b"
`),
    ).toThrow(/Duplicate team name "platform"/);
  });

  test("rejects unsafe team names", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"
task_query = "x"

[[teams]]
name = "../escape"
task_query = "a"
`),
    ).toThrow(/must contain only letters/);
  });

  test("requires a tracker and query per team when defaults omit them", () => {
    let message = "";
    try {
      parseWorkspaceConfig(`
[[teams]]
name = "platform"
`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // With [[teams]] present, the missing [defaults] tracker surfaces as a
    // per-team error instead.
    expect(message).toMatch(
      /"platform" needs a tracker: set its own tracker or \[defaults\]\.tracker/,
    );
    expect(message).toMatch(/"platform" needs a task_query/);

    expect(() =>
      parseWorkspaceConfig(`
[defaults]
task_query = "x"

[[teams]]
name = "platform"
`),
    ).toThrow(/needs a tracker/);
  });

  test("rejects team trackers without polling support", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"
task_query = "x"

[[teams]]
name = "legacy"
tracker = "fossil"
task_query = "y"
`),
    ).toThrow(/tracker "fossil" does not support polling/);
  });

  test("rejects routing rules naming unknown teams", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"
task_query = "x"

[[teams]]
name = "platform"
task_query = "y"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[routing.rules]]
team = "growth"
repo = "api"
project = "GROW"
`),
    ).toThrow(/team "growth" does not match any \[\[teams\]\] name/);
  });

  test("rejects routing rules with a team when no teams are configured", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[routing.rules]]
team = "platform"
repo = "api"
project = "PLAT"
`),
    ).toThrow(/team "platform" is set but no \[\[teams\]\] are configured/);
  });
});

describe("workspace paths", () => {
  let workspaceDir: string;
  let previousOverride: string | undefined;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    previousOverride = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
  });

  afterEach(() => {
    if (previousOverride === undefined) {
      delete process.env.DEVINTERN_WORKSPACE_DIR;
    } else {
      process.env.DEVINTERN_WORKSPACE_DIR = previousOverride;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("DEVINTERN_WORKSPACE_DIR overrides the workspace home", () => {
    expect(resolveWorkspaceDir()).toBe(workspaceDir);
    expect(workspaceConfigPath()).toBe(join(workspaceDir, "workspace.toml"));
    expect(workspaceEnvPath()).toBe(join(workspaceDir, ".env"));
    expect(workspaceDbPath()).toBe(join(workspaceDir, "state", "queue.db"));
    expect(reposDir()).toBe(join(workspaceDir, "repos"));
    expect(worktreesDir()).toBe(join(workspaceDir, "worktrees"));
    expect(locksDir()).toBe(join(workspaceDir, "locks"));
  });

  test("hasWorkspace reflects workspace.toml presence", () => {
    expect(hasWorkspace()).toBe(false);
    writeFileSync(workspaceConfigPath(), VALID_CONFIG);
    expect(hasWorkspace()).toBe(true);
  });

  test("loadWorkspaceConfig reads from disk and reports missing files", () => {
    writeFileSync(workspaceConfigPath(), VALID_CONFIG);
    const config = loadWorkspaceConfig(workspaceConfigPath());
    expect(config.repos.map((repo) => repo.name)).toEqual(["backend", "frontend"]);

    expect(() => loadWorkspaceConfig(join(workspaceDir, "missing.toml"))).toThrow(
      /devintern workspace init/,
    );
  });
});
