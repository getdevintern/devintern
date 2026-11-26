import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir, userInfo } from "os";
import path from "path";

import { stdinClosedError } from "@devintern/auth";

import { isPromptAbort } from "../src/lib/cli/prompt-abort";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "../src/lib/workspace/config";
import { loadGitHubAppRecord, saveGitHubAppRecord } from "../src/lib/code-host/github/app-setup";
import {
  ANALYTICS_CONFIG_DIR_ENV,
  setAnalyticsCaptureForTests,
} from "../src/lib/observability/analytics";
import {
  configureWorkerOperatingPolicy,
  copyProjectSessionToWorkspace,
  defaultEnsureTracker,
  generateWebhookSecret,
  renderLaunchdPlist,
  renderSystemdUnit,
  runWorkerInit,
  upsertEnvVars,
  workerAuthSessionPath,
  workspaceGitHubRepos,
} from "../src/lib/init/worker-init";

/** The login name the service step passes to loginctl (same lookup order). */
function loginName(): string {
  return process.env.USER || process.env.LOGNAME || userInfo().username;
}

describe("upsertEnvVars", () => {
  test("appends new keys under a worker section", () => {
    const result = upsertEnvVars("TASK_TRACKER=jira\n", { WORKER_TASK_QUERY: "status=todo" });
    expect(result).toContain("TASK_TRACKER=jira");
    expect(result).toContain("worker init");
    expect(result).toContain("WORKER_TASK_QUERY=status=todo");
  });

  test("updates existing keys in place without duplicating", () => {
    const result = upsertEnvVars("WORKER_TASK_QUERY=old\nTASK_TRACKER=jira\n", {
      WORKER_TASK_QUERY: "new",
    });
    expect(result).toContain("WORKER_TASK_QUERY=new");
    expect(result).not.toContain("WORKER_TASK_QUERY=old");
    expect(result.match(/WORKER_TASK_QUERY=/g)).toHaveLength(1);
  });

  test("activates commented-out template keys", () => {
    const result = upsertEnvVars("# WEBHOOK_SECRET=your-secret\n", { WEBHOOK_SECRET: "abc" });
    expect(result).toContain("WEBHOOK_SECRET=abc");
    expect(result).not.toContain("# WEBHOOK_SECRET");
  });
});

describe("renderSystemdUnit", () => {
  test("renders working directory, exec, and restart policy", () => {
    const unit = renderSystemdUnit({
      execPath: "/usr/local/bin/devintern",
      projectDir: "/srv/app",
      listen: false,
    });
    expect(unit).toContain("WorkingDirectory=/srv/app");
    expect(unit).toContain("ExecStart=/usr/local/bin/devintern worker\n");
    expect(unit).toContain("Restart=on-failure");
  });

  test("does not redirect stdout/stderr — the worker self-captures", () => {
    const unit = renderSystemdUnit({
      execPath: "/usr/local/bin/devintern",
      projectDir: "/srv/app",
    });
    expect(unit).not.toContain("StandardOutput=");
    expect(unit).not.toContain("StandardError=");
  });

  test("uses the canonical webhook command when webhook mode is chosen", () => {
    const unit = renderSystemdUnit({ execPath: "devintern", projectDir: "/srv/app", listen: true });
    expect(unit).toContain("ExecStart=devintern webhook serve");
  });
});

describe("renderLaunchdPlist", () => {
  test("renders a user agent with escaped paths and restart behavior", () => {
    const plist = renderLaunchdPlist({
      execPath: "/Applications/Dev & Intern/devintern",
      workingDir: "/Users/dev/Dev & Intern",
    });
    expect(plist).toContain("com.devintern.worker");
    expect(plist).toContain("/Applications/Dev &amp; Intern/devintern");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });
});

describe("generateWebhookSecret", () => {
  test("produces 64 hex chars, unique per call", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

test("workspaceGitHubRepos registers every GitHub repo once", () => {
  const config = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"

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
`);

  expect(workspaceGitHubRepos(config)).toEqual(["acme/api", "acme/web"]);
});

describe("runWorkerInit", () => {
  let tempDir: string;
  let workspaceDir: string;
  let logs: string[];
  let telemetryDir: string;
  const savedTracker = process.env.TASK_TRACKER;
  const savedWorkspace = process.env.DEVINTERN_WORKSPACE_DIR;
  const savedSentryToken = process.env.SENTRY_AUTH_TOKEN;
  const savedConfigDir = process.env[ANALYTICS_CONFIG_DIR_ENV];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "devintern-worker-init-"));
    workspaceDir = path.join(tempDir, "workspace");
    mkdirSync(path.join(tempDir, ".devintern-code"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(path.join(tempDir, ".devintern-code", ".env"), "TASK_TRACKER=markdown\n", "utf8");
    writeFileSync(
      path.join(workspaceDir, "workspace.toml"),
      '[defaults]\ntracker = "markdown"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n',
    );
    process.env.TASK_TRACKER = "markdown";
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    delete process.env.SENTRY_AUTH_TOKEN;
    logs = [];
  });

  afterEach(() => {
    setAnalyticsCaptureForTests(undefined);
    delete process.env.POSTHOG_API_KEY;
    if (savedConfigDir === undefined) delete process.env[ANALYTICS_CONFIG_DIR_ENV];
    else process.env[ANALYTICS_CONFIG_DIR_ENV] = savedConfigDir;
    if (telemetryDir) rmSync(telemetryDir, { recursive: true, force: true });
    if (savedTracker === undefined) delete process.env.TASK_TRACKER;
    else process.env.TASK_TRACKER = savedTracker;
    if (savedWorkspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspace;
    if (savedSentryToken === undefined) delete process.env.SENTRY_AUTH_TOKEN;
    else process.env.SENTRY_AUTH_TOKEN = savedSentryToken;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function deps(answers: string[], overrides: Partial<Parameters<typeof runWorkerInit>[0]> = {}) {
    const queued = [...answers, "n", "n"];
    return {
      cwd: tempDir,
      log: (m: string) => logs.push(m),
      prompt: async () => queued.shift() ?? "n",
      ensureTracker: async () => "markdown",
      bootstrapWorkspace: async () => ({ workspaceDir }),
      configureOperatingPolicy: async () => {},
      // Detection is real otherwise: PRManager inspects the *runner's* cwd.
      detectGithubRepo: async () => null,
      // Hermetic service step: detection stays in the temp home and never
      // touches the runner's real systemd/launchd session.
      platform: "linux" as NodeJS.Platform,
      homedir: tempDir,
      checkServiceManager: async () => ({ available: true as const }),
      // The honest start check would wait for a real worker lock.
      verifyServiceStart: async () => ({ state: "running" as const, pid: 4242 }),
      ...overrides,
    };
  }

  /** Pin analytics to a throwaway config dir and record captured events. */
  function stubAnalytics(): Array<{ event?: string; properties?: Record<string, unknown> }> {
    telemetryDir = path.join(tempDir, "telemetry");
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env[ANALYTICS_CONFIG_DIR_ENV] = telemetryDir;
    const recorded: Array<{ event?: string; properties?: Record<string, unknown> }> = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });
    return recorded;
  }

  test("fails when tracker setup does not finish", async () => {
    const result = await runWorkerInit(deps([], { ensureTracker: async () => null }));
    expect(result.ok).toBe(false);
    expect(logs.join("\n")).toContain("Tracker setup did not finish");
  });

  test("writes task_query to workspace.toml, not WORKER_TASK_QUERY", async () => {
    const result = await runWorkerInit(deps(["status=todo"], { dryRunQuery: async () => 3 }));
    expect(result.ok).toBe(true);
    const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
    expect(config.defaults.taskQuery).toBe("status=todo");
    expect(config.defaults.tracker).toBe("markdown");
    const env = readFileSync(path.join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).not.toContain("WORKER_TASK_QUERY");
    expect(logs.join("\n")).toContain("3 task(s) match");
    expect(logs.join("\n")).not.toContain("webhook listener");
  });

  test("configures task hours and pull-request maintenance policy", async () => {
    const answers = ["y", "scheduled", "1d", "y", "09:00-17:00", "Asia/Ho_Chi_Minh"];
    await configureWorkerOperatingPolicy({
      workspaceDir,
      prompt: async () => answers.shift() ?? "",
      log: (message) => logs.push(message),
    });

    const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
    expect(config.workspace.ciFailureFix).toBe(true);
    expect(config.workspace.conflictResolution).toBe("scheduled");
    expect(config.workspace.conflictSchedule?.interval).toBe("1d");
    expect(config.worker.schedule?.active.map((window) => window.spec)).toEqual(["09:00-17:00"]);
    expect(config.worker.schedule?.timezone).toBe("Asia/Ho_Chi_Minh");
  });

  test("failing dry run offers a retry then accepts the corrected query", async () => {
    let calls = 0;
    const result = await runWorkerInit(
      deps(["bad query", "y", "status=todo"], {
        dryRunQuery: async (q) => {
          calls++;
          if (q === "bad query") throw new Error("syntax error");
          return 1;
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
    expect(config.defaults.taskQuery).toBe("status=todo");
  });

  test("license failure is reported but does not abort setup", async () => {
    const result = await runWorkerInit(
      deps(["status=todo"], {
        checkAutomationLicense: async () => "No automation license found.",
      }),
    );
    expect(result.ok).toBe(true);
    expect(logs.join("\n")).toContain("No automation license found.");
    expect(logs.join("\n")).toContain("devintern.com/pricing");
  });

  test("offers workspace-scoped sign-in for a free Worker Pilot", async () => {
    const checked: string[] = [];
    const signedIn: string[] = [];
    const result = await runWorkerInit(
      deps(["status=todo", "n", ""], {
        checkAutomationLicense: async (dir) => {
          checked.push(dir);
          return checked.length === 1 ? "No automation license found." : null;
        },
        signIn: async (_projectRoot, workspace) => {
          signedIn.push(workspace ?? "");
          return { id: "user-1", email: "pilot@example.com" };
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(checked).toEqual([workspaceDir, workspaceDir]);
    expect(signedIn).toEqual([workspaceDir]);
    expect(logs.join("\n")).toContain("Free Worker Pilot available");
  });

  test("Ctrl+D during license sign-in stops setup instead of continuing", async () => {
    let checks = 0;
    const run = runWorkerInit(
      deps(["status=todo", "n", ""], {
        checkAutomationLicense: async () => {
          checks += 1;
          return "No automation license found.";
        },
        signIn: async () => {
          throw stdinClosedError();
        },
        getUser: async () => {
          throw new Error("relay step must not run after an abort");
        },
      }),
    );
    const error = await run.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isPromptAbort(error)).toBe(true);
    expect(checks).toBe(1);
    expect(logs.join("\n")).not.toContain("Sign-in failed");
    expect(logs.join("\n")).not.toContain("License check errored");
  });

  test("Ctrl+D during relay sign-in stops setup instead of continuing", async () => {
    const run = runWorkerInit(
      deps(["status=todo", "n", "", ""], {
        getUser: async () => null,
        signIn: async () => {
          throw stdinClosedError();
        },
        connectRelay: async () => {
          throw new Error("connectRelay must not run after an abort");
        },
      }),
    );
    const error = await run.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isPromptAbort(error)).toBe(true);
    expect(logs.join("\n")).not.toContain("Sign-in failed");
  });

  test("passes the workspace to the license check (DEV-126)", async () => {
    let observedWorkspaceDir: string | undefined;
    const result = await runWorkerInit(
      deps(["status=todo"], {
        checkAutomationLicense: async (selectedWorkspaceDir) => {
          observedWorkspaceDir = selectedWorkspaceDir;
          return null;
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(observedWorkspaceDir).toBe(workspaceDir);
  });

  test("validates and adds an opt-in Sentry monitor with a protected token file", async () => {
    writeFileSync(
      path.join(workspaceDir, "workspace.toml"),
      '[defaults]\ntracker = "markdown"\n\n[[repos]]\nname = "other"\nremote = "git@github.com:acme/other.git"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n',
    );
    const validations: Array<{
      authToken: string;
      organization: string;
      project: string;
      baseUrl: string;
      query?: string;
    }> = [];
    const result = await runWorkerInit(
      deps(["status=todo", "y", "", "acme", "api", "environment:production", "sntrys_test"], {
        bootstrapWorkspace: async () => ({ workspaceDir, repoName: "app" }),
        validateSentry: async (options) => {
          validations.push(options);
          return 4;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(validations).toEqual([
      {
        authToken: "sntrys_test",
        organization: "acme",
        project: "api",
        baseUrl: "https://sentry.io",
        query: "environment:production",
      },
    ]);
    const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
    expect(config.errorMonitors).toMatchObject([
      {
        id: "sentry-api",
        repo: "app",
        organization: "acme",
        project: "api",
        query: "environment:production",
        envFile: "env/sentry-api.env",
      },
    ]);
    const envPath = path.join(workspaceDir, "env", "sentry-api.env");
    expect(readFileSync(envPath, "utf8")).toBe("SENTRY_AUTH_TOKEN=sntrys_test\n");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain("4 unresolved issue(s)");
  });

  test("does not persist Sentry configuration when validation fails", async () => {
    const result = await runWorkerInit(
      deps(["status=todo", "y", "", "acme", "api", "", "bad-token"], {
        validateSentry: async () => {
          throw new Error("Sentry rejected the auth token (HTTP 401)");
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml")).errorMonitors).toEqual(
      [],
    );
    expect(logs.join("\n")).toContain("Sentry setup skipped");
    expect(logs.join("\n")).toContain("No monitor or credential file was written");
  });

  test("refuses trackers without polling support", async () => {
    const result = await runWorkerInit(deps([], { ensureTracker: async () => "not-a-tracker" }));
    expect(result.ok).toBe(false);
    expect(logs.join("\n")).toContain("does not support worker polling");
  });

  test("emits started and failed events when tracker setup does not finish", async () => {
    const recorded = stubAnalytics();
    const result = await runWorkerInit(deps([], { ensureTracker: async () => null }));
    expect(result.ok).toBe(false);
    await Promise.resolve();
    expect(recorded.map((e) => e.event)).toEqual(["worker_init_started", "worker_init_failed"]);
    expect(recorded[1]?.properties).toMatchObject({ reason: "tracker_setup_incomplete" });
  });

  test("emits worker_init_failed with tracker_not_pollable for an unknown tracker", async () => {
    const recorded = stubAnalytics();
    const result = await runWorkerInit(deps([], { ensureTracker: async () => "not-a-tracker" }));
    expect(result.ok).toBe(false);
    await Promise.resolve();
    expect(recorded.map((e) => e.event)).toEqual(["worker_init_started", "worker_init_failed"]);
    expect(recorded[1]?.properties).toMatchObject({ reason: "tracker_not_pollable" });
  });

  test("emits worker_init_failed with workspace_error when the workspace write fails", async () => {
    const recorded = stubAnalytics();
    const result = await runWorkerInit(
      deps([], { bootstrapWorkspace: async () => ({ error: "cannot write workspace" }) }),
    );
    expect(result.ok).toBe(false);
    await Promise.resolve();
    expect(recorded.map((e) => e.event)).toEqual(["worker_init_started", "worker_init_failed"]);
    expect(recorded[1]?.properties).toMatchObject({ reason: "workspace_error" });
  });

  test("emits started and completed events with per-step outcomes", async () => {
    const recorded = stubAnalytics();
    const result = await runWorkerInit(deps(["status=todo"]));
    expect(result.ok).toBe(true);
    await Promise.resolve();
    expect(recorded.map((e) => e.event)).toEqual(["worker_init_started", "worker_init_completed"]);
    expect(recorded[1]?.properties).toMatchObject({
      tracker: "markdown",
      relay_connect: "skipped",
      service_install: "declined",
      github_app: "unavailable",
    });
  });

  test("connects signed-in users and stores relay state in the workspace", async () => {
    const calls: Array<{ workspaceDir: string; trackerType: string }> = [];
    const result = await runWorkerInit(
      deps(["status=todo", "n", "", "n"], {
        getUser: async () => ({ id: "user-1", email: "dev@example.com" }),
        connectRelay: async ({ workspaceDir: dir, trackerType }) => {
          calls.push({ workspaceDir: dir, trackerType });
          return true;
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ workspaceDir, trackerType: "markdown" }]);
    expect(logs.join("\n")).toContain("Relay pairing stored");
  });

  test("default relay onboarding connects GitHub and GitLab workspace repositories", async () => {
    writeFileSync(
      path.join(workspaceDir, "workspace.toml"),
      `[defaults]
tracker = "markdown"

[[repos]]
name = "github-app"
remote = "git@github.com:acme/app.git"

[[repos]]
name = "gitlab-app"
remote = "git@gitlab.com:acme/platform.git"
[repos.env]
GITLAB_WEBHOOK_ADMIN_TOKEN = "admin"
`,
    );
    const calls: Array<{ target: string; repo?: string; projectPath?: string }> = [];

    const result = await runWorkerInit(
      deps(["status=todo", "n", "", "n"], {
        getUser: async () => ({ id: "user-1", email: "dev@example.com" }),
        runRelayConnect: async (target, connectDeps) => {
          calls.push({
            target,
            repo: connectDeps.repo,
            projectPath: connectDeps.gitlabProject?.projectPath,
          });
          return 0;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { target: "github", repo: "acme/app", projectPath: undefined },
      { target: "gitlab", repo: undefined, projectPath: "acme/platform" },
    ]);
    expect(logs.join("\n")).toContain("Relay pairing stored");
  });

  describe("GitHub App step", () => {
    const relayDeps = {
      getUser: async () => ({ id: "user-1", email: "dev@example.com" }),
      connectRelay: async () => true,
    };
    const savedAppEnv = {
      appId: process.env.GITHUB_APP_ID,
      keyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
      keyBase64: process.env.GITHUB_APP_PRIVATE_KEY_BASE64,
    };

    beforeEach(() => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
      delete process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
    });

    afterEach(() => {
      if (savedAppEnv.appId === undefined) delete process.env.GITHUB_APP_ID;
      else process.env.GITHUB_APP_ID = savedAppEnv.appId;
      if (savedAppEnv.keyPath === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
      else process.env.GITHUB_APP_PRIVATE_KEY_PATH = savedAppEnv.keyPath;
      if (savedAppEnv.keyBase64 === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
      else process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = savedAppEnv.keyBase64;
    });

    test("skips silently when no GitHub remote is detected", async () => {
      const result = await runWorkerInit(deps(["status=todo", "n"]));
      expect(result.ok).toBe(true);
      expect(logs.join("\n")).toContain("No GitHub remote detected; skipping the GitHub App step");
      expect(loadGitHubAppRecord(workspaceDir)).toBeNull();
    });

    test("an unverified repository points to the relay pairing command", async () => {
      const result = await runWorkerInit(
        deps(["status=todo", "n", "", "n"], {
          ...relayDeps,
          detectGithubRepo: async () => "acme/web",
        }),
      );
      expect(result.ok).toBe(true);
      const all = logs.join("\n");
      expect(all).toContain("No verified GitHub App pairing was recorded");
      expect(all).toContain("devintern worker connect github");
      expect(all).toContain("GitHub App events are not enabled:");
      expect(loadGitHubAppRecord(workspaceDir)).toBeNull();
    });

    test("does not trust a legacy press-Enter marker without verified GitHub ids", async () => {
      saveGitHubAppRecord({ repo: "acme/web", enabled: true }, workspaceDir);
      const result = await runWorkerInit(
        deps(["status=todo", "n", "", "n"], {
          ...relayDeps,
          detectGithubRepo: async () => "acme/web",
        }),
      );
      expect(result.ok).toBe(true);
      expect(logs.join("\n")).toContain("No verified GitHub App pairing was recorded");
    });

    test("recognizes a verified relay pairing without another confirmation prompt", async () => {
      saveGitHubAppRecord(
        {
          repo: "acme/web",
          enabled: true,
          connectedAt: "2026-08-01T00:00:00.000Z",
          installationId: 7001,
          repositoryId: 9001,
        },
        workspaceDir,
      );
      const result = await runWorkerInit(
        deps(["status=todo", "n", "", "n"], {
          ...relayDeps,
          detectGithubRepo: async () => "acme/web",
        }),
      );
      expect(result.ok).toBe(true);
      expect(logs.join("\n")).toContain("GitHub App already verified for acme/web");
      expect(logs.join("\n")).not.toContain("GitHub App events are not enabled:");
    });

    test("custom App credentials are recognized only on the no-relay path", async () => {
      process.env.GITHUB_APP_ID = "123456";
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = "/tmp/key.pem";
      const result = await runWorkerInit(
        deps(["status=todo", "n", "n"], {
          detectGithubRepo: async () => "acme/web",
        }),
      );
      expect(result.ok).toBe(true);
      expect(logs.join("\n")).toContain("advanced no-relay mode");
      expect(logs.join("\n")).toContain(
        "Customer-owned GitHub App credentials found in the environment",
      );
    });
  });

  test("declining writes the Linux definition into the workspace with manual steps", async () => {
    const files = new Map<string, string>();
    const result = await runWorkerInit(
      deps(["status=todo", "n", "n", "n"], {
        platform: "linux",
        execPath: "/usr/local/bin/devintern",
        runtimePath: "/opt/bun/bin/bun",
        environmentPath: "/opt/bun/bin:/usr/bin",
        writeFile: (file, content) => files.set(file, content),
      }),
    );
    expect(result.ok).toBe(true);
    const unit = files.get(path.join(workspaceDir, "devintern-worker.service"));
    expect(unit).toContain("WorkingDirectory=" + workspaceDir);
    expect(unit).toContain("ExecStart=/opt/bun/bin/bun /usr/local/bin/devintern worker");
    expect(unit).toContain('Environment="PATH=/opt/bun/bin:/usr/bin"');
    expect(unit).toContain("WantedBy=default.target");
    const all = logs.join("\n");
    expect(all).toContain("systemctl --user enable --now devintern-worker");
    expect(all).toContain("loginctl enable-linger");
  });

  test("declining writes the macOS definition into the workspace with manual steps", async () => {
    const files = new Map<string, string>();
    const result = await runWorkerInit(
      deps(["status=todo", "n", "n", "n"], {
        platform: "darwin",
        execPath: "/usr/local/bin/devintern",
        writeFile: (file, content) => files.set(file, content),
      }),
    );
    expect(result.ok).toBe(true);
    const plist = files.get(path.join(workspaceDir, "com.devintern.worker.plist"));
    expect(plist).toContain("<string>/usr/local/bin/devintern</string>");
    expect(plist).toContain(`<string>${workspaceDir}</string>`);
    expect(logs.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
  });

  test("unknown platforms keep terminal guidance and write nothing", async () => {
    const result = await runWorkerInit(deps(["status=todo", "n"], { platform: "win32" }));
    expect(result.ok).toBe(true);
    expect(logs.join("\n")).toContain("No generated service definition for win32");
  });

  test("--no-service skips the offer without prompting or writing files", async () => {
    const run = async (command: string) => {
      throw new Error(`unexpected command: ${command}`);
    };
    const result = await runWorkerInit(
      deps(["status=todo", "n"], { platform: "linux", noService: true, run }),
    );
    expect(result.ok).toBe(true);
    expect(logs.join("\n")).toContain("--no-service");
    expect(logs.join("\n")).not.toContain("Install and start the background service");
  });

  test("accepting installs and starts the systemd user unit on Linux", async () => {
    const commands: string[][] = [];
    let enabled = false;
    const result = await runWorkerInit(
      deps(["status=todo", "n", "n", ""], {
        platform: "linux",
        execPath: "/usr/local/bin/devintern",
        runtimePath: "/opt/bun/bin/bun",
        environmentPath: "/opt/bun/bin:/usr/bin",
        homedir: tempDir,
        run: async (command, args) => {
          commands.push([command, ...args]);
          if (args.includes("is-active")) {
            return { status: enabled ? 0 : 3, stdout: enabled ? "active" : "inactive", stderr: "" };
          }
          if (args.includes("is-enabled")) {
            return {
              status: enabled ? 0 : 1,
              stdout: enabled ? "enabled" : "disabled",
              stderr: "",
            };
          }
          if (args.includes("enable")) {
            enabled = true;
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    );
    expect(result.ok).toBe(true);
    const unitPath = path.join(tempDir, ".config", "systemd", "user", "devintern-worker.service");
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).toContain(`WorkingDirectory=${workspaceDir}`);
    expect(unit).toContain("ExecStart=/opt/bun/bin/bun /usr/local/bin/devintern worker");
    expect(unit).not.toContain("StandardOutput=");
    expect(commands).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(commands).toContainEqual(["systemctl", "--user", "enable", "--now", "devintern-worker"]);
    const all = logs.join("\n");
    expect(all).toContain("devintern-worker service installed; waiting for the worker to start");
    expect(all).toContain("✅ The worker is running (pid 4242).");
    expect(all).toContain("http://localhost:4400");
    // Lingering names the user: without one, loginctl needs a login session.
    expect(commands).toContainEqual(["loginctl", "enable-linger", loginName()]);
    expect(all).toContain("User lingering is on");
    expect(all).toContain("already running as your user service");
  });

  test("an automatic install failure cleans up and falls back to manual steps", async () => {
    const result = await runWorkerInit(
      deps(["status=todo", "n", "n", ""], {
        platform: "linux",
        execPath: "/usr/local/bin/devintern",
        homedir: tempDir,
        run: async (_command, args) =>
          args.includes("daemon-reload")
            ? {
                status: 1,
                stdout: "",
                stderr: "System has not been booted with systemd as init system (PID 1).",
              }
            : { status: 3, stdout: "inactive", stderr: "" },
      }),
    );
    expect(result.ok).toBe(true);
    const unitPath = path.join(tempDir, ".config", "systemd", "user", "devintern-worker.service");
    expect(existsSync(unitPath)).toBe(false);
    const all = logs.join("\n");
    expect(all).toContain("System has not been booted with systemd");
    expect(all).toContain("Nothing was left half-installed");
    expect(all).toContain("systemctl --user enable --now devintern-worker");
  });

  test("an installed service is offered an update and restarted instead", async () => {
    const unitDir = path.join(tempDir, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      path.join(unitDir, "devintern-worker.service"),
      "# Managed by devintern worker init\n[Service]\nWorkingDirectory=/old\n",
      "utf8",
    );
    const commands: string[][] = [];
    const result = await runWorkerInit(
      deps(["status=todo", "n", "n", ""], {
        platform: "linux",
        execPath: "/usr/local/bin/devintern",
        homedir: tempDir,
        run: async (command, args) => {
          commands.push([command, ...args]);
          if (args.includes("is-enabled")) {
            return { status: 0, stdout: "enabled", stderr: "" };
          }
          return { status: 0, stdout: "active", stderr: "" };
        },
      }),
    );
    expect(result.ok).toBe(true);
    const unit = readFileSync(path.join(unitDir, "devintern-worker.service"), "utf8");
    expect(unit).toContain(`WorkingDirectory=${workspaceDir}`);
    expect(commands).toContainEqual(["systemctl", "--user", "restart", "devintern-worker"]);
    expect(commands).not.toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "devintern-worker",
    ]);
    const all = logs.join("\n");
    expect(all).toContain("devintern-worker service updated and restarted");
    expect(all).not.toContain("service installed;");
  });

  test("a custom installed service is preserved and gets manual comparison steps", async () => {
    const unitDir = path.join(tempDir, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      path.join(unitDir, "devintern-worker.service"),
      "[Service]\nWorkingDirectory=/old\n",
      "utf8",
    );
    const commands: string[][] = [];
    const result = await runWorkerInit(
      deps(["status=todo", "n", "n"], {
        platform: "linux",
        execPath: "/usr/local/bin/devintern",
        homedir: tempDir,
        run: async (command, args) => {
          commands.push([command, ...args]);
          return { status: 0, stdout: "active", stderr: "" };
        },
      }),
    );
    expect(result.ok).toBe(true);
    // Only the read-only detection ran; no install or restart commands fired.
    expect(commands.every((c) => c.includes("is-active"))).toBe(true);
    expect(readFileSync(path.join(unitDir, "devintern-worker.service"), "utf8")).toContain(
      "WorkingDirectory=/old",
    );
    expect(logs.join("\n")).toContain("custom settings and will not be overwritten");
    expect(logs.join("\n")).toContain("already running as your user service");
    expect(logs.join("\n")).toContain("systemctl --user enable --now devintern-worker");
  });

  test("accepting installs and bootstraps the launchd agent on macOS", async () => {
    const commands: string[][] = [];
    const plistPath = path.join(tempDir, "Library", "LaunchAgents", "com.devintern.worker.plist");
    const result = await runWorkerInit(
      deps(["status=todo", "n", "n", ""], {
        platform: "darwin",
        execPath: "/usr/local/bin/devintern",
        homedir: tempDir,
        uid: 501,
        run: async (command, args) => {
          commands.push([command, ...args]);
          // launchd reports the label as absent until the agent file exists.
          if (args[0] === "print" && !existsSync(plistPath)) {
            return { status: 1, stdout: "", stderr: "Could not find service" };
          }
          return {
            status: 0,
            stdout: args[0] === "print" ? "state = running" : "",
            stderr: "",
          };
        },
      }),
    );
    expect(result.ok).toBe(true);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<string>/usr/local/bin/devintern</string>");
    expect(plist).toContain(`<string>${workspaceDir}</string>`);
    expect(commands).toEqual([
      ["launchctl", "print", "gui/501/com.devintern.worker"],
      ["launchctl", "bootstrap", "gui/501", plistPath],
    ]);
    expect(logs.join("\n")).toContain("devintern-worker service installed; waiting");
    expect(logs.join("\n")).toContain("✅ The worker is running");
  });

  describe("honest service step", () => {
    /** systemd fake: enable flips is-active/is-enabled; loginctl is scriptable. */
    function systemdRun(commands: string[][], loginctl?: (args: string[]) => RunResult) {
      let enabled = false;
      return async (command: string, args: string[]): Promise<RunResult> => {
        commands.push([command, ...args]);
        if (command === "loginctl" && loginctl) return loginctl(args);
        if (args.includes("is-active") || args.includes("is-enabled")) {
          return { status: enabled ? 0 : 3, stdout: "", stderr: "" };
        }
        if (args.includes("enable")) enabled = true;
        return { status: 0, stdout: "", stderr: "" };
      };
    }
    type RunResult = { status: number; stdout: string; stderr: string };

    test("readiness blockers keep the service from being installed", async () => {
      const commands: string[][] = [];
      const questions: string[] = [];
      const answers = ["status=todo"];
      const result = await runWorkerInit(
        deps([], {
          prompt: async (question) => {
            questions.push(question);
            return answers.shift() ?? "n";
          },
          run: systemdRun(commands),
          collectReadiness: async () => [
            {
              id: "entitlement",
              label: "Automation entitlement",
              status: "action",
              detail: "Not started",
              hint: "Run `devintern worker login github`",
            },
          ],
        }),
      );
      expect(result).toEqual({ ok: true, ready: false });
      expect(questions.some((question) => question.includes("background service"))).toBe(false);
      expect(commands.some((command) => command.includes("enable"))).toBe(false);
      const all = logs.join("\n");
      // Readiness is reported before the service step, not after it.
      expect(all.indexOf("Readiness (the same checks")).toBeLessThan(
        all.indexOf("Background service"),
      );
      expect(all).toContain("Not installed yet: the worker would not start");
      expect(all).toContain("devintern worker service install");
    });

    test("a worker that fails to start is reported, not called running", async () => {
      const commands: string[][] = [];
      const result = await runWorkerInit(
        deps(["status=todo", "n", "n", ""], {
          execPath: "/usr/local/bin/devintern",
          run: systemdRun(commands),
          verifyServiceStart: async () => ({
            state: "failed" as const,
            reason: "License check failed: Run `devintern worker login` to start your Pilot",
            permanent: true,
            logLines: ["❌ License check failed"],
          }),
        }),
      );
      expect(result.ok).toBe(true);
      const all = logs.join("\n");
      expect(all).toContain("❌ The worker did not start: License check failed");
      expect(all).toContain("The service will not retry on its own");
      expect(all).toContain("devintern worker service restart");
      expect(all).not.toContain("The worker is running");
      expect(all).not.toContain("already running as your user service");
      expect(all).not.toContain("🎉");
    });

    test("a lingering failure names the root command and the consequence", async () => {
      const commands: string[][] = [];
      const user = loginName();
      await runWorkerInit(
        deps(["status=todo", "n", "n", ""], {
          run: systemdRun(commands, (args) =>
            args[0] === "show-user"
              ? { status: 0, stdout: "no\n", stderr: "" }
              : { status: 1, stdout: "", stderr: "Access denied" },
          ),
        }),
      );
      expect(commands).toContainEqual([
        "loginctl",
        "show-user",
        user,
        "--property=Linger",
        "--value",
      ]);
      const all = logs.join("\n");
      expect(all).toContain(`could not enable lingering for ${user} (Access denied)`);
      expect(all).toContain("stops when you log out and does not start at boot");
      expect(all).toContain(`sudo loginctl enable-linger ${user}`);
    });
  });

  describe("onboarding recovery and closing summary", () => {
    const configPath = () => path.join(workspaceDir, "workspace.toml");
    const jiraTemplate =
      '[defaults]\ntracker = "jira"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n';

    test("a new workspace records the chosen tracker before the query prompt", async () => {
      writeFileSync(configPath(), jiraTemplate);
      const run = runWorkerInit(
        deps([], {
          bootstrapWorkspace: async () => ({ workspaceDir, created: true }),
          prompt: async (question) => {
            if (question.startsWith("Ready-tasks query")) throw stdinClosedError();
            return "n";
          },
        }),
      );
      const error = await run.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(isPromptAbort(error)).toBe(true);
      expect(loadWorkspaceConfig(configPath()).defaults.tracker).toBe("markdown");
    });

    test("a re-run finishes a workspace an earlier run left without a query", async () => {
      writeFileSync(configPath(), jiraTemplate);
      const result = await runWorkerInit(
        deps(["status=todo"], {
          bootstrapWorkspace: async () => ({ workspaceDir, created: false }),
        }),
      );
      expect(result.ok).toBe(true);
      const config = loadWorkspaceConfig(configPath());
      expect(config.defaults.tracker).toBe("markdown");
      expect(config.defaults.taskQuery).toBe("status=todo");
      expect(logs.join("\n")).toContain("Finishing an earlier setup");
    });

    test("a configured workspace with another tracker is still refused", async () => {
      writeFileSync(
        configPath(),
        jiraTemplate.replace('tracker = "jira"', 'tracker = "jira"\ntask_query = "project = APP"'),
      );
      const result = await runWorkerInit(
        deps(["status=todo"], {
          bootstrapWorkspace: async () => ({ workspaceDir, created: false }),
        }),
      );
      expect(result.ok).toBe(false);
      expect(logs.join("\n")).toContain("This workspace uses jira");
      expect(loadWorkspaceConfig(configPath()).defaults.tracker).toBe("jira");
    });

    test("a re-run offers the saved query and Enter keeps it", async () => {
      writeFileSync(
        configPath(),
        '[defaults]\ntracker = "markdown"\ntask_query = "status=ready"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n',
      );
      const questions: string[] = [];
      const answers = [""];
      const result = await runWorkerInit(
        deps([], {
          prompt: async (question) => {
            questions.push(question);
            return answers.shift() ?? "n";
          },
        }),
      );
      expect(result.ok).toBe(true);
      expect(questions).toContain("Ready-tasks query [status=ready]: ");
      expect(loadWorkspaceConfig(configPath()).defaults.taskQuery).toBe("status=ready");
    });

    test("yes/no prompts re-ask on an unknown answer instead of guessing", async () => {
      const result = await runWorkerInit(
        deps(["status=todo", "sure", "y", "", "acme", "api", "", "tok"], {
          bootstrapWorkspace: async () => ({ workspaceDir, repoName: "app" }),
          validateSentry: async () => 0,
        }),
      );
      expect(result.ok).toBe(true);
      expect(logs.join("\n")).toContain("Enter y or n.");
      expect(loadWorkspaceConfig(configPath()).errorMonitors).toHaveLength(1);
    });

    test("the Sentry token is read with the hidden-input prompt", async () => {
      const secretQuestions: string[] = [];
      const result = await runWorkerInit(
        deps(["status=todo", "y", "", "acme", "api", ""], {
          bootstrapWorkspace: async () => ({ workspaceDir, repoName: "app" }),
          validateSentry: async () => 0,
          promptSecret: async (question) => {
            secretQuestions.push(question);
            return "sntrys_hidden";
          },
        }),
      );
      expect(result.ok).toBe(true);
      expect(secretQuestions).toEqual(["Sentry auth token (input hidden): "]);
    });

    test("no service offer without a systemd user session; foreground guidance instead", async () => {
      const questions: string[] = [];
      const answers = ["status=todo"];
      const result = await runWorkerInit(
        deps([], {
          prompt: async (question) => {
            questions.push(question);
            return answers.shift() ?? "n";
          },
          checkServiceManager: async () => ({
            available: false as const,
            reason: "systemctl is not installed",
          }),
          installService: async () => {
            throw new Error("must not install");
          },
        }),
      );
      expect(result.ok).toBe(true);
      expect(questions.some((question) => question.includes("background service"))).toBe(false);
      const all = logs.join("\n");
      expect(all).toContain(
        "A background service is not available here: systemctl is not installed.",
      );
      expect(all).toContain("Run the worker in the foreground instead: `devintern worker`");
      expect(existsSync(path.join(workspaceDir, "devintern-worker.service"))).toBe(false);
    });

    test("ends with the doctor checks and says not ready when one fails", async () => {
      const result = await runWorkerInit(
        deps(["status=todo"], {
          collectReadiness: async () => [
            { id: "config", label: "Workspace config", status: "ok", detail: "1 repo" },
            {
              id: "harness",
              label: "Agent harness",
              status: "fail",
              detail: "claude not found",
              hint: "Install the agent CLI",
            },
          ],
        }),
      );
      expect(result).toEqual({ ok: true, ready: false });
      const all = logs.join("\n");
      expect(all).toContain("Readiness (the same checks as `devintern worker doctor`)");
      expect(all).toContain("❌ Agent harness — claude not found");
      expect(all).toContain("the worker is not ready yet");
      expect(all).toContain("1. Agent harness: Install the agent CLI");
      expect(all).not.toContain("🎉");
    });

    test("says ready only when every check passes", async () => {
      const result = await runWorkerInit(
        deps(["status=todo"], {
          collectReadiness: async () => [
            { id: "config", label: "Workspace config", status: "ok", detail: "1 repo" },
          ],
        }),
      );
      expect(result).toEqual({ ok: true, ready: true });
      expect(logs.join("\n")).toContain("🎉 Worker setup complete — the worker is ready.");
    });

    test("a license problem alone is enough to say not ready", async () => {
      const result = await runWorkerInit(
        deps(["status=todo", "n", "n"], {
          checkAutomationLicense: async () => "No automation license found.",
        }),
      );
      expect(result.ready).toBe(false);
      const all = logs.join("\n");
      expect(all).toContain("run `devintern worker login github`");
      expect(all).toContain("14-day free Worker Pilot, no card required");
      expect(all).not.toContain("🎉");
    });

    test("when signing in is the only step left, the closing line says so", async () => {
      const result = await runWorkerInit(
        deps(["status=todo"], {
          collectReadiness: async () => [
            { id: "config", label: "Workspace config", status: "ok", detail: "1 repo" },
            {
              id: "entitlement",
              label: "Automation entitlement",
              status: "action",
              detail:
                "Not started: sign in to begin your 14-day free Worker Pilot, no card required",
              hint: "Run `devintern worker login github`",
            },
          ],
        }),
      );
      expect(result).toEqual({ ok: true, ready: false });
      const all = logs.join("\n");
      expect(all).toContain(
        "👉 Worker setup saved. One step left: sign in to begin your 14-day free Worker Pilot, no card required.",
      );
      expect(all).toContain("1. Automation entitlement: Run `devintern worker login github`");
      expect(all).not.toContain("not ready yet");
    });
  });

  test("finds tracker config from a repository subdirectory", async () => {
    mkdirSync(path.join(tempDir, ".git"));
    const subdir = path.join(tempDir, "packages", "app");
    mkdirSync(subdir, { recursive: true });
    const result = await runWorkerInit(
      deps(["status=todo"], {
        cwd: subdir,
        ensureTracker: undefined,
      }),
    );
    expect(result.ok).toBe(true);
  });

  describe("tracker from [defaults].tracker (non-interactive init output)", () => {
    const savedGithubToken = process.env.GITHUB_TOKEN;
    const savedGithubRepo = process.env.GITHUB_REPO;

    const log = (m: string) => logs.push(m);

    beforeEach(() => {
      // No legacy checkout .env and no TASK_TRACKER anywhere.
      rmSync(path.join(tempDir, ".devintern-code"), { recursive: true, force: true });
      delete process.env.TASK_TRACKER;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPO;
      writeFileSync(
        path.join(workspaceDir, "workspace.toml"),
        '[defaults]\ntracker = "github"\ntask_query = "label:ready"\n',
      );
    });

    afterEach(() => {
      if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedGithubToken;
      if (savedGithubRepo === undefined) delete process.env.GITHUB_REPO;
      else process.env.GITHUB_REPO = savedGithubRepo;
    });

    test("reuses the tracker when credentials are present", async () => {
      writeFileSync(
        path.join(workspaceDir, ".env"),
        "GITHUB_TOKEN=ghp_test\nGITHUB_REPO=acme/app\n",
      );
      const tracker = await defaultEnsureTracker(
        tempDir,
        async () => "n",
        async () => "",
        log,
      );
      expect(tracker).toBe("github");
      const all = logs.join("\n");
      expect(all).toContain("Using github from");
      expect(all).not.toContain("No tracker config yet");
    });

    test("asks as before when credentials are missing", async () => {
      writeFileSync(path.join(workspaceDir, ".env"), "GITHUB_TOKEN=ghp_test\n");
      const stop = async (): Promise<string> => {
        throw new Error("tracker prompt reached");
      };
      await expect(defaultEnsureTracker(tempDir, stop, stop, log)).rejects.toThrow(
        "tracker prompt reached",
      );
      const all = logs.join("\n");
      expect(all).toContain("No tracker config yet");
      expect(all).not.toContain("Using github from");
    });
  });
});

test("worker setup copies an existing project session without replacing workspace sign-in", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-session-copy-"));
  try {
    const project = path.join(root, "project");
    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(project, ".devintern-code"), { recursive: true });
    writeFileSync(path.join(project, ".devintern-code", ".auth-session.json"), "project-session");
    expect(copyProjectSessionToWorkspace(project, workspace)).toBe(true);
    const target = path.join(workspace, "state", "code", ".auth-session.json");
    expect(readFileSync(target, "utf8")).toBe("project-session");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    writeFileSync(target, "workspace-session");
    expect(copyProjectSessionToWorkspace(project, workspace)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("workspace-session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("workerAuthSessionPath (DEV-126)", () => {
  test("resolves to the workspace's code state directory", () => {
    const workspaceDir = path.join(tmpdir(), "worker-auth-ws");
    expect(workerAuthSessionPath("/imported/repo", workspaceDir)).toBe(
      path.join(workspaceDir, "state", "code", ".auth-session.json"),
    );
  });

  test("falls back to the project config dir before the workspace exists", () => {
    expect(workerAuthSessionPath("/imported/repo")).toBe(
      path.join("/imported/repo", ".devintern-code", ".auth-session.json"),
    );
  });
});
