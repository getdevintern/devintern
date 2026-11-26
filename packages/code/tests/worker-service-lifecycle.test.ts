/**
 * Worker service lifecycle: the lifecycle record, permanent startup failures,
 * the honest start check, `worker service` actions, and what `worker status`
 * reports after a clean stop or a failed start.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  claimSignalHandling,
  isSignalHandlingClaimed,
  resetShutdownState,
} from "../src/lib/cli/shutdown-state";
import { resolveWorkerStatus } from "../src/lib/observability/dashboard-api";
import { WorkerState } from "../src/lib/state/worker-state";
import { workspaceDbPath, workspaceStateDir } from "../src/lib/workspace/paths";
import { runWorkerReadCommand } from "../src/lib/worker/dashboard-read-cli";
import {
  parseWorkerLifecycleRecord,
  readWorkerLifecycle,
  summarizeStartupFailure,
  writeWorkerLifecycle,
} from "../src/lib/worker/lifecycle";
import {
  SERVICE_MANAGED_MARKER,
  launchdAgentPath,
  systemdUnitPath,
} from "../src/lib/worker/service";
import type { RunCommandFn, WorkerServiceDeps } from "../src/lib/worker/service";
import {
  deriveRunState,
  parseLaunchctlPrint,
  parseSystemdShow,
  queryWorkerService,
  restartWorkerService,
  startWorkerService,
  stopWorkerService,
  uninstallWorkerService,
  waitForWorkerStart,
} from "../src/lib/worker/service-control";
import {
  parseServiceArgs,
  runServiceAction,
  runWorkerServiceCommand,
  serviceExitCode,
} from "../src/lib/worker/service-command";
import type { ServiceCommandArgs } from "../src/lib/worker/service-command";
import {
  WORKER_CONFIG_EXIT_CODE,
  isPermanentLicenseDenial,
  permanentStartupExitCode,
} from "../src/lib/worker/startup";

const ok = { status: 0, stdout: "", stderr: "" };

let workspaceDir: string;
let home: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "worker-lifecycle-ws-"));
  home = mkdtempSync(join(tmpdir(), "worker-lifecycle-home-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A live worker lock owned by this test process. */
function writeLiveLock(startedAt = new Date().toISOString()): void {
  writeFileSync(
    join(workspaceDir, ".worker.lock"),
    JSON.stringify({ pid: process.pid, timestamp: startedAt, heartbeatAt: startedAt }),
  );
}

/** Installed systemd unit in the fake home plus a scripted `systemctl`. */
function linuxService(
  respond: (args: string[]) => { status: number; stdout: string; stderr: string } | undefined,
): { deps: WorkerServiceDeps; commands: string[][] } {
  const unitPath = systemdUnitPath(home);
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(unitPath, `# ${SERVICE_MANAGED_MARKER}\n[Service]\n`);
  const commands: string[][] = [];
  const run: RunCommandFn = async (command, args) => {
    commands.push([command, ...args]);
    return respond([command, ...args]) ?? ok;
  };
  return { deps: { platform: "linux", homedir: home, username: "tester", run }, commands };
}

describe("lifecycle record", () => {
  test("round-trips and rejects malformed records", () => {
    writeWorkerLifecycle(workspaceDir, { state: "stopped", exitCode: 0 });
    const record = readWorkerLifecycle(workspaceDir);
    expect(record).toMatchObject({ state: "stopped", exitCode: 0, pid: process.pid });
    expect(parseWorkerLifecycleRecord({ state: "nope", pid: 1, at: "x" })).toBeNull();
    expect(
      parseWorkerLifecycleRecord({ state: "started", pid: "1", at: new Date().toISOString() }),
    ).toBeNull();
    writeFileSync(join(workspaceDir, ".worker.lifecycle.json"), "{not json");
    expect(readWorkerLifecycle(workspaceDir)).toBeNull();
  });

  test("summarizes a license failure as one line", () => {
    expect(
      summarizeStartupFailure(
        "❌ License check failed\n   Run `devintern worker login` to start your Pilot.\n   The worker will not retry",
      ),
    ).toBe("License check failed: Run `devintern worker login` to start your Pilot.");
    expect(summarizeStartupFailure("  \n")).toBeUndefined();
  });
});

describe("permanent startup failures", () => {
  test("sign-in and license denials are permanent; network failures are not", () => {
    expect(isPermanentLicenseDenial({ valid: false, message: "x", signInRequired: true })).toBe(
      true,
    );
    expect(
      isPermanentLicenseDenial({ valid: false, message: "License key is invalid or revoked." }),
    ).toBe(true);
    expect(
      isPermanentLicenseDenial({
        valid: false,
        message: "Your account has no matching license for this product. Set LICENSE_KEY ...",
      }),
    ).toBe(true);
    expect(
      isPermanentLicenseDenial({
        valid: false,
        message: "License validation failed: fetch failed",
      }),
    ).toBe(false);
    expect(
      isPermanentLicenseDenial({
        valid: false,
        message: "License entitlement check failed: HTTP 503.",
      }),
    ).toBe(false);
    expect(isPermanentLicenseDenial({ valid: true, message: "ok" })).toBe(false);
  });

  test("exit 78 everywhere except launchd, which has no RestartPreventExitStatus", () => {
    expect(WORKER_CONFIG_EXIT_CODE).toBe(78);
    expect(permanentStartupExitCode({})).toBe(78);
    expect(permanentStartupExitCode({ DEVINTERN_SERVICE_MANAGER: "launchd" })).toBe(0);
  });
});

describe("startup guard (real process exits)", () => {
  const startupModule = join(import.meta.dir, "../src/lib/worker/startup.ts");

  async function runScript(body: string, env: Record<string, string> = {}): Promise<number> {
    const script = join(workspaceDir, "guard.ts");
    writeFileSync(
      script,
      `import * as startup from ${JSON.stringify(startupModule)};\nconst dir = ${JSON.stringify(workspaceDir)};\n${body}\n`,
    );
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, ...env },
      stdout: "ignore",
      stderr: "ignore",
    });
    return child.exited;
  }

  test("an exit before the worker started records the last error lines", async () => {
    const code = await runScript(
      'startup.armWorkerStartupGuard(dir);\nconsole.error("❌ No repos configured");\nprocess.exit(1);',
    );
    expect(code).toBe(1);
    expect(readWorkerLifecycle(workspaceDir)).toMatchObject({
      state: "startup_failed",
      exitCode: 1,
      message: "❌ No repos configured",
    });
    expect(readWorkerLifecycle(workspaceDir)?.permanent).toBeUndefined();
  });

  test("a permanent failure exits 78 so systemd stops retrying", async () => {
    const code = await runScript(
      'startup.armWorkerStartupGuard(dir);\nconsole.error("❌ License check failed");\nstartup.exitWorkerStartupPermanently("   fix it");',
    );
    expect(code).toBe(78);
    expect(readWorkerLifecycle(workspaceDir)).toMatchObject({
      state: "startup_failed",
      exitCode: 78,
      permanent: true,
      message: "❌ License check failed\n   fix it",
    });
  });

  test("under launchd a permanent failure exits 0 but is still recorded as failed", async () => {
    const code = await runScript(
      'startup.armWorkerStartupGuard(dir);\nconsole.error("❌ License check failed");\nstartup.exitWorkerStartupPermanently();',
      { DEVINTERN_SERVICE_MANAGER: "launchd" },
    );
    expect(code).toBe(0);
    expect(readWorkerLifecycle(workspaceDir)).toMatchObject({
      state: "startup_failed",
      exitCode: 0,
      permanent: true,
    });
  });

  test("a started worker's later exit is not a startup failure", async () => {
    const code = await runScript(
      "startup.armWorkerStartupGuard(dir);\nstartup.markWorkerStarted(dir);\nprocess.exit(1);",
    );
    expect(code).toBe(1);
    expect(readWorkerLifecycle(workspaceDir)?.state).toBe("started");
  });
});

describe("signal ownership", () => {
  afterEach(() => resetShutdownState());

  test("the worker claims SIGINT/SIGTERM from the CLI entry point", () => {
    expect(isSignalHandlingClaimed()).toBe(false);
    claimSignalHandling();
    expect(isSignalHandlingClaimed()).toBe(true);
  });
});

describe("worker status after the worker exits", () => {
  test("no lock and no record stays unknown", () => {
    expect(resolveWorkerStatus(workspaceDir)).toEqual({ status: "unknown" });
  });

  test("a clean stop reports stopped with when", () => {
    writeWorkerLifecycle(workspaceDir, {
      state: "stopped",
      exitCode: 0,
      at: "2026-11-26T10:00:00.000Z",
    });
    expect(resolveWorkerStatus(workspaceDir)).toEqual({
      status: "stopped",
      lastExit: { outcome: "stopped", at: "2026-11-26T10:00:00.000Z", exitCode: 0 },
    });
    const text = captureRead(["--workspace", workspaceDir]);
    expect(text).toContain("Worker:     stopped (clean stop at 2026-11-26T10:00:00.000Z)");
  });

  test("a failed start reports stopped with the reason", () => {
    writeWorkerLifecycle(workspaceDir, {
      state: "startup_failed",
      exitCode: 78,
      permanent: true,
      at: "2026-11-26T10:00:00.000Z",
      message: "❌ License check failed\n   Run `devintern worker login github` to start.",
    });
    const status = resolveWorkerStatus(workspaceDir);
    expect(status).toMatchObject({
      status: "stopped",
      lastExit: { outcome: "startup_failed", exitCode: 78, permanent: true },
    });
    // A worker that never got past its license check has no database yet;
    // `worker status` must still say why it is stopped.
    const text = captureRead(["--workspace", workspaceDir], { withDb: false });
    expect(text).toContain(
      "Worker:     stopped (failed to start at 2026-11-26T10:00:00.000Z: License check failed: Run `devintern worker login github` to start.)",
    );
    expect(text).toContain("(missing)");
    expect(existsSync(workspaceStateDir(workspaceDir))).toBe(false);
  });

  test("a dead lock ignores an exit recorded before that worker started", () => {
    writeWorkerLifecycle(workspaceDir, {
      state: "stopped",
      exitCode: 0,
      at: "2026-11-01T00:00:00.000Z",
    });
    writeFileSync(
      join(workspaceDir, ".worker.lock"),
      JSON.stringify({ pid: 999_999_999, timestamp: "2026-11-26T00:00:00.000Z" }),
    );
    const status = resolveWorkerStatus(workspaceDir);
    expect(status.status).toBe("stopped");
    expect(status.lastExit).toBeUndefined();
  });
});

function captureRead(args: string[], options: { withDb?: boolean } = {}): string {
  writeFileSync(join(workspaceDir, "workspace.toml"), '[defaults]\ntracker = "markdown"\n');
  if (options.withDb !== false) {
    mkdirSync(workspaceStateDir(workspaceDir), { recursive: true });
    new WorkerState(workspaceDbPath(workspaceDir)).close();
  }
  let out = "";
  runWorkerReadCommand("status", args, {
    stdout: (text) => (out += text),
    stderr: (text) => (out += text),
  });
  return out;
}

describe("service manager views", () => {
  test("parses systemctl show and launchctl print", () => {
    expect(
      parseSystemdShow(
        "ActiveState=activating\nSubState=auto-restart\nResult=exit-code\nExecMainStatus=1\nNRestarts=4\nMainPID=0\n",
      ),
    ).toEqual({
      activeState: "activating",
      subState: "auto-restart",
      result: "exit-code",
      execMainStatus: 1,
      restarts: 4,
    });
    expect(parseLaunchctlPrint("\tstate = running\n\tpid = 812\n\tlast exit code = 78\n")).toEqual({
      loaded: true,
      activeState: "running",
      mainPid: 812,
      lastExitCode: 78,
    });
  });

  test("maps manager and worker state to one honest word", () => {
    const up = { status: "running" as const };
    const down = { status: "stopped" as const };
    expect(deriveRunState("linux", { activeState: "active" }, up, null)).toBe("running");
    expect(deriveRunState("linux", { activeState: "active" }, down, null)).toBe("starting");
    expect(
      deriveRunState("linux", { activeState: "activating", subState: "auto-restart" }, down, null),
    ).toBe("restarting");
    expect(deriveRunState("linux", { activeState: "failed" }, down, null)).toBe("failed");
    expect(deriveRunState("linux", { activeState: "inactive" }, down, null)).toBe("stopped");
    const failedRecord = {
      state: "startup_failed" as const,
      pid: 1,
      at: new Date().toISOString(),
      permanent: true,
    };
    expect(deriveRunState("darwin", { loaded: true, lastExitCode: 0 }, down, failedRecord)).toBe(
      "failed",
    );
    expect(deriveRunState("darwin", { loaded: false }, down, null)).toBe("stopped");
  });
});

describe("waitForWorkerStart", () => {
  const fastClock = () => {
    let now = Date.now();
    return { now: () => now, sleep: async (ms: number) => void (now += ms) };
  };

  test("running needs this start's started record and a live lock", async () => {
    const since = Date.now();
    writeWorkerLifecycle(workspaceDir, { state: "started", at: new Date(since + 5).toISOString() });
    writeLiveLock();
    const { deps } = linuxService(() => ({
      status: 0,
      stdout: "ActiveState=active\n",
      stderr: "",
    }));
    const result = await waitForWorkerStart({ workspaceDir, since, ...fastClock() }, deps);
    expect(result).toEqual({ state: "running", pid: process.pid });
  });

  test("a previous worker's started record does not count", async () => {
    const since = Date.now();
    writeWorkerLifecycle(workspaceDir, {
      state: "started",
      at: new Date(since - 10).toISOString(),
    });
    writeLiveLock();
    const { deps } = linuxService(() => ({
      status: 0,
      stdout: "ActiveState=active\n",
      stderr: "",
    }));
    const result = await waitForWorkerStart(
      { workspaceDir, since, timeoutMs: 2_000, ...fastClock() },
      deps,
    );
    expect(result.state).toBe("starting");
  });

  test("a permanent startup failure is reported with its log lines", async () => {
    const since = Date.now();
    writeFileSync(
      join(workspaceDir, "worker.stderr.log"),
      `${new Date(since + 1).toISOString()} ❌ License check failed\n${new Date(since + 2).toISOString()}    Run \`devintern worker login github\`\n`,
    );
    writeWorkerLifecycle(workspaceDir, {
      state: "startup_failed",
      exitCode: 78,
      permanent: true,
      at: new Date(since + 3).toISOString(),
      message: "❌ License check failed\n   Run `devintern worker login github`",
    });
    const { deps } = linuxService(() => ({
      status: 0,
      stdout: "ActiveState=failed\n",
      stderr: "",
    }));
    const result = await waitForWorkerStart({ workspaceDir, since, ...fastClock() }, deps);
    expect(result).toEqual({
      state: "failed",
      reason: "License check failed: Run `devintern worker login github`",
      permanent: true,
      logLines: ["❌ License check failed", "Run `devintern worker login github`"],
    });
  });

  test("a crash loop (auto-restart) is a retrying failure", async () => {
    const { deps } = linuxService(() => ({
      status: 0,
      stdout: "ActiveState=activating\nSubState=auto-restart\nExecMainStatus=1\n",
      stderr: "",
    }));
    const result = await waitForWorkerStart(
      { workspaceDir, since: Date.now(), ...fastClock() },
      deps,
    );
    expect(result).toMatchObject({
      state: "failed",
      permanent: false,
      reason: "the worker exited with status 1; systemd will retry it",
    });
  });
});

describe("service actions", () => {
  test("start clears a failed state first; stop and restart use systemctl", async () => {
    const { deps, commands } = linuxService(() => undefined);
    expect(await startWorkerService(deps)).toEqual({ ok: true });
    expect(await stopWorkerService(deps)).toEqual({ ok: true });
    expect(await restartWorkerService(deps)).toEqual({ ok: true });
    expect(commands).toEqual([
      ["systemctl", "--user", "reset-failed", "devintern-worker"],
      ["systemctl", "--user", "start", "devintern-worker"],
      ["systemctl", "--user", "stop", "devintern-worker"],
      ["systemctl", "--user", "reset-failed", "devintern-worker"],
      ["systemctl", "--user", "restart", "devintern-worker"],
    ]);
  });

  test("uninstall disables, removes the unit, and is idempotent", async () => {
    const { deps, commands } = linuxService(() => undefined);
    expect(await uninstallWorkerService(deps)).toEqual({ ok: true });
    expect(commands[0]).toEqual(["systemctl", "--user", "disable", "--now", "devintern-worker"]);
    expect(commands).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(await uninstallWorkerService(deps)).toEqual({ ok: true, unchanged: true });
    // Stopping a service that is not installed is a no-op, not an error.
    expect(await stopWorkerService(deps)).toEqual({ ok: true, unchanged: true });
  });

  test("uninstall refuses a hand-written unit", async () => {
    const { deps } = linuxService(() => undefined);
    writeFileSync(systemdUnitPath(home), "[Service]\nExecStart=/opt/custom\n");
    const result = await uninstallWorkerService(deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("custom service definition");
    expect(readFileSync(systemdUnitPath(home), "utf8")).toContain("/opt/custom");
  });

  test("macOS stop unloads the agent so KeepAlive cannot restart it", async () => {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(launchdAgentPath(home), `<!-- ${SERVICE_MANAGED_MARKER} -->`);
    const commands: string[][] = [];
    const deps: WorkerServiceDeps = {
      platform: "darwin",
      homedir: home,
      uid: 501,
      run: async (command, args) => {
        commands.push([command, ...args]);
        return args[0] === "print" ? { status: 0, stdout: "state = running\n", stderr: "" } : ok;
      },
    };
    expect(await stopWorkerService(deps)).toEqual({ ok: true });
    expect(commands).toContainEqual(["launchctl", "bootout", "gui/501/com.devintern.worker"]);
  });

  test("status reads the unit, the worker lock, and the last exit", async () => {
    writeWorkerLifecycle(workspaceDir, {
      state: "startup_failed",
      exitCode: 78,
      permanent: true,
      message: "❌ License check failed",
    });
    const { deps } = linuxService((args) =>
      args.includes("show")
        ? {
            status: 0,
            stdout: "ActiveState=failed\nResult=exit-code\nExecMainStatus=78\n",
            stderr: "",
          }
        : undefined,
    );
    const status = await queryWorkerService(workspaceDir, deps);
    expect(status).toMatchObject({
      state: "failed",
      installed: true,
      managed: true,
      enabled: true,
      manager: { activeState: "failed", execMainStatus: 78 },
      lastExit: { state: "startup_failed", permanent: true },
    });
  });
});

describe("devintern worker service", () => {
  const baseArgs = (overrides: Partial<ServiceCommandArgs> = {}): ServiceCommandArgs => ({
    action: "install",
    json: true,
    force: false,
    waitMs: 1_000,
    lines: 100,
    ...overrides,
  });

  /** systemd fake for a fresh install. */
  function freshLinux(): { deps: WorkerServiceDeps; commands: string[][] } {
    const commands: string[][] = [];
    let enabled = false;
    const run: RunCommandFn = async (command, args) => {
      commands.push([command, ...args]);
      if (args.includes("is-active") || args.includes("is-enabled")) {
        return { status: enabled ? 0 : 3, stdout: "", stderr: "" };
      }
      if (command === "loginctl") return { status: 0, stdout: "yes\n", stderr: "" };
      if (args.includes("enable")) enabled = true;
      return ok;
    };
    return { deps: { platform: "linux", homedir: home, username: "tester", run }, commands };
  }

  test("parses actions and flags", () => {
    expect(parseServiceArgs(["status", "--json"])).toEqual({
      ok: true,
      args: { action: "status", json: true, force: false, waitMs: 45_000, lines: 100 },
    });
    expect(parseServiceArgs(["install", "--force", "--wait", "5"])).toMatchObject({
      ok: true,
      args: { force: true, waitMs: 5_000 },
    });
    expect(parseServiceArgs(["logs", "-n", "20"])).toMatchObject({ ok: true, args: { lines: 20 } });
    expect(parseServiceArgs(["launch"])).toMatchObject({ ok: false });
    expect(parseServiceArgs(["stop", "--force"])).toMatchObject({ ok: false });
    expect(parseServiceArgs(["logs", "--json"])).toMatchObject({ ok: false });
    expect(parseServiceArgs([])).toEqual({ ok: true, help: true });
  });

  test("install refuses when signing in is the only step left (exit 2)", async () => {
    const { deps, commands } = freshLinux();
    const report = await runServiceAction(baseArgs(), {
      workspaceDir,
      service: deps,
      collectReadiness: async () => [
        {
          id: "entitlement",
          label: "Automation entitlement",
          status: "action",
          detail: "Not started",
          hint: "Run `devintern worker login github`",
        },
      ],
    });
    expect(report.result).toBe("action_required");
    expect(serviceExitCode(report)).toBe(2);
    // `command` is always runnable; the prose hint lives in `message`.
    expect(report.nextSteps.map((step) => step.command)).toEqual([
      `devintern worker login --workspace ${join(workspaceDir, "workspace.toml")} github --no-wait --json`,
      `DEVINTERN_WORKSPACE_DIR=${workspaceDir} devintern worker service install --json`,
    ]);
    expect(report.nextSteps.map((step) => step.id)).toEqual(["sign-in", "service"]);
    expect(report.nextSteps[0]?.message).toContain("sign in");
    // Same check shape as `worker init --json`.
    expect(report.checks).toEqual([
      {
        name: "entitlement",
        label: "Automation entitlement",
        status: "action",
        message: "Not started",
        hint: "Run `devintern worker login github`",
      },
    ]);
    expect(commands.some((command) => command.includes("daemon-reload"))).toBe(false);
  });

  test("install refuses a failing check unless --force", async () => {
    const failing = async () => [
      {
        id: "harness",
        label: "Agent harness",
        status: "fail" as const,
        detail: "claude not found",
      },
    ];
    const refused = await runServiceAction(baseArgs(), {
      workspaceDir,
      service: freshLinux().deps,
      collectReadiness: failing,
    });
    expect(refused.result).toBe("refused");
    expect(serviceExitCode(refused)).toBe(1);
    expect(refused.checks?.[0]).toMatchObject({ name: "harness", status: "fail" });
    expect(refused.code).toBe("agent_missing");
    // npm when it is on PATH, otherwise the standalone installer (never a bare npm on a Bun-only host).
    expect([
      "npm install -g @anthropic-ai/claude-code",
      "curl -fsSL https://claude.ai/install.sh | bash",
    ]).toContain(refused.nextSteps[0]?.command ?? "");

    const forced = await runServiceAction(baseArgs({ force: true }), {
      workspaceDir,
      service: freshLinux().deps,
      collectReadiness: failing,
      execPath: "/usr/local/bin/devintern",
      waitForStart: async () => ({
        state: "failed",
        reason: "License check failed",
        permanent: true,
        logLines: [],
      }),
    });
    expect(forced.result).toBe("failed");
    expect(serviceExitCode(forced)).toBe(1);
    expect(forced.nextSteps.map((step) => step.command)).toContain(
      "devintern worker service restart --json",
    );
  });

  test("install reports running only after the start check confirms it", async () => {
    const { deps, commands } = freshLinux();
    const waits: number[] = [];
    const report = await runServiceAction(baseArgs(), {
      workspaceDir,
      service: deps,
      collectReadiness: async () => [{ id: "config", label: "Workspace config", status: "ok" }],
      execPath: "/usr/local/bin/devintern",
      runtimePath: "/usr/local/bin/bun",
      environmentPath: "/usr/bin",
      waitForStart: async (_since, timeoutMs) => {
        waits.push(timeoutMs);
        return { state: "running", pid: 4242 };
      },
    });
    expect(report).toMatchObject({ result: "running", updated: false, start: { pid: 4242 } });
    expect(serviceExitCode(report)).toBe(0);
    expect(waits).toEqual([1_000]);
    expect(commands).toContainEqual(["systemctl", "--user", "enable", "--now", "devintern-worker"]);
    expect(readFileSync(systemdUnitPath(home), "utf8")).toContain("RestartPreventExitStatus=78");
  });

  test("a start that does not finish within --wait exits 3", async () => {
    const report = await runServiceAction(baseArgs(), {
      workspaceDir,
      service: freshLinux().deps,
      collectReadiness: async () => [],
      waitForStart: async () => ({ state: "starting", waitedMs: 1_000 }),
    });
    expect(report.result).toBe("starting");
    expect(serviceExitCode(report)).toBe(3);
  });

  test("status --json prints one document without a terminal", async () => {
    const { deps } = linuxService((args) =>
      args.includes("show")
        ? {
            status: 0,
            stdout: "ActiveState=inactive\nResult=success\nExecMainStatus=0\n",
            stderr: "",
          }
        : undefined,
    );
    writeWorkerLifecycle(workspaceDir, { state: "stopped", exitCode: 0 });
    let out = "";
    const code = await runWorkerServiceCommand(["status", "--json"], {
      workspaceDir,
      service: deps,
      write: (text) => (out += text),
    });
    expect(code).toBe(0);
    const doc = JSON.parse(out);
    expect(doc).toMatchObject({
      schema: "devintern.worker-service",
      version: 1,
      action: "status",
      result: "stopped",
      service: { installed: true, worker: { status: "stopped", lastExit: { outcome: "stopped" } } },
    });
  });

  test("text status of a failed service names the fix", async () => {
    writeWorkerLifecycle(workspaceDir, {
      state: "startup_failed",
      exitCode: 78,
      permanent: true,
      message: "❌ License check failed\n   Run `devintern worker login github`",
    });
    const { deps } = linuxService((args) =>
      args.includes("show")
        ? { status: 0, stdout: "ActiveState=failed\nExecMainStatus=78\n", stderr: "" }
        : undefined,
    );
    const lines: string[] = [];
    const code = await runWorkerServiceCommand(["status"], {
      workspaceDir,
      service: deps,
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Service:    failed");
    expect(text).toContain("License check failed");
    expect(text).toContain("devintern worker service restart");
    expect(text).toContain("journalctl --user -u devintern-worker.service");
  });

  test("logs prints the journal", async () => {
    const { deps, commands } = linuxService(() => ({
      status: 0,
      stdout: "line one\nline two",
      stderr: "",
    }));
    let out = "";
    const code = await runWorkerServiceCommand(["logs", "-n", "2"], {
      workspaceDir,
      service: deps,
      write: (text) => (out += text),
    });
    expect(code).toBe(0);
    expect(out).toBe("line one\nline two\n");
    expect(commands.at(-1)).toEqual([
      "journalctl",
      "--user",
      "-u",
      "devintern-worker.service",
      "-n",
      "2",
      "--no-pager",
    ]);
  });
});
