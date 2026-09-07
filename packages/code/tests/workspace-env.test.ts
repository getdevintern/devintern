import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { ErrorMonitorConfig, RepoConfig, TeamConfig } from "../src/lib/workspace/config";
import {
  buildErrorMonitorEnv,
  buildRepoEnv,
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

  test("pins durable state and analytics identity to the workspace", () => {
    const env = buildRepoEnv(repo(), workspaceDir);
    expect(env.WEBHOOK_QUEUE_DB).toBe(join(workspaceDir, "state", "queue.db"));
    expect(env.DEVINTERN_ANALYTICS_CONFIG_DIR).toBe(workspaceDir);
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

  test("injects PR_LABELS from repo pr_labels", () => {
    const env = buildRepoEnv(repo({ prLabels: ["devintern", "auto-pr"] }), workspaceDir);
    expect(env.PR_LABELS).toBe("devintern,auto-pr");
  });

  test("repo pr_labels overrides a PR_LABELS carried by env layers", () => {
    writeFileSync(join(workspaceDir, ".env"), "PR_LABELS=from-env\n");
    const env = buildRepoEnv(repo({ prLabels: ["from-config"] }), workspaceDir);
    expect(env.PR_LABELS).toBe("from-config");

    const unset = buildRepoEnv(repo(), workspaceDir);
    expect(unset.PR_LABELS).toBe("from-env");
  });

  test("error monitor credentials are isolated per source and override team/repo layers", () => {
    writeFileSync(join(workspaceDir, ".env"), "SENTRY_AUTH_TOKEN=workspace\n");
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(join(workspaceDir, "env", "sentry.env"), "SENTRY_AUTH_TOKEN=source-file\n");
    const team: TeamConfig = {
      name: "platform",
      tracker: "jira",
      taskQuery: "project = PLAT",
      env: { SENTRY_AUTH_TOKEN: "team" },
    };
    const source: ErrorMonitorConfig = {
      id: "api-production",
      provider: "sentry",
      enabled: true,
      repo: "backend",
      team: "platform",
      organization: "acme",
      project: "api",
      intervalSeconds: 60,
      minOccurrences: 5,
      maxIssuesPerTick: 3,
      envFile: "env/sentry.env",
      env: { SENTRY_AUTH_TOKEN: "source-inline" },
    };

    const env = buildErrorMonitorEnv(source, repo(), team, workspaceDir);
    expect(env.SENTRY_AUTH_TOKEN).toBe("source-inline");
    expect(env.DEVINTERN_WORKSPACE_REPO).toBe("backend");
    expect(env.DEVINTERN_WORKSPACE_TEAM).toBe("platform");
  });

  test("parseEnvFile ignores comments, blanks, and strips quotes", () => {
    const path = join(workspaceDir, "sample.env");
    writeFileSync(path, "# comment\n\nA=1\nB='two'\nC=a=b\nBROKEN\n");
    expect(parseEnvFile(path)).toEqual({ A: "1", B: "two", C: "a=b" });
    expect(parseEnvFile(join(workspaceDir, "missing.env"))).toEqual({});
  });
});
