import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { detectSandboxProviders } from "@devintern/agent-harness";
import { hasHelpArg } from "../cli/help";
import { flushAnalytics, trackSetupCompleted, trackSetupStarted } from "../observability/analytics";
import { findWorkspaceRepoForCheckout } from "../workspace/manual-run";
import type { ManualWorkspaceRun } from "../workspace/manual-run";
import { workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
import { readOriginRemote, registerManualCheckout } from "../workspace/register-checkout";
import { buildEnvExample, scaffoldProject } from "./scaffold";
import { isInteractive, runInitUpgrade, runInitWizard } from "./wizard";

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
async function initializeProject(): Promise<void> {
  const configDir = resolve(process.cwd(), ".devintern-code");
  let envFile = join(configDir, ".env");
  let settingsHint = `Edit ${join(configDir, "settings.json")} (optional)`;

  console.log("🚀 Initializing @devintern/code for this project...");

  if (await readOriginRemote(process.cwd())) {
    const registered = await registerManualCheckout(process.cwd(), buildEnvExample());
    if (!registered.ok) {
      console.error(`❌ ${registered.error}`);
      return;
    }
    envFile = registered.envPath;
    settingsHint = `Add [trackers] status names to ${join(registered.workspaceDir, "workspace.toml")} (optional)`;
  } else if (!scaffoldProject()) {
    return;
  }
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
      console.log(`\n🔒 Sandbox providers detected: ${names}`);
      console.log(`   Set AGENT_SANDBOX=auto in ${envFile} to run agents isolated.`);
    } else {
      console.log("\n🔓 No sandbox provider detected — agents will run unsandboxed.");
      console.log("   Run 'devintern sandbox' for install options.");
    }
  } catch {
    // Detection is best-effort; init must not fail because of it.
  }

  console.log("\n🎉 Project initialized successfully!");
  console.log("\n📝 Next steps:");
  console.log(`   1. Edit ${envFile}`);
  console.log("      - Add your task tracker credentials (Jira, Linear, etc.)");
  console.log(`   2. ${settingsHint}`);
  console.log("      - Configure per-project status transitions for your tracker");
  console.log(
    "      - The file includes examples for Jira, Linear, Trello, GitHub, Azure DevOps, and Asana",
  );
  console.log("   3. Run 'devintern <TASK-KEY>' to start working on tasks");

  trackSetupCompleted({ signedIn: "skipped" });
}

/**
 * Run `devintern init`: the interactive wizard on a TTY (or the upgrade variant
 * when a project `.env` already exists), otherwise the non-interactive scaffold.
 */
export async function runInitCommand(): Promise<never> {
  if (hasHelpArg(process.argv.slice(2))) {
    console.log(INIT_USAGE);
    process.exit(0);
  }
  const registered = await findWorkspaceRepoForCheckout();
  if (registered) {
    process.exitCode = await updateRegisteredCheckout(registered);
  } else if (isInteractive(process.argv, process.stdin)) {
    if (existsSync(resolve(process.cwd(), ".devintern-code", ".env"))) {
      await runInitUpgrade();
    } else {
      await runInitWizard();
    }
  } else {
    await initializeProject();
  }
  await flushAnalytics();
  process.exit(process.exitCode ?? 0);
}

/**
 * Re-run init in a checkout already registered in the workspace: update its
 * env file. Repos managed by the worker (no `env_file`) are left to the
 * workspace files, so init never edits the shared `.env` worker repos use.
 *
 * @returns Process exit code
 */
async function updateRegisteredCheckout(run: ManualWorkspaceRun): Promise<number> {
  const configPath = workspaceConfigPath(run.workspaceDir);
  if (!run.repo.envFile) {
    console.log(`ℹ️  This checkout is registered in ${configPath} as "${run.repo.name}".`);
    console.log(
      `   Its settings come from ${workspaceEnvPath(run.workspaceDir)} and [repos.env]; edit those directly.`,
    );
    return 0;
  }
  const envPath = isAbsolute(run.repo.envFile)
    ? run.repo.envFile
    : join(run.workspaceDir, run.repo.envFile);
  if (!isInteractive(process.argv, process.stdin)) {
    console.log(`ℹ️  This checkout is registered in ${configPath} as "${run.repo.name}".`);
    console.log(`   Edit ${envPath} to change its settings.`);
    return 0;
  }
  if (!existsSync(envPath)) {
    mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
    writeFileSync(envPath, "", { mode: 0o600 });
  }
  await runInitUpgrade({ envPath });
  return 0;
}
