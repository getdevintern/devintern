import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { ReadinessCheck } from "../src/lib/observability/readiness";
import { renderReadinessReport } from "../src/lib/observability/readiness";
import {
  collectWorkerDoctorChecks,
  defaultCheckSandbox,
  gitLsRemote,
  gitProbeEnv,
  workerDoctorClosingLine,
} from "../src/lib/observability/worker-readiness";
import type { WorkerDoctorDeps } from "../src/lib/observability/worker-readiness";

const JIRA_ENV = [
  "JIRA_BASE_URL=https://acme.atlassian.net",
  "JIRA_EMAIL=bot@acme.com",
  "JIRA_API_TOKEN=secret",
].join("\n");

const TEAMS_CONFIG = `
[defaults]
tracker = "jira"

[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT AND status = Ready"
repo = "backend"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[automations]]
id = "daily"
enabled = true
interval = "1h"
prompt = "triage"
`;

const ok = (id: string): ReadinessCheck => ({ id, label: id, status: "ok" });

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "worker-doctor-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function writeWorkspace(toml: string, env?: string): string {
  const configPath = join(workspaceDir, "workspace.toml");
  writeFileSync(configPath, toml);
  if (env !== undefined) writeFileSync(join(workspaceDir, ".env"), env);
  return configPath;
}

/** Deps with every probe stubbed to pass; tests override the one under test. */
function passingDeps(overrides: Partial<WorkerDoctorDeps> = {}): WorkerDoctorDeps {
  return {
    processEnv: {},
    dryRunQuery: async () => 3,
    checkRepoAccess: async () => ({ ok: true }),
    checkEntitlement: async () => ({ valid: true, source: "entitlement", message: "" }),
    checkHarness: async () => ok("harness"),
    checkSandbox: async () => ok("sandbox"),
    isPortInUse: async () => false,
    workerStatus: () => ({ status: "stopped" }),
    ...overrides,
  };
}

function byId(checks: ReadinessCheck[], id: string): ReadinessCheck[] {
  return checks.filter((check) => check.id === id);
}

/** Every non-ok check must carry a 💡 hint. */
function expectHintsOnProblems(checks: ReadinessCheck[]): void {
  for (const check of checks) {
    if (check.status !== "ok") expect(check.hint).toBeTruthy();
  }
  const lines = renderReadinessReport(checks).lines;
  const problems = checks.filter((check) => check.status !== "ok").length;
  expect(lines.filter((line) => line.includes("💡")).length).toBe(problems);
}

describe("collectWorkerDoctorChecks", () => {
  test("valid workspace passes with a repo/team/automation summary", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const checks = await collectWorkerDoctorChecks({ workspacePath }, passingDeps());
    const [config] = byId(checks, "workspace-config");
    expect(config?.status).toBe("ok");
    expect(config?.detail).toContain("1 repo, 1 team, 1 automation");
    expect(renderReadinessReport(checks).hasFailures).toBe(false);
    expect(checks.every((check) => check.status === "ok")).toBe(true);
  });

  test("invalid workspace.toml lists every parse problem as a failing check", async () => {
    const workspacePath = writeWorkspace(`
[defaults]
tracker = "jira"
poll_interval = -5

[[repos]]
name = "backend"
`);
    const checks = await collectWorkerDoctorChecks({ workspacePath }, passingDeps());
    const configChecks = byId(checks, "workspace-config");
    expect(configChecks.length).toBeGreaterThanOrEqual(2);
    expect(configChecks.every((check) => check.status === "fail")).toBe(true);
    expect(configChecks.some((check) => check.detail?.includes("poll_interval"))).toBe(true);
    expect(configChecks.some((check) => check.detail?.includes("remote"))).toBe(true);
    expect(renderReadinessReport(checks).hasFailures).toBe(true);
    expectHintsOnProblems(checks);
  });

  test("TOML syntax errors are reported as a failing check", async () => {
    const workspacePath = writeWorkspace("[defaults\ntracker = ");
    const checks = await collectWorkerDoctorChecks({ workspacePath }, passingDeps());
    const [config] = byId(checks, "workspace-config");
    expect(config?.status).toBe("fail");
    expect(config?.detail).toContain("Failed to parse");
  });

  test("missing --workspace path fails naming the path", async () => {
    const workspacePath = join(workspaceDir, "nope", "workspace.toml");
    const checks = await collectWorkerDoctorChecks({ workspacePath }, passingDeps());
    const [config] = byId(checks, "workspace-config");
    expect(config?.status).toBe("fail");
    expect(config?.detail).toContain(workspacePath);
    expect(config?.detail).not.toContain("    at ");
    // Config-independent checks still run.
    expect(byId(checks, "entitlement")).toHaveLength(1);
    expect(byId(checks, "sandbox")).toHaveLength(1);
  });

  test("unreadable --workspace path fails naming the path", async () => {
    if (process.getuid?.() === 0) return; // root can read anything
    const workspacePath = writeWorkspace(TEAMS_CONFIG);
    chmodSync(workspacePath, 0o000);
    try {
      const checks = await collectWorkerDoctorChecks({ workspacePath }, passingDeps());
      const [config] = byId(checks, "workspace-config");
      expect(config?.status).toBe("fail");
      expect(config?.detail).toContain(`cannot read ${workspacePath}`);
    } finally {
      chmodSync(workspacePath, 0o600);
    }
  });

  test("team missing tracker variables fails by team and variable name", async () => {
    const workspacePath = writeWorkspace(
      TEAMS_CONFIG,
      "JIRA_BASE_URL=https://acme.atlassian.net\nJIRA_EMAIL=bot@acme.com\n",
    );
    let queried = false;
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        // Present in process.env only: team clients never read it.
        processEnv: { JIRA_API_TOKEN: "from-shell" },
        dryRunQuery: async () => {
          queried = true;
          return 1;
        },
      }),
    );
    const [credentials] = byId(checks, "credentials");
    expect(credentials?.status).toBe("fail");
    expect(credentials?.detail).toContain('team "platform"');
    expect(credentials?.detail).toContain("JIRA_API_TOKEN");
    expect(credentials?.hint).toContain("platform");
    expect(byId(checks, "query")[0]?.status).toBe("fail");
    expect(queried).toBe(false);
    expectHintsOnProblems(checks);
  });

  test.each([
    ["workspace .env", JIRA_ENV, "", ""],
    ["team env_file", "", 'env_file = "platform.env"', ""],
    [
      "inline [teams.env]",
      "",
      "",
      `[teams.env]
JIRA_BASE_URL = "https://acme.atlassian.net"
JIRA_EMAIL = "bot@acme.com"
JIRA_API_TOKEN = "secret"`,
    ],
  ])("credentials from %s pass without process.env", async (_label, env, envFile, inline) => {
    writeFileSync(join(workspaceDir, "platform.env"), JIRA_ENV);
    const toml = TEAMS_CONFIG.replace(
      'repo = "backend"',
      `repo = "backend"\n${envFile}\n${inline}`,
    );
    const workspacePath = writeWorkspace(toml, env);
    const seen: Array<Record<string, string | undefined>> = [];
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        dryRunQuery: async (_tracker, queryEnv) => {
          seen.push(queryEnv);
          return 0;
        },
      }),
    );
    expect(byId(checks, "credentials")[0]?.status).toBe("ok");
    expect(seen[0]?.JIRA_API_TOKEN).toBe("secret");
  });

  test("dry-runs each team separately and reports per-team match counts", async () => {
    const toml = `${TEAMS_CONFIG}
[[teams]]
name = "mobile"
tracker = "jira"
task_query = "project = MOB"
repo = "backend"
`;
    const workspacePath = writeWorkspace(toml, JIRA_ENV);
    const queries: string[] = [];
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        dryRunQuery: async (_tracker, _env, query) => {
          queries.push(query);
          return query.includes("PLAT") ? 3 : 1;
        },
      }),
    );
    expect(queries).toEqual(["project = PLAT AND status = Ready", "project = MOB"]);
    expect(byId(checks, "query").map((check) => check.detail)).toEqual([
      'jira (team "platform"): 3 tasks match',
      'jira (team "mobile"): 1 task matches',
    ]);
  });

  test("a failing query names the team and API error; later checks still run", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        dryRunQuery: async () => {
          throw new Error("JQL: The value 'Ready' does not exist for the field 'status'.");
        },
      }),
    );
    const [query] = byId(checks, "query");
    expect(query?.status).toBe("fail");
    expect(query?.detail).toContain('team "platform"');
    expect(query?.detail).toContain("does not exist for the field 'status'");
    expect(query?.hint).toContain("platform");
    expect(byId(checks, "repo")).toHaveLength(1);
    expect(byId(checks, "entitlement")).toHaveLength(1);
    expect(byId(checks, "dashboard-port")).toHaveLength(1);
    expect(renderReadinessReport(checks).hasFailures).toBe(true);
  });

  test("a hung query times out as a failing check", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({ probeTimeoutMs: 20, dryRunQuery: () => new Promise(() => {}) }),
    );
    expect(byId(checks, "query")[0]?.status).toBe("fail");
    expect(byId(checks, "query")[0]?.detail).toContain("timed out");
  });

  test("single-defaults mode layers process.env under the workspace .env", async () => {
    const workspacePath = writeWorkspace(
      `
[defaults]
tracker = "jira"
task_query = "project = X"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
`,
      "JIRA_API_TOKEN=secret\n",
    );
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        processEnv: { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "bot@acme.com" },
      }),
    );
    expect(byId(checks, "credentials")[0]).toMatchObject({
      status: "ok",
      detail: "jira ([defaults])",
    });
    expect(byId(checks, "query")[0]?.detail).toBe("jira ([defaults]): 3 tasks match");
  });

  test("--offline skips network checks as warnings and makes no probe calls", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const fail = async (): Promise<never> => {
      throw new Error("network probe called under --offline");
    };
    const checks = await collectWorkerDoctorChecks(
      { workspacePath, offline: true },
      passingDeps({ dryRunQuery: fail, checkRepoAccess: fail, checkEntitlement: fail }),
    );
    for (const id of ["query", "repo", "entitlement"]) {
      const [check] = byId(checks, id);
      expect(check?.status).toBe("warn");
      expect(check?.detail).toContain("skipped (--offline)");
    }
    expect(renderReadinessReport(checks).hasFailures).toBe(false);
    expectHintsOnProblems(checks);
  });

  test("--offline still fails local problems such as missing credentials", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, "");
    const checks = await collectWorkerDoctorChecks({ workspacePath, offline: true }, passingDeps());
    expect(byId(checks, "credentials")[0]?.status).toBe("fail");
    expect(renderReadinessReport(checks).hasFailures).toBe(true);
  });

  test("an unreadable repository fails naming the [[repos]] entry", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, `${JIRA_ENV}\nGITHUB_TOKEN=ghp_test\n`);
    const seen: Array<string | undefined> = [];
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        checkRepoAccess: async (_repo, env) => {
          seen.push(env.GITHUB_TOKEN);
          return { ok: false, reason: "GitHub API 404 for acme/backend" };
        },
      }),
    );
    const [repo] = byId(checks, "repo");
    expect(repo?.status).toBe("fail");
    expect(repo?.detail).toContain('[[repos]] "backend"');
    expect(repo?.detail).toContain("404");
    expect(repo?.hint).toContain("backend");
    expect(seen).toEqual(["ghp_test"]);
  });

  test("a thrown repository probe error fails and remaining checks run", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        checkRepoAccess: async () => {
          throw new Error("fetch failed: ETIMEDOUT");
        },
      }),
    );
    expect(byId(checks, "repo")[0]?.status).toBe("fail");
    expect(byId(checks, "repo")[0]?.detail).toContain("ETIMEDOUT");
    expect(byId(checks, "entitlement")[0]?.status).toBe("ok");
  });

  test.each([
    { valid: false, source: "none", message: "No automation license found." },
    { valid: false, source: "none", message: "Worker Pilot expired." },
  ])("invalid entitlement fails with its state: $message", async (license) => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({ checkEntitlement: async () => license }),
    );
    const [entitlement] = byId(checks, "entitlement");
    expect(entitlement?.status).toBe("fail");
    expect(entitlement?.detail).toBe(`none: ${license.message}`);
    expect(entitlement?.hint).toContain("devintern worker login");
  });

  test("an available Worker Pilot counts as entitled", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        checkEntitlement: async () => ({
          valid: true,
          source: "trial",
          message: "available",
          trialAvailable: true,
        }),
      }),
    );
    expect(byId(checks, "entitlement")[0]?.status).toBe("ok");
  });

  test.each(["srt", "smolvm"])(
    "AGENT_SANDBOX=%s fails with the removed-provider message",
    async (provider) => {
      const workspacePath = writeWorkspace(
        TEAMS_CONFIG,
        `${JIRA_ENV}\nAGENT_SANDBOX=${provider}\n`,
      );
      const checks = await collectWorkerDoctorChecks(
        { workspacePath },
        passingDeps({ checkSandbox: defaultCheckSandbox }),
      );
      const [sandbox] = byId(checks, "sandbox");
      expect(sandbox?.status).toBe("fail");
      expect(sandbox?.detail).toContain(`${provider}:`);
      expect(sandbox?.detail).toContain(`Sandbox provider "${provider}" has been removed`);
      expect(renderReadinessReport(checks).hasFailures).toBe(true);
    },
  );

  test("a running worker owns the busy dashboard port and gets an ok Worker row", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const dirs: string[] = [];
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        isPortInUse: async () => true,
        workerStatus: (dir) => {
          dirs.push(dir);
          return { status: "running", pid: 1234, startedAt: "2026-11-22T10:00:00.000Z" };
        },
      }),
    );
    expect(dirs).toEqual([workspaceDir]);
    const [worker] = byId(checks, "worker");
    expect(worker?.status).toBe("ok");
    expect(worker?.detail).toBe("running (pid 1234, since 2026-11-22T10:00:00.000Z)");
    const [port] = byId(checks, "dashboard-port");
    expect(port?.status).toBe("ok");
    expect(port?.detail).toBe("127.0.0.1:4400 in use by the running worker");
    const report = renderReadinessReport(checks);
    expect(report.hasFailures).toBe(false);
    expect(report.hasWarnings).toBe(false);
    const closing = workerDoctorClosingLine(checks, report);
    expect(closing).toContain("already running");
    expect(closing).toContain("hot-reload");
    expect(closing).not.toContain("start it with");
    expect(closing).not.toContain("start the worker");
  });

  test("an unverifiable worker (other PID namespace) warns and keeps the port row", async () => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const checks = await collectWorkerDoctorChecks(
      { workspacePath, offline: true },
      passingDeps({
        isPortInUse: async () => true,
        workerStatus: () => ({ status: "unknown", pid: 7, reason: "pid-namespace" }),
      }),
    );
    const [worker] = byId(checks, "worker");
    expect(worker?.status).toBe("warn");
    expect(worker?.detail).toBe("unknown (cannot verify from this sandbox)");
    expect(worker?.hint).toContain("devintern worker status");
    const [port] = byId(checks, "dashboard-port");
    expect(port?.status).toBe("warn");
    expect(port?.detail).toContain("already in use");
    expectHintsOnProblems(checks);
    const report = renderReadinessReport(checks);
    expect(report.hasFailures).toBe(false);
    const closing = workerDoctorClosingLine(checks, report);
    expect(closing).toContain("could not tell whether a worker is already running");
    expect(closing).not.toContain("start it with");
    expect(closing).not.toContain("start the worker");
    expect(closing).not.toContain("stopped");
  });

  test.each([
    ["stopped", { status: "stopped" as const, pid: 99 }],
    ["no lock", { status: "unknown" as const }],
  ])("a %s worker adds no row and keeps the closing line", async (_name, status) => {
    const workspacePath = writeWorkspace(TEAMS_CONFIG, JIRA_ENV);
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({ workerStatus: () => status }),
    );
    expect(byId(checks, "worker")).toHaveLength(0);
    expect(workerDoctorClosingLine(checks, renderReadinessReport(checks))).toBe(
      "✅ Everything looks good — start the worker with `devintern worker`.",
    );
    const warned = [...checks, { id: "x", label: "x", status: "warn" as const, hint: "h" }];
    expect(workerDoctorClosingLine(warned, renderReadinessReport(warned))).toBe(
      "✅ Ready to run (with the warnings above) — start it with `devintern worker`.",
    );
  });

  test("a failing check wins over a running worker in the closing line", () => {
    const checks: ReadinessCheck[] = [
      { id: "worker", label: "Worker", status: "ok", detail: "running (pid 1)" },
      { id: "entitlement", label: "e", status: "fail", hint: "h" },
    ];
    expect(workerDoctorClosingLine(checks, renderReadinessReport(checks))).toContain("Not ready");
  });

  test("a busy dashboard port is a warning only", async () => {
    const workspacePath = writeWorkspace(
      `[workspace]\ndashboard_port = 4555\n${TEAMS_CONFIG}`,
      JIRA_ENV,
    );
    const ports: number[] = [];
    const checks = await collectWorkerDoctorChecks(
      { workspacePath },
      passingDeps({
        isPortInUse: async (port) => {
          ports.push(port);
          return true;
        },
      }),
    );
    expect(ports).toEqual([4555]);
    const [port] = byId(checks, "dashboard-port");
    expect(port?.status).toBe("warn");
    expect(port?.detail).toContain("4555");
    const report = renderReadinessReport(checks);
    expect(report.hasFailures).toBe(false);
    expect(report.hasWarnings).toBe(true);
    expectHintsOnProblems(checks);
  });

  test("zero repos, teams, and automations print zero counts and warn", async () => {
    const workspacePath = writeWorkspace(`[defaults]\ntracker = "jira"\n`);
    const checks = await collectWorkerDoctorChecks({ workspacePath }, passingDeps());
    expect(byId(checks, "workspace-config")[0]?.detail).toContain(
      "0 repos, 0 teams, 0 automations",
    );
    expect(byId(checks, "work-sources")[0]?.status).toBe("warn");
    expect(renderReadinessReport(checks).hasFailures).toBe(false);
    expectHintsOnProblems(checks);
  });
});

/** Hash every file under `dir` so the test can prove the doctor wrote nothing. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

describe("gitLsRemote SSH probe", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "worker-doctor-ssh-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs ssh in BatchMode so a passphrase or host-key prompt cannot block", async () => {
    const argsFile = join(dir, "ssh-args");
    const fakeSsh = join(dir, "ssh");
    writeFileSync(fakeSsh, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 255\n`);
    chmodSync(fakeSsh, 0o755);
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
    };
    delete env.GIT_SSH_COMMAND;
    delete env.GIT_SSH;

    const result = await gitLsRemote("git@github.com:acme/backend.git", env, 10_000);

    expect(result.ok).toBe(false);
    const args = readFileSync(argsFile, "utf8").split("\n");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=10");
  });

  test("keeps a user-supplied GIT_SSH_COMMAND or GIT_SSH", () => {
    expect(gitProbeEnv({ GIT_SSH_COMMAND: "ssh -i key" }).GIT_SSH_COMMAND).toBe("ssh -i key");
    expect(gitProbeEnv({ GIT_SSH: "/usr/bin/plink" }).GIT_SSH_COMMAND).toBeUndefined();
    expect(gitProbeEnv({}).GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("devintern worker doctor CLI", () => {
  const cliEnv = (extra: Record<string, string> = {}): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(JIRA_|AGENT_|LICENSE_KEY|DASHBOARD_PORT)/.test(key)) {
        env[key] = value;
      }
    }
    return {
      ...env,
      DEVINTERN_NO_UPDATE: "1",
      DEVINTERN_TELEMETRY_DISABLED: "1",
      // Any accidental network call fails fast instead of reaching the internet.
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ...extra,
    };
  };

  test("--offline exits 0 on a healthy workspace and changes no files", () => {
    const workspacePath = writeWorkspace(
      `[workspace]\ndashboard = false\n${TEAMS_CONFIG}`,
      `${JIRA_ENV}\nAGENT_SANDBOX=none\nAGENT_HARNESS=claude-code\nAGENT_CLI_PATH=/usr/bin/true\n`,
    );
    mkdirSync(join(workspaceDir, ".devintern-code"), { recursive: true });
    writeFileSync(join(workspaceDir, ".devintern-code", "queue.db"), "state");
    const before = snapshotTree(workspaceDir);
    const result = spawnSync(
      "bun",
      [
        join(import.meta.dir, "..", "src", "index.ts"),
        "worker",
        "doctor",
        "--workspace",
        workspacePath,
        "--offline",
      ],
      { cwd: workspaceDir, env: cliEnv(), encoding: "utf8", timeout: 60_000 },
    );
    expect(result.stdout).toContain("1 repo, 1 team, 1 automation");
    expect(result.stdout).toContain("skipped (--offline)");
    expect(result.status).toBe(0);
    expect(snapshotTree(workspaceDir)).toEqual(before);
  });

  test("a missing --workspace path exits 1 without a stack trace", () => {
    const missing = join(workspaceDir, "missing", "workspace.toml");
    const result = spawnSync(
      "bun",
      [
        join(import.meta.dir, "..", "src", "index.ts"),
        "worker",
        "doctor",
        "--workspace",
        missing,
        "--offline",
      ],
      { cwd: workspaceDir, env: cliEnv(), encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`no workspace.toml at ${missing}`);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/\n\s+at .+:\d+:\d+/);
  });

  test.each([true, false])(
    "devintern doctor points to worker doctor only when a workspace exists (%s)",
    (withWorkspace) => {
      if (withWorkspace) writeWorkspace(TEAMS_CONFIG);
      const projectDir = mkdtempSync(join(tmpdir(), "worker-doctor-project-"));
      try {
        const result = spawnSync(
          "bun",
          [join(import.meta.dir, "..", "src", "index.ts"), "doctor"],
          {
            cwd: projectDir,
            env: cliEnv({ DEVINTERN_WORKSPACE_DIR: workspaceDir }),
            encoding: "utf8",
            timeout: 60_000,
          },
        );
        const pointer = result.stdout
          .split("\n")
          .filter((line) => line.includes("devintern worker doctor"));
        expect(pointer).toHaveLength(withWorkspace ? 1 : 0);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );
});
