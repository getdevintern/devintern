import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { detectSandboxProviders } from "@devintern/agent-harness";
import { hasHelpArg } from "../cli/help";
import { isPromptAbort, promptAbortReason } from "../cli/prompt-abort";
import { flushAnalytics, trackSetupCompleted, trackSetupStarted } from "../observability/analytics";
import { findWorkspaceRepoForCheckout } from "../workspace/manual-run";
import { migrateLegacyCheckout } from "../workspace/migrate-checkout";
import type { ManualWorkspaceRun } from "../workspace/manual-run";
import { workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
import { registerManualCheckout } from "../workspace/register-checkout";
import { buildEnvExample } from "./scaffold";
import { isInteractive, runInitUpgrade, runInitWizard } from "./wizard";
import type { InitWizardDeps } from "./wizard";

const INIT_USAGE = [
  "Usage: devintern init [options]",
  "",
  "Set up DevIntern for the repository in the current directory.",
  "A checkout with an origin remote is registered in ~/.devintern/workspace.toml",
  "as a manual-only repo, with its settings in ~/.devintern/env/<repo>.env.",
  "Re-running init in a registered checkout updates that file.",
  "In a terminal this opens the interactive setup wizard; --yes, --no-interactive,",
  "or piped stdin writes the configuration templates without prompts.",
  "",
  "Options:",
  "  --yes, --no-interactive  Skip prompts and write the config templates",
  "  -h, --help               Display this help message",
].join("\n");

/**
 * Scaffold `.devintern-code/` with env template, settings, and gitignore
 * entries (non-interactive fallback for `init --yes` / piped stdin).
 */
async function initializeProject(cwd: string, log: (message: string) => void): Promise<void> {
  log("🚀 Initializing @getdevintern/code for this project...");

  const registered = await registerManualCheckout(cwd, buildEnvExample());
  if (!registered.ok) {
    console.error(`❌ ${registered.error}`);
    return;
  }
  const envFile = registered.envPath;
  const settingsHint = `Add [trackers] status names to ${join(registered.workspaceDir, "workspace.toml")} (optional)`;
  // Non-interactive setup still counts toward the activation funnel; the
  // wizard records its own started/completed pair when prompts are available.
  trackSetupStarted("init");

  // Surface installed sandbox providers so users know isolation is available.
  try {
    const detections = await detectSandboxProviders();
    const available = detections.filter((d) => d.detection.available);
    if (available.length > 0) {
      const names = available
        .map((d) => `${d.provider.name}${d.detection.version ? ` (${d.detection.version})` : ""}`)
        .join(", ");
      log(`\n🔒 Sandbox providers detected: ${names}`);
      log(`   Set AGENT_SANDBOX=auto in ${envFile} to run agents isolated.`);
    } else {
      log("\n🔓 No sandbox provider detected — agents will run unsandboxed.");
      log("   Run 'devintern sandbox' for install options.");
    }
  } catch {
    // Detection is best-effort; init must not fail because of it.
  }

  log("\n🎉 Project initialized successfully!");
  log("\n📝 Next steps:");
  log(`   1. Edit ${envFile}`);
  log("      - Add your task tracker credentials (Jira, Linear, etc.)");
  log(`   2. ${settingsHint}`);
  log("      - Status names per tracker project, e.g. [trackers.jira.projects.PROJ]");
  log("   3. Run 'devintern <TASK-KEY>' to start working on tasks");

  trackSetupCompleted({ signedIn: "skipped" });
}

/** Injection points for {@link runInit}; production callers pass none. */
export type InitCommandDeps = Omit<InitWizardDeps, "source"> & {
  /** Whether prompts are available; defaults to a TTY check on stdin. */
  interactive?: boolean;
};

/**
 * Run `devintern init`: the interactive wizard on a TTY (or the upgrade variant
 * when a project `.env` already exists), otherwise the non-interactive scaffold.
 */
export async function runInitCommand(): Promise<never> {
  if (hasHelpArg(process.argv.slice(2))) {
    console.log(INIT_USAGE);
    process.exit(0);
  }
  const code = await runInit();
  await flushAnalytics();
  process.exit(code);
}

/**
 * Body of `devintern init` without the process exit. Closing input at any
 * prompt (Ctrl+D or a closed pipe) stops setup with a one-line message
 * instead of a readline stack trace; files already written stay as they are.
 *
 * @returns Process exit code
 */
export async function runInit(deps: InitCommandDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const interactive = deps.interactive ?? isInteractive(process.argv, process.stdin);
  try {
    await migrateLegacyCheckout(cwd);
    const registered = await findWorkspaceRepoForCheckout({ cwd });
    if (registered) {
      return await updateRegisteredCheckout(registered, interactive, deps);
    }
    if (interactive) {
      await runInitWizard({ ...deps, cwd });
    } else {
      await initializeProject(cwd, log);
    }
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    if (!isPromptAbort(error)) throw error;
    log(`\n❌ ${promptAbortReason(error)}; setup stopped. Re-run \`devintern init\`.`);
    return 1;
  }
}

/**
 * Re-run init in a checkout already registered in the workspace: update its
 * env file. Repos managed by the worker (no `env_file`) are left to the
 * workspace files, so init never edits the shared `.env` worker repos use.
 *
 * @returns Process exit code
 */
async function updateRegisteredCheckout(
  run: ManualWorkspaceRun,
  interactive: boolean,
  deps: InitCommandDeps,
): Promise<number> {
  const log = deps.log ?? console.log;
  const configPath = workspaceConfigPath(run.workspaceDir);
  if (!run.repo.envFile) {
    log(`ℹ️  This checkout is registered in ${configPath} as "${run.repo.name}".`);
    log(
      `   Its settings come from ${workspaceEnvPath(run.workspaceDir)} and [repos.env]; edit those directly.`,
    );
    return 0;
  }
  const envPath = isAbsolute(run.repo.envFile)
    ? run.repo.envFile
    : join(run.workspaceDir, run.repo.envFile);
  if (!interactive) {
    log(`ℹ️  This checkout is registered in ${configPath} as "${run.repo.name}".`);
    log(`   Edit ${envPath} to change its settings.`);
    return 0;
  }
  if (!existsSync(envPath)) {
    mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
    writeFileSync(envPath, "", { mode: 0o600 });
  }
  await runInitUpgrade({ ...deps, envPath });
  return 0;
}
