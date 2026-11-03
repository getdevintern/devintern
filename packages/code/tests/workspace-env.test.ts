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

  test("rejects a remote whose port differs from the tracker instance", () => {
    expect(
      gitLabProjectFromRemote(
        "https://git.example.com:9443/group/sub/repo.git",
        "https://git.example.com:8443",
      ),
    ).toBeNull();
    expect(
      gitLabProjectFromRemote(
        "https://git.example.com:8443/group/sub/repo.git",
        "https://git.example.com:8443",
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

  test("ignores gitlab.com remotes when GITLAB_BASE_URL is self-managed", () => {
    expect(
      gitLabProjectFromRemote("git@gitlab.com:mirror/backend.git", "https://gitlab.example.com"),
    ).toBeNull();
    expect(gitLabProjectFromRemote("git@gitlab.com:mirror/backend.git", "https://gitlab.com")).toBe(
      "mirror/backend",
    );
  });

  test("matches the canonical code-host parser (aliases, decoding, validation)", () => {
    expect(
      gitLabProjectFromRemote("git@gitlab-alias:group/sub/repo.git", "https://gitlab.example.com", [
        "gitlab-alias",
      ]),
    ).toBe("group/sub/repo");
    // A relative installation path applies to alias remotes too; keeping the
    // prefix would pin `gitlab/group/sub/repo` instead of the real project.
    expect(
      gitLabProjectFromRemote(
        "https://gitlab-alias/gitlab/group/sub/repo.git",
        "https://gitlab.example.com/gitlab",
        ["gitlab-alias"],
      ),
    ).toBe("group/sub/repo");
    expect(gitLabProjectFromRemote("https://gitlab.com/group%20name/repo.git")).toBe(
      "group name/repo",
    );
    // A single-segment path is not a project path; pinning it would make the
    // tracker reject the derived GITLAB_PROJECT at construction.
    expect(gitLabProjectFromRemote("git@gitlab.com:repo.git")).toBeNull();
  });
});

describe("buildRepoEnv", () => {
  let workspaceDir: string;
  const savedGitLabEnv = new Map<string, string | undefined>();

  const repo = (overrides: Partial<RepoConfig> = {}): RepoConfig => ({
    name: "backend",
    remote: "git@github.com:acme/backend.git",
    env: {},
    ...overrides,
  });

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    for (const key of [
      "GITLAB_PROJECT",
      "GITLAB_BASE_URL",
      "GITLAB_CODE_HOST_URL",
      "GITLAB_CODE_HOST_ALIASES",
    ]) {
      savedGitLabEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    delete process.env.WS_ENV_PROCESS_MARKER;
    for (const [key, value] of savedGitLabEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedGitLabEnv.clear();
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

  test("keeps a workspace-wide GITLAB_PROJECT instead of deriving the code project", () => {
    writeFileSync(join(workspaceDir, ".env"), "GITLAB_PROJECT=workspace/project\n");

    const env = buildRepoEnv(
      repo({ remote: "https://gitlab.com/group/sub/repo.git" }),
      workspaceDir,
    );
    // GitLab iids are per-project, so switching the tracker to the code project
    // would resolve the same task key against an unrelated issue.
    expect(env.GITLAB_PROJECT).toBe("workspace/project");
  });

  test("keeps a self-managed tracker project for a gitlab.com code mirror", () => {
    writeFileSync(
      join(workspaceDir, ".env"),
      "GITLAB_BASE_URL=https://gitlab.example.com\nGITLAB_PROJECT=onprem/issues\n",
    );

    const env = buildRepoEnv(repo({ remote: "git@gitlab.com:mirror/backend.git" }), workspaceDir);
    expect(env.GITLAB_PROJECT).toBe("onprem/issues");
  });

  test("pins GITLAB_PROJECT for a self-managed remote matching GITLAB_BASE_URL", () => {
    writeFileSync(join(workspaceDir, ".env"), "GITLAB_BASE_URL=git.example.com/\n");

    const env = buildRepoEnv(
      repo({ remote: "ssh://git@git.example.com/group/sub/repo.git" }),
      workspaceDir,
    );
    expect(env.GITLAB_PROJECT).toBe("group/sub/repo");
  });

  test("uses SSH aliases only when the code host matches the tracker instance", () => {
    writeFileSync(
      join(workspaceDir, ".env"),
      "GITLAB_BASE_URL=https://gitlab.example.com/gitlab\n" +
        "GITLAB_CODE_HOST_URL=https://gitlab.example.com/gitlab\n" +
        "GITLAB_CODE_HOST_ALIASES=gitlab-alias\n",
    );

    const matched = buildRepoEnv(
      repo({ remote: "https://gitlab-alias/gitlab/group/sub/repo.git" }),
      workspaceDir,
    );
    expect(matched.GITLAB_PROJECT).toBe("group/sub/repo");

    // The alias belongs to a different code host than the tracker; pairing its
    // project path with GITLAB_BASE_URL would target another host's project.
    writeFileSync(
      join(workspaceDir, ".env"),
      "GITLAB_BASE_URL=https://gitlab.onprem.example.com\n" +
        "GITLAB_CODE_HOST_URL=https://gitlab.com\n" +
        "GITLAB_CODE_HOST_ALIASES=corp-git\n",
    );
    const crossHost = buildRepoEnv(repo({ remote: "git@corp-git:group/repo.git" }), workspaceDir);
    expect(crossHost.GITLAB_PROJECT).toBeUndefined();
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

  test("re-derives GITLAB_PROJECT against the team instance", () => {
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "env", "onprem.env"),
      "GITLAB_BASE_URL=https://gitlab.onprem.example.com\n",
    );
    const team: TeamConfig = {
      name: "platform",
      tracker: "gitlab",
      taskQuery: "label:devintern",
      envFile: "env/onprem.env",
      env: {},
    };

    const matched = buildTeamTaskEnv(
      repo({ remote: "https://gitlab.onprem.example.com/group/sub/repo.git" }),
      team,
      workspaceDir,
    );
    expect(matched.GITLAB_PROJECT).toBe("group/sub/repo");

    // The repo remote belongs to gitlab.com, so the team's on-prem project must
    // not be paired with the pin derived at the repo layer.
    const mirrored = buildTeamTaskEnv(
      repo({ remote: "git@gitlab.com:group/sub/repo.git" }),
      team,
      workspaceDir,
    );
    expect(mirrored.GITLAB_PROJECT).toBeUndefined();
  });

  test("keeps an explicit team GITLAB_PROJECT for a non-GitLab code repo", () => {
    const team: TeamConfig = {
      name: "platform",
      tracker: "gitlab",
      taskQuery: "label:devintern",
      env: { GITLAB_PROJECT: "onprem/issues" },
    };

    const env = buildTeamTaskEnv(repo(), team, workspaceDir);
    expect(env.GITLAB_PROJECT).toBe("onprem/issues");
  });

  test("keeps a namespaced team project for the subprocess and the worker", () => {
    writeFileSync(
      join(workspaceDir, ".env"),
      "GITLAB_BASE_URL=https://gitlab.com\n" +
        "GITLAB_TOKEN=shared-token\n" +
        "GITLAB_PLATFORM_PROJECT=onprem/issues\n",
    );
    const team: TeamConfig = {
      name: "platform",
      tracker: "gitlab",
      taskQuery: "label:devintern",
      env: {},
    };
    // The worker validates and polls with buildTeamEnv; the subprocess must
    // resolve the same project, or it acts on a same-IID issue in the code repo.
    expect(buildTeamEnv(team, workspaceDir).GITLAB_PROJECT).toBe("onprem/issues");
    const env = buildTeamTaskEnv(
      repo({ remote: "git@gitlab.com:group/backend.git" }),
      team,
      workspaceDir,
    );
    expect(env.GITLAB_PROJECT).toBe("onprem/issues");
    expect(env.TASK_TRACKER).toBe("gitlab");
  });

  test("namespaced team credentials override repo env_file layers for subprocesses", () => {
    writeFileSync(join(workspaceDir, ".env"), "GITHUB_PLATFORM_TOKEN=team-token\n");
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(join(workspaceDir, "env", "github.env"), "GITHUB_TOKEN=repo-token\n");
    const team: TeamConfig = {
      name: "platform",
      tracker: "github",
      taskQuery: "label:devintern",
      env: {},
    };

    // The worker resolves and validates with buildTeamEnv, so the subprocess
    // must push/comment with the same namespaced token rather than the repo's.
    expect(buildTeamEnv(team, workspaceDir).GITHUB_TOKEN).toBe("team-token");
    const env = buildTeamTaskEnv(repo({ envFile: "env/github.env" }), team, workspaceDir);
    expect(env.GITHUB_TOKEN).toBe("team-token");
  });

  test("keeps an explicit repo GITLAB_PROJECT when the team adds a base URL", () => {
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(join(workspaceDir, "env", "onprem.env"), "GITLAB_BASE_URL=https://onprem.test\n");
    const team: TeamConfig = {
      name: "platform",
      tracker: "gitlab",
      taskQuery: "label:devintern",
      envFile: "env/onprem.env",
      env: {},
    };

    const env = buildTeamTaskEnv(
      repo({
        remote: "git@gitlab.com:group/sub/repo.git",
        env: { GITLAB_PROJECT: "onprem/issues" },
      }),
      team,
      workspaceDir,
    );
    expect(env.GITLAB_PROJECT).toBe("onprem/issues");
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
