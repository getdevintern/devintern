/**
 * Initialize .devintern-pm configuration in the current directory
 */

import { join } from "node:path";
import { readFile, writeFile, pathExists, mkdir } from "./runtime/fs.js";
import { getModuleDir } from "./runtime/path.js";
import { askConfirm } from "./runtime/stdin.js";

/**
 * Initialize `.devintern-pm` configuration in the current directory.
 *
 * Creates `.devintern-pm/.env` from `.env.example`, migrates values from `.devintern-code`
 * when present, and updates `.gitignore` to exclude secret files.
 *
 * @returns Resolves when initialization completes; may exit the process if the user cancels overwrite.
 */
export async function initializeProject(): Promise<void> {
  const cwd = process.cwd();
  const devinternPmDir = join(cwd, ".devintern-pm");
  const envPath = join(devinternPmDir, ".env");

  console.log("🚀 Initializing @devintern/pm in current directory...\n");

  // Check if .devintern-pm already exists
  try {
    const stat = await pathExists(devinternPmDir);
    if (stat) {
      console.log("⚠️  .devintern-pm directory already exists");
      const shouldOverwrite = await askConfirm("Overwrite existing configuration?");
      if (!shouldOverwrite) {
        console.log("❌ Initialization cancelled");
        process.exit(0);
      }
    }
  } catch {
    // Directory doesn't exist, continue
  }

  // Create .devintern-pm directory
  await mkdir(devinternPmDir);
  console.log("✅ Created .devintern-pm directory");

  // Copy .env.example from the script's directory
  const scriptDir = getModuleDir(import.meta.url);
  const projectRoot = join(scriptDir, "..");
  const envExamplePath = join(projectRoot, ".env.example");
  const envExampleContent = await readFile(envExamplePath);

  // Check for existing .devintern-code configuration
  const devinternCodeDir = join(cwd, ".devintern-code");
  const devinternCodeEnvPath = join(devinternCodeDir, ".env");

  let jiraBaseUrl = "";
  let jiraEmail = "";
  let jiraApiToken = "";
  let agentHarness = "";
  let agentCliPath = "";

  try {
    if (await pathExists(devinternCodeEnvPath)) {
      console.log("📋 Found existing .devintern-code configuration");
      const devinternCodeEnv = await readFile(devinternCodeEnvPath);

      // Extract JIRA_* and agent configuration values
      const lines = devinternCodeEnv.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          if (trimmed.startsWith("JIRA_BASE_URL=")) {
            jiraBaseUrl = trimmed.split("=", 2)[1]?.trim() || "";
          } else if (trimmed.startsWith("JIRA_EMAIL=")) {
            jiraEmail = trimmed.split("=", 2)[1]?.trim() || "";
          } else if (trimmed.startsWith("JIRA_API_TOKEN=")) {
            jiraApiToken = trimmed.split("=", 2)[1]?.trim() || "";
          } else if (trimmed.startsWith("AGENT_HARNESS=")) {
            agentHarness = trimmed.split("=", 2)[1]?.trim() || "";
          } else if (trimmed.startsWith("AGENT_CLI_PATH=")) {
            agentCliPath = trimmed.split("=", 2)[1]?.trim() || "";
          } else if (trimmed.startsWith("CLAUDE_CLI_PATH=")) {
            agentCliPath = trimmed.split("=", 2)[1]?.trim() || "";
          }
        }
      }

      if (jiraBaseUrl || jiraEmail || jiraApiToken || agentCliPath) {
        console.log("✅ Migrating configuration from .devintern-code");
      }
    }
  } catch {
    // No .devintern-code found, that's fine
  }

  // Replace values in .env.example with migrated values if available
  let envContent = envExampleContent;
  if (jiraBaseUrl) {
    envContent = envContent.replace(/JIRA_BASE_URL=.*/, `JIRA_BASE_URL=${jiraBaseUrl}`);
  }
  if (jiraEmail) {
    envContent = envContent.replace(/JIRA_EMAIL=.*/, `JIRA_EMAIL=${jiraEmail}`);
  }
  if (jiraApiToken) {
    envContent = envContent.replace(/JIRA_API_TOKEN=.*/, `JIRA_API_TOKEN=${jiraApiToken}`);
  }
  if (agentHarness) {
    envContent = envContent.replace(/AGENT_HARNESS=.*/, `AGENT_HARNESS=${agentHarness}`);
  }
  if (agentCliPath) {
    // The example ships AGENT_CLI_PATH commented out (detection is the default).
    // When migrating an explicit path, write it as an active line.
    envContent = envContent.replace(/#?\s*AGENT_CLI_PATH=.*/, `AGENT_CLI_PATH=${agentCliPath}`);
  }

  // Write .env file
  await writeFile(envPath, envContent);
  console.log("✅ Created .env configuration file");

  await ensureGitignore(cwd);

  console.log("\n✨ Initialization complete!");
  console.log(`\nNext steps:`);
  console.log(`1. Edit .devintern-pm/.env with your configuration`);
  console.log(`2. Run devpm --interactive to create your first task`);
}

/**
 * Update (or create) `.gitignore` in `cwd` to exclude `.devintern-pm` secret
 * files. Shared by the non-interactive scaffold and the init wizard.
 */
export async function ensureGitignore(cwd: string, log: (m: string) => void = console.log) {
  const gitignorePath = join(cwd, ".gitignore");

  try {
    if (await pathExists(gitignorePath)) {
      let gitignoreContent = await readFile(gitignorePath);

      const hasEnvIgnored = gitignoreContent.includes(".devintern-pm/.env");
      const hasSessionIgnored = gitignoreContent.includes(".devintern-pm/.auth-session.json");

      if (!hasEnvIgnored || !hasSessionIgnored) {
        if (!gitignoreContent.endsWith("\n")) {
          gitignoreContent += "\n";
        }
        gitignoreContent +=
          "\n# devintern-pm configuration (contains secrets)\n.devintern-pm/.env\n.devintern-pm/.auth-session.json\n";
        await writeFile(gitignorePath, gitignoreContent);
        log("✅ Updated .gitignore to exclude @devintern/pm secret files");
      } else {
        log("ℹ️  .gitignore already contains .devintern-pm");
      }
    } else {
      // Create new .gitignore
      const gitignoreContent =
        "# devintern-pm configuration (contains secrets)\n.devintern-pm/.env\n.devintern-pm/.auth-session.json\n";
      await writeFile(gitignorePath, gitignoreContent);
      log("✅ Created .gitignore with @devintern/pm secret files");
    }
  } catch (error) {
    console.warn(
      "⚠️  Could not update .gitignore:",
      error instanceof Error ? error.message : error,
    );
  }
}
