import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { RepoConfig, TeamConfig } from "../src/lib/workspace/config";
import {
  buildRepoEnv,
  buildTeamEnv,
  buildTeamTaskEnv,
  gitHubSlugFromRemote,
  parseEnvFile,
} from "../src/lib/workspace/env";

describe("gitHubSlugFromRemote", () => {
  test("parses ssh and https GitHub remotes", () => {
    expect(gitHubSlugFromRemote("git@github.com:acme/backend.git")).toBe("acme/backend");
    expect(gitHubSlugFromRemote("https://github.com/acme/backend.git")).toBe("acme/backend");
    expect(gitHubSlugFromRemote("https://github.com/acme/backend")).toBe("acme/backend");
    expect(gitHubSlugFromRemote("https://github.com/acme/backend/")).toBe("acme/backend");
  });

  test("returns null for non-GitHub remotes", () => {
    expect(gitHubSlugFromRemote("git@bitbucket.org:acme/backend.git")).toBeNull();
    expect(gitHubSlugFromRemote("file:///srv/git/backend.git")).toBeNull();
  });
});

describe("buildRepoEnv", () => {
  let workspaceDir: string;

  const repo = (overrides: Partial<RepoConfig> = {}): RepoConfig => ({
    name: "backend",
    remote: "git@github.com:acme/backend.git",
    env: {},
    ...overrides,
  });

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    delete process.env.WS_ENV_PROCESS_MARKER;
  });

  test("layers workspace .env, repo env_file, and inline env in precedence order", () => {
    process.env.WS_ENV_PROCESS_MARKER = "from-process";
    writeFileSync(
      join(workspaceDir, ".env"),
      'SHARED="from-workspace"\nWORKSPACE_ONLY=ws\nWS_ENV_PROCESS_MARKER=from-workspace\n',
    );
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(join(workspaceDir, "env", "backend.env"), "SHARED=from-file\nFILE_ONLY=file\n");

    const env = buildRepoEnv(
      repo({ envFile: "env/backend.env", env: { SHARED: "inline", INLINE_ONLY: "inline" } }),
      workspaceDir,
    );

    expect(env.WS_ENV_PROCESS_MARKER).toBe("from-workspace"); // workspace .env beats process
    expect(env.WORKSPACE_ONLY).toBe("ws");
    expect(env.FILE_ONLY).toBe("file");
    expect(env.SHARED).toBe("inline"); // inline wins over env_file and .env
    expect(env.INLINE_ONLY).toBe("inline");
  });

  test("pins WEBHOOK_QUEUE_DB to the central workspace DB", () => {
    const env = buildRepoEnv(repo(), workspaceDir);
    expect(env.WEBHOOK_QUEUE_DB).toBe(join(workspaceDir, "state", "queue.db"));
  });

  test("injects GITHUB_REPO from a GitHub remote unless overridden", () => {
    expect(buildRepoEnv(repo(), workspaceDir).GITHUB_REPO).toBe("acme/backend");

    const overridden = buildRepoEnv(repo({ env: { GITHUB_REPO: "acme/fork" } }), workspaceDir);
    expect(overridden.GITHUB_REPO).toBe("acme/fork");

    const nonGitHub = buildRepoEnv(
      repo({ remote: "git@bitbucket.org:acme/backend.git" }),
      workspaceDir,
    );
    expect(nonGitHub.GITHUB_REPO).toBe(process.env.GITHUB_REPO);
  });

  test("parseEnvFile ignores comments, blanks, and strips quotes", () => {
    const path = join(workspaceDir, "sample.env");
    writeFileSync(path, "# comment\n\nA=1\nB='two'\nC=a=b\nBROKEN\n");
    expect(parseEnvFile(path)).toEqual({ A: "1", B: "two", C: "a=b" });
    expect(parseEnvFile(join(workspaceDir, "missing.env"))).toEqual({});
  });

  test("resolves a relative env_file against the workspace dir and absolute paths as-is", () => {
    writeFileSync(join(workspaceDir, ".env"), "FROM_WS=ws\n");
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(join(workspaceDir, "env", "relative.env"), "REL=rel\n");

    const relative = buildRepoEnv(repo({ envFile: "env/relative.env" }), workspaceDir);
    expect(relative.REL).toBe("rel");
    expect(relative.FROM_WS).toBe("ws");

    const absolute = buildRepoEnv(
      repo({ envFile: join(workspaceDir, "env", "relative.env") }),
      workspaceDir,
    );
    expect(absolute.REL).toBe("rel");
  });
});

describe("buildTeamEnv", () => {
  let workspaceDir: string;

  const team = (overrides: Partial<TeamConfig> = {}): TeamConfig => ({
    name: "platform",
    tracker: "jira",
    env: {},
    ...overrides,
  });

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("layers workspace .env, team env_file, and inline env in precedence order", () => {
    writeFileSync(join(workspaceDir, ".env"), "SHARED=from-workspace\nWS_ONLY=ws\n");
    mkdirSync(join(workspaceDir, "teams"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "teams", "platform.env"),
      "SHARED=from-team-file\nFILE_ONLY=file\n",
    );

    const env = buildTeamEnv(
      team({
        envFile: "teams/platform.env",
        env: { SHARED: "inline", INLINE_ONLY: "inline" },
      }),
      workspaceDir,
    );

    expect(env.WS_ONLY).toBe("ws");
    expect(env.FILE_ONLY).toBe("file");
    expect(env.SHARED).toBe("inline"); // inline wins over env_file
    expect(env.INLINE_ONLY).toBe("inline");
  });

  test("resolves a relative team env_file against the workspace dir", () => {
    mkdirSync(join(workspaceDir, "teams"), { recursive: true });
    writeFileSync(join(workspaceDir, "teams", "platform.env"), "JIRA_API_TOKEN=tok\n");

    const env = buildTeamEnv(team({ envFile: "teams/platform.env" }), workspaceDir);
    expect(env.JIRA_API_TOKEN).toBe("tok");

    const absolute = buildTeamEnv(
      team({ envFile: join(workspaceDir, "teams", "platform.env") }),
      workspaceDir,
    );
    expect(absolute.JIRA_API_TOKEN).toBe("tok");
  });
});

describe("buildTeamTaskEnv", () => {
  let workspaceDir: string;

  const repo = (overrides: Partial<RepoConfig> = {}): RepoConfig => ({
    name: "backend",
    remote: "git@github.com:acme/backend.git",
    env: {},
    ...overrides,
  });

  const team = (overrides: Partial<TeamConfig> = {}): TeamConfig => ({
    name: "platform",
    tracker: "linear",
    env: {},
    ...overrides,
  });

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("repo env_file overrides survive team layering despite the workspace .env", () => {
    // Regression: the team layers used to re-spread the workspace .env over
    // the repo's env_file / [repos.env] overrides.
    writeFileSync(
      join(workspaceDir, ".env"),
      "GITHUB_TOKEN=from-workspace\nSHARED=from-workspace\n",
    );
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(join(workspaceDir, "env", "backend.env"), "GITHUB_TOKEN=from-repo-file\n");

    const env = buildTeamTaskEnv(repo({ envFile: "env/backend.env" }), team(), workspaceDir);

    expect(env.GITHUB_TOKEN).toBe("from-repo-file");
    expect(env.SHARED).toBe("from-workspace"); // workspace layer still applies below repo layers
  });

  test("team wins ties against repo layers", () => {
    writeFileSync(join(workspaceDir, "repo.env"), "TRACKER_TOKEN=from-repo\n");
    writeFileSync(join(workspaceDir, "team.env"), "TRACKER_TOKEN=from-team\n");

    const env = buildTeamTaskEnv(
      repo({ envFile: "repo.env" }),
      team({ envFile: "team.env" }),
      workspaceDir,
    );

    expect(env.TRACKER_TOKEN).toBe("from-team");
  });

  test("TASK_TRACKER pin survives every layer including inline overrides", () => {
    writeFileSync(join(workspaceDir, ".env"), "TASK_TRACKER=jira\n");

    const fromWorkspace = buildTeamTaskEnv(repo(), team({ tracker: "linear" }), workspaceDir);
    expect(fromWorkspace.TASK_TRACKER).toBe("linear");

    const fromRepoInline = buildTeamTaskEnv(
      repo({ env: { TASK_TRACKER: "github" } }),
      team({ tracker: "asana" }),
      workspaceDir,
    );
    expect(fromRepoInline.TASK_TRACKER).toBe("asana");

    const fromTeamInline = buildTeamTaskEnv(
      repo(),
      team({ tracker: "trello", env: { TASK_TRACKER: "jira" } }),
      workspaceDir,
    );
    expect(fromTeamInline.TASK_TRACKER).toBe("trello");
  });

  test("keeps buildRepoEnv behavior for injected workspace values", () => {
    const env = buildTeamTaskEnv(repo(), team(), workspaceDir);

    expect(env.WEBHOOK_QUEUE_DB).toBe(join(workspaceDir, "state", "queue.db"));
    expect(env.GITHUB_REPO).toBe("acme/backend");
  });
});
