/**
 * `devintern worker service <install|start|stop|restart|status|uninstall|logs>`:
 * manage the worker's systemd user unit / launchd agent without the wizard.
 *
 * Works with no TTY (coding agents, provisioning scripts, `ssh host cmd`).
 * `install` runs the same readiness checks as `worker doctor` first and
 * refuses when the worker could not start; `install`, `start`, and
 * `restart` then wait until the worker has really started and report
 * running, failed (with its last log lines), or still starting. Every
 * action is idempotent.
 */

import { resolve } from "path";
import {
  agentStartNextStep,
  readAgentStartFailures,
  renderAgentStartFailures,
} from "../observability/agent-start-health";
import type { AgentStartFailureView } from "../observability/agent-start-health";
import type { ReadinessCheck } from "../observability/readiness";
import {
  blockerNextSteps,
  failureCodeFor,
  serviceInstallCommand,
  toReportCheck,
} from "../observability/readiness-json";
import type { NextStep, ReportCheck } from "../observability/readiness-json";
import { renderNextSteps } from "../observability/next-steps-text";
import { parseEnvFile } from "../workspace/env";
import { DEFAULT_MEMORY_BUDGET } from "./memory-budget";
import type { MemoryBudgetPercentages } from "./memory-budget";
import {
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceDbPath,
  workspaceEnvPath,
} from "../workspace/paths";
import {
  checkServiceManager,
  detectWorkerService,
  workerServiceDefinitionCurrent,
} from "./service";
import type { ServiceInstallResult, WorkerServiceDeps } from "./service";
import {
  DEFAULT_START_TIMEOUT_MS,
  installAndStartWorkerService,
  queryWorkerService,
  restartWorkerService,
  serviceLogCommand,
  startWorkerService,
  stopWorkerService,
  uninstallWorkerService,
  waitForWorkerStart,
} from "./service-control";
import type { ServiceActionResult, StartCheck, WorkerServiceStatus } from "./service-control";
import { renderServiceStatus, renderStartCheck } from "./service-report";
import { clearWorkerStartIntent } from "./start-intent";

export const WORKER_SERVICE_JSON_SCHEMA = "devintern.worker-service";
export const WORKER_SERVICE_JSON_VERSION = 1;

const ACTIONS = ["install", "start", "stop", "restart", "status", "uninstall", "logs"] as const;
export type ServiceAction = (typeof ACTIONS)[number];

export const WORKER_SERVICE_USAGE = [
  "Usage: devintern worker service <action> [options]",
  "",
  "Manage the worker's background service (a systemd user unit on Linux, a",
  "launchd agent on macOS) without the wizard. Works without a terminal.",
  "",
  "Actions:",
  "  install    Check readiness (same checks as `worker doctor`), install or update",
  "             the service, start it, and wait until the worker is running",
  "  start      Start the installed service and wait until the worker is running",
  "  stop       Stop the service; the worker finishes its graceful shutdown",
  "  restart    Restart the service (also after a failure) and wait for the worker",
  "  status     Show the service and worker state",
  "  uninstall  Stop the service and remove the DevIntern-managed definition",
  "  logs       Print the service manager's log (journal / launchd log)",
  "",
  "Options:",
  "  --json            Print one JSON document (all actions except logs)",
  "  --force           install: install even when readiness checks fail",
  `  --wait <seconds>  How long to wait for the worker to start (default ${DEFAULT_START_TIMEOUT_MS / 1000}; 0 skips)`,
  "  -n, --lines <n>   logs: number of lines (default 100)",
  "  -h, --help        Display this help message",
  "",
  "Exit codes: 0 done (worker running for install/start/restart); 1 failed;",
  "2 install refused because signing in is the only step left; 3 the service",
  "started but the worker had not finished starting within --wait.",
  "",
  "The workspace is ~/.devintern (or DEVINTERN_WORKSPACE_DIR).",
].join("\n");

export interface ServiceCommandArgs {
  action: ServiceAction;
  json: boolean;
  force: boolean;
  waitMs: number;
  lines: number;
}

export type ParsedServiceArgs =
  | { ok: true; args: ServiceCommandArgs }
  | { ok: false; error: string; json: boolean }
  | { ok: true; help: true };

/** Parse `worker service` arguments (everything after `service`). */
export function parseServiceArgs(argv: string[]): ParsedServiceArgs {
  const json = argv.includes("--json");
  if (argv.length === 0 || argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { ok: true, help: true };
  }
  const [action, ...rest] = argv;
  if (!ACTIONS.includes(action as ServiceAction)) {
    return {
      ok: false,
      json,
      error: `Unknown service action: ${action}. Use one of: ${ACTIONS.join(", ")}`,
    };
  }
  const args: ServiceCommandArgs = {
    action: action as ServiceAction,
    json: false,
    force: false,
    waitMs: DEFAULT_START_TIMEOUT_MS,
    lines: 100,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => inline ?? rest[++i];
    if (flag === "--json") args.json = true;
    else if (flag === "--force") args.force = true;
    else if (flag === "--wait") {
      const raw = value();
      if (raw === undefined || !/^\d+$/.test(raw)) {
        return { ok: false, json, error: "--wait needs a number of seconds (0 skips the wait)" };
      }
      args.waitMs = Number(raw) * 1000;
    } else if (flag === "--lines" || flag === "-n") {
      const raw = value();
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
        return { ok: false, json, error: "--lines needs a positive number" };
      }
      args.lines = Number(raw);
    } else {
      return { ok: false, json, error: `Unknown option for worker service ${action}: ${arg}` };
    }
  }
  if (args.json && args.action === "logs") {
    return { ok: false, json: false, error: "--json is not available for worker service logs" };
  }
  if (args.force && args.action !== "install") {
    return { ok: false, json, error: "--force only applies to worker service install" };
  }
  return { ok: true, args };
}

/** Everything the command touches, injectable for tests. */
export interface ServiceCommandDeps {
  workspaceDir?: string;
  service?: WorkerServiceDeps;
  /** Worker executable written into the definition. */
  execPath?: string;
  runtimePath?: string;
  environmentPath?: string;
  /** The readiness checks `install` runs first (`worker doctor`). */
  collectReadiness?: (workspaceDir: string) => Promise<ReadinessCheck[]>;
  /** Override the honest start check (tests). */
  waitForStart?: (since: number, timeoutMs: number) => Promise<StartCheck>;
  now?: () => number;
  log?: (line: string) => void;
  error?: (line: string) => void;
  write?: (text: string) => void;
}

/** One step the user still has to take (the shared next-step shape). */
export type ServiceNextStep = NextStep;

/** `--json` document. `result` values may grow; treat unknown ones as not done. */
export interface ServiceCommandReport {
  schema: typeof WORKER_SERVICE_JSON_SCHEMA;
  version: typeof WORKER_SERVICE_JSON_VERSION;
  action: ServiceAction;
  /**
   * install/start/restart: `running`, `starting`, `failed`, `refused`,
   * `action_required`, or `error`. stop: `stopped` or `error`. uninstall:
   * `uninstalled`, `not_installed`, or `error`. status: the service state.
   */
  result: string;
  error?: string;
  /** Stable code for a failure (`refused`, `error`): e.g. `query_rejected`, `service_unavailable`. */
  code?: string;
  workspaceDir: string;
  /** install: an existing service was updated instead of installed. */
  updated?: boolean;
  /**
   * install: the service was already installed with this exact definition and
   * running, so nothing was written and the worker was not restarted.
   */
  unchanged?: boolean;
  /** install: the `worker doctor` checks that ran first (same shape as `worker init --json`). */
  checks?: ReportCheck[];
  start?: StartCheck;
  warnings: string[];
  service?: WorkerServiceStatus;
  /** status: tasks whose agent CLI failed to start on their latest run (present when any). */
  agentStartFailures?: AgentStartFailureView[];
  nextSteps: ServiceNextStep[];
}

/** Exit code for a finished report. */
export function serviceExitCode(report: ServiceCommandReport): number {
  // status reports any state successfully; only failing to read it is an error.
  if (report.action === "status") return report.error === undefined ? 0 : 1;
  switch (report.result) {
    case "running":
    case "stopped":
    case "uninstalled":
    case "not_installed":
      return 0;
    case "action_required":
      return 2;
    case "starting":
      return 3;
    default:
      return 1;
  }
}

function startResultOf(start: StartCheck | undefined): string {
  return start ? start.state : "starting";
}

function nextStepsForStart(start: StartCheck | undefined): ServiceNextStep[] {
  if (!start || start.state === "running") return [];
  if (start.state === "starting") {
    return [
      {
        id: "check-start",
        message: "Check whether the worker finished starting",
        command: "devintern worker service status --json",
      },
    ];
  }
  return [
    {
      id: "logs",
      message: "See why the worker stopped",
      command: "devintern worker logs --level error",
    },
    {
      id: "restart",
      message: start.permanent
        ? "Fix the problem, then start the worker again"
        : "After fixing the problem, restart without waiting for the next retry",
      command: "devintern worker service restart --json",
    },
  ];
}

/**
 * The memory budget configured for this workspace, or the defaults when the
 * config cannot be read (a `worker service install --force` must still be able
 * to write a unit while the readiness checks report the config problem).
 */
async function workspaceMemoryBudget(workspaceDir: string): Promise<MemoryBudgetPercentages> {
  try {
    const { loadWorkerWorkspaceConfig } = await import("../workspace/config");
    return loadWorkerWorkspaceConfig(workspaceConfigPath(workspaceDir)).workspace.execution.memory;
  } catch {
    return DEFAULT_MEMORY_BUDGET;
  }
}

async function runInstall(
  args: ServiceCommandArgs,
  deps: ServiceCommandDeps,
  workspaceDir: string,
  base: ServiceCommandReport,
  log: (line: string) => void,
): Promise<ServiceCommandReport> {
  const manager = await checkServiceManager(deps.service);
  if (!manager.available) {
    return {
      ...base,
      result: "error",
      code: "service_unavailable",
      error: `A background service is not available here: ${manager.reason}. Run the worker in the foreground instead: devintern worker (inside tmux or screen to keep it running).`,
    };
  }
  const existing = await detectWorkerService(deps.service);
  if (existing.installed && !existing.managed) {
    return {
      ...base,
      result: "error",
      code: "custom_service",
      error:
        "The installed devintern-worker service has custom settings; it is left untouched. Remove it yourself to let DevIntern manage it.",
    };
  }

  let checks: ReadinessCheck[] | undefined;
  if (deps.collectReadiness) {
    log("📋 Readiness (the same checks as `devintern worker doctor`):");
    try {
      checks = await deps.collectReadiness(workspaceDir);
      const { renderReadinessReport } = await import("../observability/readiness");
      for (const line of renderReadinessReport(checks).lines) log(`   ${line}`);
    } catch (error) {
      log(`   ⚠️  Could not run the checks: ${(error as Error).message}`);
    }
  }
  const blockers = (checks ?? []).filter(
    (check) => check.status === "fail" || check.status === "action",
  );
  if (blockers.length > 0 && !args.force) {
    const onlyActions = blockers.every((check) => check.status === "action");
    const reportChecks = checks?.map(toReportCheck) ?? [];
    const code = failureCodeFor(reportChecks);
    return {
      ...base,
      checks: reportChecks,
      result: onlyActions ? "action_required" : "refused",
      ...(code ? { code } : {}),
      error: onlyActions
        ? "Not installed: the worker would not start until you sign in."
        : "Not installed: the worker would not start with the problems above.",
      nextSteps: [
        ...blockerNextSteps(blockers, {
          workspaceDir,
          env: { ...process.env, ...parseEnvFile(workspaceEnvPath(workspaceDir)) },
        }),
        {
          id: "service",
          message: "Then install the service (or pass --force to install it anyway)",
          command: serviceInstallCommand(workspaceDir),
        },
      ],
    };
  }
  if (blockers.length > 0) {
    log(
      "⚠️  --force: installing although the worker is not ready; it will not start until the checks above pass.",
    );
  }

  const definition = {
    workspaceDir,
    execPath: deps.execPath ?? (process.argv[1] ? resolve(process.argv[1]) : "devintern"),
    runtimePath: deps.runtimePath ?? process.execPath,
    environmentPath: deps.environmentPath ?? process.env.PATH ?? "",
    memory: await workspaceMemoryBudget(workspaceDir),
  };
  // Idempotent: the same definition and a running worker means there is
  // nothing to do, and restarting would interrupt the worker's tasks.
  if (existing.installed && workerServiceDefinitionCurrent(definition, deps.service)) {
    const current = await queryWorkerService(workspaceDir, deps.service);
    if (current.state === "running") {
      return {
        ...base,
        checks: checks?.map(toReportCheck),
        result: "running",
        updated: false,
        unchanged: true,
        service: current,
        start: { state: "running", pid: current.worker.pid },
      };
    }
  }

  if (args.waitMs > 0) log("⏳ Installing the service and waiting for the worker to start...");
  const { install, start } = await installAndStartWorkerService(
    {
      ...definition,
      waitMs: args.waitMs,
      now: deps.now,
      waitForStart: deps.waitForStart
        ? (since) =>
            (deps.waitForStart as NonNullable<ServiceCommandDeps["waitForStart"]>)(
              since,
              args.waitMs,
            )
        : undefined,
    },
    deps.service,
  );
  return installReport(base, install, start, checks);
}

function installReport(
  base: ServiceCommandReport,
  install: ServiceInstallResult,
  start: StartCheck | undefined,
  readiness: ReadinessCheck[] | undefined,
): ServiceCommandReport {
  const checks = readiness?.map(toReportCheck);
  if (!install.ok) {
    return {
      ...base,
      checks,
      result: "error",
      code: "install_failed",
      error: `Could not install the service: ${install.error}. Nothing was left half-installed.`,
    };
  }
  return {
    ...base,
    checks,
    updated: install.updated === true,
    result: startResultOf(start),
    ...(start ? { start } : {}),
    warnings: install.warning ? [install.warning] : [],
    nextSteps: nextStepsForStart(start),
  };
}

async function runStartLike(
  action: "start" | "restart",
  args: ServiceCommandArgs,
  deps: ServiceCommandDeps,
  workspaceDir: string,
  base: ServiceCommandReport,
): Promise<ServiceCommandReport> {
  const since = (deps.now ?? Date.now)();
  if (action === "start") {
    const current = await queryWorkerService(workspaceDir, deps.service);
    if (current.state === "running") {
      return {
        ...base,
        result: "running",
        service: current,
        start: { state: "running", pid: current.worker.pid },
      };
    }
  }
  const outcome: ServiceActionResult =
    action === "start"
      ? await startWorkerService(deps.service)
      : await restartWorkerService(deps.service);
  if (!outcome.ok) return { ...base, result: "error", error: outcome.error };
  if (args.waitMs === 0) return { ...base, result: "starting" };
  const start = deps.waitForStart
    ? await deps.waitForStart(since, args.waitMs)
    : await waitForWorkerStart({ workspaceDir, since, timeoutMs: args.waitMs }, deps.service);
  return { ...base, result: start.state, start, nextSteps: nextStepsForStart(start) };
}

/** Run one `worker service` action and build its report (prints progress via `log`). */
export async function runServiceAction(
  args: ServiceCommandArgs,
  deps: ServiceCommandDeps = {},
): Promise<ServiceCommandReport> {
  const workspaceDir = deps.workspaceDir ?? resolveWorkspaceDir();
  const log = args.json ? () => {} : (deps.log ?? console.log);
  const base: ServiceCommandReport = {
    schema: WORKER_SERVICE_JSON_SCHEMA,
    version: WORKER_SERVICE_JSON_VERSION,
    action: args.action,
    result: "error",
    workspaceDir,
    warnings: [],
    nextSteps: [],
  };
  switch (args.action) {
    case "install":
      return runInstall(args, deps, workspaceDir, base, log);
    case "start":
    case "restart":
      return runStartLike(args.action, args, deps, workspaceDir, base);
    case "stop": {
      const outcome = await stopWorkerService(deps.service);
      if (!outcome.ok) return { ...base, result: "error", error: outcome.error };
      const service = await queryWorkerService(workspaceDir, deps.service);
      return { ...base, result: "stopped", service };
    }
    case "uninstall": {
      const outcome = await uninstallWorkerService(deps.service);
      if (!outcome.ok) return { ...base, result: "error", error: outcome.error };
      // No pending `worker init --start` may reinstall it at the next sign-in.
      clearWorkerStartIntent(workspaceDir);
      return { ...base, result: outcome.unchanged ? "not_installed" : "uninstalled" };
    }
    case "status": {
      const service = await queryWorkerService(workspaceDir, deps.service);
      const nextSteps: ServiceNextStep[] =
        service.state === "not_installed"
          ? [
              {
                id: "service",
                message: "Install and start the background service (it checks readiness first)",
                command: serviceInstallCommand(workspaceDir),
              },
            ]
          : [];
      // A running service can still be doing nothing: say when the agent CLI
      // keeps failing to start.
      const agentStartFailures = readAgentStartFailures(workspaceDbPath(workspaceDir));
      const agentStep = agentStartNextStep(agentStartFailures);
      if (agentStep) nextSteps.push(agentStep);
      return {
        ...base,
        result: service.state,
        service,
        nextSteps,
        ...(agentStartFailures.length > 0 ? { agentStartFailures } : {}),
      };
    }
    case "logs":
      return { ...base, result: "logs" };
  }
}

/** Text lines for a finished report. */
export function renderServiceReport(
  report: ServiceCommandReport,
  platform: NodeJS.Platform,
): string[] {
  const lines: string[] = [];
  if (report.error) lines.push(`❌ ${report.error}`);
  const context = { platform, workspaceDir: report.workspaceDir };
  switch (report.action) {
    case "install":
      if (
        report.result !== "error" &&
        report.result !== "refused" &&
        report.result !== "action_required"
      ) {
        lines.push(
          report.unchanged
            ? "✅ The devintern-worker service is already installed and running; nothing changed and the worker was not restarted (use `devintern worker service restart` to restart it)."
            : report.updated
              ? "✅ Updated the devintern-worker service and restarted it."
              : "✅ Installed the devintern-worker service.",
        );
      }
      break;
    case "stop":
      if (report.result === "stopped") lines.push("✅ The devintern-worker service is stopped.");
      break;
    case "uninstall":
      if (report.result === "uninstalled") lines.push("✅ Removed the devintern-worker service.");
      if (report.result === "not_installed")
        lines.push("✅ The devintern-worker service is not installed.");
      break;
    case "status":
      if (report.service) lines.push(...renderServiceStatus(report.service, report.workspaceDir));
      if (report.agentStartFailures?.length) {
        lines.push("", ...renderAgentStartFailures(report.agentStartFailures));
      }
      break;
    default:
      break;
  }
  if (report.start) lines.push(...renderStartCheck(report.start, context));
  else if (report.result === "starting" && report.action !== "status") {
    lines.push(
      "⏳ Started the service without waiting (--wait 0). Check it with `devintern worker service status`.",
    );
  }
  for (const warning of report.warnings) lines.push(`⚠️  ${warning}`);
  if (report.nextSteps.length > 0 && !report.start) {
    lines.push("", "Next steps:", ...renderNextSteps(report.nextSteps, { indent: "   " }));
  }
  return lines;
}

/** Print the service manager's own log (journal on Linux, launchd log on macOS). */
async function printServiceLogs(
  lines: number,
  deps: ServiceCommandDeps,
  workspaceDir: string,
): Promise<number> {
  const { resolveServiceDeps, launchdAgentPath, LAUNCHD_LOG_NAME } = await import("./service");
  const d = resolveServiceDeps(deps.service ?? {});
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const error = deps.error ?? console.error;
  if (d.platform === "linux") {
    const result = await d.run("journalctl", [
      "--user",
      "-u",
      "devintern-worker.service",
      "-n",
      String(lines),
      "--no-pager",
    ]);
    if (result.status !== 0) {
      error(`❌ journalctl failed: ${(result.stderr || result.stdout).trim()}`);
      error("   The worker's own log: devintern worker logs");
      return 1;
    }
    write(
      result.stdout.endsWith("\n") || result.stdout === "" ? result.stdout : `${result.stdout}\n`,
    );
    return 0;
  }
  if (d.platform === "darwin") {
    const { join } = await import("path");
    const path = join(workspaceDir, LAUNCHD_LOG_NAME);
    if (!d.exists(path)) {
      error(
        d.exists(launchdAgentPath(d.homedir))
          ? `No launchd log yet at ${path}. The worker's own log: devintern worker logs`
          : "The worker service is not installed; run `devintern worker service install`.",
      );
      return 1;
    }
    const content = d.readFile(path).split("\n");
    if (content.at(-1) === "") content.pop();
    write(`${content.slice(-lines).join("\n")}\n`);
    return 0;
  }
  error(`❌ No service exists for ${d.platform}. ${serviceLogCommand(d.platform, workspaceDir)}`);
  return 1;
}

/** Default readiness preflight: the same checks and environment as `worker doctor`. */
export async function collectServiceReadiness(workspaceDir: string): Promise<ReadinessCheck[]> {
  const [{ collectWorkerDoctorChecks }, { applyWorkspaceProcessEnv }, { checkLicense }, bootstrap] =
    await Promise.all([
      import("../observability/worker-readiness"),
      import("../workspace/env"),
      import("@devintern/license-check"),
      import("../cli/bootstrap"),
    ]);
  const { workspaceCodeStateDir } = await import("../workspace/paths");
  const { workerLoginCommandFor } = await import("../account/worker-pilot");
  const processEnv = { ...process.env };
  try {
    applyWorkspaceProcessEnv(workspaceDir);
  } catch {
    // Unreadable workspace .env: the config check reports it.
  }
  const configPath = workspaceConfigPath(workspaceDir);
  return collectWorkerDoctorChecks(
    { workspacePath: configPath },
    {
      processEnv,
      checkEntitlement: (dir) =>
        checkLicense({
          productKey: "devintern/code",
          supabaseConfig: bootstrap.loadSupabaseConfig(workspaceCodeStateDir(dir)),
          requireAutomation: true,
          allowTrial: true,
          setup: true,
          loginCommand: workerLoginCommandFor(configPath),
        }),
    },
  );
}

/**
 * CLI entry: parse, run, print, and return the exit code.
 *
 * @param argv - Arguments after `devintern worker service`
 * @param deps - Injectable workspace, service, and output (tests)
 */
export async function runWorkerServiceCommand(
  argv: string[],
  deps: ServiceCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const parsed = parseServiceArgs(argv);
  if ("help" in parsed) {
    log(WORKER_SERVICE_USAGE);
    return 0;
  }
  if (!parsed.ok) {
    if (parsed.json) {
      write(
        `${JSON.stringify({ schema: WORKER_SERVICE_JSON_SCHEMA, version: WORKER_SERVICE_JSON_VERSION, result: "error", code: "invalid_arguments", error: parsed.error }, null, 2)}\n`,
      );
    } else {
      error(`❌ ${parsed.error}`);
      error("   Run `devintern worker service --help` for usage.");
    }
    return 1;
  }
  const { args } = parsed;
  const workspaceDir = deps.workspaceDir ?? resolveWorkspaceDir();
  if (args.action === "logs") return printServiceLogs(args.lines, deps, workspaceDir);
  const report = await runServiceAction(args, {
    ...deps,
    workspaceDir,
    collectReadiness: deps.collectReadiness ?? collectServiceReadiness,
  });
  if (report.result === "error" && !report.code) report.code = "service_command_failed";
  if (args.json) {
    write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const platform = deps.service?.platform ?? process.platform;
    const exitCode = serviceExitCode(report);
    const out = exitCode === 0 ? log : error;
    for (const line of renderServiceReport(report, platform)) out(line);
  }
  return serviceExitCode(report);
}
