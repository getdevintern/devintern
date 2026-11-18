import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { findRepo, parseWorkspaceConfig, resolveCredentialTeam } from "../src/lib/workspace/config";
import type { WorkspaceConfig } from "../src/lib/workspace/config";
import {
  buildRepoEnv,
  buildRepoRunEnv,
  WORKSPACE_REPO_ENV,
  WORKSPACE_TEAM_ENV,
} from "../src/lib/workspace/env";

/**
 * Env resolution for ad-hoc (`worker add`) tasks and repo automations: which
 * `[[teams]]` entry's credentials apply, and how they layer over the repo env.
 */

const CONFIG = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
task_query = "is:open label:devintern"

[[teams]]
name = "x-rep-github"
tracker = "github"
repo = "x-rep"
env_file = "env/personal.env"
  [teams.env]
  GITHUB_REPO = "danii1/x-rep"

[[teams]]
name = "shared-a"
tracker = "github"
repo = "shared"

[[teams]]
name = "shared-b"
tracker = "github"
repo = "shared"

[[teams]]
name = "routed"
tracker = "github"
  [teams.env]
  GITHUB_TOKEN = "routed-token"

[[routing.rules]]
repo = "plain"
labels = ["plain"]

[[repos]]
name = "x-rep"
remote = "git@github.com:danii1/x-rep.git"

[[repos]]
name = "shared"
remote = "git@github.com:acme/shared.git"

[[repos]]
name = "plain"
remote = "git@github.com:acme/plain.git"
`);

describe("resolveCredentialTeam", () => {
  const resolvedName = (config: WorkspaceConfig, repo: string, requested?: string) => {
    const result = resolveCredentialTeam(config, repo, requested);
    return result.ok ? (result.team?.name ?? null) : result;
  };

  test("no fixed team and no --team: no team (unchanged behavior)", () => {
    expect(resolvedName(CONFIG, "plain")).toBeNull();
  });

  test("exactly one fixed team: that team", () => {
    expect(resolvedName(CONFIG, "x-rep")).toBe("x-rep-github");
  });

  test("--team overrides the fixed team and may name a non-fixed team", () => {
    expect(resolvedName(CONFIG, "x-rep", "routed")).toBe("routed");
    expect(resolvedName(CONFIG, "plain", "routed")).toBe("routed");
    expect(resolvedName(CONFIG, "shared", "shared-b")).toBe("shared-b");
  });

  test("two fixed teams without --team is ambiguous", () => {
    expect(resolvedName(CONFIG, "shared")).toEqual({
      ok: false,
      reason: "ambiguous",
      error: 'repo "shared" is the fixed repo of several teams (shared-a, shared-b)',
    });
  });

  test("an unknown --team is rejected with the valid names", () => {
    const result = resolveCredentialTeam(CONFIG, "x-rep", "nope");
    expect(result).toMatchObject({ ok: false, reason: "unknown-team" });
    expect(!result.ok && result.error).toContain("valid teams: x-rep-github, shared-a");
  });
});

describe("buildRepoRunEnv", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "ad-hoc-team-env-"));
    writeFileSync(
      join(workspaceDir, ".env"),
      "GITHUB_TOKEN=shared-org-token\nTASK_TRACKER=jira\nSHARED_ONLY=ws\n",
    );
    mkdirSync(join(workspaceDir, "env"));
    writeFileSync(
      join(workspaceDir, "env", "personal.env"),
      "GITHUB_TOKEN=personal-token\nTASK_TRACKER=github\n",
    );
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("without a team it is exactly the repo env", () => {
    const repo = findRepo(CONFIG, "plain")!;
    expect(buildRepoRunEnv(repo, undefined, workspaceDir)).toEqual(
      buildRepoEnv(repo, workspaceDir),
    );
  });

  test("a fixed team's env_file and inline env layer over the shared workspace .env", () => {
    const repo = findRepo(CONFIG, "x-rep")!;
    const resolved = resolveCredentialTeam(CONFIG, repo.name);
    const team = resolved.ok ? resolved.team : undefined;
    const env = buildRepoRunEnv(repo, team, workspaceDir);

    expect(env.GITHUB_TOKEN).toBe("personal-token");
    expect(env.SHARED_ONLY).toBe("ws");
    // Tracker selection stays the repo env's: the run is local, not a team poll.
    expect(env.TASK_TRACKER).toBe("jira");
    expect(env.GITHUB_REPO).toBe("danii1/x-rep");
    expect(env[WORKSPACE_REPO_ENV]).toBe("x-rep");
    expect(env[WORKSPACE_TEAM_ENV]).toBeUndefined();
  });

  test("an explicit non-fixed team keeps the destination repo's GITHUB_REPO", () => {
    const repo = findRepo(CONFIG, "plain")!;
    const resolved = resolveCredentialTeam(CONFIG, repo.name, "routed");
    const env = buildRepoRunEnv(repo, resolved.ok ? resolved.team : undefined, workspaceDir);

    expect(env.GITHUB_TOKEN).toBe("routed-token");
    expect(env.GITHUB_REPO).toBe("acme/plain");
    expect(env.TASK_TRACKER).toBe("jira");
  });

  test("a team layer cannot add TASK_TRACKER when the repo env has none", () => {
    writeFileSync(join(workspaceDir, ".env"), "GITHUB_TOKEN=shared-org-token\n");
    const saved = process.env.TASK_TRACKER;
    delete process.env.TASK_TRACKER;
    try {
      const repo = findRepo(CONFIG, "x-rep")!;
      const resolved = resolveCredentialTeam(CONFIG, repo.name);
      const env = buildRepoRunEnv(repo, resolved.ok ? resolved.team : undefined, workspaceDir);
      expect(env.TASK_TRACKER).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBe("personal-token");
    } finally {
      if (saved !== undefined) process.env.TASK_TRACKER = saved;
    }
  });
});
