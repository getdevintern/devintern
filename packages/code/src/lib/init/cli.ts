import { existsSync } from "fs";
import { join, resolve } from "path";
import { detectSandboxProviders } from "@devintern/agent-harness";
import { flushAnalytics, trackSetupCompleted, trackSetupStarted } from "../observability/analytics";
import { scaffoldProject } from "./scaffold";
import { isInteractive, runInitUpgrade, runInitWizard } from "./wizard";

/**
 * Scaffold `.devintern-code/` with env template, settings, and gitignore
 * entries (non-interactive fallback for `init --yes` / piped stdin).
 */
async function initializeProject(): Promise<void> {
  const configDir = resolve(process.cwd(), ".devintern-code");
  const envFile = join(configDir, ".env");
  const settingsFile = join(configDir, "settings.json");

  console.log("🚀 Initializing @devintern/code for this project...");

  if (!scaffoldProject()) {
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
      console.log("   Set AGENT_SANDBOX=auto in .devintern-code/.env to run agents isolated.");
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
  console.log(`   2. Edit ${settingsFile} (optional)`);
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
  if (isInteractive(process.argv, process.stdin)) {
    if (existsSync(resolve(process.cwd(), ".devintern-code", ".env"))) {
      await runInitUpgrade();
    } else {
      await runInitWizard();
    }
  } else {
    await initializeProject();
  }
  await flushAnalytics();
  process.exit(0);
}
