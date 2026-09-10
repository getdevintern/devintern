import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { saveRelayState } from "../src/lib/relay-connect";
import { runWorkerConnectCommand } from "../src/lib/worker-connect";

describe("runWorkerConnectCommand", () => {
  let workspaceDir: string;
  let logs: string[];
  let errors: string[];
  const originalLog = console.log;
  const originalError = console.error;
  const savedLinearKey = process.env.LINEAR_API_KEY;
  const savedSentryToken = process.env.SENTRY_AUTH_TOKEN;
  const savedWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;
  const savedGitLabAdminToken = process.env.GITLAB_WEBHOOK_ADMIN_TOKEN;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "devintern-worker-connect-"));
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]
tracker = "linear"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "https://github.com/acme/web.git"

[[repos]]
name = "mirror"
remote = "https://git.example.com/acme/api.git"
[repos.env]
GITHUB_REPO = "acme/api"
`,
      "utf8",
    );
    writeFileSync(join(workspaceDir, ".env"), "LINEAR_API_KEY=workspace-key\n", "utf8");
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    delete process.env.SENTRY_AUTH_TOKEN;
    logs = [];
    errors = [];
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
    console.error = (...values: unknown[]) => errors.push(values.join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    if (savedLinearKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = savedLinearKey;
    if (savedSentryToken === undefined) delete process.env.SENTRY_AUTH_TOKEN;
    else process.env.SENTRY_AUTH_TOKEN = savedSentryToken;
    if (savedWorkspaceDir === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceDir;
    if (savedGitLabAdminToken === undefined) delete process.env.GITLAB_WEBHOOK_ADMIN_TOKEN;
    else process.env.GITLAB_WEBHOOK_ADMIN_TOKEN = savedGitLabAdminToken;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("pairs every unverified workspace repo and continues after a failure", async () => {
    saveRelayState(
      {
        relayUrl: "https://relay.test",
        customerId: "customer-1",
        connectedAt: "2026-09-02T00:00:00.000Z",
        registrations: [],
        relayToken: "drt_test",
        githubRepositories: [{ repo: "acme/api", installationId: 10, repositoryId: 20 }],
      },
      workspaceDir,
    );
    const calls: Array<{ target: string; repo?: string }> = [];

    const result = await runWorkerConnectCommand([], {
      workspaceDir,
      runConnect: async (target, deps) => {
        calls.push({ target, repo: deps?.repo });
        return deps?.repo === "acme/web" ? 1 : 0;
      },
    });

    expect(result).toBe(1);
    expect(calls).toEqual([{ target: "github", repo: "acme/web" }]);
    expect(logs.join("\n")).toContain("acme/api is already verified");
    expect(errors.join("\n")).toContain("1 workspace repository pairing(s) failed");
  });

  test("bare connect configures both GitHub and GitLab code hosts", async () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]
tracker = "linear"

[[repos]]
name = "github-api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "gitlab-api"
remote = "git@gitlab.com:acme/platform.git"
[repos.env]
GITLAB_WEBHOOK_ADMIN_TOKEN = "admin"
`,
    );
    const calls: Array<{ target: string; repo?: string; projectPath?: string }> = [];

    const result = await runWorkerConnectCommand([], {
      workspaceDir,
      runConnect: async (target, deps) => {
        calls.push({
          target,
          repo: deps.repo,
          projectPath: deps.gitlabProject?.projectPath,
        });
        return 0;
      },
    });

    expect(result).toBe(0);
    expect(calls).toEqual([
      { target: "github", repo: "acme/api", projectPath: undefined },
      { target: "gitlab", repo: undefined, projectPath: "acme/platform" },
    ]);
  });

  test("rejects repository selection for relay targets", async () => {
    const result = await runWorkerConnectCommand(["github", "--repo", "acme/web"], {
      workspaceDir,
    });

    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("--repo is only valid for Sentry connect");
  });

  test("connect gitlab discovers cloud and self-managed projects and continues after failure", async () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]
tracker = "linear"

[[repos]]
name = "cloud"
remote = "git@gitlab.com:acme/cloud.git"
[repos.env]
GITLAB_WEBHOOK_ADMIN_TOKEN = "cloud-admin"

[[repos]]
name = "self-managed"
remote = "git@git.internal:platform/service.git"
[repos.env]
GITLAB_CODE_HOST_URL = "https://gitlab.internal"
GITLAB_CODE_HOST_ALIASES = "git.internal"
GITLAB_WEBHOOK_ADMIN_TOKEN = "self-admin"

[[repos]]
name = "duplicate"
remote = "https://gitlab.com/acme/cloud.git"
`,
    );
    const calls: Array<{
      target: string;
      project?: { instanceUrl: string; projectPath: string };
      token?: string;
    }> = [];

    const result = await runWorkerConnectCommand(["gitlab"], {
      workspaceDir,
      runConnect: async (target, deps) => {
        calls.push({
          target,
          project: deps.gitlabProject,
          token: deps.env?.GITLAB_WEBHOOK_ADMIN_TOKEN,
        });
        return deps.gitlabProject?.instanceUrl === "https://gitlab.internal" ? 1 : 0;
      },
    });

    expect(result).toBe(1);
    expect(calls).toEqual([
      {
        target: "gitlab",
        project: { instanceUrl: "https://gitlab.com", projectPath: "acme/cloud" },
        token: "cloud-admin",
      },
      {
        target: "gitlab",
        project: {
          instanceUrl: "https://gitlab.internal",
          projectPath: "platform/service",
        },
        token: "self-admin",
      },
    ]);
    expect(errors.join("\n")).toContain("1 GitLab project hook setup(s) failed");
  });

  test("GitLab disconnect is explicit and applies to every configured project", async () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]
tracker = "linear"

[[repos]]
name = "gitlab"
remote = "git@gitlab.com:acme/platform.git"
`,
    );
    const disconnectFlags: Array<boolean | undefined> = [];

    const result = await runWorkerConnectCommand(["gitlab", "--disconnect"], {
      workspaceDir,
      runConnect: async (_target, deps) => {
        disconnectFlags.push(deps.disconnectGitLab);
        return 0;
      },
    });

    expect(result).toBe(0);
    expect(disconnectFlags).toEqual([true]);
  });

  test("connect sentry validates and adds a monitor for the selected repo", async () => {
    const answers = ["", "acme", "frontend", "environment:production", "sntrys_connect"];
    const result = await runWorkerConnectCommand(["sentry", "--repo", "web"], {
      workspaceDir,
      prompt: async () => answers.shift() ?? "",
      validateSentry: async (options) => {
        expect(options).toEqual({
          authToken: "sntrys_connect",
          organization: "acme",
          project: "frontend",
          baseUrl: "https://sentry.io",
          query: "environment:production",
        });
        return 2;
      },
    });

    expect(result).toBe(0);
    const configText = readFileSync(join(workspaceDir, "workspace.toml"), "utf8");
    expect(configText).toContain('id = "sentry-frontend"');
    expect(configText).toContain('repo = "web"');
    const envPath = join(workspaceDir, "env", "sentry-frontend.env");
    expect(readFileSync(envPath, "utf8")).toBe("SENTRY_AUTH_TOKEN=sntrys_connect\n");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain("2 unresolved issue(s)");
  });

  test("connect sentry rejects an unknown repository before prompting", async () => {
    let prompted = false;
    const result = await runWorkerConnectCommand(["sentry", "--repo", "missing"], {
      workspaceDir,
      prompt: async () => {
        prompted = true;
        return "";
      },
    });

    expect(result).toBe(1);
    expect(prompted).toBe(false);
    expect(logs.join("\n")).toContain('workspace repository "missing" does not exist');
  });

  test("connect sentry prompts for the repo when a multi-repo checkout cannot be inferred", async () => {
    const answers = ["api", "", "acme", "backend", "", "sntrys_backend"];
    const result = await runWorkerConnectCommand(["sentry"], {
      workspaceDir,
      cwd: workspaceDir,
      prompt: async () => answers.shift() ?? "",
      validateSentry: async () => 0,
    });

    expect(result).toBe(0);
    expect(logs.join("\n")).toContain("Workspace repositories: api, web, mirror");
    expect(readFileSync(join(workspaceDir, "workspace.toml"), "utf8")).toContain('repo = "api"');
  });

  test("connect sentry refuses a non-interactive session instead of waiting for input", async () => {
    const result = await runWorkerConnectCommand(["sentry", "--repo", "web"], {
      workspaceDir,
    });

    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("worker connect sentry' is interactive");
  });

  test("status reports workspace repos without verified pairing", async () => {
    saveRelayState(
      {
        relayUrl: "https://relay.test",
        customerId: "customer-1",
        connectedAt: "2026-09-02T00:00:00.000Z",
        registrations: [],
        relayToken: "drt_test",
        githubRepositories: [{ repo: "acme/api", installationId: 10, repositoryId: 20 }],
      },
      workspaceDir,
    );

    const result = await runWorkerConnectCommand(["status"], {
      workspaceDir,
      runConnect: async (target) => {
        expect(target).toBe("status");
        return 0;
      },
    });

    expect(result).toBe(0);
    expect(logs.join("\n")).toContain("Unverified workspace repositories: acme/web");
  });

  test("status reports GitLab verification independently from GitHub", async () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]
tracker = "linear"

[[repos]]
name = "gitlab"
remote = "git@gitlab.com:acme/platform.git"
`,
    );
    saveRelayState(
      {
        relayUrl: "https://relay.test",
        customerId: "customer-1",
        connectedAt: "2026-09-02T00:00:00.000Z",
        registrations: [],
        relayToken: "drt_test",
      },
      workspaceDir,
    );

    const result = await runWorkerConnectCommand(["status"], {
      workspaceDir,
      runConnect: async () => 0,
    });

    expect(result).toBe(0);
    expect(logs.join("\n")).toContain(
      "GitLab projects without local relay registration: acme/platform",
    );
    expect(logs.join("\n")).toContain("devintern worker connect gitlab");
  });

  test("tracker connect loads workspace env without overriding the shell", async () => {
    process.env.LINEAR_API_KEY = "shell-key";
    let observedKey: string | undefined;

    const result = await runWorkerConnectCommand(["linear"], {
      workspaceDir,
      runConnect: async (target) => {
        expect(target).toBe("linear");
        observedKey = process.env.LINEAR_API_KEY;
        return 0;
      },
    });

    expect(result).toBe(0);
    expect(observedKey).toBe("shell-key");
  });

  test("tracker connect loads the selected team's credential layers", async () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[[teams]]
name = "growth"
tracker = "linear"
task_query = "{}"
repo = "web"
env_file = "growth.env"
  [teams.env]
  TEAM_MARKER = "inline"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`,
    );
    writeFileSync(join(workspaceDir, "growth.env"), "LINEAR_API_KEY=team-key\n", "utf8");
    let observed: Record<string, string | undefined> | undefined;

    const result = await runWorkerConnectCommand(["linear", "--team", "growth"], {
      workspaceDir,
      runConnect: async (_target, deps) => {
        observed = deps.env;
        return 0;
      },
    });

    expect(result).toBe(0);
    expect(observed?.LINEAR_API_KEY).toBe("team-key");
    expect(observed?.TEAM_MARKER).toBe("inline");
    expect(logs.join("\n")).toContain("team 'growth'");
  });

  test("same-tracker teams remain polling-only because relay lacks team identity", async () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[[teams]]
name = "platform"
tracker = "linear"
task_query = "{}"
repo = "api"

[[teams]]
name = "growth"
tracker = "linear"
task_query = "{}"
repo = "web"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`,
    );
    let called = false;
    const result = await runWorkerConnectCommand(["linear", "--team", "growth"], {
      workspaceDir,
      runConnect: async () => {
        called = true;
        return 0;
      },
    });

    expect(result).toBe(1);
    expect(called).toBe(false);
    expect(errors.join("\n")).toContain("polling-only");
  });

  test("requires a workspace instead of writing repository-local relay state", async () => {
    rmSync(join(workspaceDir, "workspace.toml"));

    const result = await runWorkerConnectCommand([], {
      workspaceDir,
    });

    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("No workspace found");
    expect(errors.join("\n")).toContain("devintern worker init");
  });
});
