import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_DASHBOARD,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_WORKTREES_TTL_DAYS,
  effectiveMaxConcurrency,
  findRepo,
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
    expect(config.workspace.dashboard).toBe(true);
    expect(config.workspace.dashboardPort).toBeUndefined();
    expect(config.defaults.tracker).toBe("jira");
    expect(config.defaults.taskQuery).toBe("labels = devintern");
    expect(config.defaults.workerTaskArgs).toBe("--create-pr");
    expect(config.defaults.pollIntervalSeconds).toBe(DEFAULT_POLL_INTERVAL_SECONDS);

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
    expect(config.workspace.parallelAcrossRepos).toBe(false);
    expect(config.workspace.maxConcurrency).toBeUndefined();
    expect(config.workspace.dashboard).toBe(DEFAULT_DASHBOARD);
    expect(config.defaults.pollIntervalSeconds).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(config.repos).toEqual([]);
    expect(config.routing).toEqual([]);
  });

  test("parses parallel execution settings", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[workspace]
parallel_across_repos = true
max_concurrency = 6

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/b.git"
`);
    expect(config.workspace.parallelAcrossRepos).toBe(true);
    expect(config.workspace.maxConcurrency).toBe(6);
    // Effective limit respects the explicit cap.
    expect(effectiveMaxConcurrency(config)).toBe(6);
  });

  test("serial mode always has an effective concurrency of one", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[workspace]
max_concurrency = 8

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"
`);
    expect(config.workspace.parallelAcrossRepos).toBe(false);
    expect(config.workspace.maxConcurrency).toBe(8); // validated, kept, inert
    expect(effectiveMaxConcurrency(config)).toBe(1);
  });

  test("effective concurrency defaults safely and is bounded by the repo count", () => {
    const two = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[workspace]
parallel_across_repos = true

[[repos]]
name = "a"
remote = "git@github.com:acme/a.git"

[[repos]]
name = "b"
remote = "git@github.com:acme/b.git"
`);
    expect(two.workspace.maxConcurrency).toBeUndefined();
    expect(effectiveMaxConcurrency(two)).toBe(DEFAULT_MAX_CONCURRENCY);

    const five = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[workspace]
parallel_across_repos = true
max_concurrency = 2

[[repos]]
name = "a"
remote = "git@github.com:acme/a.git"
[[repos]]
name = "b"
remote = "git@github.com:acme/b.git"
[[repos]]
name = "c"
remote = "git@github.com:acme/c.git"
[[repos]]
name = "d"
remote = "git@github.com:acme/d.git"
[[repos]]
name = "e"
remote = "git@github.com:acme/e.git"
`);
    expect(effectiveMaxConcurrency(five)).toBe(2);

    // A cap larger than the fleet is valid and naturally bounded.
    const oversized = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[workspace]
parallel_across_repos = true
max_concurrency = 50

[[repos]]
name = "a"
remote = "git@github.com:acme/a.git"
`);
    expect(() => oversized).not.toThrow();
    expect(effectiveMaxConcurrency(oversized)).toBe(50);
  });

  test("rejects a non-boolean parallel_across_repos", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[workspace]
parallel_across_repos = "yes"
`),
    ).toThrow(/parallel_across_repos must be a boolean/);
  });

  test.each([true, false])("accepts max_concurrency while parallel is %s", (parallel) => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[workspace]
parallel_across_repos = ${parallel}
max_concurrency = 3
`),
    ).not.toThrow();
  });

  test.each([
    ["true (boolean)", "true", /max_concurrency must be a positive integer/],
    ["zero", "0", /max_concurrency must be a positive integer/],
    ["negative", "-2", /max_concurrency must be a positive integer/],
    ["fraction", "1.5", /max_concurrency must be a positive integer/],
    ["string", '"4"', /max_concurrency must be a positive integer/],
  ])("rejects max_concurrency as %s", (_label, raw, pattern) => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[workspace]
max_concurrency = ${raw}
`),
    ).toThrow(pattern);
  });

  test("parses dashboard and poll interval settings", () => {
    const config = parseWorkspaceConfig(`
[workspace]
dashboard = false
dashboard_port = 4410

[defaults]
tracker = "markdown"
poll_interval = 15
`);
    expect(config.workspace.dashboard).toBe(false);
    expect(config.workspace.dashboardPort).toBe(4410);
    expect(config.defaults.pollIntervalSeconds).toBe(15);
  });

  test("rejects invalid dashboard and poll interval values", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
dashboard = "off"

[defaults]
tracker = "markdown"
`),
    ).toThrow(/\[workspace\]\.dashboard must be a boolean/);

    expect(() =>
      parseWorkspaceConfig(`
[workspace]
dashboard_port = 70000

[defaults]
tracker = "markdown"
`),
    ).toThrow(/dashboard_port must be an integer between 1 and 65535/);

    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
poll_interval = 0
`),
    ).toThrow(/poll_interval must be a positive integer/);
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
