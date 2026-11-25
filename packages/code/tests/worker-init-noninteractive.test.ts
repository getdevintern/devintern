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
import { join, resolve } from "path";

import {
  WORKER_INIT_LOCK_FILE,
  acquireWorkspaceInitLock,
  condenseMessage,
  parseNonInteractiveInitArgs,
  renderNonInteractiveReport,
  runNonInteractiveWorkerInit,
} from "../src/lib/init/worker-init-noninteractive";
import type {
  NonInteractiveInitArgs,
  NonInteractiveInitDeps,
} from "../src/lib/init/worker-init-noninteractive";
import type { WorkerDoctorDeps } from "../src/lib/observability/worker-readiness";
import { loadWorkspaceConfig } from "../src/lib/workspace/config";

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

  test("names every missing input and writes nothing", async () => {
    const report = await run({});
    expect(report.result).toBe("failure");
    expect(report.error).toStartWith("missing: --tracker, --task-query.");
    expect(existsSync(workspaceDir)).toBe(false);

    const jira = await run({ tracker: "jira" }, { processEnv: { JIRA_BASE_URL: "https://x" } });
    expect(jira.error).toStartWith("missing: --task-query, JIRA_EMAIL, JIRA_API_TOKEN.");
    expect(existsSync(workspaceDir)).toBe(false);
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

  test("sign-in needed is a warning and a next step, not a failure", async () => {
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      {
        processEnv: { ...JIRA_ENV },
        doctorOverrides: {
          checkEntitlement: async () => ({
            valid: false,
            source: "none",
            message: "Not signed in",
          }),
        },
      },
    );
    expect(report.result).toBe("success");
    expect(report.checks.find((check) => check.name === "entitlement")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("sign-in needed"),
    });
    expect(report.nextSteps[0]).toMatchObject({
      id: "sign-in",
      command: "devintern worker login",
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

  test("refuses an --env-file readable by group or others", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(envFile, "JIRA_API_TOKEN=x\n");
    chmodSync(envFile, 0o644);
    const report = await run({ tracker: "jira", taskQuery: "q", envFile });
    expect(report.error).toContain(`chmod 600 ${envFile}`);
    expect(existsSync(workspaceDir)).toBe(false);
  });

  test("--repo-from-cwd outside git or without a GitHub origin names the directory", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const outside = await run(
      { tracker: "jira", taskQuery: "q", repoFromCwd: true },
      { cwd: plain, processEnv: { ...JIRA_ENV } },
    );
    expect(outside.error).toContain(`${plain} is not inside a git repository`);

    git(repoDir, "remote set-url origin https://gitlab.com/acme/app.git");
    const gitlab = await run(
      { tracker: "jira", taskQuery: "q", repoFromCwd: true },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(gitlab.error).toContain("is not a GitHub repository");
    expect(gitlab.error).toContain(resolve(repoDir));
    expect(existsSync(workspaceDir)).toBe(false);
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

  test("a lock left by a dead process is taken over", () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, WORKER_INIT_LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 7 }));
    const lock = acquireWorkspaceInitLock(workspaceDir);
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.release();
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
});
