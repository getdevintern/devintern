import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { activateWorkerTrial, checkLicense, requireLicense } from "@devintern/license-check";
import {
  VERSION,
  enforceLicenseOrExit,
  loadEnvironment,
  loadSupabaseConfig,
} from "../cli/bootstrap";
import { isPromptAbort } from "../cli/prompt-abort";
import { flushAnalytics, trackWorkerConnect } from "../observability/analytics";
import { initSentryOnce } from "../observability/sentry-init";
import { TaskTrackerManager } from "../trackers/manager";
import { applyWorkspaceProcessEnv } from "../workspace/env";
import {
  ensureWorkspaceCodeState,
  resolveWorkspaceDir,
  workspaceCodeStateDir,
  workspaceConfigPath,
} from "../workspace/paths";
import { parseRunNowArgs, runWorkerRunNow } from "./run-now";

export { parseRunNowArgs, runWorkerRunNow };

/** Read-only dashboard subcommands (kept in sync with `WORKER_READ_COMMANDS`; loaded lazily). */
const WORKER_READ_SUBCOMMANDS = new Set([
  "runs",
  "stats",
  "automations",
  "prs",
  "queue",
  "status",
  "overview",
  "logs",
]);

/** Sign in to the selected worker workspace without changing project login. */
async function runWorkerLoginSubcommand(args: string[]): Promise<never> {
  if (hasHelpArg(args)) {
    console.log("Usage: devintern worker login [method] [--workspace <path>]");
    console.log("Sign in for the worker workspace (github | google | x | email).");
    process.exit(0);
  }
  const workspaceFlag = args.indexOf("--workspace");
  const workspacePath = workspaceFlag >= 0 ? args[workspaceFlag + 1] : undefined;
  if (workspaceFlag >= 0 && (!workspacePath || workspacePath.startsWith("-"))) {
    console.error("❌ --workspace requires a path to workspace.toml.");
    process.exit(1);
  }
  const workspaceDir = workspacePath ? dirname(resolve(workspacePath)) : resolveWorkspaceDir();
  const configPath = workspacePath ? resolve(workspacePath) : workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) {
    console.error(`❌ No workspace.toml at ${configPath}.`);
    process.exit(1);
  }
  const loginArgs =
    workspaceFlag < 0
      ? args
      : args.filter((_, index) => index !== workspaceFlag && index !== workspaceFlag + 1);
  ensureWorkspaceCodeState(workspaceDir);
  const { runLoginCommand } = await import("../account/cli");
  return runLoginCommand(["devintern", "login", ...loginArgs], workspaceCodeStateDir(workspaceDir));
}

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
 * `devintern worker add` — enqueue a one-off task for a workspace repo
 * without a tracker ticket.
 */
async function runWorkerAddSubcommand(args: string[]): Promise<never> {
  const { runWorkerAdd } = await import("../workspace/add-command");
  process.exit(await runWorkerAdd(args));
}

/** `devintern worker cancel <taskKey>` — withdraw a pending ad-hoc task. */
async function runWorkerCancelSubcommand(args: string[]): Promise<never> {
  const { runWorkerCancel } = await import("../workspace/cancel-command");
  process.exit(runWorkerCancel(args));
}

/**
 * `devintern worker run-now` — ask a running workspace worker for one immediate
 * drain, bypassing working windows without editing them.
 */
async function runWorkerRunNowSubcommand(args: string[]): Promise<never> {
  process.exit(runWorkerRunNow(args));
}

/**
 * `devintern worker doctor` — side-effect-free preflight answering whether
 * this workspace can acquire and run work right now. Never starts the daemon.
 */
async function runWorkerDoctorSubcommand(args: string[]): Promise<never> {
  if (hasHelpArg(args)) {
    console.log("Usage: devintern worker doctor [--workspace <path>] [--offline]");
    console.log("");
    console.log("Check whether this worker workspace can acquire and run work right now:");
    console.log("workspace.toml, per-team tracker credentials, ready-tasks query dry-runs,");
    console.log("repository access, automation entitlement, harness and sandbox, and the");
    console.log("dashboard port. Changes nothing and does not start the worker.");
    console.log("Exits non-zero when any check fails.");
    console.log("");
    console.log("Options:");
    console.log("  --workspace <path>  Use this workspace.toml (default: ~/.devintern/");
    console.log("                      workspace.toml, or DEVINTERN_WORKSPACE_DIR)");
    console.log("  --offline           Skip query, repository, and license checks (no network)");
    console.log("  -h, --help          Display this help message");
    process.exit(0);
  }
  let workspacePath: string | undefined;
  let offline = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("❌ --workspace requires a path to workspace.toml.");
        process.exit(1);
      }
      workspacePath = value;
      i++;
    } else if (arg === "--offline") {
      offline = true;
    } else {
      console.error(`❌ Unknown option for worker doctor: ${arg}`);
      console.error("   Run `devintern worker doctor --help` for usage.");
      process.exit(1);
    }
  }

  const { collectWorkerDoctorChecks, workerDoctorClosingLine } =
    await import("../observability/worker-readiness");
  const { renderReadinessReport } = await import("../observability/readiness");
  const workspaceDir = workspacePath ? dirname(resolve(workspacePath)) : resolveWorkspaceDir();
  // Mirror the daemon: shared workspace values (AGENT_HARNESS, AGENT_CLI_PATH,
  // LICENSE_KEY, ...) apply to this process. Only process.env changes.
  const processEnv = { ...process.env };
  try {
    applyWorkspaceProcessEnv(workspaceDir);
  } catch {
    // Unreadable workspace .env: the config check reports the workspace state.
  }
  const checks = await collectWorkerDoctorChecks({ workspacePath, offline }, { processEnv });
  const report = renderReadinessReport(checks);
  console.log(`🩺 devintern worker readiness${offline ? " (offline)" : ""}:\n`);
  console.log(report.lines.join("\n"));
  console.log(`\n${workerDoctorClosingLine(checks, report)}`);
  process.exit(report.hasFailures ? 1 : 0);
}

const WORKER_INIT_USAGE = [
  "Usage: devintern worker init [--no-service]",
  "       devintern worker init --non-interactive --tracker <id> --task-query <query>",
  "                             [--repo-from-cwd] [--env-file <path>] [--yes] [--json]",
  "",
  "Interactively configure unattended automation and a native user service.",
  "",
  "Options:",
  "  --no-service        Skip the install-and-launch offer for the systemd/launchd service",
  "",
  "Non-interactive mode (coding agents, scripts, SSH without a TTY):",
  "  --non-interactive   Set up from flags; never prompts, signs in, pairs, or installs",
  "  --tracker <id>      Tracker the worker polls (jira, linear, github, ...)",
  "  --task-query <q>    Ready-tasks query, written to [defaults].task_query",
  "  --repo-from-cwd     Register the current Git repository (uses its origin remote)",
  "  --env-file <path>   Read credentials from this file (mode 0600) and save them",
  "                      to the workspace .env; otherwise they come from the environment",
  "  --yes               Update an existing workspace.toml (other settings are kept)",
  "  --json              Print one JSON document with checks, files, and next steps",
  "",
  "Secrets are never accepted as flags. See https://devintern.com/docs/code/worker#non-interactive-setup",
].join("\n");

/** `worker init --non-interactive`: flag-driven setup plus doctor checks. */
async function runWorkerInitNonInteractive(args: string[]): Promise<never> {
  const {
    parseNonInteractiveInitArgs,
    renderNonInteractiveReport,
    runNonInteractiveWorkerInit,
    unexpectedFailureReport,
    WORKER_INIT_JSON_SCHEMA,
    WORKER_INIT_JSON_VERSION,
  } = await import("../init/worker-init-noninteractive");
  const parsed = parseNonInteractiveInitArgs(args);
  if (!parsed.ok) {
    if (parsed.json) {
      const doc = {
        schema: WORKER_INIT_JSON_SCHEMA,
        version: WORKER_INIT_JSON_VERSION,
        result: "failure",
        error: parsed.error,
        workspaceDir: resolveWorkspaceDir(),
        tracker: null,
        taskQuery: null,
        repo: null,
        filesWritten: [],
        checks: [],
        nextSteps: [],
      };
      process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    } else {
      console.error(`❌ ${parsed.error}`);
    }
    process.exit(1);
  }
  const { json } = parsed.args;
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  if (json) {
    // stdout carries only the JSON document; route library chatter to stderr.
    const toStderr = (...parts: unknown[]) => console.error(...parts);
    console.log = toStderr;
    console.info = toStderr;
    console.warn = toStderr;
    console.debug = toStderr;
  }
  const { trackWorkerInitCompleted, trackWorkerInitFailed, trackWorkerInitStarted } =
    await import("../observability/analytics");
  let report: Awaited<ReturnType<typeof runNonInteractiveWorkerInit>>;
  try {
    // Load .env before any analytics call so its telemetry opt-out applies.
    loadEnvironment();
    trackWorkerInitStarted("non_interactive");
    report = await runNonInteractiveWorkerInit(parsed.args, {
      log: json ? undefined : (message) => console.log(message),
    });
  } catch (error) {
    // Still emit a (redacted) failure document so --json stdout stays parseable.
    report = unexpectedFailureReport(resolveWorkspaceDir(), error);
  }
  if (report.error) trackWorkerInitFailed("non_interactive_input", "non_interactive");
  else
    trackWorkerInitCompleted({
      tracker: report.tracker ?? "unknown",
      relayConnect: "skipped",
      serviceInstall: "skipped",
      githubApp: "skipped",
      source: "non_interactive",
      outcome: report.result === "success" ? "succeeded" : "failed",
    });
  if (json) {
    stdoutWrite(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = renderNonInteractiveReport(report);
    (report.error ? console.error : console.log)(lines.join("\n"));
  }
  await flushAnalytics();
  process.exit(report.result === "success" ? 0 : 1);
}

/** Interactively configure unattended automation and a native user service. */
async function runWorkerInitSubcommand(args: string[]): Promise<never> {
  if (hasHelpArg(args)) {
    console.log(WORKER_INIT_USAGE);
    process.exit(0);
  }
  if (args.includes("--non-interactive")) return runWorkerInitNonInteractive(args);
  const nonInteractiveOnly = args.find((arg) =>
    ["--tracker", "--task-query", "--repo-from-cwd", "--env-file", "--json", "--yes"].includes(
      arg.split("=")[0],
    ),
  );
  if (nonInteractiveOnly) {
    console.error(`❌ ${nonInteractiveOnly.split("=")[0]} needs --non-interactive.`);
    console.error("   Run `devintern worker init --help` for options.");
    process.exit(1);
  }
  loadEnvironment();
  const { runWorkerInit } = await import("../init/worker-init");
  const { isInteractive } = await import("../init/wizard");
  if (!isInteractive(args, process.stdin)) {
    console.log("❌ 'devintern worker init' needs a terminal for its prompts.");
    console.log("   Without one, use the flag-driven mode, for example:");
    console.log(
      '   devintern worker init --non-interactive --tracker jira --task-query "<query>" --repo-from-cwd',
    );
    console.log("   Run `devintern worker init --help` for every option.");
    process.exit(1);
  }
  const trackerManager = new TaskTrackerManager();
  let ok = false;
  try {
    const result = await runWorkerInit({
      noService: args.some((arg) => arg === "--no-service"),
      dryRunQuery: async (query) => {
        const result = await trackerManager.getClient().searchTasks(query);
        return result.tasks.length;
      },
      checkAutomationLicense: async (workspaceDir) => {
        const license = await checkLicense({
          productKey: "devintern/code",
          supabaseConfig: loadSupabaseConfig(workspaceCodeStateDir(workspaceDir)),
          requireAutomation: true,
          allowTrial: true,
        });
        return license.valid ? null : license.message;
      },
    });
    ok = result.ok;
  } catch (error) {
    if (!isPromptAbort(error)) throw error;
    console.log("\n❌ Input closed (Ctrl+D); setup stopped. Re-run `devintern worker init`.");
  }
  await flushAnalytics();
  process.exit(ok ? 0 : 1);
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
      console.log(
        "Usage: devintern worker [init|login|scaffold|add-repo|add|cancel|run-now|doctor] [options]",
      );
      console.log("       devintern worker connect [target] [--workspace <path>]");
      console.log(
        "       devintern worker <runs|stats|automations|prs|queue|status|overview|logs> [--json]",
      );
      console.log("");
      console.log("Run the devintern worker daemon. The worker acquires events (reviews on");
      console.log("the agent's PRs, ready tasks from your tracker) and executes them locally.");
      console.log("`worker connect` configures relay integrations and Sentry auto-fixes;");
      console.log("see `devintern worker connect --help` for targets and options.");
      console.log("");
      console.log("Unattended runs require automation access. A signed-in workspace runs the");
      console.log("no-card Worker Pilot for 14 days (no task limit) until a license is added.");
      console.log("");
      console.log("Configure polling, the dashboard, and per-task flags in workspace.toml");
      console.log("(~/.devintern/workspace.toml). See `devintern worker init`.");
      console.log("");
      console.log("Subcommands:");
      console.log("  init                Guided unattended setup: tracker, workspace, ready-tasks");
      console.log(
        "                      query, operating policy, optional Sentry, and license check",
      );
      console.log("  login               Sign in for this worker workspace");
      console.log("  scaffold            Create workspace.toml and the shared .env only");
      console.log("  add-repo            Add the current repository to the worker workspace");
      console.log("  add                 Enqueue a one-off task for a workspace repo");
      console.log("  cancel              Cancel a pending ad-hoc task before it starts");
      console.log("  connect             Configure relay integrations or Sentry auto-fixes");
      console.log("  run-now             One immediate drain, ignoring working windows");
      console.log("  doctor              Check workspace readiness without starting the worker");
      console.log("");
      console.log("Read-only dashboard data (no dashboard, worker, or network needed; --json");
      console.log("prints the matching /api response body):");
      const { WORKER_READ_HELP_LINES } = await import("./dashboard-read-cli");
      for (const line of WORKER_READ_HELP_LINES) console.log(line);
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

  const { hasWorkspace, resolveWorkspaceDir } = await import("../workspace/paths");
  const workspaceMode = Boolean(workspacePath) || hasWorkspace();
  if (!workspaceMode) {
    console.error("❌ No workspace configured. Run `devintern worker init` first.");
    process.exit(1);
  }

  // Workspace credentials must be available before the license gate. This
  // matters for native services, whose working directory is the workspace
  // home rather than a source checkout.
  const selectedWorkspaceDir = workspacePath
    ? dirname(resolve(workspacePath))
    : resolveWorkspaceDir();
  ensureWorkspaceCodeState(selectedWorkspaceDir);
  applyWorkspaceProcessEnv(selectedWorkspaceDir);
  initSentryOnce(`code@${VERSION}`);

  // License check — the worker is unattended automation, so it always
  // requires an automation entitlement.
  const supabaseConfig = loadSupabaseConfig(workspaceCodeStateDir(selectedWorkspaceDir));
  const licenseResult = await checkLicense({
    productKey: "devintern/code",
    supabaseConfig,
    requireAutomation: true,
    allowTrial: true,
  });
  await enforceLicenseOrExit(licenseResult);
  if (licenseResult.source === "trial") {
    process.env.DEVINTERN_WORKER_TRIAL = "1";
  }

  const { runWorkspaceWorker } = await import("../workspace/workspace-worker");
  await runWorkspaceWorker({
    workspacePath,
    verbose,
    cliVersion: VERSION,
    beforeAcquirersStart: licenseResult.trialAvailable
      ? async () => {
          const activated = await activateWorkerTrial({
            productKey: "devintern/code",
            supabaseConfig,
          });
          requireLicense(activated);
        }
      : undefined,
    accessCheck: async () => {
      let access = await checkLicense({
        productKey: "devintern/code",
        supabaseConfig,
        requireAutomation: true,
        allowTrial: true,
      });
      if (access.trialAvailable) {
        access = await activateWorkerTrial({ productKey: "devintern/code", supabaseConfig });
      }
      if (access.source === "trial") process.env.DEVINTERN_WORKER_TRIAL = "1";
      else delete process.env.DEVINTERN_WORKER_TRIAL;
      return access;
    },
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
  if (subcommand === "add") return runWorkerAddSubcommand(rest);
  if (subcommand === "cancel") return runWorkerCancelSubcommand(rest);
  if (subcommand === "run-now") return runWorkerRunNowSubcommand(rest);
  if (subcommand === "init") return runWorkerInitSubcommand(rest);
  if (subcommand === "login") return runWorkerLoginSubcommand(rest);
  if (subcommand === "doctor") return runWorkerDoctorSubcommand(rest);
  if (subcommand && WORKER_READ_SUBCOMMANDS.has(subcommand)) {
    const { isWorkerReadCommand, runWorkerReadCommand } = await import("./dashboard-read-cli");
    if (isWorkerReadCommand(subcommand)) process.exit(runWorkerReadCommand(subcommand, rest));
  }
  return runWorkerDaemon(args);
}
