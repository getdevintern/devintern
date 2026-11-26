import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "child_process";
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
import { dirname, join, resolve } from "path";

import {
  WORKER_INIT_LOCK_FILE,
  acquireWorkspaceInitLock,
  condenseMessage,
  initExitCode,
  parseNonInteractiveInitArgs,
  removeStaleLock,
  resultFor,
  runNonInteractiveWorkerInit,
} from "../src/lib/init/worker-init-noninteractive";
import { renderNonInteractiveReport } from "../src/lib/init/worker-init-noninteractive-text";
import type {
  NonInteractiveInitArgs,
  NonInteractiveInitDeps,
} from "../src/lib/init/worker-init-noninteractive";
import { gitCommitIdentityCheck } from "../src/lib/observability/git-identity-readiness";
import type { WorkerDoctorDeps } from "../src/lib/observability/worker-readiness";
import { loadWorkspaceConfig } from "../src/lib/workspace/config";
import { workspaceCodeStateDir } from "../src/lib/workspace/paths";

const JIRA_ENV = {
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_EMAIL: "bot@acme.test",
  JIRA_API_TOKEN: "ATATT-very-secret-token",
};

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: "ignore" });
}

/** Offline doctor stubs: every probe passes unless overridden. */
function doctorStubs(overrides: WorkerDoctorDeps = {}): WorkerDoctorDeps {
  return {
    dryRunQuery: async () => 3,
    checkRepoAccess: async () => ({ ok: true, detail: "GitHub acme/app readable" }),
    checkEntitlement: async () => ({ valid: true, source: "license-key", message: "ok" }),
    checkHarness: async () => ({ id: "harness", label: "Agent harness", status: "ok" }),
    checkSandbox: async () => ({ id: "sandbox", label: "Agent sandbox", status: "ok" }),
    checkGitIdentity: async () => ({
      id: "git-identity",
      label: "Git commit identity",
      status: "ok",
    }),
    isPortInUse: async () => false,
    workerStatus: () => ({ status: "stopped" }),
    ...overrides,
  };
}

describe("parseNonInteractiveInitArgs", () => {
  test("parses space and = forms", () => {
    const parsed = parseNonInteractiveInitArgs([
      "--non-interactive",
      "--tracker",
      "jira",
      "--task-query=project = X",
      "--repo-from-cwd",
      "--env-file",
      "creds.env",
      "--yes",
      "--json",
    ]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        tracker: "jira",
        taskQuery: "project = X",
        repoFromCwd: true,
        envFile: "creds.env",
        yes: true,
        json: true,
      },
    });
  });

  test("rejects secret flags and points to the env and --env-file", () => {
    for (const flag of ["--jira-token", "--jira-token=abc"]) {
      const parsed = parseNonInteractiveInitArgs(["--non-interactive", flag]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain("Unknown option: --jira-token");
        expect(parsed.error).toContain("--env-file");
        expect(parsed.error).toContain("environment");
        expect(parsed.error).not.toContain("abc");
      }
    }
  });

  test("requires values for value flags", () => {
    const parsed = parseNonInteractiveInitArgs(["--tracker", "--json"]);
    expect(parsed).toMatchObject({ ok: false, json: true });
  });

  test("--sign-in takes an OAuth provider or an email address", () => {
    expect(parseNonInteractiveInitArgs(["--sign-in", "github"])).toMatchObject({
      ok: true,
      args: { signIn: { method: "github" } },
    });
    expect(parseNonInteractiveInitArgs(["--sign-in=twitter"])).toMatchObject({
      ok: true,
      args: { signIn: { method: "x" } },
    });
    expect(parseNonInteractiveInitArgs(["--sign-in", "me@acme.test"])).toMatchObject({
      ok: true,
      args: { signIn: { method: "email", email: "me@acme.test" } },
    });
    for (const bad of [
      ["--sign-in", "email"],
      ["--sign-in"],
      ["--sign-in", "--json"],
      ["--sign-in", "facebook"],
    ]) {
      const parsed = parseNonInteractiveInitArgs(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("--sign-in");
    }
  });
});

describe("condenseMessage", () => {
  test("drops HTML error bodies and bounds the length", () => {
    expect(condenseMessage("JIRA API Error: 404 Not Found - <!DOCTYPE html>\n<html>...")).toBe(
      "JIRA API Error: 404 Not Found (HTML error page)",
    );
    expect(condenseMessage("x".repeat(500)).length).toBe(300);
  });
});

describe("runNonInteractiveWorkerInit", () => {
  let root: string;
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worker-init-ni-"));
    workspaceDir = join(root, "workspace");
    repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init -q -b main");
    git(repoDir, "remote add origin git@github.com:acme/app.git");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(
    args: Partial<NonInteractiveInitArgs>,
    deps: Partial<NonInteractiveInitDeps> & { doctorOverrides?: WorkerDoctorDeps } = {},
  ) {
    const { doctorOverrides, ...rest } = deps;
    return runNonInteractiveWorkerInit(
      { repoFromCwd: false, json: false, yes: false, ...args },
      {
        cwd: repoDir,
        workspaceDir,
        processEnv: {},
        probe: async () => {},
        probeTimeoutMs: 2_000,
        doctor: doctorStubs(doctorOverrides),
        ...rest,
      },
    );
  }

  test("happy path: writes tracker, task_query, and repo, and every check passes", async () => {
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP AND labels = ai", repoFromCwd: true },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(report.error).toBeUndefined();
    expect(report.result).toBe("success");
    const config = loadWorkspaceConfig(join(workspaceDir, "workspace.toml"));
    expect(config.defaults.tracker).toBe("jira");
    expect(config.defaults.taskQuery).toBe("project = APP AND labels = ai");
    expect(config.repos.map((repo) => repo.remote)).toEqual(["git@github.com:acme/app.git"]);
    expect(report.repo).toEqual({
      name: "app",
      remote: "git@github.com:acme/app.git",
      added: true,
    });
    expect(report.filesWritten).toEqual([
      join(workspaceDir, ".env"),
      join(workspaceDir, "workspace.toml"),
    ]);
    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check.status]));
    expect(byName).toMatchObject({
      "tracker-auth": "pass",
      query: "pass",
      repo: "pass",
      entitlement: "pass",
    });
    // Credentials from the environment are saved for the service.
    const env = readFileSync(join(workspaceDir, ".env"), "utf8");
    expect(env).toContain("JIRA_API_TOKEN=ATATT-very-secret-token");
    expect(statSync(join(workspaceDir, ".env")).mode & 0o777).toBe(0o600);
    expect(report.nextSteps.map((step) => step.id)).toEqual(["connect", "start", "service"]);
    // Nothing secret in the report.
    expect(JSON.stringify(report)).not.toContain(JIRA_ENV.JIRA_API_TOKEN);
    expect(existsSync(join(workspaceDir, WORKER_INIT_LOCK_FILE))).toBe(false);
  });

  test("a host without a git identity gets a Git commit identity warning, not a failure", async () => {
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP", repoFromCwd: true, json: true },
      {
        processEnv: {
          ...JIRA_ENV,
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        doctorOverrides: { checkGitIdentity: gitCommitIdentityCheck },
      },
    );
    expect(report.result).toBe("success");
    const identity = report.checks.find((check) => check.name === "git-identity");
    expect(identity).toMatchObject({ label: "Git commit identity", status: "warn" });
    expect(identity?.message).toContain("DevIntern <devintern@users.noreply.github.com>");
    expect(identity?.hint).toContain("git_author_name");
  });

  test("0 matching tasks is a warning, not a failure", async () => {
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      { processEnv: { ...JIRA_ENV }, doctorOverrides: { dryRunQuery: async () => 0 } },
    );
    expect(report.result).toBe("success");
    expect(report.checks.find((check) => check.name === "query")).toMatchObject({
      status: "warn",
      message: "jira ([defaults]): 0 tasks match",
    });
  });

  test("a failed harness check offers install-agent and withholds start and service", async () => {
    const failedHarness = async () => ({
      id: "harness",
      label: "Agent harness",
      status: "fail" as const,
      detail: "no harness CLI found",
      hint: "Install the agent CLI",
    });
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      {
        processEnv: { ...JIRA_ENV, AGENT_HARNESS: "codex" },
        doctorOverrides: { checkHarness: failedHarness },
      },
    );
    expect(report.result).toBe("failure");
    const ids = report.nextSteps.map((step) => step.id);
    expect(ids).toContain("install-agent");
    expect(ids).not.toContain("start");
    expect(ids).not.toContain("service");
    expect(report.nextSteps.find((step) => step.id === "install-agent")?.command).toBe(
      "npm install -g @openai/codex",
    );

    const unknown = await run(
      { tracker: "jira", taskQuery: "project = APP", yes: true },
      {
        processEnv: { ...JIRA_ENV, AGENT_HARNESS: "goose" },
        doctorOverrides: { checkHarness: failedHarness },
      },
    );
    expect(unknown.nextSteps.find((step) => step.id === "install-agent")?.command).toBe(
      "https://devintern.com/docs/code/agent-harness",
    );
  });

  test("the credential probe and doctor's credentials row have distinct labels", async () => {
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      { processEnv: { ...JIRA_ENV } },
    );
    const labels = report.checks.map((check) => check.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("names every missing input and writes nothing", async () => {
    const report = await run({});
    expect(report.result).toBe("failure");
    expect(report.error).toStartWith("missing: --tracker, --task-query.");
    expect(existsSync(workspaceDir)).toBe(false);

    const jira = await run({ tracker: "jira" }, { processEnv: { JIRA_BASE_URL: "https://x" } });
    expect(jira.error).toStartWith("missing: --task-query, JIRA_EMAIL, JIRA_API_TOKEN.");
    expect(existsSync(workspaceDir)).toBe(false);
  });

  test("a missing MARKDOWN_TASKS_DIR is named as the task folder with an absolute-path example", async () => {
    const markdown = await run({ tracker: "markdown" });
    expect(markdown.error).toBe(
      "missing: --task-query, MARKDOWN_TASKS_DIR. Pass the flags, and set credentials in the " +
        "environment or in a file passed with --env-file <path> (mode 0600). MARKDOWN_TASKS_DIR " +
        "is the folder that holds the Markdown task files; set it to an absolute path, for " +
        "example MARKDOWN_TASKS_DIR=$PWD/tasks.",
    );
    expect(existsSync(workspaceDir)).toBe(false);

    // Other trackers keep their wording.
    const jira = await run({ tracker: "jira", taskQuery: "project = X" });
    expect(jira.error).toBe(
      "missing: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN. Pass the flags, and set credentials " +
        "in the environment or in a file passed with --env-file <path> (mode 0600).",
    );
  });

  test("a relative MARKDOWN_TASKS_DIR is saved as an absolute path with a note", async () => {
    const logs: string[] = [];
    let queriedDir: string | undefined;
    const report = await run(
      { tracker: "markdown", taskQuery: "*" },
      {
        processEnv: { MARKDOWN_TASKS_DIR: "./tasks" },
        log: (line) => logs.push(line),
        doctorOverrides: {
          dryRunQuery: async (_tracker, env) => {
            queriedDir = env.MARKDOWN_TASKS_DIR;
            return 1;
          },
        },
      },
    );
    const absolute = join(repoDir, "tasks");
    expect(report.error).toBeUndefined();
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toContain(
      `MARKDOWN_TASKS_DIR=${absolute}`,
    );
    expect(queriedDir).toBe(absolute);
    expect(logs).toContain(`ℹ️  MARKDOWN_TASKS_DIR=./tasks saved as the absolute path ${absolute}`);
    // The folder itself is not created.
    expect(existsSync(absolute)).toBe(false);
  });

  test("a relative MARKDOWN_TASKS_DIR from --env-file is saved as an absolute path", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(envFile, "MARKDOWN_TASKS_DIR=todo\n", { mode: 0o600 });
    const report = await run({ tracker: "markdown", taskQuery: "*", envFile });
    expect(report.error).toBeUndefined();
    const env = readFileSync(join(workspaceDir, ".env"), "utf8");
    expect(env).toContain(`MARKDOWN_TASKS_DIR=${join(repoDir, "todo")}`);
    expect(env).not.toContain("MARKDOWN_TASKS_DIR=todo");
  });

  test("an absolute MARKDOWN_TASKS_DIR is saved unchanged without a note", async () => {
    const logs: string[] = [];
    const absolute = join(root, "tasks");
    await run(
      { tracker: "markdown", taskQuery: "*" },
      { processEnv: { MARKDOWN_TASKS_DIR: absolute }, log: (line) => logs.push(line) },
    );
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toContain(
      `MARKDOWN_TASKS_DIR=${absolute}`,
    );
    expect(logs.some((line) => line.includes("absolute path"))).toBe(false);
  });

  test("lists supported trackers for an unsupported value", async () => {
    const report = await run({ tracker: "notion", taskQuery: "x" });
    expect(report.error).toContain('Unsupported --tracker "notion"');
    expect(report.error).toContain("jira, linear");
  });

  test("a rejected credential fails by name with the status and env names, and is redacted", async () => {
    let queried = false;
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      {
        processEnv: { ...JIRA_ENV },
        probe: async (_tracker, env) => {
          throw new Error(
            `JIRA API Error: 401 Unauthorized - token ${env.JIRA_API_TOKEN} rejected`,
          );
        },
        doctorOverrides: {
          dryRunQuery: async () => {
            queried = true;
            return 1;
          },
        },
      },
    );
    expect(report.result).toBe("failure");
    const auth = report.checks.find((check) => check.name === "tracker-auth");
    expect(auth?.status).toBe("fail");
    expect(auth?.message).toContain("HTTP 401");
    expect(auth?.hint).toContain("JIRA_API_TOKEN");
    expect(report.checks.find((check) => check.name === "query")?.status).toBe("skipped");
    expect(queried).toBe(false);
    const rendered = JSON.stringify(report) + renderNonInteractiveReport(report).join("\n");
    expect(rendered).not.toContain(JIRA_ENV.JIRA_API_TOKEN);
  });

  test("an invalid query fails with the tracker's message", async () => {
    const report = await run(
      { tracker: "jira", taskQuery: "project = = APP" },
      {
        processEnv: { ...JIRA_ENV },
        doctorOverrides: {
          dryRunQuery: async () => {
            throw new Error("Error in the JQL Query: Expecting a field name");
          },
        },
      },
    );
    expect(report.result).toBe("failure");
    expect(report.checks.find((check) => check.name === "query")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("Expecting a field name"),
    });
  });

  test("a hung tracker times out and the independent checks still run", async () => {
    const started = Date.now();
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP", repoFromCwd: true },
      {
        processEnv: { ...JIRA_ENV },
        probeTimeoutMs: 50,
        probe: () => new Promise(() => {}),
      },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.result).toBe("failure");
    expect(report.checks.find((check) => check.name === "tracker-auth")?.message).toContain(
      "timed out",
    );
    expect(report.checks.find((check) => check.name === "repo")?.status).toBe("pass");
  });

  describe("sign-in and the result / exit code matrix", () => {
    const notSignedIn = async () => ({
      valid: false,
      source: "none",
      message: "No automation license or Worker Pilot was found.",
      signInRequired: true,
    });
    const pilotUsedUp = async () => ({
      valid: false,
      source: "none",
      message: "Your account has no matching license.",
    });
    const fakeStart = (calls: unknown[]) => async (dir: string, login: unknown) => {
      calls.push({ dir, login });
      return {
        method: "github" as const,
        url: "https://example.supabase.co/auth/v1/authorize?provider=github",
        redirectTo: "http://127.0.0.1:17865/auth/callback",
        expiresAt: "2026-11-26T12:30:00.000Z",
      };
    };

    test("only sign-in missing: action_required (exit 2), config saved, concrete sign-in step", async () => {
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP" },
        { processEnv: { ...JIRA_ENV }, doctorOverrides: { checkEntitlement: notSignedIn } },
      );
      expect(report.result).toBe("action_required");
      expect(initExitCode(report.result)).toBe(2);
      expect(report.filesWritten).toContain(join(workspaceDir, "workspace.toml"));
      expect(report.checks.find((check) => check.name === "entitlement")).toMatchObject({
        status: "action",
        message: "Not started: sign in to begin your 14-day free Worker Pilot, no card required",
        hint: expect.stringContaining("devintern worker login"),
      });
      expect(report.checks.some((check) => check.status === "fail")).toBe(false);
      const signIn = report.nextSteps[0];
      expect(signIn.id).toBe("sign-in");
      // A concrete command with a method, for this (non-default) workspace.
      expect(signIn.command).toBe(
        `devintern worker login --workspace ${join(workspaceDir, "workspace.toml")} github`,
      );
      expect(signIn.message).toContain("14-day free Worker Pilot, no card required");
      expect(report.signIn).toBeUndefined();
      const text = renderNonInteractiveReport(report).join("\n");
      expect(text).toContain("👉 entitlement: Not started");
      expect(text).toContain(
        "👉 Configuration saved. One step left: sign in to begin your 14-day free Worker Pilot, no card required",
      );
      expect(text).not.toContain("re-run with --yes");
      expect(text).not.toContain("❌");
    });

    test("sign-in missing plus a warning is still action_required", async () => {
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP" },
        {
          processEnv: { ...JIRA_ENV },
          doctorOverrides: { checkEntitlement: notSignedIn, dryRunQuery: async () => 0 },
        },
      );
      expect(report.checks.some((check) => check.status === "warn")).toBe(true);
      expect(report.result).toBe("action_required");
    });

    test("sign-in missing plus a real failure is a failure (exit 1)", async () => {
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP" },
        {
          processEnv: { ...JIRA_ENV },
          doctorOverrides: {
            checkEntitlement: notSignedIn,
            checkHarness: async () => ({
              id: "harness",
              label: "Agent harness",
              status: "fail",
              detail: "claude not found",
            }),
          },
        },
      );
      expect(report.result).toBe("failure");
      expect(initExitCode(report.result)).toBe(1);
      expect(report.nextSteps[0].id).toBe("sign-in");
    });

    test("signed in without an entitlement (Pilot used up) is a failure, not an action", async () => {
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP" },
        { processEnv: { ...JIRA_ENV }, doctorOverrides: { checkEntitlement: pilotUsedUp } },
      );
      expect(report.result).toBe("failure");
      expect(report.checks.find((check) => check.name === "entitlement")?.status).toBe("fail");
    });

    test("a paid LICENSE_KEY passes as before (exit 0)", async () => {
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP" },
        { processEnv: { ...JIRA_ENV } },
      );
      expect(report.result).toBe("success");
      expect(initExitCode(report.result)).toBe(0);
      expect(report.nextSteps.some((step) => step.id === "sign-in")).toBe(false);
    });

    test("an active Worker Pilot shows its end date", async () => {
      const endsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP" },
        {
          processEnv: { ...JIRA_ENV },
          doctorOverrides: {
            checkEntitlement: async () => ({
              valid: true,
              source: "trial",
              message: "Free Worker Pilot active.",
              trialEndsAt: endsAt,
            }),
          },
        },
      );
      expect(report.result).toBe("success");
      expect(report.checks.find((check) => check.name === "entitlement")?.message).toBe(
        `Worker Pilot active, ends ${endsAt.slice(0, 10)} (10 days left)`,
      );
    });

    test("--sign-in starts the sign-in and puts {url, method, expiresAt, complete} in the report", async () => {
      const calls: unknown[] = [];
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP", signIn: { method: "github" } },
        {
          processEnv: { ...JIRA_ENV },
          doctorOverrides: { checkEntitlement: notSignedIn },
          startSignIn: fakeStart(calls),
        },
      );
      expect(calls).toEqual([{ dir: workspaceDir, login: { method: "github" } }]);
      const complete = `devintern worker login --workspace ${join(workspaceDir, "workspace.toml")} --complete '<address>'`;
      expect(report.signIn).toEqual({
        url: "https://example.supabase.co/auth/v1/authorize?provider=github",
        method: "github",
        expiresAt: "2026-11-26T12:30:00.000Z",
        complete,
      });
      expect(Object.keys(JSON.parse(JSON.stringify(report)).signIn).sort()).toEqual([
        "complete",
        "expiresAt",
        "method",
        "url",
      ]);
      expect(report.result).toBe("action_required");
      expect(report.nextSteps[0]).toMatchObject({ id: "sign-in", command: complete });
      const text = renderNonInteractiveReport(report).join("\n");
      expect(text).toContain(
        "🔑 Sign in to begin your 14-day free Worker Pilot, no card required:",
      );
      expect(text).toContain("https://example.supabase.co/auth/v1/authorize?provider=github");
      expect(text).toContain(complete);
      expect(text).toContain("open the address above, then run");
    });

    test("--sign-in does nothing when the workspace is already entitled", async () => {
      const calls: unknown[] = [];
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP", signIn: { method: "github" } },
        { processEnv: { ...JIRA_ENV }, startSignIn: fakeStart(calls) },
      );
      expect(calls).toEqual([]);
      expect(report.signIn).toBeUndefined();
      expect(report.result).toBe("success");
    });

    test("--sign-in that cannot start is a failed check", async () => {
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP", signIn: { method: "github" } },
        {
          processEnv: { ...JIRA_ENV },
          doctorOverrides: { checkEntitlement: notSignedIn },
          startSignIn: async () => {
            throw new Error("network down");
          },
        },
      );
      expect(report.signIn).toBeUndefined();
      expect(report.checks.find((check) => check.name === "sign-in")).toMatchObject({
        status: "fail",
        message: "Could not start the sign-in: network down",
      });
      expect(report.result).toBe("failure");
    });

    test("resultFor and initExitCode", () => {
      const check = (status: "pass" | "warn" | "action" | "fail" | "skipped") => ({
        name: status,
        label: status,
        status,
        message: "",
      });
      expect(resultFor([check("pass"), check("skipped")])).toBe("success");
      expect(resultFor([check("pass"), check("warn")])).toBe("success");
      expect(resultFor([check("warn"), check("action")])).toBe("action_required");
      expect(resultFor([check("action"), check("fail")])).toBe("failure");
      expect([
        initExitCode("success"),
        initExitCode("action_required"),
        initExitCode("failure"),
      ]).toEqual([0, 2, 1]);
    });
  });

  test("reads a 0600 --env-file and saves its values", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(
      envFile,
      Object.entries(JIRA_ENV)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      { mode: 0o600 },
    );
    chmodSync(envFile, 0o600);
    const report = await run({ tracker: "jira", taskQuery: "project = APP", envFile });
    expect(report.result).toBe("success");
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toContain(
      "JIRA_API_TOKEN=ATATT-very-secret-token",
    );
    expect(JSON.stringify(report)).not.toContain("ATATT-very-secret-token");
  });

  test("non-secret --env-file values are not redacted from the report", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(
      envFile,
      [
        "TASK_TRACKER=jira",
        "GITHUB_REPO=acme/app",
        ...Object.entries(JIRA_ENV).map(([k, v]) => `${k}=${v}`),
      ].join("\n"),
      { mode: 0o600 },
    );
    chmodSync(envFile, 0o600);
    const report = await run({
      tracker: "jira",
      taskQuery: "project = APP",
      envFile,
      repoFromCwd: true,
    });
    expect(report.error).toBeUndefined();
    expect(report.tracker).toBe("jira");
    expect(report.repo?.remote).toBe("git@github.com:acme/app.git");
    const json = JSON.stringify(report);
    expect(json).not.toContain("***");
    expect(json).not.toContain(JIRA_ENV.JIRA_API_TOKEN);
  });

  test("default entitlement check receives LICENSE_KEY from --env-file", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(envFile, "LICENSE_KEY=lic-from-env-file\n", { mode: 0o600 });
    chmodSync(envFile, 0o600);
    const seen: (string | undefined)[] = [];
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP", envFile },
      {
        processEnv: { ...JIRA_ENV },
        doctorOverrides: { checkEntitlement: undefined },
        checkLicense: async (options) => {
          seen.push(options.licenseKey);
          return {
            valid: options.licenseKey === "lic-from-env-file",
            source: "license-key",
            message: "ok",
          };
        },
      },
    );
    expect(seen).toEqual(["lic-from-env-file"]);
    expect(report.checks.find((check) => check.name === "entitlement")?.status).toBe("pass");
    expect(report.nextSteps.some((step) => step.id === "sign-in")).toBe(false);
  });

  test("default entitlement check receives LICENSE_KEY from the workspace .env", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, ".env"), "LICENSE_KEY=lic-from-workspace\n");
    const seen: (string | undefined)[] = [];
    await run(
      { tracker: "jira", taskQuery: "project = APP" },
      {
        processEnv: { ...JIRA_ENV },
        doctorOverrides: { checkEntitlement: undefined },
        checkLicense: async (options) => {
          seen.push(options.licenseKey);
          return { valid: true, source: "license-key", message: "ok" };
        },
      },
    );
    expect(seen).toEqual(["lic-from-workspace"]);
  });

  test("refuses an --env-file readable by group or others", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(envFile, "JIRA_API_TOKEN=x\n");
    chmodSync(envFile, 0o644);
    const report = await run({ tracker: "jira", taskQuery: "q", envFile });
    expect(report.error).toContain(`chmod 600 ${envFile}`);
    expect(existsSync(workspaceDir)).toBe(false);
  });

  test("--repo-from-cwd outside git or without an origin names the directory", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const outside = await run(
      { tracker: "jira", taskQuery: "q", repoFromCwd: true },
      { cwd: plain, processEnv: { ...JIRA_ENV } },
    );
    expect(outside.error).toContain(`${plain} is not inside a git repository`);

    git(repoDir, "remote remove origin");
    const noOrigin = await run(
      { tracker: "jira", taskQuery: "q", repoFromCwd: true },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(noOrigin.error).toContain("has no origin remote");
    expect(noOrigin.error).toContain(resolve(repoDir));
    expect(existsSync(workspaceDir)).toBe(false);
  });

  test("--repo-from-cwd registers a non-GitHub origin", async () => {
    git(repoDir, "remote set-url origin https://gitlab.com/acme/app.git");
    const report = await run(
      { tracker: "jira", taskQuery: "q", repoFromCwd: true },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(report.error).toBeUndefined();
    expect(report.repo).toEqual({
      name: "app",
      remote: "https://gitlab.com/acme/app.git",
      added: true,
    });
    const config = loadWorkspaceConfig(join(workspaceDir, "workspace.toml"));
    expect(config.repos.map((repo) => repo.remote)).toEqual(["https://gitlab.com/acme/app.git"]);
  });

  test("--repo-from-cwd with a non-GitHub origin does not invent GITHUB_REPO", async () => {
    git(repoDir, "remote set-url origin https://gitlab.com/acme/app.git");
    const report = await run(
      { tracker: "github", taskQuery: "label:ai", repoFromCwd: true },
      { processEnv: { GITHUB_TOKEN: "ghp_x" } },
    );
    expect(report.error).toContain("GITHUB_REPO");
    expect(existsSync(join(workspaceDir, "workspace.toml"))).toBe(false);
  });

  test("an existing workspace needs --yes, and --yes keeps unrelated settings", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    const configPath = join(workspaceDir, "workspace.toml");
    const original =
      '# my notes\n[workspace]\nci_failure_fix = true\n\n[defaults]\ntracker = "linear"\npoll_interval = 123\n\n[[repos]]\nname = "other"\nremote = "git@github.com:acme/other.git"\n';
    writeFileSync(configPath, original);

    const refused = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(refused.error).toContain("--yes");
    expect(readFileSync(configPath, "utf8")).toBe(original);

    const updated = await run(
      { tracker: "jira", taskQuery: "project = APP", repoFromCwd: true, yes: true },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(updated.result).toBe("success");
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("# my notes");
    const config = loadWorkspaceConfig(configPath);
    expect(config.defaults.tracker).toBe("jira");
    expect(config.defaults.taskQuery).toBe("project = APP");
    expect(config.defaults.pollIntervalSeconds).toBe(123);
    expect(config.workspace.ciFailureFix).toBe(true);
    expect(config.repos.map((repo) => repo.name)).toEqual(["other", "app"]);
  });

  test("a concurrent run fails with 'workspace is being modified' and leaves the file intact", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    const held = acquireWorkspaceInitLock(workspaceDir);
    expect(held.ok).toBe(true);
    try {
      const report = await run(
        { tracker: "jira", taskQuery: "project = APP" },
        { processEnv: { ...JIRA_ENV } },
      );
      expect(report.result).toBe("failure");
      expect(report.error).toContain("workspace is being modified");
      expect(existsSync(join(workspaceDir, "workspace.toml"))).toBe(false);
    } finally {
      if (held.ok) held.release();
    }
  });

  test("an unwritable workspace path fails with a report instead of throwing", async () => {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      { processEnv: { ...JIRA_ENV }, workspaceDir: join(blocker, "ws") },
    );
    expect(report.result).toBe("failure");
    expect(report.error).toContain(`Cannot create ${join(blocker, "ws")}`);
    expect(report.error).toContain("ENOTDIR");
    expect(report.checks).toEqual([]);
  });

  test("a write failure under the lock is reported and releases the lock", async () => {
    // A file where the state directory belongs makes ensureWorkspaceCodeState throw.
    const stateParent = dirname(workspaceCodeStateDir(workspaceDir));
    mkdirSync(dirname(stateParent), { recursive: true });
    writeFileSync(stateParent, "x");
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(report.result).toBe("failure");
    expect(report.error).toStartWith(`Cannot write to ${workspaceDir}`);
    expect(existsSync(join(workspaceDir, WORKER_INIT_LOCK_FILE))).toBe(false);
  });

  test("an unreadable existing workspace.toml fails with a report instead of throwing", async () => {
    // A directory named workspace.toml makes readFileSync throw EISDIR.
    mkdirSync(join(workspaceDir, "workspace.toml"), { recursive: true });
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP", yes: true },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(report.result).toBe("failure");
    expect(report.error).toContain(`Cannot read ${join(workspaceDir, "workspace.toml")}`);
    expect(report.error).toContain("EISDIR");
  });

  test("an unexpected throw becomes a redacted failure report", async () => {
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      {
        processEnv: { ...JIRA_ENV },
        log: () => {
          throw new Error(`boom ${JIRA_ENV.JIRA_API_TOKEN}`);
        },
      },
    );
    expect(report.result).toBe("failure");
    expect(report.error).toContain("boom");
    expect(JSON.stringify(report)).not.toContain(JIRA_ENV.JIRA_API_TOKEN);
  });

  test("a lock left by a dead process is taken over", () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, WORKER_INIT_LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 7 }));
    const lock = acquireWorkspaceInitLock(workspaceDir);
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.release();
  });

  test("release leaves a lock that another run now holds", () => {
    mkdirSync(workspaceDir, { recursive: true });
    const lockPath = join(workspaceDir, WORKER_INIT_LOCK_FILE);
    const lock = acquireWorkspaceInitLock(workspaceDir);
    expect(lock.ok).toBe(true);
    const other = JSON.stringify({ pid: 424242, acquiredAt: 1 });
    writeFileSync(lockPath, other);
    if (lock.ok) lock.release();
    expect(readFileSync(lockPath, "utf8")).toBe(other);
  });

  test("a stale takeover that loses the race keeps the winner's fresh lock", () => {
    mkdirSync(workspaceDir, { recursive: true });
    const lockPath = join(workspaceDir, WORKER_INIT_LOCK_FILE);
    const stale = JSON.stringify({ pid: 2 ** 22 + 7 });
    // Run A already replaced the stale lock with its own before run B acts.
    const winner = acquireWorkspaceInitLock(workspaceDir);
    expect(winner.ok).toBe(true);
    const fresh = readFileSync(lockPath, "utf8");
    expect(removeStaleLock(lockPath, stale)).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe(fresh);
    // B's next create attempt sees A's live lock.
    expect(acquireWorkspaceInitLock(workspaceDir).ok).toBe(false);
    if (winner.ok) winner.release();
    expect(existsSync(lockPath)).toBe(false);
    // Matching content is removed.
    writeFileSync(lockPath, stale);
    expect(removeStaleLock(lockPath, stale)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a freshly created, still-empty lock is not taken over", () => {
    mkdirSync(workspaceDir, { recursive: true });
    const lockPath = join(workspaceDir, WORKER_INIT_LOCK_FILE);
    writeFileSync(lockPath, "");
    const lock = acquireWorkspaceInitLock(workspaceDir);
    expect(lock.ok).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("--yes keeps a 0600 workspace.toml at 0600", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    const configPath = join(workspaceDir, "workspace.toml");
    writeFileSync(
      configPath,
      '[defaults]\ntracker = "linear"\n\n[[repos]]\nname = "other"\nremote = "git@github.com:acme/other.git"\n  [repos.env]\n  GITHUB_TOKEN = "ghp_secret"\n',
    );
    chmodSync(configPath, 0o600);
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP", repoFromCwd: true, yes: true },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(report.error).toBeUndefined();
    expect(report.filesWritten).toContain(configPath);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(workspaceDir, ".env")).mode & 0o777).toBe(0o600);
  });

  test("--env-file and the workspace .env accept quoted values and export lines", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(
      envFile,
      `export JIRA_BASE_URL=${JIRA_ENV.JIRA_BASE_URL}\nJIRA_EMAIL='${JIRA_ENV.JIRA_EMAIL}'\n`,
    );
    chmodSync(envFile, 0o600);
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, ".env"), `JIRA_API_TOKEN="${JIRA_ENV.JIRA_API_TOKEN}"\n`);
    const probed: Array<Record<string, string>> = [];
    const report = await run(
      { tracker: "jira", taskQuery: "q", envFile },
      {
        probe: async (_tracker, env) => {
          probed.push(env);
        },
      },
    );
    expect(report.error).toBeUndefined();
    expect(probed[0]).toMatchObject(JIRA_ENV);
    const saved = readFileSync(join(workspaceDir, ".env"), "utf8");
    // The quoted token equals the parsed value, so it is not rewritten.
    expect(saved).toContain(`JIRA_API_TOKEN="${JIRA_ENV.JIRA_API_TOKEN}"`);
    expect(saved).toContain(`JIRA_EMAIL=${JIRA_ENV.JIRA_EMAIL}`);
    expect(saved).not.toContain("export JIRA_BASE_URL");
  });

  test("--repo-from-cwd imports the checkout env and seeds routing like add-repo", async () => {
    mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(repoDir, ".devintern-code", ".env"),
      "JIRA_DEFAULT_PROJECT_KEY=APP\nAPP_ONLY=1\nJIRA_EMAIL=other@acme.test\nWEBHOOK_QUEUE_DB=/x.db\n",
    );
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, ".env"), `JIRA_EMAIL=${JIRA_ENV.JIRA_EMAIL}\n`);
    const report = await run(
      { tracker: "jira", taskQuery: "q", repoFromCwd: true },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(report.error).toBeUndefined();
    const config = loadWorkspaceConfig(join(workspaceDir, "workspace.toml"));
    expect(config.repos[0].env).toEqual({ JIRA_EMAIL: "other@acme.test" });
    expect(config.routing).toEqual([expect.objectContaining({ repo: "app", project: "APP" })]);
    const saved = readFileSync(join(workspaceDir, ".env"), "utf8");
    expect(saved).toContain("APP_ONLY=1");
    expect(saved).toContain("JIRA_DEFAULT_PROJECT_KEY=APP");
    expect(saved).not.toContain("WEBHOOK_QUEUE_DB");
    expect(saved).not.toContain("other@acme.test");
  });
});

describe("devintern worker init (CLI)", () => {
  const entry = resolve(import.meta.dir, "../src/index.ts");

  function cli(args: string[]) {
    return spawnSync(process.execPath, [entry, "worker", "init", ...args], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, DEVINTERN_TELEMETRY_DISABLED: "1", SENTRY_DISABLED: "1" },
      timeout: 60_000,
    });
  }

  test("closed stdin without --non-interactive exits 1 and points to it", () => {
    const result = cli([]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("--non-interactive");
    expect(result.stdout + result.stderr).not.toContain("AbortError");
  });

  test("--json prints exactly one JSON document on input errors", () => {
    const result = cli(["--non-interactive", "--json", "--jira-token", "x"]);
    expect(result.status).toBe(1);
    const doc = JSON.parse(result.stdout);
    expect(doc).toMatchObject({
      schema: "devintern.worker-init",
      version: 1,
      result: "failure",
      checks: [],
    });
    expect(doc.error).toContain("Unknown option: --jira-token");
  });

  test("--json prints one failure document when the workspace cannot be created", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-init-cli-"));
    try {
      const blocker = join(root, "blocker");
      writeFileSync(blocker, "not a directory");
      const result = spawnSync(
        process.execPath,
        [
          entry,
          "worker",
          "init",
          "--non-interactive",
          "--json",
          "--tracker",
          "linear",
          "--task-query",
          "q",
        ],
        {
          input: "",
          encoding: "utf8",
          env: {
            ...process.env,
            DEVINTERN_TELEMETRY_DISABLED: "1",
            SENTRY_DISABLED: "1",
            DEVINTERN_WORKSPACE_DIR: join(blocker, "ws"),
            LINEAR_API_KEY: "lin_api_very_secret_key",
          },
          timeout: 60_000,
        },
      );
      expect(result.status).toBe(1);
      const doc = JSON.parse(result.stdout);
      expect(doc).toMatchObject({ schema: "devintern.worker-init", result: "failure" });
      expect(doc.error).toContain("ENOTDIR");
      expect(result.stdout).not.toContain("lin_api_very_secret_key");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
