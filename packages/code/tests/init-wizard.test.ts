import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { BUNDLED_TRELLO_API_KEY } from "@devintern/task-trackers";
import { TRACKER_SETUP, buildEnvExample, renderEnvFile } from "../src/lib/init/scaffold";
import { isInteractive, runInitUpgrade, runInitWizard } from "../src/lib/init/wizard";
import { registerManualCheckout } from "../src/lib/workspace/register-checkout";
import {
  ANALYTICS_CONFIG_DIR_ENV,
  setAnalyticsCaptureForTests,
} from "../src/lib/observability/analytics";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "init-wizard-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Prompt stub that answers from a queue and records questions. */
function promptQueue(answers: string[]) {
  const asked: string[] = [];
  const remaining = [...answers];
  const prompt = (question: string): Promise<string> => {
    asked.push(question);
    if (remaining.length === 0) {
      throw new Error(`Prompt queue exhausted at question: ${question}`);
    }
    return Promise.resolve(remaining.shift()!);
  };
  return { prompt, asked, remaining };
}

const silentLog = () => {};

/** Env file the upgrade tests seed and update. */
function upgradeEnvPath(): string {
  return join(tempDir, ".devintern-code", ".env");
}

/** Env file `devintern init` registers for the checkout at `dir`. */
function wizardEnvPath(dir: string = tempDir): string {
  return join(process.env.DEVINTERN_WORKSPACE_DIR!, "env", `${basename(dir)}.env`);
}

function readWizardEnv(dir: string = tempDir): string {
  return readFileSync(wizardEnvPath(dir), "utf8");
}

/** Default deps for wizard tests: no session on disk, deterministic agents. */
function testDeps(overrides: Record<string, unknown> = {}) {
  return {
    getUser: () => Promise.resolve(null),
    listInstalledAgents: () => [{ name: "claude-code", displayName: "Claude Code" }],
    ...overrides,
  };
}

describe("isInteractive", () => {
  test("true only for a TTY without escape flags", () => {
    expect(isInteractive(["bun", "cli", "init"], { isTTY: true })).toBe(true);
    expect(isInteractive(["bun", "cli", "init"], { isTTY: undefined })).toBe(false);
    expect(isInteractive(["bun", "cli", "init"], { isTTY: false })).toBe(false);
    expect(isInteractive(["bun", "cli", "init", "--yes"], { isTTY: true })).toBe(false);
    expect(isInteractive(["bun", "cli", "init", "--no-interactive"], { isTTY: true })).toBe(false);
  });
});

describe("buildEnvExample", () => {
  test("documents all trackers with links, commented values, and TASK_TRACKER example", () => {
    const template = buildEnvExample();
    expect(template).toContain("TASK_TRACKER=jira");
    for (const trackerId of Object.keys(TRACKER_SETUP)) {
      expect(template).toContain(`TASK_TRACKER=${trackerId})`);
    }
    expect(template).toContain("# JIRA_API_TOKEN=");
    expect(template).toContain("https://id.atlassian.com/manage-profile/security/api-tokens");
    expect(template).toContain("https://linear.app/settings/account/security");
    expect(template).toContain("https://app.asana.com/0/my-apps");
    expect(template).toContain("# MARKDOWN_TASKS_DIR=");
    // GitLab section: instance URL defaults to cloud, project path allows subgroups
    expect(template).toContain("# GITLAB_TOKEN=");
    expect(template).toContain("# GITLAB_PROJECT=group/sub/repo");
    expect(template).toContain("# GITLAB_BASE_URL=https://gitlab.example.com");
    // Agent + PR integration tail is preserved
    expect(template).toContain("AGENT_HARNESS=claude-code");
    expect(template).toContain("DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST=true");
    expect(template).toContain("GITLAB_CODE_HOST_TOKEN=glpat_xxxxxxxxxxxx");
    expect(template).toContain("GITLAB_CODE_HOST_CA_FILE=/path/to/company-ca.pem");
    expect(template).toContain("GITLAB_REVIEWER_ALLOWLIST=alice,bob");
    expect(template).toContain("BITBUCKET_TOKEN");
  });
});

describe("renderEnvFile", () => {
  test("writes TASK_TRACKER, provided values, and comments out skipped optionals", () => {
    const env = renderEnvFile("jira", {
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "dev@acme.com",
      JIRA_API_TOKEN: "secret-token",
    });
    expect(env).toContain("TASK_TRACKER=jira");
    expect(env).toContain("JIRA_BASE_URL=https://acme.atlassian.net");
    expect(env).toContain("JIRA_API_TOKEN=secret-token");
    expect(env).toContain("# JIRA_DEFAULT_PROJECT_KEY=");
    expect(env).toContain("AGENT_HARNESS=claude-code");
  });

  test("renders GitLab env with base URL default written out", () => {
    const env = renderEnvFile("gitlab", {
      GITLAB_TOKEN: "glpat-secret",
      GITLAB_PROJECT: "acme/team/webapp",
    });
    expect(env).toContain("TASK_TRACKER=gitlab");
    expect(env).toContain("GITLAB_TOKEN=glpat-secret");
    expect(env).toContain("GITLAB_PROJECT=acme/team/webapp");
    // Skipped optional is commented so users can find it later
    expect(env).toContain("# GITLAB_BASE_URL=https://gitlab.example.com");
  });

  test("writes extra values (PR token) under a dedicated section", () => {
    const env = renderEnvFile("linear", {
      LINEAR_API_KEY: "lin_api_123",
      GITHUB_TOKEN: "ghp_abc",
    });
    expect(env).toContain("TASK_TRACKER=linear");
    expect(env).toContain("LINEAR_API_KEY=lin_api_123");
    expect(env).toContain("# Pull Request integration\nGITHUB_TOKEN=ghp_abc");
  });
});

describe("runInitWizard", () => {
  test("jira happy path: prompts, validates, writes real .env", async () => {
    const probeCalls: Array<{ trackerId: string; env: Record<string, string> }> = [];
    const { prompt } = promptQueue([
      "jira", // markdown now leads the menu, so pick Jira by id
      "https://acme.atlassian.net",
      "dev@acme.com",
      "secret-token",
      "PROJ", // default project key
      "", // skip GITHUB_TOKEN PR step
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: (trackerId, env) => {
        probeCalls.push({ trackerId, env });
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0].trackerId).toBe("jira");
    const env = readWizardEnv();
    expect(env).toContain("TASK_TRACKER=jira");
    expect(env).toContain("JIRA_API_TOKEN=secret-token");
    expect(env).toContain("JIRA_DEFAULT_PROJECT_KEY=PROJ");
    expect(env).toContain("# GITHUB_TOKEN=");
    // Nothing is written into the checkout.
    expect(existsSync(join(tempDir, ".devintern-code"))).toBe(false);
  });

  test("tokens go through the hidden-input prompt; other answers do not", async () => {
    const { prompt, asked } = promptQueue([
      "jira",
      "https://acme.atlassian.net",
      "dev@acme.com",
      "PROJ",
      "n", // decline sign-in offer
    ]);
    const secretAsked: string[] = [];
    const secrets = ["secret-token", "ghp_hidden"];
    await runInitWizard({
      ...testDeps(),
      prompt,
      promptSecret: (question: string) => {
        secretAsked.push(question);
        return Promise.resolve(secrets.shift() ?? "");
      },
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });
    expect(secretAsked).toEqual([
      "JIRA API token (input hidden): ",
      "GitHub token for creating pull requests (input hidden; optional, Enter to skip): ",
    ]);
    expect(asked.some((question) => question.includes("token"))).toBe(false);
    const env = readWizardEnv();
    expect(env).toContain("JIRA_API_TOKEN=secret-token");
    expect(env).toContain("GITHUB_TOKEN=ghp_hidden");
  });

  test("every tracker token step is marked secret", () => {
    const secretKeys = Object.values(TRACKER_SETUP)
      .flat()
      .filter((step) => step.secret)
      .map((step) => step.key)
      .sort();
    expect(secretKeys).toEqual([
      "ASANA_API_TOKEN",
      "AZURE_DEVOPS_PAT",
      "GITHUB_TOKEN",
      "GITLAB_TOKEN",
      "JIRA_API_TOKEN",
      "LINEAR_API_KEY",
      "TRELLO_API_TOKEN",
    ]);
  });

  test("an HTML error page from the connection check prints one bounded line", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue([
      "jira",
      "https://acme.atlassian.net",
      "dev@acme.com",
      "tok",
      "",
      "s", // skip validation
      "",
      "n",
    ]);
    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () =>
        Promise.reject(
          new Error(
            `JIRA API error: 404 - <!DOCTYPE html><html><head><title>Oops</title></head><body>${"x".repeat(2000)}</body></html>`,
          ),
        ),
      cwd: tempDir,
      log: (message: string) => logs.push(message),
    });
    const failure = logs.find((line) => line.startsWith("❌ Connection check failed"));
    expect(failure).toBe("❌ Connection check failed: JIRA API error: 404 (HTML error page)");
  });

  test("accepts tracker id input and re-prompts on invalid menu choice", async () => {
    const { prompt } = promptQueue([
      "99", // invalid number
      "not-a-tracker", // invalid id
      "linear",
      "lin_api_123",
      "", // skip team key
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });

    const env = readWizardEnv();
    expect(env).toContain("TASK_TRACKER=linear");
    expect(env).toContain("LINEAR_API_KEY=lin_api_123");
  });

  test("writes config at the repository root when run from a subdirectory", async () => {
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    const subDir = join(tempDir, "packages", "app");
    mkdirSync(subDir, { recursive: true });
    const { prompt } = promptQueue([
      "linear",
      "lin_api_123",
      "", // skip team key
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: subDir,
      log: silentLog,
    });

    // Registered at the repository root, not the subdirectory.
    expect(existsSync(wizardEnvPath())).toBe(true);
    expect(existsSync(join(tempDir, ".devintern-code"))).toBe(false);
    expect(existsSync(join(subDir, ".devintern-code"))).toBe(false);
  });

  test("failed probe: retry then success", async () => {
    let attempts = 0;
    const { prompt } = promptQueue([
      "linear",
      "lin_bad_then_good",
      "", // skip team key
      "r", // retry after failure
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => {
        attempts++;
        return attempts === 1 ? Promise.reject(new Error("401")) : Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(attempts).toBe(2);
    expect(existsSync(wizardEnvPath())).toBe(true);
  });

  test("failed probe: edit values then success", async () => {
    const seenKeys: string[] = [];
    const { prompt } = promptQueue([
      "linear",
      "lin_wrong",
      "", // skip team key
      "e", // edit values
      "lin_right",
      "", // skip team key again
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: (_, env) => {
        seenKeys.push(env.LINEAR_API_KEY);
        return env.LINEAR_API_KEY === "lin_right"
          ? Promise.resolve()
          : Promise.reject(new Error("401"));
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(seenKeys).toEqual(["lin_wrong", "lin_right"]);
    const env = readWizardEnv();
    expect(env).toContain("LINEAR_API_KEY=lin_right");
  });

  test("failed probe: skip validation still writes values with warning", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue([
      "asana",
      "asana-token",
      "", // skip project gid
      "s", // skip validation
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.reject(new Error("network unreachable")),
      cwd: tempDir,
      log: (m) => logs.push(m),
    });

    const env = readWizardEnv();
    expect(env).toContain("ASANA_API_TOKEN=asana-token");
    const output = logs.join("\n");
    expect(output).toContain("Skipping validation");
    // Setup guides on devintern.com: printed after tracker selection and for
    // the optional PR-token step, and written into the generated .env.
    expect(output).toContain("https://devintern.com/docs/code/asana-integration");
    expect(output).toContain("https://devintern.com/docs/code/github-integration");
    expect(env).toContain("# Setup guide: https://devintern.com/docs/code/asana-integration");
  });

  test("fast track: reuses .devintern-pm credentials without re-prompting", async () => {
    mkdirSync(join(tempDir, ".devintern-pm"), { recursive: true });
    writeFileSync(
      join(tempDir, ".devintern-pm", ".env"),
      "TASK_TRACKER=linear\nLINEAR_API_KEY=lin_api_shared\nLINEAR_DEFAULT_TEAM_KEY=ENG\n",
      "utf8",
    );

    const probeEnvs: Array<Record<string, string>> = [];
    const { prompt, asked } = promptQueue([
      "y", // accept reuse
      "", // skip PR token
      "n", // decline sign-in offer
    ]);
    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: (_, env) => {
        probeEnvs.push({ ...env });
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(asked.some((q) => q.includes("Enter a number"))).toBe(false);
    expect(probeEnvs[0].LINEAR_API_KEY).toBe("lin_api_shared");
    const env = readWizardEnv();
    expect(env).toContain("TASK_TRACKER=linear");
    expect(env).toContain("LINEAR_API_KEY=lin_api_shared");
    expect(env).toContain("LINEAR_DEFAULT_TEAM_KEY=ENG");
  });

  test("fast track: declining reuse falls back to the tracker menu", async () => {
    mkdirSync(join(tempDir, ".devintern-pm"), { recursive: true });
    writeFileSync(
      join(tempDir, ".devintern-pm", ".env"),
      "TASK_TRACKER=linear\nLINEAR_API_KEY=lin_api_shared\n",
      "utf8",
    );

    const { prompt, asked } = promptQueue([
      "n", // decline reuse
      "markdown",
      "", // accept default tasks dir
      "", // skip PR token
      "n", // decline sign-in offer
    ]);
    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });

    expect(asked.some((q) => q.includes("Enter a number"))).toBe(true);
    const env = readWizardEnv();
    expect(env).toContain("TASK_TRACKER=markdown");
    expect(env).not.toContain("lin_api_shared");
  });

  test("trello bundled key default is omitted from .env so fallback applies", async () => {
    const probeEnvs: Array<Record<string, string>> = [];
    const { prompt } = promptQueue([
      "trello",
      "", // accept bundled API key default
      "trello-token",
      "", // skip board id
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: (_, env) => {
        probeEnvs.push({ ...env });
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    // Probe sees the bundled key so validation exercises real credentials
    expect(probeEnvs[0].TRELLO_API_KEY).toBe(BUNDLED_TRELLO_API_KEY);
    const env = readWizardEnv();
    expect(env).toContain(`TRELLO_API_KEY=${BUNDLED_TRELLO_API_KEY}`);
    expect(env).toContain("TRELLO_API_TOKEN=trello-token");
  });

  test("tracker menu leads with the zero-account markdown option", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue([
      "markdown",
      "", // accept ./tasks default
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: (m) => logs.push(m),
    });

    const output = logs.join("\n");
    expect(output).toContain(
      "1. Markdown files (markdown) — local .md task files, no account needed",
    );
    expect(output).toContain("2. JIRA (jira)");
    const env = readWizardEnv();
    expect(env).toContain("TASK_TRACKER=markdown");
  });

  test("markdown tracker: no probe, defaults tasks dir", async () => {
    let probed = false;
    const { prompt } = promptQueue([
      "markdown",
      "", // accept ./tasks default
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => {
        probed = true;
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(probed).toBe(false);
    const env = readWizardEnv();
    expect(env).toContain("TASK_TRACKER=markdown");
    // Saved absolute: the worker service and task runs use other cwds.
    expect(env).toContain(`MARKDOWN_TASKS_DIR=${join(tempDir, "tasks")}`);
  });

  test("github tracker skips the extra PR-token step", async () => {
    const { prompt, remaining } = promptQueue([
      "github",
      "ghp_token",
      "acme/widgets",
      "", // skip status labels
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });

    expect(remaining).toHaveLength(0);
    const env = readWizardEnv();
    expect(env).toContain("GITHUB_TOKEN=ghp_token");
    expect(env).toContain("GITHUB_REPO=acme/widgets");
  });

  test("PR token answer is written for non-github trackers", async () => {
    const { prompt } = promptQueue([
      "linear",
      "lin_api_123",
      "", // skip team key
      "ghp_pr_token",
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });

    const env = readWizardEnv();
    expect(env).toContain("GITHUB_TOKEN=ghp_pr_token");
  });

  test("keeps guiding when the config folder exists but .env is missing", async () => {
    mkdirSync(join(tempDir, ".devintern-code"), { recursive: true });
    const { prompt } = promptQueue([
      "linear",
      "lin_api_123",
      "", // skip team key
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });

    const env = readWizardEnv();
    expect(env).toContain("TASK_TRACKER=linear");
    expect(env).toContain("LINEAR_API_KEY=lin_api_123");
  });

  test("post-setup: offers sign-in and reports success", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue([
      "linear",
      "lin_api_123",
      "", // skip team key
      "", // skip PR token
      "y", // accept sign-in offer
    ]);
    let signInCalled = false;

    await runInitWizard({
      ...testDeps({
        signIn: () => {
          signInCalled = true;
          return Promise.resolve({ id: "u1", email: "dev@acme.com" });
        },
      }),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: (m) => logs.push(m),
    });

    expect(signInCalled).toBe(true);
    expect(logs.join("\n")).toContain("Signed in as dev@acme.com");
  });

  test("post-setup: declining sign-in skips it without error", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue([
      "linear",
      "lin_api_123",
      "", // skip team key
      "", // skip PR token
      "n", // decline sign-in
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: (m) => logs.push(m),
    });

    expect(logs.join("\n")).not.toContain("Signed in as");
  });

  test("post-setup: already signed in is reported without prompting", async () => {
    const logs: string[] = [];
    const { prompt, asked } = promptQueue([
      "linear",
      "lin_api_123",
      "", // skip team key
      "", // skip PR token
    ]);

    await runInitWizard({
      ...testDeps({ getUser: () => Promise.resolve({ id: "u1", email: "dev@acme.com" }) }),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: (m) => logs.push(m),
    });

    expect(asked.some((q) => q.includes("Sign in"))).toBe(false);
    expect(logs.join("\n")).toContain("✅ Signed in as dev@acme.com");
  });

  test("post-setup: warns when no agent CLI is installed", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue([
      "linear",
      "lin_api_123",
      "", // skip team key
      "", // skip PR token
      "n",
    ]);

    await runInitWizard({
      ...testDeps({ listInstalledAgents: () => [] }),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: (m) => logs.push(m),
    });

    expect(logs.join("\n")).toContain("No AI agent CLI found");
  });

  test("post-setup: readiness checklist reflects the freshly written config", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue([
      "linear",
      "lin_api_123",
      "", // skip team key
      "", // skip PR token
      "n",
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: (m) => logs.push(m),
    });

    const output = logs.join("\n");
    expect(output).toContain("📋 Readiness:");
    expect(output).toContain("✅ Task tracker — Linear");
    expect(output).not.toContain("❌ Task tracker");
  });
});

describe("runInitWizard analytics", () => {
  let telemetryDir: string;

  beforeEach(() => {
    telemetryDir = mkdtempSync(join(tmpdir(), "init-wizard-telemetry-"));
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env[ANALYTICS_CONFIG_DIR_ENV] = telemetryDir;
  });

  afterEach(() => {
    setAnalyticsCaptureForTests(undefined);
    delete process.env.POSTHOG_API_KEY;
    delete process.env[ANALYTICS_CONFIG_DIR_ENV];
    rmSync(telemetryDir, { recursive: true, force: true });
  });

  function stubAnalytics(): Array<{ event?: string; properties?: Record<string, unknown> }> {
    const recorded: Array<{ event?: string; properties?: Record<string, unknown> }> = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });
    return recorded;
  }

  test("completed wizard emits setup_started then setup_completed for the init source", async () => {
    const recorded = stubAnalytics();
    const { prompt } = promptQueue([
      "markdown",
      "", // accept ./tasks default
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });

    expect(recorded.map((e) => e.event)).toEqual(["setup_started", "setup_completed"]);
    expect(recorded[0]?.properties).toMatchObject({ source: "init" });
    expect(recorded[1]?.properties).toMatchObject({
      tracker: "markdown",
      signed_in: "skipped",
    });
  });

  test("the first-run rescue records source: rescue on setup_started", async () => {
    const recorded = stubAnalytics();
    const { prompt } = promptQueue([
      "markdown",
      "", // accept ./tasks default
      "", // skip PR token
      "n", // decline sign-in offer
    ]);

    await runInitWizard({
      ...testDeps(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
      source: "rescue",
    });

    expect(recorded.map((e) => e.event)).toEqual(["setup_started", "setup_completed"]);
    expect(recorded[0]?.properties).toMatchObject({ source: "rescue" });
  });

  test("an existing registration never starts the funnel", async () => {
    await registerManualCheckout(tempDir, "", silentLog);
    const recorded = stubAnalytics();
    const { prompt, asked } = promptQueue([]);

    await runInitWizard({
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });

    expect(asked).toHaveLength(0);
    expect(recorded).toEqual([]);
  });
});

describe("runInitUpgrade", () => {
  /** Scaffold an existing linear config to upgrade from. */
  function seedExistingConfig(extra = ""): void {
    mkdirSync(join(tempDir, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(tempDir, ".devintern-code", ".env"),
      [
        "# @devintern/code Environment Configuration",
        "TASK_TRACKER=linear",
        "LINEAR_API_KEY=lin_old_key",
        "# LINEAR_DEFAULT_TEAM_KEY=",
        "CUSTOM_VAR=keep-me",
        extra,
      ].join("\n"),
      "utf8",
    );
  }

  test("update credentials: Enter keeps current values, new values replace", async () => {
    seedExistingConfig();
    const { prompt } = promptQueue([
      "1", // update credentials
      "", // keep LINEAR_API_KEY
      "ENG", // set team key (was skipped)
      "ghp_new_pr", // PR token (none stored yet)
    ]);
    let probed: Record<string, string> | undefined;
    await runInitUpgrade({
      envPath: upgradeEnvPath(),
      prompt,
      probe: (_, env) => {
        probed = env;
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("LINEAR_API_KEY=lin_old_key");
    expect(env).toContain("LINEAR_DEFAULT_TEAM_KEY=ENG");
    expect(env).toContain("CUSTOM_VAR=keep-me");
    expect(env).toContain("GITHUB_TOKEN=ghp_new_pr");
    // Probe validated with the merged values (stored + new)
    expect(probed?.LINEAR_API_KEY).toBe("lin_old_key");
  });

  test("update credentials: rotated key replaces the stored one", async () => {
    seedExistingConfig();
    const { prompt } = promptQueue([
      "1",
      "lin_rotated", // new API key
      "", // skip team key
      "ghp_rotated",
    ]);
    await runInitUpgrade({
      envPath: upgradeEnvPath(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("LINEAR_API_KEY=lin_rotated");
    expect(env).toContain("ghp_rotated");
    expect(env).not.toContain("lin_old_key");
  });

  test("switch tracker: writes TASK_TRACKER and carries the GitHub token over", async () => {
    seedExistingConfig("GITHUB_TOKEN=ghp_shared\n");
    const { prompt } = promptQueue([
      "2", // switch
      "jira", // target tracker
      "https://acme.atlassian.net",
      "dev@acme.com",
      "jira-token",
      "PROJ", // default project key
    ]);
    await runInitUpgrade({
      envPath: upgradeEnvPath(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toMatch(/TASK_TRACKER=jira/);
    expect(env).not.toMatch(/TASK_TRACKER=linear/);
    expect(env).toContain("JIRA_API_TOKEN=jira-token");
    expect(env).toContain("GITHUB_TOKEN=ghp_shared");
    expect(env).toContain("LINEAR_API_KEY=lin_old_key");
  });

  test.skipIf(process.platform === "win32")(
    "update credentials: a group/world-readable env file ends up owner-only",
    async () => {
      seedExistingConfig();
      chmodSync(upgradeEnvPath(), 0o644);
      const { prompt } = promptQueue(["1", "lin_rotated", "", "ghp_rotated"]);
      await runInitUpgrade({
        envPath: upgradeEnvPath(),
        prompt,
        probe: () => Promise.resolve(),
        cwd: tempDir,
        log: silentLog,
      });
      expect(readFileSync(upgradeEnvPath(), "utf8")).toContain("LINEAR_API_KEY=lin_rotated");
      expect(statSync(upgradeEnvPath()).mode & 0o777).toBe(0o600);
    },
  );

  test.skipIf(process.platform === "win32")(
    "switch tracker: a group/world-readable env file ends up owner-only",
    async () => {
      seedExistingConfig("GITHUB_TOKEN=ghp_shared\n");
      chmodSync(upgradeEnvPath(), 0o644);
      const { prompt } = promptQueue([
        "2",
        "jira",
        "https://acme.atlassian.net",
        "dev@acme.com",
        "jira-token",
        "PROJ",
      ]);
      await runInitUpgrade({
        envPath: upgradeEnvPath(),
        prompt,
        probe: () => Promise.resolve(),
        cwd: tempDir,
        log: silentLog,
      });
      expect(readFileSync(upgradeEnvPath(), "utf8")).toContain("TASK_TRACKER=jira");
      expect(statSync(upgradeEnvPath()).mode & 0o777).toBe(0o600);
    },
  );

  test("exit option leaves the file untouched", async () => {
    seedExistingConfig();
    const before = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    const { prompt } = promptQueue(["3"]);
    await runInitUpgrade({
      envPath: upgradeEnvPath(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });
    expect(readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8")).toBe(before);
  });

  test("a missing env file is reported without prompting", async () => {
    mkdirSync(join(tempDir, ".devintern-code"), { recursive: true });
    const { prompt, asked } = promptQueue([]);
    await runInitUpgrade({
      envPath: upgradeEnvPath(),
      prompt,
      probe: () => Promise.resolve(),
      cwd: tempDir,
      log: silentLog,
    });
    expect(asked).toHaveLength(0);
  });
});

describe("init --yes subprocess", () => {
  // Spawns a fresh bun process; under full-suite load this exceeds bun's 5s default.
  test("registers the checkout and writes the template env without prompting", () => {
    const result = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "init", "--yes"],
      {
        cwd: tempDir,
        // Pass the per-file pinned workspace (children otherwise get the start env).
        env: { ...process.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    const env = readWizardEnv();
    expect(existsSync(join(tempDir, ".devintern-code"))).toBe(false);
    expect(env).toContain("TASK_TRACKER=jira");
    expect(env).toContain("# LINEAR_API_KEY=");
  }, 30_000);
});
