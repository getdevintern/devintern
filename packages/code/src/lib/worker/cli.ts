import { existsSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { checkLicense } from "@devintern/license-check";
import {
  VERSION,
  enforceLicenseOrExit,
  loadEnvironment,
  loadSupabaseConfig,
} from "../cli/bootstrap";
import { flushAnalytics, trackWorkerConnect } from "../observability/analytics";
import { TaskTrackerManager } from "../trackers/manager";

/** True when `args` contains a `--help`/`-h` flag. */
function hasHelpArg(args: string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h");
}

/**
 * Configure relay-backed integrations or a directly polled Sentry monitor via
 * `devintern worker connect [target]`.
 */
async function runWorkerConnectSubcommand(args: string[]): Promise<never> {
  const { runWorkerConnectCommand, parseConnectArgs, WORKER_CONNECT_TARGETS } =
    await import("../init/worker-connect");
  // Parse once and hand the result to the command, so attribution and
  // execution cannot drift. Arg errors (`--team` with no value) and unknown
  // targets stay out of analytics: the command reports them, and tracking only
  // allowlisted targets keeps the funnel low-cardinality.
  const parsed = parseConnectArgs(args);
  const shouldTrack =
    !parsed.error &&
    !parsed.help &&
    parsed.target !== "status" &&
    WORKER_CONNECT_TARGETS.has(parsed.target);
  const exitCode = await runWorkerConnectCommand(args, { parsed });
  if (shouldTrack) {
    await trackWorkerConnect({
      target: parsed.target,
      outcome: exitCode === 0 ? "succeeded" : "failed",
    });
  }
  await flushAnalytics();
  process.exit(exitCode);
}

/** Create `~/.devintern/workspace.toml` and the shared `.env` without the wizard. */
async function runWorkerScaffoldSubcommand(args: string[]): Promise<never> {
  if (hasHelpArg(args)) {
    console.log("Usage: devintern worker scaffold");
    console.log("");
    console.log("Create ~/.devintern/workspace.toml and the shared .env without the wizard.");
    process.exit(0);
  }
  const { runWorkerScaffold } = await import("../workspace/init");
  process.exit(runWorkerScaffold());
}

/** Add the current Git repository to the worker workspace. */
async function runWorkerAddRepoSubcommand(args: string[]): Promise<never> {
  if (hasHelpArg(args)) {
    console.log("Usage: devintern worker add-repo");
    console.log("");
    console.log("Add the current Git repository to the worker workspace.");
    process.exit(0);
  }
  const { runWorkerAddRepo } = await import("../workspace/init");
  process.exit(await runWorkerAddRepo(process.cwd()));
}

/**
 * `devintern worker run-now` — ask a running workspace worker for one immediate
 * drain, bypassing working windows without editing them.
 */
async function runWorkerRunNowSubcommand(args: string[]): Promise<never> {
  let workspacePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace" && args[i + 1] && !args[i + 1]?.startsWith("-")) {
      workspacePath = args[i + 1];
      i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: devintern worker run-now [--workspace <path>]");
      console.log("");
      console.log("Ask the running workspace worker to drain ready tasks now,");
      console.log("ignoring working windows (quiet hours) for this one pass.");
      console.log("The worker picks up the request on its next poll interval");
      console.log("(default 60s) and deletes the marker once served.");
      process.exit(0);
    }
  }
  const { resolveWorkspaceDir, workspaceConfigPath, workspaceRunNowPath } =
    await import("../workspace/paths");
  const selectedDir = workspacePath ? dirname(resolve(workspacePath)) : resolveWorkspaceDir();
  if (!existsSync(workspaceConfigPath(selectedDir))) {
    console.error(`❌ No workspace.toml at ${workspaceConfigPath(selectedDir)}.`);
    process.exit(1);
  }
  writeFileSync(workspaceRunNowPath(selectedDir), "");
  console.log(`✅ Run-now requested for ${workspaceConfigPath(selectedDir)}`);
  console.log(`   Marker: ${workspaceRunNowPath(selectedDir)}`);
  console.log("   The worker drains within one poll interval and removes the marker.");
  process.exit(0);
}

/** Interactively configure unattended automation and a native user service. */
async function runWorkerInitSubcommand(args: string[]): Promise<never> {
  if (hasHelpArg(args)) {
    console.log("Usage: devintern worker init [--no-service]");
    console.log("");
    console.log("Interactively configure unattended automation and a native user service.");
    console.log("");
    console.log("Options:");
    console.log(
      "  --no-service  Skip the install-and-launch offer for the systemd/launchd service",
    );
    process.exit(0);
  }
  loadEnvironment();
  const { runWorkerInit } = await import("../init/worker-init");
  const { isInteractive } = await import("../init/wizard");
  if (!isInteractive(args, process.stdin)) {
    console.log("❌ 'devintern worker init' is interactive; run it in a terminal.");
    console.log("   Non-interactive setup: `devintern worker scaffold` + `worker add-repo`,");
    console.log("   set [defaults].task_query in workspace.toml, then `devintern worker`.");
    process.exit(1);
  }
  const trackerManager = new TaskTrackerManager();
  const result = await runWorkerInit({
    noService: args.some((arg) => arg === "--no-service"),
    dryRunQuery: async (query) => {
      const result = await trackerManager.getClient().searchTasks(query);
      return result.tasks.length;
    },
    checkAutomationLicense: async () => {
      const license = await checkLicense({
        productKey: "devintern/code",
        supabaseConfig: loadSupabaseConfig(),
        requireAutomation: true,
      });
      return license.valid ? null : license.message;
    },
  });
  await flushAnalytics();
  process.exit(result.ok ? 0 : 1);
}

/** Parse daemon flags, load the workspace, gate on license, and run the worker. */
async function runWorkerDaemon(args: string[]): Promise<void> {
  let verbose = false;
  let workspacePath: string | undefined;

  const removedWorkerFlags: Record<string, string> = {
    "--listen": "Use the workspace worker or `devintern webhook serve`.",
    "--no-workspace": "Use the workspace worker or `devintern webhook serve`.",
    "--port": "Use the workspace worker or `devintern webhook serve`.",
    "--host": "Use the workspace worker or `devintern webhook serve`.",
    "--query": "Set [defaults].task_query in workspace.toml.",
    "--interval": "Set [defaults].poll_interval in workspace.toml.",
    "--ui": "The dashboard is on by default. Set [workspace].dashboard = false to disable it.",
    "--no-ui": "Set [workspace].dashboard = false in workspace.toml.",
    "--ui-port": "Set [workspace].dashboard_port in workspace.toml.",
    "--sandbox": "Set AGENT_SANDBOX in the workspace .env.",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    const removed = removedWorkerFlags[arg];
    if (removed) {
      console.error(`❌ ${arg} has been removed from devintern worker.`);
      console.error(`   ${removed}`);
      process.exit(1);
    }
    if (arg === "--workspace") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        console.error("❌ --workspace requires a path to workspace.toml.");
        process.exit(1);
      }
      workspacePath = args[i + 1];
      i++;
    } else if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: devintern worker [init|scaffold|add-repo|run-now] [options]");
      console.log("       devintern worker connect [target] [--workspace <path>]");
      console.log("");
      console.log("Run the devintern worker daemon. The worker acquires events (reviews on");
      console.log("the agent's PRs, ready tasks from your tracker) and executes them locally.");
      console.log("`worker connect` configures relay integrations and Sentry auto-fixes;");
      console.log("see `devintern worker connect --help` for targets and options.");
      console.log("");
      console.log("Configure polling, the dashboard, and per-task flags in workspace.toml");
      console.log("(~/.devintern/workspace.toml). See `devintern worker init`.");
      console.log("");
      console.log("Subcommands:");
      console.log("  init                Guided unattended setup: tracker, workspace, ready-tasks");
      console.log(
        "                      query, operating policy, optional Sentry, and license check",
      );
      console.log("  scaffold            Create workspace.toml and the shared .env only");
      console.log("  add-repo            Add the current repository to the worker workspace");
      console.log("  connect             Configure relay integrations or Sentry auto-fixes");
      console.log("  run-now             One immediate drain, ignoring working windows");
      console.log("");
      console.log("Options:");
      console.log("  --workspace <path>  Use this workspace.toml (default: ~/.devintern/");
      console.log("                      workspace.toml, or DEVINTERN_WORKSPACE_DIR)");
      console.log("  -v, --verbose       Verbose logging");
      console.log("  -h, --help          Display this help message");
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      console.error(`❌ Unknown worker command: ${arg}`);
      console.error("   Run `devintern worker --help` for available commands.");
      process.exit(1);
    }
  }

  loadEnvironment();

  const { hasWorkspace, resolveWorkspaceDir, workspaceEnvPath } =
    await import("../workspace/paths");
  const workspaceMode = Boolean(workspacePath) || hasWorkspace();
  if (!workspaceMode) {
    console.error("❌ No workspace configured. Run `devintern worker init` first.");
    process.exit(1);
  }

  // Workspace credentials must be available before the license gate. This
  // matters for native services, whose working directory is the workspace
  // home rather than a source checkout.
  const { parseEnvFile } = await import("../workspace/env");
  const selectedWorkspaceDir = workspacePath
    ? dirname(resolve(workspacePath))
    : resolveWorkspaceDir();
  for (const [key, value] of Object.entries(parseEnvFile(workspaceEnvPath(selectedWorkspaceDir)))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  // License check — the worker is unattended automation, so it always
  // requires an automation entitlement.
  const licenseResult = await checkLicense({
    productKey: "devintern/code",
    supabaseConfig: loadSupabaseConfig(),
    requireAutomation: true,
  });
  await enforceLicenseOrExit(licenseResult);

  const { runWorkspaceWorker } = await import("../workspace/workspace-worker");
  await runWorkspaceWorker({
    workspacePath,
    verbose,
    cliVersion: VERSION,
  });
}

/**
 * Dispatch `devintern worker <subcommand>`.
 *
 * Each subcommand owns its argument parsing and exits on completion; the
 * no-subcommand path configures and runs the long-lived workspace daemon.
 */
export async function runWorkerCli(args: string[]): Promise<void> {
  const [subcommand] = args;
  const rest = args.slice(1);
  if (subcommand === "connect") return runWorkerConnectSubcommand(rest);
  if (subcommand === "scaffold") return runWorkerScaffoldSubcommand(rest);
  if (subcommand === "add-repo") return runWorkerAddRepoSubcommand(rest);
  if (subcommand === "run-now") return runWorkerRunNowSubcommand(rest);
  if (subcommand === "init") return runWorkerInitSubcommand(rest);
  return runWorkerDaemon(args);
}
