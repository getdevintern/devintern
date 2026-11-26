/**
 * The headless setup contract: every `nextSteps` entry has one shape and runs
 * as written without a terminal, a failed `worker init` keeps nothing it
 * wrote, re-runs are no-ops, and every failure carries a `code`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  initExitCode,
  runNonInteractiveWorkerInit,
  wrongQueryLanguage,
} from "../src/lib/init/worker-init-noninteractive";
import type {
  NonInteractiveInitArgs,
  NonInteractiveInitDeps,
  NonInteractiveInitReport,
} from "../src/lib/init/worker-init-noninteractive";
import { renderNonInteractiveReport } from "../src/lib/init/worker-init-noninteractive-text";
import {
  buildWorkerDoctorReport,
  installAgentStep,
  setupStateFor,
} from "../src/lib/observability/readiness-json";
import { classifyPushDryRun, gitPushDryRun } from "../src/lib/observability/repo-push-probe";
import { entitlementCheck } from "../src/lib/observability/worker-entitlement";
import { collectWorkerDoctorChecks } from "../src/lib/observability/worker-readiness";
import type { WorkerDoctorDeps } from "../src/lib/observability/worker-readiness";
import { SERVICE_MANAGED_MARKER, systemdUnitPath } from "../src/lib/worker/service";
import type { RunCommandFn, WorkerServiceDeps } from "../src/lib/worker/service";
import { runServiceAction } from "../src/lib/worker/service-command";
import type { ServiceCommandArgs } from "../src/lib/worker/service-command";
import { writeWorkerLifecycle } from "../src/lib/worker/lifecycle";

const GITHUB_ENV = { GITHUB_TOKEN: "ghp_headlessContractSecret0123456789" };

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: "ignore" });
}

function doctorStubs(overrides: WorkerDoctorDeps = {}): WorkerDoctorDeps {
  return {
    dryRunQuery: async () => 2,
    checkRepoAccess: async () => ({ ok: true, detail: "GitHub acme/app readable and writable" }),
    checkEntitlement: async () => ({ valid: true, source: "license-key", message: "ok" }),
    checkHarness: async () => ({ id: "harness", label: "Agent harness", status: "ok" }),
    checkSandbox: async () => ({ id: "sandbox", label: "Agent sandbox", status: "ok" }),
    checkGitIdentity: async () => ({ id: "git-identity", label: "Git identity", status: "ok" }),
    isPortInUse: async () => false,
    workerStatus: () => ({ status: "stopped" }),
    notificationChannelDeps: undefined,
    ...overrides,
  };
}

/** Every step has the shared shape, and nothing in it waits for a terminal. */
function expectHeadlessSteps(report: {
  nextSteps: { id: string; message: string; command: string }[];
}) {
  for (const step of report.nextSteps) {
    expect(typeof step.id).toBe("string");
    expect(step.id.length).toBeGreaterThan(0);
    expect(step.message.length).toBeGreaterThan(0);
    expect(step.command.length).toBeGreaterThan(0);
    if (/devintern worker login\b/.test(step.command) && !step.command.includes("--complete")) {
      expect(step.command).toContain("--no-wait");
    }
    if (/devintern worker connect\b/.test(step.command))
      expect(step.command).toMatch(/--no-wait|--status/);
    // The foreground worker blocks; it is only ever named as an alternative.
    expect(step.command).not.toMatch(/(^|&& )devintern worker$/);
    expect(step.command).not.toBe("devintern worker doctor");
  }
}

describe("worker init --non-interactive (headless contract)", () => {
  let root: string;
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worker-headless-"));
    workspaceDir = join(root, "workspace");
    repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init -q -b main");
    git(repoDir, "remote add origin https://github.com/acme/app.git");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(
    args: Partial<NonInteractiveInitArgs>,
    deps: Partial<NonInteractiveInitDeps> & { doctorOverrides?: WorkerDoctorDeps } = {},
  ): Promise<NonInteractiveInitReport> {
    const { doctorOverrides, ...rest } = deps;
    return runNonInteractiveWorkerInit(
      { repoFromCwd: true, json: true, yes: false, ...args },
      {
        cwd: repoDir,
        workspaceDir,
        home: root,
        processEnv: { ...GITHUB_ENV },
        probe: async () => {},
        probeTimeoutMs: 2_000,
        which: () => null,
        doctor: doctorStubs(doctorOverrides),
        ...rest,
      },
    );
  }

  const GITHUB_ARGS = { tracker: "github", taskQuery: "is:open label:devintern" };

  test("a re-run with the same flags is unchanged (exit 0) without --yes", async () => {
    const first = await run(GITHUB_ARGS);
    expect(first.result).toBe("success");
    expect(first.changed).toBe(true);
    const config = readFileSync(join(workspaceDir, "workspace.toml"), "utf8");

    const again = await run(GITHUB_ARGS);
    expect(again.error).toBeUndefined();
    expect(again.result).toBe("unchanged");
    expect(initExitCode(again.result)).toBe(0);
    expect(again.changed).toBe(false);
    expect(again.persisted).toBe(true);
    expect(again.filesWritten).toEqual([]);
    expect(readFileSync(join(workspaceDir, "workspace.toml"), "utf8")).toBe(config);
    expect(renderNonInteractiveReport(again).join("\n")).toContain("Worker setup unchanged");
    expectHeadlessSteps(again);
  });

  test("different flags on an existing workspace need --yes: code and the exact update command", async () => {
    await run(GITHUB_ARGS);
    const changed = await run({ ...GITHUB_ARGS, taskQuery: "is:open label:other" });
    expect(changed.result).toBe("failure");
    expect(changed.code).toBe("workspace_exists");
    expect(changed.nextSteps).toEqual([
      {
        id: "update",
        message: expect.any(String),
        command: `cd ${repoDir} && DEVINTERN_WORKSPACE_DIR=${workspaceDir} devintern worker init --non-interactive --tracker github --task-query 'is:open label:other' --repo-from-cwd --yes --json`,
      },
    ]);
  });

  test("a query the tracker rejects is not saved, and the previous query is restored", async () => {
    await run(GITHUB_ARGS);
    const configPath = join(workspaceDir, "workspace.toml");
    const before = readFileSync(configPath, "utf8");
    const rejected = await run(
      { ...GITHUB_ARGS, taskQuery: "is:open label:devintern sort:nonsense", yes: true },
      {
        doctorOverrides: {
          dryRunQuery: async () => {
            throw new Error("GitHub API error 422: Validation Failed");
          },
        },
      },
    );
    expect(rejected.result).toBe("failure");
    expect(rejected.code).toBe("query_rejected");
    expect(rejected.persisted).toBe(false);
    expect(rejected.filesWritten).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    const fix = rejected.nextSteps.find((step) => step.id === "fix-query");
    expect(fix?.command).toContain("--task-query '<query>'");
    expect(fix?.command).toContain("--yes --json");
    expectHeadlessSteps(rejected);
  });

  test("a failed first run leaves no workspace.toml or .env behind", async () => {
    const failed = await run(GITHUB_ARGS, {
      probe: async () => {
        throw new Error("GitHub API error 401: Bad credentials");
      },
    });
    expect(failed.result).toBe("failure");
    expect(failed.code).toBe("credentials_rejected");
    expect(existsSync(join(workspaceDir, "workspace.toml"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".env"))).toBe(false);
    expect(failed.warnings.join("\n")).toContain("Nothing was saved");
    const fix = failed.nextSteps.find((step) => step.id === "fix-credentials");
    expect(fix?.command).toContain("--env-file <path>");
    // The re-run needs no --yes: nothing exists yet.
    const retry = await run(GITHUB_ARGS);
    expect(retry.result).toBe("success");
    expect(JSON.stringify(failed)).not.toContain(GITHUB_ENV.GITHUB_TOKEN);
  });

  test("a Jira-style query for the github tracker is rejected with a hint, nothing written", async () => {
    const report = await run({ tracker: "github", taskQuery: "project = APP AND labels = ai" });
    expect(report.result).toBe("failure");
    expect(report.code).toBe("invalid_query");
    expect(report.error).toContain("looks like Jira JQL");
    expect(report.error).toContain("is:open label:devintern");
    expect(existsSync(join(workspaceDir, "workspace.toml"))).toBe(false);
    expect(report.nextSteps[0]).toMatchObject({ id: "fix-query" });
  });

  test("wrongQueryLanguage only flags JQL-shaped queries for github", () => {
    for (const query of [
      "project = APP",
      "status != Done",
      "labels in (ai)",
      "is:open ORDER BY created",
    ]) {
      expect(wrongQueryLanguage("github", query)).toBeDefined();
    }
    for (const query of [
      "is:open label:devintern",
      "is:issue is:open assignee:@me",
      "repo:a/b fix",
    ]) {
      expect(wrongQueryLanguage("github", query)).toBeUndefined();
    }
    expect(wrongQueryLanguage("jira", "project = APP")).toBeUndefined();
  });

  test("missing input has code missing_input and the missing list", async () => {
    const report = await run({ tracker: "github" }, { processEnv: {} });
    expect(report.code).toBe("missing_input");
    expect(report.missing).toEqual(["--task-query", "GITHUB_TOKEN"]);
  });

  test("the --env-file is left in place with a note, or removed with --remove-env-file", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(envFile, `GITHUB_TOKEN=${GITHUB_ENV.GITHUB_TOKEN}\n`, { mode: 0o600 });
    const kept = await run({ ...GITHUB_ARGS, envFile }, { processEnv: {} });
    expect(kept.result).toBe("success");
    expect(existsSync(envFile)).toBe(true);
    expect(kept.warnings.join("\n")).toContain(`${envFile} still holds the credentials`);
    expect(kept.warnings.join("\n")).toContain("--remove-env-file");

    const removed = await run(
      { ...GITHUB_ARGS, envFile, removeEnvFile: true, yes: true },
      { processEnv: {} },
    );
    expect(removed.result).toBe("unchanged");
    expect(removed.envFileRemoved).toBe(true);
    expect(existsSync(envFile)).toBe(false);
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toContain("GITHUB_TOKEN=");
  });

  test("a failed run never removes the --env-file", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(envFile, `GITHUB_TOKEN=${GITHUB_ENV.GITHUB_TOKEN}\n`, { mode: 0o600 });
    const failed = await run(
      { ...GITHUB_ARGS, envFile, removeEnvFile: true },
      {
        processEnv: {},
        probe: async () => {
          throw new Error("401");
        },
      },
    );
    expect(failed.result).toBe("failure");
    expect(existsSync(envFile)).toBe(true);
    expect(failed.envFileRemoved).toBeUndefined();
  });

  test("--repo-from-cwd records the remote's default branch and warns about another checkout branch", async () => {
    const remote = join(root, "remote.git");
    execSync(`git init -q --bare -b trunk ${remote}`);
    git(repoDir, `commit -q --allow-empty -m init`);
    git(repoDir, `remote set-url origin ${remote}`);
    git(repoDir, "push -q origin main:trunk");
    git(repoDir, "fetch -q origin");
    git(repoDir, "remote set-head origin trunk");
    git(repoDir, "switch -q -c feature/x");
    const report = await run(
      { tracker: "jira", taskQuery: "project = APP" },
      {
        processEnv: {
          JIRA_BASE_URL: "https://acme.atlassian.net",
          JIRA_EMAIL: "bot@acme.test",
          JIRA_API_TOKEN: "jira-secret-token",
        },
      },
    );
    expect(report.repo).toMatchObject({ added: true, defaultBranch: "trunk", branch: "feature/x" });
    expect(readFileSync(join(workspaceDir, "workspace.toml"), "utf8")).toContain(
      'default_branch = "trunk"',
    );
    expect(report.warnings.join("\n")).toContain("--pr-target-branch feature/x");
  });

  test("DEVINTERN_SKIP_LICENSE_CHECK in the workspace .env gives the same verdict as doctor", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, ".env"), "DEVINTERN_SKIP_LICENSE_CHECK=1\n", { mode: 0o600 });
    const { checkEntitlement: _unused, ...stubs } = doctorStubs();
    const report = await runNonInteractiveWorkerInit(
      { repoFromCwd: true, json: true, yes: false, ...GITHUB_ARGS },
      {
        cwd: repoDir,
        workspaceDir,
        home: root,
        processEnv: { ...GITHUB_ENV },
        probe: async () => {},
        which: () => null,
        doctor: stubs,
      },
    );
    expect(report.checks.find((check) => check.name === "entitlement")).toMatchObject({
      status: "pass",
      message: expect.stringContaining("skipped (DEVINTERN_SKIP_LICENSE_CHECK=1"),
    });
    expect(report.result).toBe("success");
  });

  test("a missing agent on a host without npm gets an installer that needs no npm", async () => {
    const report = await run(GITHUB_ARGS, {
      doctorOverrides: {
        checkHarness: async () => ({
          id: "harness",
          label: "Agent harness",
          status: "fail",
          detail: "claude-code: not found",
        }),
      },
    });
    const step = report.nextSteps.find((s) => s.id === "install-agent");
    expect(step?.command).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(step?.message).toContain("A person must sign it in");
    // A host problem keeps the configuration, so doctor confirms the fix.
    expect(step?.message).toContain("devintern worker doctor --json");
    expect(report.persisted).toBe(true);
    expect(existsSync(join(workspaceDir, "workspace.toml"))).toBe(true);
    expect(report.code).toBe("agent_missing");
    expectHeadlessSteps(report);
  });
});

describe("shared readiness helpers", () => {
  test("installAgentStep prefers npm when present, then a standalone installer, then bun", () => {
    const npm = () => "/usr/bin/npm";
    const none = () => null;
    expect(installAgentStep({}, { which: npm }).command).toBe(
      "npm install -g @anthropic-ai/claude-code",
    );
    expect(installAgentStep({}, { which: none }).command).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
    expect(installAgentStep({ AGENT_HARNESS: "codex" }, { which: none }).command).toBe(
      "bun install -g @openai/codex",
    );
  });

  test("setupStateFor is the explicit done signal", () => {
    expect(setupStateFor([{ id: "repo", label: "Repo", status: "ok" }]).setup).toBe("ready");
    expect(
      setupStateFor([
        { id: "repo", label: "Repo", status: "ok" },
        { id: "worker", label: "Worker", status: "ok", detail: "running (pid 7)" },
      ]),
    ).toEqual({
      setup: "complete",
      summary: "every check passed and the worker is running (pid 7).",
    });
    expect(setupStateFor([{ id: "entitlement", label: "E", status: "action" }]).setup).toBe(
      "action_required",
    );
    expect(setupStateFor([{ id: "repo", label: "Repo", status: "fail" }])).toEqual({
      setup: "not_ready",
      summary: "1 check failed (Repo).",
    });
  });

  test("the skipped license check is labelled as skipped, not as a LICENSE_KEY", () => {
    const row = entitlementCheck(
      { valid: true, source: "license-key", message: "skipped", skipped: true },
      "devintern worker login",
      "hint",
    );
    expect(row.detail).toContain("DEVINTERN_SKIP_LICENSE_CHECK=1");
    expect(row.detail).not.toContain("LICENSE_KEY (");
  });
});

describe("dry-run push probe", () => {
  test("classifies GitHub's denial and acceptance", () => {
    expect(classifyPushDryRun(true, "")).toEqual({ status: "ok" });
    expect(
      classifyPushDryRun(
        false,
        "remote: Permission to torvalds/linux.git denied to someone.\nfatal: unable to access 'https://github.com/torvalds/linux.git/': The requested URL returned error: 403\n",
      ),
    ).toEqual({
      status: "denied",
      reason: "remote: Permission to torvalds/linux.git denied to someone.",
    });
    expect(
      classifyPushDryRun(false, "fatal: unable to access: Could not resolve host"),
    ).toMatchObject({ status: "unknown" });
  });

  test("never creates a ref on the remote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "push-probe-"));
    try {
      const remote = join(dir, "remote.git");
      execSync(`git init -q --bare ${remote}`);
      const outcome = await gitPushDryRun(remote, () => ({ ...process.env }), 10_000);
      expect(outcome.status).not.toBe("denied");
      expect(execSync(`git -C ${remote} for-each-ref`).toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worker service install (idempotent)", () => {
  let workspaceDir: string;
  let home: string;
  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "headless-service-ws-"));
    home = mkdtempSync(join(tmpdir(), "headless-service-home-"));
  });
  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const args: ServiceCommandArgs = {
    action: "install",
    json: true,
    force: false,
    waitMs: 1_000,
    lines: 100,
  };

  function systemd(active: () => boolean): { deps: WorkerServiceDeps; commands: string[][] } {
    const commands: string[][] = [];
    const run: RunCommandFn = async (command, argv) => {
      commands.push([command, ...argv]);
      if (argv.includes("is-active") || argv.includes("is-enabled")) {
        return { status: active() ? 0 : 3, stdout: "", stderr: "" };
      }
      if (argv.includes("show")) {
        return {
          status: 0,
          stdout: `ActiveState=${active() ? "active" : "inactive"}\n`,
          stderr: "",
        };
      }
      if (command === "loginctl") return { status: 0, stdout: "yes\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { deps: { platform: "linux", homedir: home, username: "tester", run }, commands };
  }

  const definition = {
    execPath: "/usr/local/bin/devintern",
    runtimePath: "/usr/local/bin/bun",
    environmentPath: "/usr/bin",
  };

  test("an up-to-date, running service is not restarted", async () => {
    let active = false;
    const first = systemd(() => active);
    const installed = await runServiceAction(args, {
      workspaceDir,
      service: first.deps,
      collectReadiness: async () => [],
      ...definition,
      waitForStart: async () => {
        active = true;
        return { state: "running", pid: process.pid };
      },
    });
    expect(installed.result).toBe("running");
    expect(readFileSync(systemdUnitPath(home), "utf8")).toContain(SERVICE_MANAGED_MARKER);

    // A live worker: started record plus a lock owned by this process.
    writeWorkerLifecycle(workspaceDir, { state: "started" });
    const now = new Date().toISOString();
    writeFileSync(
      join(workspaceDir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: now, heartbeatAt: now }),
    );
    const second = systemd(() => true);
    const again = await runServiceAction(args, {
      workspaceDir,
      service: second.deps,
      collectReadiness: async () => [],
      ...definition,
      waitForStart: async () => {
        throw new Error("must not wait: nothing was started");
      },
    });
    expect(again).toMatchObject({ result: "running", updated: false, unchanged: true });
    expect(second.commands.some((c) => c.includes("restart") || c.includes("daemon-reload"))).toBe(
      false,
    );
  });

  test("a changed definition is still updated and restarted", async () => {
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(
      systemdUnitPath(home),
      `# ${SERVICE_MANAGED_MARKER}\n[Service]\nExecStart=/old\n`,
    );
    const { deps, commands } = systemd(() => true);
    const report = await runServiceAction(args, {
      workspaceDir,
      service: deps,
      collectReadiness: async () => [],
      ...definition,
      waitForStart: async () => ({ state: "running", pid: 1 }),
    });
    expect(report).toMatchObject({ result: "running", updated: true });
    expect(report.unchanged).toBeUndefined();
    expect(commands).toContainEqual(["systemctl", "--user", "restart", "devintern-worker"]);
  });

  test("status of a missing service offers the install step; failures carry a code", async () => {
    const { deps } = systemd(() => false);
    const status = await runServiceAction(
      { ...args, action: "status" },
      { workspaceDir, service: deps },
    );
    expect(status.result).toBe("not_installed");
    expect(status.nextSteps).toEqual([
      {
        id: "service",
        message: expect.any(String),
        command: `DEVINTERN_WORKSPACE_DIR=${workspaceDir} devintern worker service install --json`,
      },
    ]);
    const refused = await runServiceAction(args, {
      workspaceDir,
      service: deps,
      collectReadiness: async () => [
        { id: "query", label: "Task query", status: "fail", detail: "422" },
      ],
    });
    expect(refused).toMatchObject({ result: "refused", code: "query_rejected" });
    expect(refused.nextSteps.every((step) => step.id && step.message && step.command)).toBe(true);
  });
});

describe("worker doctor repository row for a read-only token", () => {
  test("names the push fix as the hint, and the fix step does not repeat it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-doctor-"));
    try {
      writeFileSync(
        join(dir, "workspace.toml"),
        '[defaults]\ntracker = "markdown"\ntask_query = "status=todo"\n\n[[repos]]\nname = "app"\nremote = "https://github.com/acme/app.git"\n',
      );
      writeFileSync(join(dir, ".env"), `MARKDOWN_TASKS_DIR=${dir}\n`, { mode: 0o600 });
      const checks = await collectWorkerDoctorChecks(
        { workspacePath: join(dir, "workspace.toml") },
        {
          ...doctorStubs({
            checkRepoAccess: async () => ({
              ok: false,
              reason:
                "GITHUB_TOKEN can read acme/app but cannot push branches or open pull requests",
            }),
          }),
          processEnv: {},
        },
      );
      const repo = checks.find((check) => check.id === "repo");
      expect(repo?.status).toBe("fail");
      expect(repo?.hint).toContain("Contents and Pull requests read and write");
      const report = buildWorkerDoctorReport(checks, {
        workspaceDir: dir,
        offline: false,
        env: {},
        home: dir,
      });
      expect(report.code).toBe("repo_access_denied");
      const fix = report.nextSteps.find((step) => step.id === "fix-repo-access");
      expect(fix?.url).toBe("https://github.com/settings/personal-access-tokens");
      expect(fix?.message.split("Contents and Pull requests").length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
