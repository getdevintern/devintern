import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  DEFAULT_DASHBOARD,
  DEFAULT_CI_FAILURE_FIX,
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
    expect(config.workspace.ciFailureFix).toBe(DEFAULT_CI_FAILURE_FIX);
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
ci_failure_fix = true

[defaults]
tracker = "markdown"
poll_interval = 15
`);
    expect(config.workspace.dashboard).toBe(false);
    expect(config.workspace.dashboardPort).toBe(4410);
    expect(config.workspace.ciFailureFix).toBe(true);
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

  describe("[[estimations]]", () => {
    function configWithEstimations(table: string): string {
      return `
[defaults]
tracker = "jira"
task_query = "labels = devintern"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

${table}
`;
    }

    test("parses scheduled estimation sweeps", () => {
      const config = parseWorkspaceConfig(
        configWithEstimations(`
[[estimations]]
id = "weekday-groom"
enabled = true
cron = "0 9 * * 1-5"
query = "status = 'To Do' AND labels IN (NeedsEstimate)"

[[estimations]]
id = "sprint-gaps"
enabled = true
cron = "0 10 * * 3"
query = "sprint in openSprints() AND \\"Story Points\\" is EMPTY"
`),
      );

      expect(config.estimations).toHaveLength(2);
      expect(config.estimations[0]).toMatchObject({
        id: "weekday-groom",
        enabled: true,
        cron: "0 9 * * 1-5",
        query: "status = 'To Do' AND labels IN (NeedsEstimate)",
      });
      expect(config.estimations[1]?.query).toContain("is EMPTY");
    });

    test("an omitted table leaves estimation off", () => {
      expect(parseWorkspaceConfig(VALID_CONFIG).estimations).toEqual([]);
    });

    test("requires no repo or routing even with several repos", () => {
      const config = parseWorkspaceConfig(
        configWithEstimations(`
[[estimations]]
id = "groom"
enabled = true
interval = "1d"
query = "labels IN (NeedsEstimate)"
`),
      );
      // Estimation entries carry only schedule + query fields.
      expect(config.estimations[0]).toEqual({
        id: "groom",
        enabled: true,
        interval: "1d",
        intervalMs: 86_400_000,
        query: "labels IN (NeedsEstimate)",
      });
    });

    test("rejects prompt and repo keys", () => {
      expect(() =>
        parseWorkspaceConfig(
          configWithEstimations(`
[[estimations]]
id = "groom"
enabled = true
interval = "1d"
query = "q"
prompt = "implement it"
repo = "backend"
`),
        ),
      ).toThrow(/prompt is not supported[\s\S]*repo is not supported/s);
    });

    test("rejects the kind selector", () => {
      expect(() =>
        parseWorkspaceConfig(
          configWithEstimations(`
[[estimations]]
id = "groom"
enabled = true
interval = "1d"
query = "q"
kind = "estimate"
`),
        ),
      ).toThrow(/kind is not supported/);
    });

    test("rejects [defaults].estimate_query", () => {
      expect(() =>
        parseWorkspaceConfig(`
[defaults]
tracker = "jira"
estimate_query = "labels = NeedsEstimate"
`),
      ).toThrow(/\[defaults\]\.estimate_query is not supported/);
    });

    test.each(["trello", "markdown"])(
      "fails startup on trackers that cannot estimate (%s)",
      (tracker) => {
        expect(() =>
          parseWorkspaceConfig(`
[defaults]
tracker = "${tracker}"

[[repos]]
name = "board"
remote = "git@github.com:acme/board.git"

[[estimations]]
id = "groom"
enabled = true
interval = "1d"
query = "list:'To Do'"
`),
        ).toThrow(/requires a tracker that supports --estimate/);
      },
    );
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
  test("a team can map every task directly to one repo", () => {
    const config = parseWorkspaceConfig(`
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
    expect(config.defaults.tracker).toBe("");
    expect(config.teams).toEqual([
      {
        name: "platform",
        tracker: "jira",
        taskQuery: "project = PLAT",
        repo: "api",
        envFile: undefined,
        env: {},
      },
    ]);
  });

  test("a team spanning several repos uses team-scoped routing", () => {
    const config = parseWorkspaceConfig(`
[[teams]]
name = "platform"
tracker = "gitlab"
task_query = "labels=devintern"

[[repos]]
name = "api"
remote = "git@gitlab.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@gitlab.com:acme/web.git"

[[routing.rules]]
team = "platform"
repo = "api"
labels = ["backend"]

[[routing.rules]]
team = "platform"
repo = "web"
labels = ["frontend"]
`);
    expect(config.teams[0]?.tracker).toBe("gitlab");
    expect(config.teams[0]?.repo).toBeUndefined();
    expect(config.routing.map((rule) => rule.repo)).toEqual(["api", "web"]);
  });

  test("rejects unknown fixed repos and fixed-plus-rules ambiguity", () => {
    expect(() =>
      parseWorkspaceConfig(`
[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT"
repo = "missing"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
`),
    ).toThrow(/repo "missing" does not match any \[\[repos\]\] name/);

    expect(() =>
      parseWorkspaceConfig(`
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

[[routing.rules]]
team = "platform"
repo = "web"
labels = ["frontend"]
`),
    ).toThrow(/sets repo and cannot also have team-scoped routing rules/);
  });

  test("requires routing for an unfixed team in a multi-repo workspace", () => {
    expect(() =>
      parseWorkspaceConfig(`
[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`),
    ).toThrow(/has no applicable routing rules/);
  });

  test("team names are unique case-insensitively", () => {
    expect(() =>
      parseWorkspaceConfig(`
[[teams]]
name = "Platform"
tracker = "jira"
task_query = "project = PLAT"

[[teams]]
name = "platform"
tracker = "linear"
task_query = "{}"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
`),
    ).toThrow(/Duplicate team name/);
  });

  test("scheduled estimations require an explicit defaults tracker", () => {
    expect(() =>
      parseWorkspaceConfig(`
[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[estimations]]
id = "groom"
enabled = true
query = "project = PLAT"
interval = "1d"
`),
    ).toThrow(/\[\[estimations\]\] uses \[defaults\]\.tracker/);
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
      /devintern worker scaffold/,
    );
  });
});
