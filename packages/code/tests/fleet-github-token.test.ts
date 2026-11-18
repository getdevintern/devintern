import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { fleetGitHubTokenForRepo } from "../src/lib/workspace/fleet-event-acquirers";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import { buildFleetEventEnv } from "../src/lib/workspace/env";
import {
  createFleetAddressPr,
  createFleetCiFix,
  createFleetResolveConflicts,
} from "../src/lib/workspace/fleet-events";
import type { RepoManagerLike } from "../src/lib/workspace/fleet-executor";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "fleet-github-token-"));
  mkdirSync(join(workspaceDir, "env"));
  writeFileSync(join(workspaceDir, ".env"), "GITHUB_TOKEN=workspace-token\n");
  writeFileSync(join(workspaceDir, "env", "personal.env"), "GITHUB_TOKEN=personal-token\n");
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

test("GitHub event requests use the fixed GitHub team's token for its repo", () => {
  const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"
task_query = "status = 'To Do'"

[[teams]]
name = "personal-github"
tracker = "github"
task_query = "is:open"
repo = "personal"
env_file = "env/personal.env"

[[teams]]
name = "company-github"
tracker = "github"
task_query = "is:open"
repo = "company"

[[repos]]
name = "company"
remote = "https://github.com/acme/company"

[[repos]]
name = "personal"
remote = "git@github.com:user/personal.git"
`);

  expect(fleetGitHubTokenForRepo(config, workspaceDir, "acme/company")).toBe("workspace-token");
  expect(fleetGitHubTokenForRepo(config, workspaceDir, "user/personal")).toBe("personal-token");
});

function configWithTeams(teams: string): ReturnType<typeof parseWorkspaceConfig> {
  return parseWorkspaceConfig(`
[defaults]
tracker = "jira"
task_query = "status = 'To Do'"
${teams}
[[repos]]
name = "personal"
remote = "git@github.com:user/personal.git"
`);
}

test("a single fixed non-GitHub team supplies the token, matching ad-hoc tasks", () => {
  const config = configWithTeams(`
[[teams]]
name = "jira-team"
tracker = "jira"
task_query = "project = X"
repo = "personal"
env_file = "env/personal.env"
`);
  expect(fleetGitHubTokenForRepo(config, workspaceDir, "user/personal")).toBe("personal-token");
});

test("a Jira and a GitHub team fixed to one repo: the GitHub team's token is used", () => {
  writeFileSync(join(workspaceDir, "env", "jira.env"), "GITHUB_TOKEN=jira-token\n");
  const config = configWithTeams(`
[[teams]]
name = "jira-team"
tracker = "jira"
task_query = "project = X"
repo = "personal"
env_file = "env/jira.env"

[[teams]]
name = "gh-team"
tracker = "github"
task_query = "is:open"
repo = "personal"
env_file = "env/personal.env"
`);
  expect(fleetGitHubTokenForRepo(config, workspaceDir, "user/personal")).toBe("personal-token");
});

test("two GitHub teams fixed to one repo: falls back to the repo env, not the first team", () => {
  writeFileSync(join(workspaceDir, "env", "other.env"), "GITHUB_TOKEN=other-token\n");
  const config = configWithTeams(`
[[teams]]
name = "gh-a"
tracker = "github"
task_query = "is:open"
repo = "personal"
env_file = "env/personal.env"

[[teams]]
name = "gh-b"
tracker = "github"
task_query = "is:open"
repo = "personal"
env_file = "env/other.env"
`);
  expect(fleetGitHubTokenForRepo(config, workspaceDir, "user/personal")).toBe("workspace-token");
});

describe("PR follow-up runs use the fixed team's credentials", () => {
  const repoManager: RepoManagerLike = {
    ensureBareClone: async () => join(workspaceDir, "bare.git"),
    fetch: async () => {},
    ensureBaseWorktree: async () => {
      const path = join(workspaceDir, "base");
      mkdirSync(path, { recursive: true });
      return path;
    },
    createTaskWorktree: async () => workspaceDir,
    removeTaskWorktree: async () => {},
    sweepStaleWorktrees: async () => [],
  };

  const fixedTeamConfig = () =>
    configWithTeams(`
[[teams]]
name = "linear-team"
tracker = "linear"
task_query = "team = X"
repo = "personal"
env_file = "env/personal.env"
`);

  test("review, conflict and CI-fix runs get the team's GITHUB_TOKEN, keep the repo tracker", async () => {
    const config = fixedTeamConfig();
    const envs: Record<string, Record<string, string | undefined>> = {};
    const deps = {
      config,
      workspaceDir,
      repoManager,
      userHasPushAccess: async () => true,
      runReview: async (
        _s: string,
        _n: number,
        opts: { env: Record<string, string | undefined> },
      ) => {
        envs.review = opts.env;
        return true as const;
      },
      runResolve: async (
        _s: string,
        _n: number,
        opts: { env?: Record<string, string | undefined> } = {},
      ) => {
        envs.resolve = opts.env ?? {};
        return { outcome: "skipped" as const, message: "test" };
      },
      runCiFix: async (
        _s: string,
        _n: number,
        _f: string,
        opts: { env: Record<string, string | undefined> },
      ) => {
        envs.ci = opts.env;
        return true;
      },
    };
    await createFleetAddressPr(deps)("user/personal", 1);
    await createFleetResolveConflicts(deps)("user/personal", 1, { headSha: "h", baseSha: "b" });
    await createFleetCiFix(deps)("user/personal", 1, join(workspaceDir, "feedback.md"));
    for (const kind of ["review", "resolve", "ci"]) {
      expect(envs[kind]?.GITHUB_TOKEN).toBe("personal-token");
      // The team lends credentials only; it does not re-route the tracker.
      expect(envs[kind]?.TASK_TRACKER).not.toBe("linear");
      expect(envs[kind]?.DEVINTERN_WORKSPACE_TEAM).toBeUndefined();
      expect(envs[kind]?.GITHUB_REPO).toBe("user/personal");
    }
  });

  test("a repo with no fixed team keeps the workspace token", async () => {
    const config = configWithTeams("");
    let env: Record<string, string | undefined> = {};
    await createFleetAddressPr({
      config,
      workspaceDir,
      repoManager,
      userHasPushAccess: async () => true,
      runReview: async (_s, _n, opts) => {
        env = opts.env;
        return true;
      },
    })("user/personal", 1);
    expect(env.GITHUB_TOKEN).toBe("workspace-token");
  });

  test("buildFleetEventEnv matches the token used for event reads", () => {
    const config = fixedTeamConfig();
    const repo = config.repos[0]!;
    expect(buildFleetEventEnv(config, repo, workspaceDir).GITHUB_TOKEN).toBe(
      fleetGitHubTokenForRepo(config, workspaceDir, "user/personal"),
    );
  });
});
