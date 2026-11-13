import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { EstimationAcquirer } from "../src/lib/automation/estimation-acquirer";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import { WorkspaceConfigReloader } from "../src/lib/workspace/config-reload";
import { WORKSPACE_REPO_ENV, WORKSPACE_TEAM_ENV } from "../src/lib/workspace/env";
import { workspaceDbPath } from "../src/lib/workspace/paths";
import {
  resolveWorkspaceEstimationContext,
  validateReloadedWorkspaceConfig,
} from "../src/lib/workspace/workspace-worker";

/** Jira defaults plus a Jira team and a GitHub-Issues team with its own credentials. */
function teamsConfig(estimations: string): string {
  return `
[defaults]
tracker = "jira"
task_query = "labels = devintern"

[[teams]]
name = "platform"
task_query = "project = PLAT"
repo = "backend"

[[teams]]
name = "Issues"
tracker = "github"
task_query = "label:devintern"
repo = "backend"
env_file = "issues.env"

[teams.env]
GITHUB_STATUS_LABELS = "todo,doing,done"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

${estimations}
`;
}

const TEAMLESS = `
[[estimations]]
id = "groom"
enabled = true
interval = "15m"
query = "labels = NeedsEstimate"
`;

const ISSUES_TEAM = `
[[estimations]]
id = "groom"
enabled = true
interval = "15m"
query = "labels = NeedsEstimate"
team = "issues"
`;

describe("[[estimations]] team: config parsing", () => {
  test("parses team and canonicalizes it to the declared team name", () => {
    const config = parseWorkspaceConfig(teamsConfig(ISSUES_TEAM));
    expect(config.estimations[0]?.team).toBe("Issues");
  });

  test("an entry without team carries no team key", () => {
    const config = parseWorkspaceConfig(teamsConfig(TEAMLESS));
    expect(config.estimations[0]).not.toHaveProperty("team");
  });

  test("rejects an empty team string", () => {
    expect(() =>
      parseWorkspaceConfig(teamsConfig(ISSUES_TEAM.replace('team = "issues"', 'team = ""'))),
    ).toThrow(/\[\[estimations\]\]\[0\]\.team must be a non-empty string/);
  });
});

describe("[[estimations]] team: validation", () => {
  test("an unknown team is an error", () => {
    expect(() =>
      parseWorkspaceConfig(teamsConfig(ISSUES_TEAM.replace('"issues"', '"mobile"'))),
    ).toThrow(/Estimation "groom"\.team "mobile" does not match any \[\[teams\]\] name/);
  });

  test("a team without any [[teams]] configured is an error", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
${ISSUES_TEAM}`),
    ).toThrow(/Estimation "groom"\.team "issues" is set but no \[\[teams\]\] are configured/);
  });

  test("a team whose tracker cannot estimate is an error naming team and tracker", () => {
    expect(() =>
      parseWorkspaceConfig(
        teamsConfig(ISSUES_TEAM.replace('"issues"', '"platform"')).replace(
          'name = "platform"\ntask_query',
          'name = "platform"\ntracker = "trello"\ntask_query',
        ),
      ),
    ).toThrow(
      /Estimation "groom" requires a tracker that supports --estimate \(supported: [^)]+\); team "platform" tracker "trello" does not\./,
    );
  });

  test("team estimations do not need [defaults].tracker", () => {
    const config = parseWorkspaceConfig(
      teamsConfig(ISSUES_TEAM)
        .replace('tracker = "jira"\n', "")
        .replace(
          'name = "platform"\ntask_query',
          'name = "platform"\ntracker = "jira"\ntask_query',
        ),
    );
    expect(config.defaults.tracker).toBe("");
    expect(config.estimations[0]?.team).toBe("Issues");
  });

  test("the [defaults].tracker requirement still applies to team-less estimations", () => {
    expect(() =>
      parseWorkspaceConfig(
        teamsConfig(`${ISSUES_TEAM}${TEAMLESS.replace('"groom"', '"shared"')}`)
          .replace('tracker = "jira"\n', "")
          .replace(
            'name = "platform"\ntask_query',
            'name = "platform"\ntracker = "jira"\ntask_query',
          ),
      ),
    ).toThrow(/\[\[estimations\]\] uses \[defaults\]\.tracker/);
  });

  test("an unsupported [defaults].tracker does not block a team estimation", () => {
    const config = parseWorkspaceConfig(
      teamsConfig(ISSUES_TEAM)
        .replace(
          'tracker = "jira"\ntask_query = "labels',
          'tracker = "trello"\ntask_query = "labels',
        )
        .replace(
          'name = "platform"\ntask_query',
          'name = "platform"\ntracker = "jira"\ntask_query',
        ),
    );
    expect(config.defaults.tracker).toBe("trello");
    expect(config.estimations[0]?.team).toBe("Issues");
  });
});

describe("resolveWorkspaceEstimationContext", () => {
  let workspaceDir: string;
  const saved: Record<string, string | undefined> = {};
  const keys = ["TASK_TRACKER", WORKSPACE_TEAM_ENV, WORKSPACE_REPO_ENV, "GITHUB_REPO"];

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "estimation-team-"));
    writeFileSync(
      join(workspaceDir, ".env"),
      "JIRA_API_TOKEN=shared-jira\nGITHUB_TOKEN=shared-gh\n",
    );
    writeFileSync(
      join(workspaceDir, "issues.env"),
      "GITHUB_TOKEN=issues-gh\nGITHUB_REPO=acme/issues\n",
    );
    for (const key of keys) saved[key] = process.env[key];
    // The worker pins [defaults].tracker on its own process env at startup.
    process.env.TASK_TRACKER = "jira";
    // Leaked shell markers must never attribute or re-route a sweep.
    process.env[WORKSPACE_TEAM_ENV] = "leaked-team";
    process.env[WORKSPACE_REPO_ENV] = "leaked-repo";
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("a team estimation uses that team's tracker, env_file, and inline env", () => {
    const config = parseWorkspaceConfig(teamsConfig(ISSUES_TEAM));
    const context = resolveWorkspaceEstimationContext(config.estimations[0]!, config, workspaceDir);

    expect(context?.cwd).toBe(workspaceDir);
    expect(context?.repo).toBeUndefined();
    const env = context?.env ?? {};
    expect(env.TASK_TRACKER).toBe("github");
    expect(env[WORKSPACE_TEAM_ENV]).toBe("Issues");
    expect(env[WORKSPACE_REPO_ENV]).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBe("issues-gh");
    expect(env.GITHUB_REPO).toBe("acme/issues");
    expect(env.GITHUB_STATUS_LABELS).toBe("todo,doing,done");
    // Shared workspace values still sit underneath the team layers.
    expect(env.JIRA_API_TOKEN).toBe("shared-jira");
    expect(env.WEBHOOK_QUEUE_DB).toBe(workspaceDbPath(workspaceDir));
    expect(env.DEVINTERN_WORKSPACE_DIR).toBe(workspaceDir);
  });

  test("a team-less estimation keeps the defaults tracker and shared env", () => {
    const config = parseWorkspaceConfig(teamsConfig(TEAMLESS));
    const context = resolveWorkspaceEstimationContext(config.estimations[0]!, config, workspaceDir);

    const env = context?.env ?? {};
    expect(context?.cwd).toBe(workspaceDir);
    expect(env.TASK_TRACKER).toBe("jira");
    expect(env[WORKSPACE_TEAM_ENV]).toBeUndefined();
    expect(env.GITHUB_STATUS_LABELS).toBeUndefined();
    expect(env.GITHUB_REPO).toBe(saved.GITHUB_REPO);
    expect(env.WEBHOOK_QUEUE_DB).toBe(workspaceDbPath(workspaceDir));
  });

  test("an unconfigured team skips the occurrence", () => {
    const config = parseWorkspaceConfig(teamsConfig(TEAMLESS));
    const context = resolveWorkspaceEstimationContext(
      { ...config.estimations[0]!, team: "gone" },
      config,
      workspaceDir,
    );
    expect(context).toBeNull();
  });
});

describe("[[estimations]] team: live reload", () => {
  let workspaceDir: string;
  let savedTracker: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "estimation-team-reload-"));
    writeFileSync(join(workspaceDir, "issues.env"), "GITHUB_TOKEN=issues-gh\n");
    savedTracker = process.env.TASK_TRACKER;
    process.env.TASK_TRACKER = "jira";
  });

  afterEach(() => {
    if (savedTracker === undefined) delete process.env.TASK_TRACKER;
    else process.env.TASK_TRACKER = savedTracker;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("a reload that adds and changes team applies to the next occurrence", async () => {
    const configPath = join(workspaceDir, "workspace.toml");
    writeFileSync(configPath, teamsConfig(TEAMLESS));
    const config = parseWorkspaceConfig(teamsConfig(TEAMLESS));

    let now = 0;
    const runs: Array<{ tracker?: string; team?: string }> = [];
    const acquirer = new EstimationAcquirer({
      estimations: config.estimations,
      dbPath: join(workspaceDir, "queue.db"),
      now: () => now,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      // Same wiring as the worker: resolve against the live shared config.
      resolveContext: async (estimation) =>
        resolveWorkspaceEstimationContext(estimation, config, workspaceDir),
      spawnRun: (_estimation, context) => {
        runs.push({ tracker: context.env.TASK_TRACKER, team: context.env[WORKSPACE_TEAM_ENV] });
        return { completion: Promise.resolve(true), terminate() {} };
      },
    });
    const reloader = new WorkspaceConfigReloader({
      configPath,
      current: config,
      validate: (next, active) =>
        validateReloadedWorkspaceConfig(next, active, { multiTeam: true, sourceCount: 2 }),
      onApplied: (updated) => acquirer.applyEstimations(updated.estimations),
      onError: (message) => {
        throw new Error(message);
      },
    });

    const occurrence = async (): Promise<void> => {
      now += 900_000;
      await acquirer.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await acquirer.start();
    await occurrence();

    writeFileSync(configPath, teamsConfig(ISSUES_TEAM));
    expect(reloader.reload("test").applied).toBe(true);
    await occurrence();

    writeFileSync(configPath, teamsConfig(ISSUES_TEAM.replace('"issues"', '"platform"')));
    expect(reloader.reload("test").applied).toBe(true);
    await occurrence();

    reloader.stop();
    await acquirer.stop();

    expect(runs).toEqual([
      { tracker: "jira", team: undefined },
      { tracker: "github", team: "Issues" },
      { tracker: "jira", team: "platform" },
    ]);
  });
});
