import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  DEFAULT_DASHBOARD,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_WORKTREES_TTL_DAYS,
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
pr_labels = ["devintern", "auto-pr"]

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
default_branch = "develop"
pr_labels = ["backend"]
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
    expect(config.defaults.prLabels).toEqual(["devintern", "auto-pr"]);

    const backend = findRepo(config, "backend");
    expect(backend?.remote).toBe("git@github.com:acme/backend.git");
    expect(backend?.defaultBranch).toBe("develop");
    expect(backend?.prLabels).toEqual(["backend"]);
    expect(backend?.envFile).toBe("env/backend.env");
    expect(backend?.env).toEqual({ GITHUB_REPO: "acme/backend" });

    // frontend has no default_branch of its own: inherits [defaults].
    const frontend = findRepo(config, "frontend");
    expect(frontend?.defaultBranch).toBe("main");
    expect(frontend?.prLabels).toEqual(["devintern", "auto-pr"]);
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
    expect(config.workspace.dashboard).toBe(DEFAULT_DASHBOARD);
    expect(config.defaults.pollIntervalSeconds).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(config.defaults.prLabels).toBeUndefined();
    expect(config.repos).toEqual([]);
    expect(config.routing).toEqual([]);
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

  test("defaults conflict resolution to auto without a schedule", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
`);
    expect(config.workspace.conflictResolution).toBe("auto");
    expect(config.workspace.conflictSchedule).toBeUndefined();
  });

  test("parses scheduled conflict resolution with cron", () => {
    const config = parseWorkspaceConfig(`
[workspace]
conflict_resolution = "scheduled"
conflict_resolution_cron = "0 3 * * *"

[defaults]
tracker = "markdown"
`);
    expect(config.workspace.conflictResolution).toBe("scheduled");
    expect(config.workspace.conflictSchedule).toEqual({ cron: "0 3 * * *" });
  });

  test("parses scheduled conflict resolution with an interval", () => {
    const config = parseWorkspaceConfig(`
[workspace]
conflict_resolution = "scheduled"
conflict_resolution_interval = "1d"

[defaults]
tracker = "markdown"
`);
    expect(config.workspace.conflictResolution).toBe("scheduled");
    expect(config.workspace.conflictSchedule).toEqual({ interval: "1d", intervalMs: 86_400_000 });
  });

  test("scheduled conflict resolution requires exactly one schedule key", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
conflict_resolution = "scheduled"

[defaults]
tracker = "markdown"
`),
    ).toThrow(/must set exactly one of conflict_resolution_cron or conflict_resolution_interval/);

    expect(() =>
      parseWorkspaceConfig(`
[workspace]
conflict_resolution = "scheduled"
conflict_resolution_cron = "0 3 * * *"
conflict_resolution_interval = "1d"

[defaults]
tracker = "markdown"
`),
    ).toThrow(/must set exactly one of conflict_resolution_cron or conflict_resolution_interval/);
  });

  test("rejects invalid scheduled conflict resolution schedules", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
conflict_resolution = "scheduled"
conflict_resolution_cron = "99 bad"

[defaults]
tracker = "markdown"
`),
    ).toThrow(/five-field cron expression/);

    expect(() =>
      parseWorkspaceConfig(`
[workspace]
conflict_resolution = "scheduled"
conflict_resolution_interval = "30s"

[defaults]
tracker = "markdown"
`),
    ).toThrow(/positive duration such as 15m, 6h, or 1d/);
  });

  test("rejects unknown conflict resolution modes", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
conflict_resolution = "nightly"

[defaults]
tracker = "markdown"
`),
    ).toThrow(/must be "auto", "scheduled", or "disabled"/);
  });

  test("parses disabled conflict resolution", () => {
    const config = parseWorkspaceConfig(`
[workspace]
conflict_resolution = "disabled"

[defaults]
tracker = "markdown"
`);
    expect(config.workspace.conflictResolution).toBe("disabled");
    expect(config.workspace.conflictSchedule).toBeUndefined();
  });

  test("rejects schedule keys with disabled conflict resolution", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
conflict_resolution = "disabled"
conflict_resolution_cron = "0 3 * * *"

[defaults]
tracker = "markdown"
`),
    ).toThrow(/only used when conflict_resolution = "scheduled"/);
  });

  test("rejects schedule keys without scheduled mode", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
conflict_resolution = "auto"
conflict_resolution_cron = "0 3 * * *"

[defaults]
tracker = "markdown"
`),
    ).toThrow(/only used when conflict_resolution = "scheduled"/);
  });

  test("rejects invalid pr_labels values", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"
pr_labels = "devintern"
`),
    ).toThrow(/\[defaults\]\.pr_labels must be an array of non-empty strings/);

    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"
pr_labels = [""]
`),
    ).toThrow(/\[\[repos\]\]\[0\]\.pr_labels must be an array of non-empty strings/);
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

describe("parseWorkspaceConfig [worker.schedule] (quiet hours)", () => {
  test("parses working windows into config.worker.schedule", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[worker.schedule]
active = ["22:00-06:00", "12:00-13:00"]
blocked = ["01:30-02:30"]
timezone = "Europe/Berlin"
catch_up_missed = false

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"
`);

    expect(config.worker.schedule?.active.map((w) => w.spec)).toEqual([
      "22:00-06:00",
      "12:00-13:00",
    ]);
    expect(config.worker.schedule?.blocked.map((w) => w.spec)).toEqual(["01:30-02:30"]);
    expect(config.worker.schedule?.timezone).toBe("Europe/Berlin");
    expect(config.worker.schedule?.catchUpMissed).toBe(false);
  });

  test("no [worker] section leaves the schedule disabled", () => {
    const config = parseWorkspaceConfig(VALID_CONFIG);
    expect(config.worker.schedule).toBeNull();
  });

  test("an empty [worker.schedule] section stays disabled", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[worker.schedule]

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"
`);
    expect(config.worker.schedule).toBeNull();
  });

  test("schedule problems are collected alongside other errors", () => {
    let message = "";
    try {
      parseWorkspaceConfig(`
[defaults]
tracker = ""

[worker.schedule]
active = ["25:99-06:00"]
timezone = "Nowhere/Land"
`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/\[worker\.schedule\]\.active/);
    expect(message).toMatch(/is not a valid IANA timezone/);
    expect(message).toMatch(/tracker is required/);
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
