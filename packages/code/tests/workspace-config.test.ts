import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

import {
  DEFAULT_DASHBOARD,
  DEFAULT_CI_FAILURE_FIX,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_CONCURRENCY_PER_REPO,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_WORKTREES_TTL_DAYS,
  autoMergePathsFor,
  autoMergeReviewFor,
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
    expect(config.workspace.execution).toEqual({
      isolation: undefined,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      maxConcurrencyPerRepo: DEFAULT_MAX_CONCURRENCY_PER_REPO,
    });
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

    // frontend has no override and will resolve the remote's origin/HEAD.
    const frontend = findRepo(config, "frontend");
    expect(frontend?.defaultBranch).toBeUndefined();
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

  test("parses workspace and per-repo pipeline_file references", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"
pipeline_file = "pipelines/default.json"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
pipeline_file = "pipelines/backend.json"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"
`);
    expect(config.defaults.pipelineFile).toBe("pipelines/default.json");
    expect(findRepo(config, "backend")?.pipelineFile).toBe("pipelines/backend.json");
    expect(findRepo(config, "frontend")?.pipelineFile).toBeUndefined();
  });

  test("sync_team_prs is off by default and parses as a per-repo boolean", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
sync_team_prs = true

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"
`);
    expect(findRepo(config, "backend")?.syncTeamPrs).toBe(true);
    expect(findRepo(config, "frontend")?.syncTeamPrs).toBeUndefined();
  });

  test("rejects a non-boolean sync_team_prs", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
sync_team_prs = "yes"
`),
    ).toThrow(/\[\[repos\]\]\[0\]\.sync_team_prs must be a boolean/);
  });

  test("rejects sync_team_prs on a non-GitHub (e.g. GitLab) repo", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "widgets"
remote = "https://gitlab.com/acme/widgets.git"
sync_team_prs = true
`),
    ).toThrow(/sync_team_prs is GitHub-only; "widgets"/);
    // sync_team_prs = false (or absent) stays valid on GitLab repos.
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "widgets"
remote = "https://gitlab.com/acme/widgets.git"
sync_team_prs = false
`);
    expect(findRepo(config, "widgets")?.syncTeamPrs).toBe(false);
  });

  test("rejects an empty pipeline_file value", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"
pipeline_file = ""
`),
    ).toThrow(/\[defaults\]\.pipeline_file must be a non-empty string/);
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

  test("parses an explicit best-effort host concurrency opt-in", () => {
    const config = parseWorkspaceConfig(`
[workspace.execution]
isolation = "best_effort_host"
max_concurrency = 4
max_concurrency_per_repo = 2

[defaults]
tracker = "markdown"
`);

    expect(config.workspace.execution).toEqual({
      isolation: "best_effort_host",
      maxConcurrency: 4,
      maxConcurrencyPerRepo: 2,
    });
  });

  test("requires an explicit host-isolation acknowledgement above concurrency one", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace.execution]
max_concurrency = 2

[defaults]
tracker = "markdown"
`),
    ).toThrow(/isolation = "best_effort_host" is required/);
  });

  test("validates execution limits and isolation mode", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace.execution]
isolation = "required"
max_concurrency = 2
max_concurrency_per_repo = 3

[defaults]
tracker = "markdown"
`),
    ).toThrow(/isolation must be "best_effort_host"/);
    expect(() =>
      parseWorkspaceConfig(`
[workspace.execution]
isolation = "best_effort_host"
max_concurrency = 2
max_concurrency_per_repo = 3

[defaults]
tracker = "markdown"
`),
    ).toThrow(/max_concurrency_per_repo cannot exceed/);
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

  test("rejects [defaults].default_branch", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
default_branch = "main"
`),
    ).toThrow(/\[defaults\]\.default_branch is not supported/);
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

  test("parses repo- and team-scoped Sentry monitors with independent credentials", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"
poll_interval = 90

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

[[error_monitors]]
id = "api-production"
provider = "sentry"
repo = "api"
team = "platform"
organization = "acme"
project = "api"
env_file = "env/sentry-api.env"
min_occurrences = 10
max_per_tick = 2
comment_on_action = true
  [error_monitors.env]
  SENTRY_AUTH_TOKEN = "api-token"

[[error_monitors]]
id = "web-production"
provider = "sentry"
repo = "web"
organization = "acme"
project = "web"
poll_interval = 30
`);

    expect(config.errorMonitors).toHaveLength(2);
    expect(config.errorMonitors[0]).toMatchObject({
      id: "api-production",
      repo: "api",
      team: "platform",
      intervalSeconds: 90,
      minOccurrences: 10,
      maxIssuesPerTick: 2,
      commentOnAction: true,
      env: { SENTRY_AUTH_TOKEN: "api-token" },
    });
    expect(config.errorMonitors[1]).toMatchObject({
      id: "web-production",
      repo: "web",
      intervalSeconds: 30,
      commentOnAction: false,
    });
  });

  test("requires explicit monitor routing in multi-repo workspaces", () => {
    expect(() =>
      parseWorkspaceConfig(`
[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"

[[error_monitors]]
id = "production"
provider = "sentry"
organization = "acme"
project = "web"
`),
    ).toThrow(/repo is required in a workspace with multiple repositories/);
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

describe("parseWorkspaceConfig [worker] auto_update (idle self-update)", () => {
  test("defaults to enabled without the key", () => {
    const config = parseWorkspaceConfig(VALID_CONFIG);
    expect(config.worker.autoUpdate).toBe(true);
  });

  test("parses auto_update = false as the opt-out", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[worker]
auto_update = false

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"
`);
    expect(config.worker.autoUpdate).toBe(false);
  });

  test("parses auto_update = true explicitly", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[worker]
auto_update = true

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"
`);
    expect(config.worker.autoUpdate).toBe(true);
  });

  test("rejects non-boolean auto_update values", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[worker]
auto_update = "no"

[[repos]]
name = "backend"
remote = "git@github.com:acme/a.git"
`),
    ).toThrow(/\[worker\]\.auto_update must be a boolean/);
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

describe("[workspace].auto_merge", () => {
  const base = `
[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
`;

  test("is off by default with review on and squash", () => {
    const { workspace } = parseWorkspaceConfig(base);
    expect(workspace.autoMerge).toEqual({
      enabled: false,
      method: "squash",
      review: true,
      safePaths: [],
      denyPaths: [],
      reviewPaths: [],
      reviewLabel: "needs-human-review",
      policy: "strict",
      reviewLargeDiffs: false,
    });
  });

  test("auto_merge_review_label renames the label; an empty string disables it", () => {
    const parse = (value: string) =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_review_label = ${value}
${base}`).workspace.autoMerge.reviewLabel;
    expect(parse('"  triage  "')).toBe("triage");
    expect(parse('""')).toBe("");
    expect(() => parse("true")).toThrow(/auto_merge_review_label must be a string/);
  });

  test("parses the policy, agent override, and per-repo path lists", () => {
    const config = parseWorkspaceConfig(`
[workspace]
auto_merge = true
auto_merge_method = "rebase"
auto_merge_review = false
auto_merge_review_large_diffs = true
auto_merge_safe_paths = ["**/*.md", "docs/"]
auto_merge_deny_paths = ["db/migrations/**"]
auto_merge_model = "sonnet"

[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
auto_merge_safe_paths = ["e2e/**"]

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`);
    expect(config.workspace.autoMerge).toEqual({
      enabled: true,
      method: "rebase",
      review: false,
      safePaths: ["**/*.md", "docs/"],
      denyPaths: ["db/migrations/**"],
      reviewPaths: [],
      reviewLabel: "needs-human-review",
      policy: "strict",
      reviewLargeDiffs: true,
      agent: { model: "sonnet" },
    });
    const [api, web] = config.repos;
    expect(autoMergePathsFor(config.workspace.autoMerge, api!)).toEqual({
      safePaths: ["e2e/**"],
      denyPaths: ["db/migrations/**"],
      reviewPaths: [],
    });
    expect(autoMergePathsFor(config.workspace.autoMerge, web!)).toEqual({
      safePaths: ["**/*.md", "docs/"],
      denyPaths: ["db/migrations/**"],
      reviewPaths: [],
    });
  });

  test("auto_merge_review_paths: workspace list, per-repo replacement, and validation", () => {
    const config = parseWorkspaceConfig(`
[workspace]
auto_merge_safe_paths = ["**/*.md"]
auto_merge_review_paths = ["**/AGENTS.md", "**/skills/**"]

[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
auto_merge_review_paths = ["prompts/"]

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"

[[repos]]
name = "docs"
remote = "git@github.com:acme/docs.git"
auto_merge_review_paths = []
`);
    const settings = config.workspace.autoMerge;
    expect(settings.reviewPaths).toEqual(["**/AGENTS.md", "**/skills/**"]);
    const [api, web, docs] = config.repos;
    expect(api?.autoMergeReviewPaths).toEqual(["prompts/"]);
    expect(web).not.toHaveProperty("autoMergeReviewPaths");
    // Per-repo lists replace the workspace list; they are not merged.
    expect(autoMergePathsFor(settings, api!).reviewPaths).toEqual(["prompts/"]);
    expect(autoMergePathsFor(settings, web!).reviewPaths).toEqual(["**/AGENTS.md", "**/skills/**"]);
    expect(autoMergePathsFor(settings, docs!).reviewPaths).toEqual([]);

    const invalid = (snippet: string) => () => parseWorkspaceConfig(`${snippet}\n${base}`);
    expect(invalid('[workspace]\nauto_merge_review_paths = "AGENTS.md"')).toThrow(
      /auto_merge_review_paths/,
    );
    expect(invalid("[workspace]\nauto_merge_review_paths = [1]")).toThrow(
      /auto_merge_review_paths/,
    );
    expect(invalid('[workspace]\nauto_merge_review_paths = ["../x/**"]')).toThrow(
      /auto_merge_review_paths entry "..\/x\/\*\*" must be a repo-relative glob/,
    );
    expect(() => parseWorkspaceConfig(`${base}auto_merge_review_paths = "AGENTS.md"\n`)).toThrow(
      /\[\[repos\]\]\[0\]\.auto_merge_review_paths must be an array/,
    );
  });

  test("auto_merge_policy and review instructions: workspace values with per-repo overrides", () => {
    const config = parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "standard"
auto_merge_review_instructions = """
- Changes under billing/ always need a human.
"""

[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
auto_merge_policy = "strict"
auto_merge_review_instructions = "Never merge schema changes."

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"

[[repos]]
name = "docs"
remote = "git@github.com:acme/docs.git"
auto_merge_review_instructions = ""
`);
    const settings = config.workspace.autoMerge;
    expect(settings.policy).toBe("standard");
    expect(settings.reviewInstructions).toBe("- Changes under billing/ always need a human.");
    const [api, web, docs] = config.repos;
    expect(api).toMatchObject({
      autoMergePolicy: "strict",
      autoMergeReviewInstructions: "Never merge schema changes.",
    });
    expect(autoMergeReviewFor(settings, api!, "/ws")).toEqual({
      reviewPolicy: "strict",
      reviewInstructions: "Never merge schema changes.",
    });
    expect(web).not.toHaveProperty("autoMergePolicy");
    expect(autoMergeReviewFor(settings, web!, "/ws")).toEqual({
      reviewPolicy: "standard",
      reviewInstructions: "- Changes under billing/ always need a human.",
    });
    // An empty per-repo string clears the workspace instructions.
    expect(autoMergeReviewFor(settings, docs!, "/ws")).toEqual({ reviewPolicy: "standard" });
  });

  test("rejects unknown auto_merge_policy values and non-string instructions", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "lenient"
${base}`),
    ).toThrow(/\[workspace\]\.auto_merge_policy must be one of: strict, standard, relaxed, custom/);
    expect(() =>
      parseWorkspaceConfig(`${base}auto_merge_policy = "lenient"
`),
    ).toThrow(/auto_merge_policy must be one of: strict, standard/);
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_review_instructions = ["no"]
${base}`),
    ).toThrow(/auto_merge_review_instructions must be a string/);
  });

  test("parses every preset", () => {
    for (const policy of ["strict", "standard", "relaxed"] as const) {
      const config = parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "${policy}"
${base}`);
      expect(config.workspace.autoMerge.policy).toBe(policy);
      expect(autoMergeReviewFor(config.workspace.autoMerge, config.repos[0]!, "/ws")).toEqual({
        reviewPolicy: policy,
      });
    }
  });

  test("custom with inline rules", () => {
    const config = parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "custom"
auto_merge_rules = """
- Anything under billing/ is unsafe.
"""
auto_merge_review_instructions = "Also hold schema changes."
${base}`);
    const settings = config.workspace.autoMerge;
    expect(settings).toMatchObject({
      policy: "custom",
      rules: "- Anything under billing/ is unsafe.",
    });
    expect(settings).not.toHaveProperty("rulesFile");
    expect(autoMergeReviewFor(settings, config.repos[0]!, "/ws")).toEqual({
      reviewPolicy: "custom",
      rules: "- Anything under billing/ is unsafe.",
      reviewInstructions: "Also hold schema changes.",
    });
  });

  test("custom with a rules file resolves against the workspace home, with ~ expanded", () => {
    const config = parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "custom"
auto_merge_rules_file = "merge-rules.md"

[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
auto_merge_rules_file = "~/rules/web.md"

[[repos]]
name = "abs"
remote = "git@github.com:acme/abs.git"
auto_merge_rules_file = "/etc/devintern/abs.md"
`);
    const settings = config.workspace.autoMerge;
    expect(settings.rulesFile).toBe("merge-rules.md");
    const [api, web, abs] = config.repos;
    // Never relative to the process cwd (the repo checkout auto-merge runs in).
    expect(autoMergeReviewFor(settings, api!, "/home/me/.devintern")).toEqual({
      reviewPolicy: "custom",
      rulesFile: "/home/me/.devintern/merge-rules.md",
    });
    expect(autoMergeReviewFor(settings, web!, "/ws").rulesFile).toBe(
      join(homedir(), "rules/web.md"),
    );
    expect(autoMergeReviewFor(settings, abs!, "/ws").rulesFile).toBe("/etc/devintern/abs.md");
  });

  test("per-repo rules and policy replace the workspace's", () => {
    const config = parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "custom"
auto_merge_rules_file = "rules.md"

[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
auto_merge_rules = "Only docs are safe."

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
auto_merge_policy = "relaxed"

[[repos]]
name = "cli"
remote = "git@github.com:acme/cli.git"
auto_merge_policy = "custom"
`);
    const settings = config.workspace.autoMerge;
    const [api, web, cli] = config.repos;
    expect(api).toMatchObject({ autoMergeRules: "Only docs are safe." });
    // The repo's inline rules replace the workspace file; they do not merge.
    expect(autoMergeReviewFor(settings, api!, "/ws")).toEqual({
      reviewPolicy: "custom",
      rules: "Only docs are safe.",
    });
    expect(autoMergeReviewFor(settings, web!, "/ws")).toEqual({ reviewPolicy: "relaxed" });
    expect(autoMergeReviewFor(settings, cli!, "/ws")).toEqual({
      reviewPolicy: "custom",
      rulesFile: "/ws/rules.md",
    });
  });

  test("rejects invalid custom-rule combinations", () => {
    const repo = (extra: string) => `
[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
${extra}
`;
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "custom"
${base}`),
    ).toThrow(/\[workspace\]\.auto_merge_policy = "custom" needs auto_merge_rules or/);
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "custom"
auto_merge_rules = "x"
auto_merge_rules_file = "rules.md"
${base}`),
    ).toThrow(/set only one of auto_merge_rules and auto_merge_rules_file/);
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_rules = "x"
${base}`),
    ).toThrow(/apply only with auto_merge_policy = "custom" \(the policy here is "strict"\)/);
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "standard"
${repo('auto_merge_rules_file = "rules.md"')}`),
    ).toThrow(/\[\[repos\]\] "api"\.auto_merge_rules and auto_merge_rules_file apply only/);
    expect(() => parseWorkspaceConfig(repo('auto_merge_policy = "custom"'))).toThrow(
      /\[\[repos\]\] "api"\.auto_merge_policy = "custom" needs/,
    );
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_policy = "custom"
auto_merge_rules = "  "
${base}`),
    ).toThrow(/auto_merge_rules must be a non-empty string/);
    // A repo can opt into custom with its own rules under a strict workspace.
    const ok = parseWorkspaceConfig(repo('auto_merge_policy = "custom"\nauto_merge_rules = "x"'));
    expect(ok.repos[0]).toMatchObject({ autoMergePolicy: "custom", autoMergeRules: "x" });
  });

  test("caps inline rules at 20,000 characters", () => {
    const rules = (n: number) => `
[workspace]
auto_merge_policy = "custom"
auto_merge_rules = "${"a".repeat(n)}"
${base}`;
    expect(parseWorkspaceConfig(rules(20_000)).workspace.autoMerge.rules).toHaveLength(20_000);
    expect(() => parseWorkspaceConfig(rules(20_001))).toThrow(
      /auto_merge_rules is 20001 characters; the limit is 20000/,
    );
  });

  test("rejects unknown merge methods and non-relative globs", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_method = "octopus"
${base}`),
    ).toThrow(/auto_merge_method must be one of: merge, squash, rebase/);
    expect(() =>
      parseWorkspaceConfig(`
[workspace]
auto_merge_safe_paths = ["../outside/**"]
${base}`),
    ).toThrow(/must be a repo-relative glob/);
  });
});
