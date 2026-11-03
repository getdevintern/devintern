import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { ErrorMonitorConfig, RepoConfig, TeamConfig } from "../src/lib/workspace/config";
import {
  applyWorkspaceProcessEnv,
  buildErrorMonitorEnv,
  buildRepoEnv,
  buildTeamEnv,
  buildTeamTaskEnv,
  gitHubSlugFromRemote,
  gitLabProjectFromRemote,
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

describe("gitLabProjectFromRemote", () => {
  test("parses gitlab.com https, ssh, and scp remotes", () => {
    expect(gitLabProjectFromRemote("https://gitlab.com/group/sub/repo.git")).toBe("group/sub/repo");
    expect(gitLabProjectFromRemote("https://gitlab.com/group/sub/repo/")).toBe("group/sub/repo");
    expect(gitLabProjectFromRemote("git@gitlab.com:group/sub/repo.git")).toBe("group/sub/repo");
    expect(gitLabProjectFromRemote("ssh://git@gitlab.com/group/sub/repo.git")).toBe(
      "group/sub/repo",
    );
  });

  test("parses self-managed remotes matching GITLAB_BASE_URL", () => {
    expect(
      gitLabProjectFromRemote(
        "https://git.example.com/group/sub/repo.git",
        "https://git.example.com",
      ),
    ).toBe("group/sub/repo");
    expect(
      gitLabProjectFromRemote("git@git.example.com:group/sub/repo.git", "git.example.com/"),
    ).toBe("group/sub/repo");
    expect(
      gitLabProjectFromRemote(
        "ssh://git@git.example.com/group/sub/repo.git",
        "https://git.example.com/",
      ),
    ).toBe("group/sub/repo");
    expect(
      gitLabProjectFromRemote(
        "https://git.example.com/gitlab/group/sub/repo.git",
        "https://git.example.com/gitlab/",
      ),
    ).toBe("group/sub/repo");
  });

  test("returns null for non-GitLab remotes and unmatched self-managed hosts", () => {
    expect(gitLabProjectFromRemote("git@github.com:acme/backend.git")).toBeNull();
    expect(
      gitLabProjectFromRemote("https://bitbucket.org/acme/backend.git", "https://gitlab.com"),
    ).toBeNull();
    expect(gitLabProjectFromRemote("https://git.example.com/group/sub/repo.git")).toBeNull();
    expect(
      gitLabProjectFromRemote(
        "git@git.example.com:group/sub/repo.git",
        "https://gitlab.example.com",
      ),
    ).toBeNull();
  });
});

describe("buildRepoEnv", () => {
  let workspaceDir: string;
  let savedGitLabProject: string | undefined;
  let savedGitLabBaseUrl: string | undefined;

  const repo = (overrides: Partial<RepoConfig> = {}): RepoConfig => ({
    name: "backend",
    remote: "git@github.com:acme/backend.git",
    env: {},
    ...overrides,
  });

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    savedGitLabProject = process.env.GITLAB_PROJECT;
    savedGitLabBaseUrl = process.env.GITLAB_BASE_URL;
    delete process.env.GITLAB_PROJECT;
    delete process.env.GITLAB_BASE_URL;
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    delete process.env.WS_ENV_PROCESS_MARKER;
    if (savedGitLabProject === undefined) delete process.env.GITLAB_PROJECT;
    else process.env.GITLAB_PROJECT = savedGitLabProject;
    if (savedGitLabBaseUrl === undefined) delete process.env.GITLAB_BASE_URL;
    else process.env.GITLAB_BASE_URL = savedGitLabBaseUrl;
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

  test("workspace process credentials override values inherited from a local checkout", () => {
    process.env.WS_ENV_PROCESS_MARKER = "from-local-checkout";
    writeFileSync(join(workspaceDir, ".env"), "WS_ENV_PROCESS_MARKER=from-workspace\n");

    applyWorkspaceProcessEnv(workspaceDir);

    expect(process.env.WS_ENV_PROCESS_MARKER).toBe("from-workspace");
  });

  test("pins durable state and analytics identity to the workspace", () => {
    const env = buildRepoEnv(repo(), workspaceDir);
    expect(env.WEBHOOK_QUEUE_DB).toBe(join(workspaceDir, "state", "queue.db"));
    expect(env.DEVINTERN_ANALYTICS_CONFIG_DIR).toBe(workspaceDir);
    expect(env.DEVINTERN_WORKSPACE_DIR).toBe(workspaceDir);
    expect(env.DEVINTERN_WORKER_SUBPROCESS).toBe("1");
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

  test("an explicit repo env_file GITHUB_REPO wins over the remote", () => {
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(join(workspaceDir, "env", "github.env"), "GITHUB_REPO=acme/file-fork\n");

    const env = buildRepoEnv(repo({ envFile: "env/github.env" }), workspaceDir);
    expect(env.GITHUB_REPO).toBe("acme/file-fork");
  });

  test("injects GITLAB_PROJECT from a GitLab remote unless overridden", () => {
    const remote = "git@gitlab.com:group/sub/repo.git";
    expect(buildRepoEnv(repo({ remote }), workspaceDir).GITLAB_PROJECT).toBe("group/sub/repo");

    const overridden = buildRepoEnv(
      repo({ remote, env: { GITLAB_PROJECT: "group/fork" } }),
      workspaceDir,
    );
    expect(overridden.GITLAB_PROJECT).toBe("group/fork");

    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(join(workspaceDir, "env", "gitlab.env"), "GITLAB_PROJECT=group/from-file\n");
    const fromFile = buildRepoEnv(repo({ remote, envFile: "env/gitlab.env" }), workspaceDir);
    expect(fromFile.GITLAB_PROJECT).toBe("group/from-file");
  });

  test("derived GITLAB_PROJECT overrides a workspace-wide value", () => {
    writeFileSync(join(workspaceDir, ".env"), "GITLAB_PROJECT=workspace/project\n");

    const env = buildRepoEnv(
      repo({ remote: "https://gitlab.com/group/sub/repo.git" }),
      workspaceDir,
    );
    expect(env.GITLAB_PROJECT).toBe("group/sub/repo");
  });

  test("pins GITLAB_PROJECT for a self-managed remote matching GITLAB_BASE_URL", () => {
    writeFileSync(join(workspaceDir, ".env"), "GITLAB_BASE_URL=git.example.com/\n");

    const env = buildRepoEnv(
      repo({ remote: "ssh://git@git.example.com/group/sub/repo.git" }),
      workspaceDir,
    );
    expect(env.GITLAB_PROJECT).toBe("group/sub/repo");
  });

  test("does not infer GITLAB_PROJECT for non-GitLab or unmatched self-managed remotes", () => {
    const github = buildRepoEnv(repo(), workspaceDir);
    expect(github.GITLAB_PROJECT).toBeUndefined();

    const bitbucket = buildRepoEnv(
      repo({ remote: "https://bitbucket.org/acme/backend.git" }),
      workspaceDir,
    );
    expect(bitbucket.GITLAB_PROJECT).toBeUndefined();

    const unmatched = buildRepoEnv(
      repo({ remote: "https://git.example.com/group/sub/repo.git" }),
      workspaceDir,
    );
    expect(unmatched.GITLAB_PROJECT).toBeUndefined();

    writeFileSync(join(workspaceDir, ".env"), "GITLAB_BASE_URL=https://other.example.com\n");
    const mismatched = buildRepoEnv(
      repo({ remote: "https://git.example.com/group/sub/repo.git" }),
      workspaceDir,
    );
    expect(mismatched.GITLAB_PROJECT).toBeUndefined();
  });

  test("keeps per-repo tracker project-key overrides from [repos.env]", () => {
    writeFileSync(
      join(workspaceDir, ".env"),
      "JIRA_DEFAULT_PROJECT_KEY=WORKSPACE\nLINEAR_DEFAULT_TEAM_KEY=WORKSPACE\n",
    );

    const env = buildRepoEnv(
      repo({
        env: {
          JIRA_DEFAULT_PROJECT_KEY: "BACKEND",
          LINEAR_DEFAULT_TEAM_KEY: "BACKEND-TEAM",
        },
      }),
      workspaceDir,
    );
    expect(env.JIRA_DEFAULT_PROJECT_KEY).toBe("BACKEND");
    expect(env.LINEAR_DEFAULT_TEAM_KEY).toBe("BACKEND-TEAM");
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

  test("pins workspace pipeline references for the routed repository", () => {
    const env = buildRepoEnv(repo({ pipelineFile: "pipelines/backend.json" }), workspaceDir, {
      pipelineDefaultFile: join(workspaceDir, "pipelines/default.json"),
    });
    expect(env.DEVINTERN_WORKSPACE_PIPELINE_REPO).toBe(
      join(workspaceDir, "pipelines/backend.json"),
    );
    expect(env.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT).toBe(
      join(workspaceDir, "pipelines/default.json"),
    );
  });

  test("keeps an absolute pipeline_file unchanged", () => {
    const absolute = join(workspaceDir, "absolute.json");
    const env = buildRepoEnv(repo({ pipelineFile: absolute }), workspaceDir);
    expect(env.DEVINTERN_WORKSPACE_PIPELINE_REPO).toBe(absolute);
    expect(env.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT).toBeUndefined();
  });

  test("clears pipeline references inherited from the worker process env", () => {
    process.env.DEVINTERN_WORKSPACE_PIPELINE_REPO = "/stale/repo.json";
    process.env.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT = "/stale/default.json";
    try {
      const env = buildRepoEnv(repo(), workspaceDir);
      expect(env.DEVINTERN_WORKSPACE_PIPELINE_REPO).toBeUndefined();
      expect(env.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT).toBeUndefined();
    } finally {
      delete process.env.DEVINTERN_WORKSPACE_PIPELINE_REPO;
      delete process.env.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT;
    }
  });

  test("team layers cannot re-route the pinned pipeline references", () => {
    process.env.DEVINTERN_WORKSPACE_PIPELINE_REPO = "/stale/repo.json";
    process.env.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT = "/stale/default.json";
    const team: TeamConfig = {
      name: "platform",
      tracker: "jira",
      taskQuery: "project = PLAT",
      env: {
        DEVINTERN_WORKSPACE_PIPELINE_REPO: "/team/repo.json",
        DEVINTERN_WORKSPACE_PIPELINE_DEFAULT: "/team/default.json",
      },
    };
    try {
      const pinned = buildTeamTaskEnv(
        repo({ pipelineFile: "pipelines/backend.json" }),
        team,
        workspaceDir,
        { pipelineDefaultFile: join(workspaceDir, "pipelines/default.json") },
      );
      expect(pinned.DEVINTERN_WORKSPACE_PIPELINE_REPO).toBe(
        join(workspaceDir, "pipelines/backend.json"),
      );
      expect(pinned.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT).toBe(
        join(workspaceDir, "pipelines/default.json"),
      );

      const cleared = buildTeamTaskEnv(repo(), team, workspaceDir);
      expect(cleared.DEVINTERN_WORKSPACE_PIPELINE_REPO).toBeUndefined();
      expect(cleared.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT).toBeUndefined();
    } finally {
      delete process.env.DEVINTERN_WORKSPACE_PIPELINE_REPO;
      delete process.env.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT;
    }
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
      commentOnAction: false,
      envFile: "env/sentry.env",
      env: { SENTRY_AUTH_TOKEN: "source-inline" },
    };

    const env = buildErrorMonitorEnv(source, repo(), team, workspaceDir);
    expect(env.SENTRY_AUTH_TOKEN).toBe("source-inline");
    expect(env.DEVINTERN_WORKSPACE_REPO).toBe("backend");
    expect(env.DEVINTERN_WORKSPACE_TEAM).toBe("platform");
  });

  test("team and error-monitor layers cannot override worker runtime paths", () => {
    const poisoned = {
      DEVINTERN_WORKSPACE_DIR: "/tmp/not-the-workspace",
      DEVINTERN_WORKER_SUBPROCESS: "0",
      WEBHOOK_QUEUE_DB: "/tmp/queue.db",
      DEVINTERN_ANALYTICS_CONFIG_DIR: "/tmp/analytics",
    };
    const team: TeamConfig = {
      name: "platform",
      tracker: "jira",
      taskQuery: "project = PLAT",
      env: poisoned,
    };
    const source: ErrorMonitorConfig = {
      id: "api-production",
      provider: "sentry",
      enabled: true,
      repo: "backend",
      organization: "acme",
      project: "api",
      intervalSeconds: 60,
      minOccurrences: 5,
      maxIssuesPerTick: 3,
      commentOnAction: false,
      env: poisoned,
    };
    const expected = {
      DEVINTERN_WORKSPACE_DIR: workspaceDir,
      DEVINTERN_WORKER_SUBPROCESS: "1",
      WEBHOOK_QUEUE_DB: join(workspaceDir, "state", "queue.db"),
      DEVINTERN_ANALYTICS_CONFIG_DIR: workspaceDir,
    };
    expect(buildTeamTaskEnv(repo(), team, workspaceDir)).toMatchObject(expected);
    expect(buildErrorMonitorEnv(source, repo(), team, workspaceDir)).toMatchObject(expected);
    expect(buildErrorMonitorEnv(source, repo(), undefined, workspaceDir)).toMatchObject(expected);
  });

  test("parseEnvFile ignores comments, blanks, and strips quotes", () => {
    const path = join(workspaceDir, "sample.env");
    writeFileSync(path, "# comment\n\nA=1\nB='two'\nC=a=b\nBROKEN\n");
    expect(parseEnvFile(path)).toEqual({ A: "1", B: "two", C: "a=b" });
    expect(parseEnvFile(join(workspaceDir, "missing.env"))).toEqual({});
  });
});

describe("buildTeamEnv", () => {
  test("projects tracker/team-namespaced workspace credentials", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "ws-team-env-"));
    try {
      writeFileSync(
        join(workspaceDir, ".env"),
        "JIRA_PLATFORM_URL=https://platform.atlassian.net\n" +
          "JIRA_PLATFORM_EMAIL=platform@example.com\n" +
          "JIRA_PLATFORM_API_TOKEN=platform-token\n" +
          "JIRA_GROWTH_URL=https://growth.atlassian.net\n",
      );
      const team: TeamConfig = {
        name: "platform",
        tracker: "jira",
        taskQuery: "project = PLAT",
        env: {},
      };

      const env = buildTeamEnv(team, workspaceDir);
      expect(env.JIRA_BASE_URL).toBe("https://platform.atlassian.net");
      expect(env.JIRA_EMAIL).toBe("platform@example.com");
      expect(env.JIRA_API_TOKEN).toBe("platform-token");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
