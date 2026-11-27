/**
 * Initialize .devintern-pm configuration in the current directory
 */

import { join } from "node:path";
import { readFile, writeFile, pathExists, mkdir } from "./runtime/fs.js";
import { getModuleDir } from "./runtime/path.js";
import { askConfirm } from "./runtime/stdin.js";
import { findCodeCredentials } from "./code-credentials";

/**
 * Initialize `.devintern-pm` configuration in the current directory.
 *
 * Creates `.devintern-pm/.env` from `.env.example`, migrates values DevIntern Code
 * already has for the project when present, and updates `.gitignore` to exclude secret files.
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

  const migrated = await readDevinternCodeConfig(cwd);

  // Replace values in .env.example with migrated values if available
  const envContent = applyMigratedConfig(envExampleContent, migrated);

  // Write .env file
  await writeFile(envPath, envContent);
  console.log("✅ Created .env configuration file");

  await ensureGitignore(cwd);

  console.log("\n✨ Initialization complete!");
  console.log(`\nNext steps:`);
  console.log(`1. Edit .devintern-pm/.env with your configuration`);
  console.log(`2. Run devpm --interactive to create your first task`);
}

export interface MigratedPmConfig {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
  agentHarness: string;
  agentCliPath: string;
}

function emptyMigratedConfig(): MigratedPmConfig {
  return { jiraBaseUrl: "", jiraEmail: "", jiraApiToken: "", agentHarness: "", agentCliPath: "" };
}

/**
 * Read JIRA_* / AGENT_* values DevIntern Code already has for the project
 * (its workspace entry, or a legacy `.devintern-code/.env`), if any.
 *
 * @param cwd - Project directory to look in.
 * @returns Migrated values, or empty strings when no config is found.
 */
async function readDevinternCodeConfig(cwd: string): Promise<MigratedPmConfig> {
  const code = await findCodeCredentials(cwd);
  if (!code) return emptyMigratedConfig();

  console.log(`📋 Found existing ${code.sourceLabel}`);
  const env = code.env;
  const config: MigratedPmConfig = {
    jiraBaseUrl: env.JIRA_BASE_URL ?? "",
    jiraEmail: env.JIRA_EMAIL ?? "",
    jiraApiToken: env.JIRA_API_TOKEN ?? "",
    agentHarness: env.AGENT_HARNESS ?? "",
    agentCliPath: env.AGENT_CLI_PATH || env.CLAUDE_CLI_PATH || "",
  };

  if (config.jiraBaseUrl || config.jiraEmail || config.jiraApiToken || config.agentCliPath) {
    console.log(`✅ Migrating configuration from ${code.sourceLabel}`);
  }
  return config;
}

/**
 * Apply migrated DevIntern Code values onto the `.env.example` template.
 *
 * @param envContent - `.env.example` template contents.
 * @param config - Migrated values to substitute.
 * @returns Template with migrated values written in.
 */
export function applyMigratedConfig(envContent: string, config: MigratedPmConfig): string {
  // Anchor to whole lines: the template also mentions these keys in comments
  // (e.g. `#   https://... → JIRA_BASE_URL=...`), and an unanchored match would
  // rewrite the comment instead of the setting. A replacer function keeps `$`
  // sequences in a token from being read as replacement patterns.
  const setLine = (content: string, pattern: RegExp, key: string, value: string) =>
    value ? content.replace(pattern, () => `${key}=${value}`) : content;
  let result = envContent;
  result = setLine(result, /^JIRA_BASE_URL=.*$/m, "JIRA_BASE_URL", config.jiraBaseUrl);
  result = setLine(result, /^JIRA_EMAIL=.*$/m, "JIRA_EMAIL", config.jiraEmail);
  result = setLine(result, /^JIRA_API_TOKEN=.*$/m, "JIRA_API_TOKEN", config.jiraApiToken);
  result = setLine(result, /^AGENT_HARNESS=.*$/m, "AGENT_HARNESS", config.agentHarness);
  // The example ships AGENT_CLI_PATH commented out (detection is the default).
  // When migrating an explicit path, write it as an active line.
  result = setLine(result, /^#?\s*AGENT_CLI_PATH=.*$/m, "AGENT_CLI_PATH", config.agentCliPath);
  return result;
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
