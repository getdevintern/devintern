#!/usr/bin/env node

import { type ChildProcess, execSync } from "child_process";
import { Option, program } from "commander";
import { config } from "dotenv";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  createDefaultSupabaseAuthConfig,
  getAuthenticatedUser,
  login,
  logout,
  requireAuthenticatedUser,
  resolveLogin,
} from "@devintern/auth";
import { checkLicense, requireLicense } from "@devintern/license-check";
import {
  detectIncompleteImplementation,
  detectMaxTurnsReached,
  detectUsageLimit,
  resolveHarness,
  resolveExecutablePathStrict,
  resolveExecutablePathWithRetry,
  spawnReapable,
  reapTree,
  type AgentHarness,
  type ResolvedHarness,
} from "@devintern/agent-harness";
import { isMarkdownFilePath, parseTrelloCardReference } from "@devintern/task-trackers";
import { findEnvFile, resolveConfigDir } from "@devintern/utils";
import { TaskFormatter } from "./lib/task-formatter";
import { GitHubAppAuth } from "./lib/github-app-auth";
import { TaskTrackerManager } from "./lib/task-tracker-manager";
import type { TaskTrackerClient } from "./lib/task-tracker-client";
import { JiraTaskTrackerClient } from "./lib/trackers/jira/jira-task-tracker-client";
import {
  isMarkdownTaskTracker,
  type MarkdownTaskRaw,
} from "./lib/trackers/markdown/markdown-task-tracker-client";
import {
  TRACKER_CAPABILITIES,
  supportedTrackers,
  supportsEstimate,
  supportsQuery,
  trackersSupportingEstimate,
  trackersSupportingQuery,
} from "./lib/tracker-capabilities";
import { parseAsanaTaskReference } from "./lib/trackers/asana/asana-task-tracker-client";
import { parseAzureDevOpsWorkItemReference } from "./lib/trackers/azure-devops/azure-devops-task-tracker-client";
import { parseGitHubIssueReference } from "./lib/trackers/github/github-task-tracker-client";
import { parseLinearIssueReference } from "./lib/trackers/linear/linear-task-tracker-client";
import { LockManager } from "./lib/lock-manager";
import { PRManager } from "./lib/pr-client";
import { Utils } from "./lib/utils";
import { isCommitAlreadyComplete, runAgentHarnessToFixGitHook } from "./lib/git-hook-fixer";
import { runAutoReviewLoop } from "./lib/auto-review-loop";
import { isAutomatedEnvironment } from "./lib/env-detector";
import type { BaseProjectConfig, ProjectSettings, TrackerSection } from "./types/settings";

// Version is injected at build time via --define flag, or read from package.json in dev
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0";

// Get the directory of this script at runtime (works in both ESM and bundled environments)
const __filename_resolved = fileURLToPath(import.meta.url);
const __dirname_resolved = dirname(__filename_resolved);

/**
 * Rename legacy `.claude-intern` project config to `.devintern-code` once.
 */
function migrateLegacyConfigDir(): void {
  const cwd = process.cwd();
  const newDir = resolve(cwd, ".devintern-code");
  const oldDir = resolve(cwd, ".claude-intern");

  if (existsSync(newDir)) return;
  if (existsSync(oldDir)) {
    try {
      renameSync(oldDir, newDir);
      console.log(`ℹ️  Migrated legacy config directory: .claude-intern → .devintern-code`);
    } catch (error) {
      console.warn(
        `⚠️  Failed to migrate legacy config directory .claude-intern: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

interface ProgramOptions {
  claudePath: string;
  agentPath: string;
  envFile?: string;
  git: boolean;
  verbose: boolean;
  maxTurns: string;
  autoCommit: boolean;
  skipClarityCheck: boolean; // New option to skip clarity check
  createPr: boolean; // New option to create pull request
  prTargetBranch: string; // Target branch for PR
  autoReview: boolean; // New option to run automatic PR review loop
  autoReviewIterations: string; // Max iterations for auto-review loop
  query?: string; // Generic query for batch processing
  jql?: string; // Deprecated alias for --query
  skipComments: boolean; // Skip posting comments to task tracker
  skipJiraComments: boolean; // Deprecated alias for --skip-comments
  hookRetries: string; // Number of retries for git hook failures
  estimate: boolean; // Run in estimation mode to add story points
}

interface ClarityAssessment {
  isImplementable: boolean;
  clarityScore: number;
  issues: Array<{
    category: string;
    description: string;
    severity: "critical" | "major" | "minor";
  }>;
  recommendations: string[];
  summary: string;
}

interface EstimationResult {
  storyPoints: number; // 1, 2, 3, 5, 8, 13, 21
  confidence: "high" | "medium" | "low";
  implementationConfidence: number; // 0-10 likelihood AI can implement
  reasoning: string;
  risks: string[];
  unclearAreas: string[];
  summary: string;
}

/**
 * Scaffold `.devintern-code/` with env template, settings, and gitignore entries.
 */
async function initializeProject(): Promise<void> {
  const configDir = resolve(process.cwd(), ".devintern-code");
  const envFile = join(configDir, ".env");
  const envSampleFile = join(configDir, ".env.example");

  console.log("🚀 Initializing @devintern/code for this project...");

  // Check if .devintern-code folder already exists
  if (existsSync(configDir)) {
    console.log(`\n⚠️  Configuration folder already exists: ${configDir}`);

    // Check if .env file exists
    if (existsSync(envFile)) {
      console.log("✅ .env file found");
    } else {
      console.log("⚠️  .env file not found");
    }

    console.log("\n💡 To reconfigure, either:");
    console.log(`   1. Delete the folder: rm -rf ${configDir}`);
    console.log("   2. Or edit the files directly");
    return;
  }

  // Create .devintern-code folder
  try {
    mkdirSync(configDir, { recursive: true });
    console.log(`✅ Created configuration folder: ${configDir}`);
  } catch (error) {
    console.error(`❌ Failed to create configuration folder: ${error}`);
    process.exit(1);
  }

  // Create .env.example file with template
  const envSampleContent = `# @devintern/code Environment Configuration
# Copy this file to .env and update with your actual values

# JIRA Configuration
# Your JIRA instance URL (without trailing slash)
JIRA_BASE_URL=https://your-company.atlassian.net

# Your JIRA email address
JIRA_EMAIL=your-email@company.com

# Your JIRA API token
# Create one at: https://id.atlassian.com/manage-profile/security/api-tokens
# Option 1: Just the API token (will be combined with email above)
JIRA_API_TOKEN=your-api-token-here
# Option 2: If your token already includes email, use format: email@company.com:api-token
# JIRA_API_TOKEN=your-email@company.com:your-api-token-here

# Agent Harness Configuration
# Which AI agent to use: claude-code | opencode | codex | cursor
# Defaults to 'claude-code' if not specified
AGENT_HARNESS=claude-code

# Path to the agent CLI executable (defaults to harness-specific default if not specified)
AGENT_CLI_PATH=claude

# Backward compatibility: CLAUDE_CLI_PATH is still supported as a fallback
# CLAUDE_CLI_PATH=claude

# Note: Agents will be run with --dangerously-skip-permissions and --max-turns (agent-specific)
# This allows for elevated permissions and extended conversations for complex tasks

# Optional: Output Directory Configuration
# Base directory for saving task-related files (defaults to /tmp/devintern-tasks)
# DEVINTERN_OUTPUT_DIR=/tmp/devintern-tasks

# Optional: Enable verbose logging by default
# VERBOSE=true

# Optional: Pull Request Integration
#
# Option 1: GitHub Personal Access Token (for individual users)
# Create at: https://github.com/settings/tokens
# Required permissions:
#   - Classic token: 'repo' scope (or 'public_repo' for public repos only)
#   - Fine-grained token (recommended): 'Pull requests: Read and write' + 'Contents: Read'
# GITHUB_TOKEN=your-github-token-here
#
# Option 2: GitHub App Authentication (for organizations)
# Each organization creates their own GitHub App for centralized control.
# Create at: https://github.com/settings/apps (or your org's settings)
# Required App permissions:
#   - Repository permissions:
#     - Contents: Read (to check branches)
#     - Pull requests: Read and write (to create PRs)
# After creating the App, generate a private key and install the App on your repositories.
#
# GITHUB_APP_ID=123456
# Private key can be provided as a file path:
# GITHUB_APP_PRIVATE_KEY_PATH=/path/to/your-app.private-key.pem
# Or as base64-encoded content (useful for CI/CD environments):
# To encode: base64 -i your-key.pem (macOS) or base64 -w 0 your-key.pem (Linux)
# GITHUB_APP_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTi4uLg==
#
# Note: If both GITHUB_TOKEN and GitHub App credentials are set, GITHUB_TOKEN takes precedence.

# Bitbucket app password for creating pull requests
# Create at: https://bitbucket.org/account/settings/app-passwords/
# Required permissions: 'Repositories: Write'
# BITBUCKET_TOKEN=your-bitbucket-app-password-here

# Note: Bitbucket workspace is automatically detected from your git remote URL

# Optional: License Key
# You can purchase a license at https://devintern.com/pricing
# Required for unattended automation (systemd, cron, CI, webhook server); interactive use needs no license
# License keys start with CODE-****
# LICENSE_KEY=CODE-XXXX-XXXX-XXXX-XXXX
`;

  try {
    writeFileSync(envSampleFile, envSampleContent, "utf8");
    console.log(`✅ Created template file: ${envSampleFile}`);
  } catch (error) {
    console.error(`❌ Failed to create .env.example: ${error}`);
    process.exit(1);
  }

  // Create empty .env file for user to fill in
  try {
    writeFileSync(envFile, envSampleContent, "utf8");
    console.log(`✅ Created configuration file: ${envFile}`);
  } catch (error) {
    console.error(`❌ Failed to create .env file: ${error}`);
    process.exit(1);
  }

  // Create settings.json for per-project configuration
  const settingsFile = join(configDir, "settings.json");
  const settingsContent = {
    jira: {
      projects: {
        "PROJECT-KEY": {
          inProgressStatus: "In Progress",
          todoStatus: "To Do",
          prStatus: "In Review",
          storyPointsField: "customfield_10016",
        },
      },
    },
    linear: {
      projects: {
        "TEAM-KEY": {
          inProgressStatus: "In Progress",
          todoStatus: "Backlog",
          prStatus: "In Review",
        },
      },
    },
    trello: {
      projects: {
        "BOARD-KEY": {
          inProgressStatus: "Doing",
          todoStatus: "To Do",
          prStatus: "Code Review",
        },
      },
    },
    github: {
      projects: {
        "REPO-KEY": {
          inProgressStatus: "in progress",
          todoStatus: "todo",
          prStatus: "in review",
        },
      },
    },
    "azure-devops": {
      projects: {
        "PROJECT-KEY": {
          inProgressStatus: "Active",
          todoStatus: "New",
          prStatus: "Resolved",
        },
      },
    },
    asana: {
      projects: {
        "PROJECT-KEY": {
          inProgressStatus: "In Progress",
          todoStatus: "Backlog",
          prStatus: "In Review",
        },
      },
    },
  };

  const settingsJsonString = JSON.stringify(settingsContent, null, 2);

  try {
    writeFileSync(settingsFile, settingsJsonString, "utf8");
    console.log(`✅ Created settings file: ${settingsFile}`);
  } catch (error) {
    console.error(`❌ Failed to create settings.json: ${error}`);
    process.exit(1);
  }

  // Update .gitignore to exclude .devintern-code/.env, lock file, and review worktree
  const gitignorePath = join(process.cwd(), ".gitignore");
  const gitignoreEntries = [
    ".devintern-code/.env",
    ".devintern-code/.env.local",
    ".devintern-code/.pid.lock",
    ".devintern-code/.auth-session.json",
  ];

  try {
    let gitignoreContent = "";
    let gitignoreExists = false;

    // Read existing .gitignore if it exists
    if (existsSync(gitignorePath)) {
      gitignoreContent = readFileSync(gitignorePath, "utf8");
      gitignoreExists = true;
    }

    // Check if entries already exist
    const entriesToAdd = gitignoreEntries.filter((entry) => !gitignoreContent.includes(entry));

    if (entriesToAdd.length > 0) {
      // Add entries to .gitignore
      const newEntries = ["", "# @devintern/code - Keep credentials secure", ...entriesToAdd].join(
        "\n",
      );

      // Ensure there's a newline at the end of existing content if it exists
      if (gitignoreContent && !gitignoreContent.endsWith("\n")) {
        gitignoreContent += "\n";
      }

      writeFileSync(gitignorePath, gitignoreContent + newEntries + "\n", "utf8");
      console.log(`✅ Updated .gitignore to exclude ${entriesToAdd.join(", ")}`);
    } else if (gitignoreExists) {
      console.log("✅ .gitignore already excludes .devintern-code/.env");
    }
  } catch (error) {
    console.warn(`⚠️  Could not update .gitignore automatically: ${error}`);
    console.log("   Please manually add '.devintern-code/.env' to your .gitignore");
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
}

/**
 * Load per-project workflow settings from `.devintern-code/settings.json`.
 *
 * @returns Parsed settings, or `null` when missing or invalid
 */
function loadProjectSettings(): ProjectSettings | null {
  const settingsPath = resolve(process.cwd(), ".devintern-code", "settings.json");

  if (!existsSync(settingsPath)) {
    return null;
  }

  try {
    const settingsContent = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(settingsContent) as ProjectSettings;
    return settings;
  } catch (error) {
    console.warn(`⚠️  Failed to parse settings.json: ${error}`);
    return null;
  }
}

/**
 * Resolve the active tracker type from environment.
 */
function getActiveTrackerType(): string {
  return (process.env.TASK_TRACKER || "jira").toLowerCase();
}

function normalizeTaskKeys(keys: string[]): string[] {
  const trackerType = getActiveTrackerType();
  if (trackerType === "trello") {
    return keys.map(parseTrelloCardReference);
  }
  if (trackerType === "linear") {
    return keys.map((key) => parseLinearIssueReference(key) ?? key);
  }
  if (trackerType === "github") {
    return keys.map((key) => parseGitHubIssueReference(key) ?? key);
  }
  if (trackerType === "azure-devops") {
    return keys.map((key) => parseAzureDevOpsWorkItemReference(key) ?? key);
  }
  if (trackerType === "asana") {
    return keys.map((key) => parseAsanaTaskReference(key) ?? key);
  }
  return keys;
}

function resolveProjectKey(taskKey: string, task?: { raw: unknown }): string {
  const trackerType = getActiveTrackerType();
  if (trackerType === "trello") {
    const raw = task?.raw as
      | { idBoard?: string; board?: { id?: string; shortLink?: string } }
      | undefined;
    const boardKey = raw?.board?.shortLink ?? raw?.idBoard ?? process.env.TRELLO_DEFAULT_BOARD_ID;
    if (boardKey) {
      return boardKey;
    }
  }
  if (trackerType === "github" && process.env.GITHUB_REPO) {
    return process.env.GITHUB_REPO;
  }
  if (trackerType === "azure-devops" && process.env.AZURE_DEVOPS_PROJECT) {
    return process.env.AZURE_DEVOPS_PROJECT;
  }
  if (trackerType === "asana") {
    const raw = task?.raw as { memberships?: Array<{ project?: { gid?: string } }> } | undefined;
    const projectGid =
      raw?.memberships?.find((m) => m.project?.gid)?.project?.gid ??
      process.env.ASANA_DEFAULT_PROJECT_GID;
    if (projectGid) {
      return projectGid;
    }
  }
  return taskKey.split("-")[0] ?? taskKey;
}

function printMissingEnvHelp(): void {
  console.error("\nPlease ensure you have a .env file in one of these locations:");
  console.error(
    `   - Project-specific: ${resolve(process.cwd(), ".devintern-code", ".env")} (or in any parent directory)`,
  );
  console.error(
    `   - Current directory: ${resolve(process.cwd(), ".env")} (or in any parent directory)`,
  );
  console.error(`   - Home directory: ${resolve(process.env.HOME || "~", ".env")}`);
  console.error("\nOr specify a custom .env file with --env-file <path>");
  console.error("Or set these environment variables in your shell.");
  console.error("\n💡 Quick start: Run 'devintern init' to create project-specific configuration");
}

/**
 * Resolve tracker-specific project configuration from settings.
 *
 * Checks the tracker-specific section first (e.g., `settings.jira.projects`),
 * then falls back to the legacy top-level `projects` map for backward
 * compatibility when the active tracker is Jira.
 */
function resolveProjectConfig(
  projectKey: string,
  settings: ProjectSettings | null,
  trackerType?: string,
): BaseProjectConfig | undefined {
  if (!settings) {
    return undefined;
  }

  const tracker = trackerType ? trackerType.toLowerCase() : getActiveTrackerType();

  // 1. Check tracker-specific section first
  const trackerSection = settings[tracker as keyof ProjectSettings];
  if (trackerSection && typeof trackerSection === "object" && "projects" in trackerSection) {
    const projects = (trackerSection as TrackerSection).projects;
    if (projects) {
      const config = projects[projectKey];
      if (config) {
        return config;
      }

      // Trello cards expose a 24-char idBoard; settings often use the board short link.
      if (tracker === "trello") {
        const defaultBoardId = process.env.TRELLO_DEFAULT_BOARD_ID;
        if (defaultBoardId && defaultBoardId !== projectKey && projects[defaultBoardId]) {
          return projects[defaultBoardId];
        }

        const projectKeys = Object.keys(projects);
        if (projectKeys.length === 1 && projectKeys[0]) {
          return projects[projectKeys[0]];
        }
      }
    }
  }

  // 2. Fall back to legacy top-level `projects` for Jira backward compatibility.
  //    The legacy map was originally Jira-only, so we only fall back for Jira.
  if (tracker === "jira" && settings.projects) {
    return settings.projects[projectKey];
  }

  return undefined;
}

/** Resolve the status name to use after PR creation for a project. */
function getPrStatusForProject(
  projectKey: string,
  settings: ProjectSettings | null,
): string | undefined {
  return resolveProjectConfig(projectKey, settings)?.prStatus;
}

/** Resolve the "In Progress" status name for a project. */
function getInProgressStatusForProject(
  projectKey: string,
  settings: ProjectSettings | null,
): string | undefined {
  return resolveProjectConfig(projectKey, settings)?.inProgressStatus;
}

/** Resolve the "To Do" status name for a project. */
function getTodoStatusForProject(
  projectKey: string,
  settings: ProjectSettings | null,
): string | undefined {
  return resolveProjectConfig(projectKey, settings)?.todoStatus;
}

/** Return an optional story-points custom field override from project settings. */
function getStoryPointsFieldForProject(
  projectKey: string,
  settings: ProjectSettings | null,
): string | undefined {
  return resolveProjectConfig(projectKey, settings)?.storyPointsField;
}

let loadedEnvPath: string | null = null;

/**
 * Load environment variables from standard locations or a custom file.
 *
 * Searches upward from the current working directory for the nearest
 * `.devintern-code/.env`, then plain `.env`. Falls back to home directory
 * and package directory if no project config is found.
 *
 * @param envFile - Optional explicit `.env` path (exits on missing file)
 * @returns Path to the loaded .env file, or `null` if none was found
 */
function loadEnvironment(envFile?: string): string | null {
  // If user specified a custom env file, use that first
  if (envFile) {
    const customEnvPath = resolve(envFile);
    if (existsSync(customEnvPath)) {
      config({ path: customEnvPath });
      console.log(`📁 Loaded environment from custom file: ${customEnvPath}`);
      return customEnvPath;
    }
    console.error(`❌ Specified .env file not found: ${customEnvPath}`);
    process.exit(1);
  }

  // Otherwise, search upward from cwd for the nearest .env file
  const envPath = findEnvFile({ configDirName: ".devintern-code" });

  if (envPath) {
    config({ path: envPath });
    return envPath;
  }

  // Final fallback: home directory and package directory
  const fallbackPaths = [
    resolve(process.env.HOME || "~", ".env"),
    resolve(__dirname_resolved, "..", ".env"),
  ];

  for (const fallbackPath of fallbackPaths) {
    if (existsSync(fallbackPath)) {
      config({ path: fallbackPath });
      return fallbackPath;
    }
  }

  return null;
}

/** Build Supabase auth config pointing at the project session file. */
function loadSupabaseConfig() {
  const configDir = resolveConfigDir({ configDirName: ".devintern-code" });
  return createDefaultSupabaseAuthConfig(join(configDir, ".auth-session.json"));
}

// Migrate legacy config directory on startup
migrateLegacyConfigDir();

// Check if running subcommands before parsing
// This needs to happen early to avoid Commander treating them as task keys
if (process.argv[2] === "init") {
  (async () => {
    await initializeProject();
    process.exit(0);
  })();
} else if (process.argv[2] === "serve") {
  // Handle serve command - start webhook server
  (async () => {
    // Load environment for webhook server
    loadedEnvPath = loadEnvironment();

    // Parse serve-specific options
    const args = process.argv.slice(3);
    let port = parseInt(process.env.WEBHOOK_PORT || "3000", 10);
    let host = process.env.WEBHOOK_HOST || "0.0.0.0";

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--port" && args[i + 1]) {
        port = parseInt(args[i + 1], 10);
        i++;
      } else if (args[i] === "--host" && args[i + 1]) {
        host = args[i + 1];
        i++;
      } else if (args[i] === "--help" || args[i] === "-h") {
        console.log("Usage: devintern serve [options]");
        console.log("");
        console.log("Start the webhook server to automatically address PR review feedback");
        console.log("");
        console.log("Options:");
        console.log("  --port <port>  Port to listen on (default: 3000, or WEBHOOK_PORT env var)");
        console.log("  --host <host>  Host to bind to (default: 0.0.0.0, or WEBHOOK_HOST env var)");
        console.log("  -h, --help     Display this help message");
        console.log("");
        console.log("Environment variables:");
        console.log(
          "  WEBHOOK_SECRET      (required) Secret for verifying GitHub webhook signatures",
        );
        console.log("  WEBHOOK_PORT        Port to listen on (default: 3000)");
        console.log("  WEBHOOK_HOST        Host to bind to (default: 0.0.0.0)");
        console.log(
          "  WEBHOOK_AUTO_REPLY  Set to 'true' to automatically reply to review comments",
        );
        console.log("  WEBHOOK_VALIDATE_IP Set to 'true' to only accept requests from GitHub IPs");
        console.log("  WEBHOOK_DEBUG       Set to 'true' for verbose logging");
        console.log("");
        console.log("See docs/WEBHOOK-DEPLOYMENT.md for deployment instructions.");
        process.exit(0);
      }
    }

    // License check — the webhook server is unattended automation, so it
    // always requires an automation license.
    const supabaseConfig = loadSupabaseConfig();
    const licenseResult = await checkLicense({
      productKey: "devintern/code",
      supabaseConfig,
      requireAutomation: true,
    });
    requireLicense(licenseResult);

    // Import and start webhook server
    const { startWebhookServer } = await import("./webhook-server");
    startWebhookServer({ port, host });
  })();
} else if (process.argv[2] === "address-review") {
  // Handle address-review command - manually address PR review feedback
  (async () => {
    // Load environment
    loadedEnvPath = loadEnvironment();

    // Parse address-review options
    const args = process.argv.slice(3);
    let prUrl: string | undefined;
    let noPush = false;
    let noReply = false;
    let verbose = false;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--no-push") {
        noPush = true;
      } else if (args[i] === "--no-reply") {
        noReply = true;
      } else if (args[i] === "-v" || args[i] === "--verbose") {
        verbose = true;
      } else if (args[i] === "--help" || args[i] === "-h") {
        console.log("Usage: devintern address-review <pr-url> [options]");
        console.log("");
        console.log("Manually address PR review feedback using Agent");
        console.log("");
        console.log("Arguments:");
        console.log(
          "  pr-url         GitHub PR URL (e.g., https://github.com/owner/repo/pull/123)",
        );
        console.log("");
        console.log("Options:");
        console.log("  --no-push      Don't push changes after fixing");
        console.log("  --no-reply     Don't post a reply comment on the PR");
        console.log("  -v, --verbose  Enable verbose logging");
        console.log("  -h, --help     Display this help message");
        console.log("");
        console.log("Examples:");
        console.log("  devintern address-review https://github.com/owner/repo/pull/123");
        console.log("  devintern address-review https://github.com/owner/repo/pull/123 --no-push");
        process.exit(0);
      } else if (!args[i].startsWith("-")) {
        prUrl = args[i];
      }
    }

    if (!prUrl) {
      console.error("❌ Error: PR URL is required");
      console.error("");
      console.error("Usage: devintern address-review <pr-url>");
      console.error("Run 'devintern address-review --help' for more information.");
      process.exit(1);
    }

    // Import and run address-review
    const { addressReview } = await import("./lib/address-review");
    try {
      await addressReview(prUrl, { noPush, noReply, verbose });
    } catch (error) {
      console.error(`❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  })();
} else if (process.argv[2] === "login") {
  (async () => {
    try {
      const supabaseConfig = loadSupabaseConfig();
      const resolved = await resolveLogin(process.argv);
      const user = await login(supabaseConfig, resolved);
      console.log(`✅ Signed in as ${user.email || user.id}`);
      process.exit(0);
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
      process.exit(1);
    }
  })();
} else if (process.argv[2] === "logout") {
  (async () => {
    const supabaseConfig = loadSupabaseConfig();
    await logout(supabaseConfig);
    console.log("✅ Signed out");
    process.exit(0);
  })();
} else if (process.argv[2] === "whoami") {
  (async () => {
    const supabaseConfig = loadSupabaseConfig();
    const user = await getAuthenticatedUser(supabaseConfig);
    if (!user) {
      console.log("Not signed in. Run `devintern login`.");
      process.exit(0);
    }
    console.log(`Signed in as ${user.email || user.id}`);
    process.exit(0);
  })();
} else {
  // Load environment variables early (before CLI parsing)
  loadedEnvPath = loadEnvironment();
}

/**
 * Resolve the configured agent harness and normalize its executable path.
 *
 * @param providedPath - Optional CLI path override from flags
 */
function resolveAgentHarness(providedPath?: string): ResolvedHarness {
  const harness = resolveHarness({ cliPath: providedPath });
  harness.path = resolveExecutablePathStrict(harness.path, harness.harness.displayName);
  return harness;
}

// Configure CLI
program
  .name("devintern")
  .description(
    "Your AI intern for automatically implementing tasks using Agent Harness. Supports single tasks, multiple tasks, or query-based batch processing.",
  )
  .version(VERSION)
  .argument(
    "[task-keys...]",
    "One or more task keys (Jira: PROJ-123; Linear: ENG-42 or issue URL; GitHub: 123, #123, or issue URL; Trello: card short link, full card URL, or 24-char ID), local markdown file paths (./task.md), or use --query for batch selection",
  )
  .option(
    "--query <query>",
    'Query to fetch multiple tasks (syntax depends on tracker; Jira: JQL, e.g., "project = PROJ AND status = \'To Do\'"; Linear: JSON IssueFilter or plain text; GitHub: search qualifiers, e.g., "is:open label:bug")',
  )
  .addOption(new Option("--jql <query>", "JQL query to fetch multiple Jira issues").hideHelp())
  .option("--agent-path <path>", "Path to the AI agent CLI executable")
  .addOption(new Option("--claude-path <path>", "Path to Claude CLI executable").hideHelp())
  .option("--env-file <path>", "Path to .env file")
  .option("--no-git", "Skip git branch creation")
  .option("-v, --verbose", "Verbose output")
  .option("--max-turns <number>", "Maximum number of turns for Agent", "500")
  .option("--no-auto-commit", "Skip automatic git commit after Agent completes")
  .option("--skip-clarity-check", "Skip running Agent for clarity assessment")
  .option("--create-pr", "Create pull request after implementation")
  .option("--pr-target-branch <branch>", "Target branch for pull request", "main")
  .option("--auto-review", "Run automatic PR review loop after creating PR (requires --create-pr)")
  .option("--auto-review-iterations <number>", "Maximum iterations for auto-review loop", "5")
  .option("--skip-comments", "Skip posting comments to the task tracker (for testing)")
  .addOption(new Option("--skip-jira-comments", "Skip posting comments to JIRA").hideHelp())
  .option("--hook-retries <number>", "Number of retry attempts for git hook failures", "10")
  .option(
    "--estimate",
    "Run in estimation mode to add story points estimates to tasks (Jira, Linear, Azure DevOps, Asana via custom field; GitHub posts comment-only estimates)",
  );

program.addHelpText(
  "after",
  `
Examples (Jira):
  devintern PROJ-123 --create-pr
  devintern PROJ-123 PROJ-456 PROJ-789 --create-pr
  devintern --query "project = PROJ AND status = 'To Do'" --create-pr

Examples (Linear; set TASK_TRACKER=linear in .devintern-code/.env):
  devintern ENG-42 --create-pr
  devintern https://linear.app/acme/issue/ENG-42/issue-slug --create-pr
  devintern --query '{"state":{"name":{"eq":"Todo"}}}' --create-pr
  devintern --query "login bug" --create-pr

Examples (GitHub Issues; set TASK_TRACKER=github and GITHUB_REPO in .devintern-code/.env):
  devintern 123 --create-pr
  devintern https://github.com/acme/webapp/issues/123 --create-pr
  devintern --query "is:open label:bug" --create-pr

Examples (Azure DevOps; set TASK_TRACKER=azure-devops in .devintern-code/.env):
  devintern 4211 --create-pr
  devintern https://dev.azure.com/my-org/MyProject/_workitems/edit/4211 --create-pr
  devintern --query "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'New'" --create-pr

Examples (Asana; set TASK_TRACKER=asana in .devintern-code/.env):
  devintern 1200000000000001 --create-pr
  devintern https://app.asana.com/0/1200000000000000/1200000000000001 --create-pr
  devintern --query 'section:"To Do" completed:false' --create-pr

Examples (Trello; set TASK_TRACKER=trello in .devintern-code/.env):
  devintern 4uWKPOTv --create-pr
  devintern https://trello.com/c/4uWKPOTv/card-slug --create-pr
  devintern --query 'list:"To Do" is:open' --create-pr

Examples (Markdown; no PM credentials required for file paths):
  devintern ./tasks/feature-spec.md --no-git
  devintern /path/to/my-task.md --create-pr
  devintern ./epic.md ./subtask-a.md ./subtask-b.md --no-git

Examples (Markdown tracker; set TASK_TRACKER=markdown and MARKDOWN_TASKS_DIR in .devintern-code/.env):
  devintern 2025-01-01T12-00-00-abcd-my-feature --create-pr
  devintern --query "status=todo" --create-pr

Subcommands:
  init                 Initialize .devintern-code configuration in current directory
  serve                Start the webhook server to address PR review feedback
  address-review       Address review feedback on an existing pull request
  login [method]       Sign in (github | google | x | email; prompts if omitted)
  logout               Clear local auth session
  whoami               Show current authenticated user

Run 'devintern <subcommand> --help' for subcommand-specific options.`,
);

// Only parse with Commander if we're not running a subcommand
const isSubcommand = ["init", "serve", "address-review", "login", "logout", "whoami"].includes(
  process.argv[2],
);
if (!isSubcommand) {
  program.parse();
}

const options = isSubcommand ? ({} as ProgramOptions) : program.opts<ProgramOptions>();
const taskKeys = isSubcommand ? [] : program.args;

// Map deprecated options to their canonical equivalents
if (options.jql && !options.query) {
  process.stderr.write("⚠️  --jql is deprecated, use --query instead\n");
  options.query = options.jql;
}
if (options.skipJiraComments && !options.skipComments) {
  process.stderr.write("⚠️  --skip-jira-comments is deprecated, use --skip-comments instead\n");
  options.skipComments = true;
}

// Reload environment variables if custom env file was specified
if (options.envFile) {
  loadedEnvPath = loadEnvironment(options.envFile);
} else if (options.verbose) {
  if (loadedEnvPath) {
    console.log(`📁 Loaded environment from: ${loadedEnvPath}`);
  } else {
    console.log("⚠️  No .env file found in standard locations");
    console.log("   Searched upward from current directory, then home and package directories.");
  }
}

// Resolve the final agent harness
const resolvedAgent = resolveAgentHarness(options.agentPath || options.claudePath);
if (options.verbose) {
  console.log(`🤖 ${resolvedAgent.harness.displayName} resolved to: ${resolvedAgent.path}`);
}

/**
 * Ensure required environment variables for the configured task tracker are present.
 *
 * Supports `TASK_TRACKER=jira` (default), `trello`, or `markdown`.
 *
 * @throws Exits the process when variables are missing
 */
function validateEnvironment(): void {
  const trackerType = (process.env.TASK_TRACKER || "jira").toLowerCase();
  const capabilities = TRACKER_CAPABILITIES[trackerType];

  if (!capabilities) {
    console.error(`❌ Unsupported task tracker: "${trackerType}"`);
    console.error(`   Supported values: ${supportedTrackers().join(", ")}`);
    process.exit(1);
  }

  const missing = capabilities.requiredEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`❌ Missing required ${capabilities.displayName} environment variables:`);
    missing.forEach((key) => console.error(`   - ${key}`));
    printMissingEnvHelp();
    process.exit(1);
  }
}

/**
 * Thrown when the agent hits an account-wide usage/rate limit. Since every
 * remaining task in a batch would fail identically, callers abort the batch
 * rather than retrying immediately.
 */
class UsageLimitError extends Error {
  constructor(public readonly resetHint?: string) {
    super(`Agent usage limit reached${resetHint ? ` (resets ${resetHint})` : ""}`);
    this.name = "UsageLimitError";
  }
}

/**
 * Run the full implementation workflow for one JIRA task key.
 *
 * @param taskKey - JIRA issue key
 * @param taskIndex - Zero-based index in a batch run
 * @param totalTasks - Total tasks in the batch
 */
async function processSingleTask(taskKey: string, taskIndex = 0, totalTasks = 1): Promise<void> {
  try {
    const taskPrefix = totalTasks > 1 ? `[${taskIndex + 1}/${totalTasks}] ` : "";
    const markdownInput = isMarkdownFilePath(taskKey);

    if (!markdownInput) {
      validateEnvironment();
    }

    const tracker = new TaskTrackerManager().getClient(taskKey);

    if (options.verbose && !markdownInput) {
      console.log("📥 Fetching task details...");
    }

    if (!markdownInput) {
      console.log(`${taskPrefix}🔍 Fetching task: ${taskKey}`);
    }

    const task = await tracker.getTask(taskKey);
    const workflowKey = task.key;

    if (markdownInput && isMarkdownTaskTracker(tracker)) {
      const raw = task.raw as MarkdownTaskRaw;
      console.log(`${taskPrefix}📄 Processing markdown file: ${raw.filePath}`);
    }

    // Load project settings to get status transitions
    const projectSettings = loadProjectSettings();
    const projectKey = resolveProjectKey(workflowKey, task);

    // Check if incomplete implementation comment exists with unchanged description
    // If so, skip processing to avoid redundant work
    if (!options.skipComments && !isMarkdownTaskTracker(tracker)) {
      console.log("🔍 Checking for previous incomplete implementation attempts...");

      const descriptionText = tracker.extractDescriptionText(task);

      const hasDuplicate = await tracker.hasIncompleteImplementationComment(
        workflowKey,
        descriptionText,
      );

      if (hasDuplicate) {
        console.log(
          `\n⏭️  Skipping ${workflowKey} - incomplete implementation comment already exists`,
        );
        console.log("   Task description hasn't changed since last incomplete attempt");
        console.log("   Please update the task description with more details before retrying");
        console.log();

        // For batch processing, just return to continue with next task
        // For single task processing, this will end execution
        if (totalTasks > 1) {
          return;
        }
        // Release lock before exiting
        if (lockManager) {
          lockManager.release();
        }
        process.exit(0);
      }
    }

    if (!isMarkdownTaskTracker(tracker)) {
      if (options.verbose) {
        console.log("💬 Fetching comments...");
      }
      console.log("💬 Fetching comments...");
    }
    const comments = await tracker.getComments(workflowKey);
    if (!isMarkdownTaskTracker(tracker)) {
      console.log(`✅ Successfully fetched ${comments.length} comments`);
    }

    if (!isMarkdownTaskTracker(tracker)) {
      if (options.verbose) {
        console.log("🔗 Extracting linked resources...");
      }
      console.log("🔗 Extracting linked resources...");
    }
    const linkedResources = tracker.extractLinkedResources(task);
    if (!isMarkdownTaskTracker(tracker)) {
      console.log(`✅ Successfully extracted ${linkedResources.length} linked resources`);
    }

    if (!isMarkdownTaskTracker(tracker)) {
      console.log("🔗 Fetching related work items...");
    }
    const relatedIssues = await tracker.getRelatedWorkItems(task);
    if (!isMarkdownTaskTracker(tracker)) {
      console.log(`✅ Successfully fetched ${relatedIssues.length} related work items`);
    }

    if (!isMarkdownTaskTracker(tracker)) {
      console.log("📝 Formatting task details...");
      console.log(
        "🔍 Task structure:",
        JSON.stringify(
          {
            key: task.key,
            summary: task.summary,
            issueType: task.issueType,
          },
          null,
          2,
        ),
      );
    }

    let taskDetails;
    try {
      taskDetails = tracker.formatTaskDetails(task, comments, linkedResources, relatedIssues);
      console.log("✅ Successfully formatted task details");
    } catch (formatError) {
      console.error("❌ Error formatting task details:", formatError);
      throw formatError;
    }

    // Display summary
    console.log("\n📋 Task Summary:");
    console.log(`   Key: ${taskDetails.key}`);
    console.log(`   Summary: ${taskDetails.summary}`);
    console.log(`   Type: ${taskDetails.issueType}`);
    console.log(`   Status: ${taskDetails.status}`);
    if (!isMarkdownTaskTracker(tracker)) {
      console.log(`   Priority: ${taskDetails.priority || "Not specified"}`);
      console.log(`   Assignee: ${taskDetails.assignee || "Unassigned"}`);
    }

    if (linkedResources.length > 0) {
      console.log(`   Linked Resources: ${linkedResources.length} found`);
      if (options.verbose) {
        linkedResources.forEach((resource) => {
          if (resource.url) {
            console.log(`     - ${resource.description}: ${resource.url}`);
          } else if (resource.issueKey) {
            console.log(`     - ${resource.linkType}: ${resource.issueKey}`);
          }
        });
      }
    }

    if (relatedIssues.length > 0) {
      console.log(`   Related Work Items: ${relatedIssues.length} found`);
      if (options.verbose) {
        relatedIssues.forEach((relatedIssue) => {
          console.log(
            `     - ${relatedIssue.linkType}: ${relatedIssue.key} - ${relatedIssue.summary} (${relatedIssue.status})`,
          );
        });
      }
    }

    if (comments.length > 0) {
      console.log(`   Comments: ${comments.length} found`);
    }

    // Extract target branch from task description if present
    // This allows per-task branch targeting via patterns like "Target branch: develop"
    // Falls back to --pr-target-branch CLI option (default: main)
    let effectiveTargetBranch = options.prTargetBranch;
    const descriptionText = tracker.extractDescriptionText(task);
    const extractedBranch = Utils.extractTargetBranch(descriptionText);

    if (extractedBranch) {
      console.log(`   🎯 Detected target branch from description: ${extractedBranch}`);
      if (options.verbose) {
        // Show context around the match for debugging
        const lines = descriptionText?.split("\n") || [];
        const matchingLine = lines.find(
          (line) =>
            line.toLowerCase().includes("target branch") ||
            line.toLowerCase().includes("base branch"),
        );
        if (matchingLine) {
          console.log(
            `      Context: "${matchingLine.substring(0, 100)}${matchingLine.length > 100 ? "..." : ""}"`,
          );
        }
      }
      effectiveTargetBranch = extractedBranch;
    } else {
      console.log(`   🎯 Using target branch: ${effectiveTargetBranch} (from CLI option)`);
    }

    // Validate the target branch actually exists on the remote. A wrong or missing
    // target (e.g. `--pr-target-branch main` on a `master` repo) otherwise makes GitHub
    // reject the PR with "Validation Failed", leaving a pushed branch and no PR. Fall
    // back to the repo's real default branch so the PR target, the feature-branch base,
    // and the auto-review diff base all stay consistent.
    if (
      options.git &&
      !(await Utils.remoteBranchExists(effectiveTargetBranch, { verbose: options.verbose }))
    ) {
      const defaultBranch = await Utils.getMainBranchName();
      if (defaultBranch !== effectiveTargetBranch) {
        console.log(
          `   ⚠️  Target branch '${effectiveTargetBranch}' not found on remote, falling back to '${defaultBranch}'`,
        );
        effectiveTargetBranch = defaultBranch;
      }
    }

    // Create unified task-specific directory structure
    const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
    const taskDir = join(baseOutputDir, workflowKey.toLowerCase());
    const taskFileName = "task-details.md";

    // Create task directory if it doesn't exist
    mkdirSync(taskDir, { recursive: true });

    const outputFile = join(taskDir, taskFileName);
    const attachmentDir = join(taskDir, "attachments");

    // Download attachments automatically - both direct attachments and embedded ones
    let attachmentMap: Map<string, string> | undefined;

    // First, download direct attachments
    if (taskDetails.attachments.length > 0) {
      console.log(`\n📎 Downloading ${taskDetails.attachments.length} direct attachments...`);
      attachmentMap = await tracker.downloadAttachments(workflowKey, attachmentDir);
    } else {
      attachmentMap = new Map<string, string>();
    }

    if (!isMarkdownTaskTracker(tracker)) {
      console.log("\n🔍 Scanning content for embedded attachments...");
    }
    let allHtmlContent = "";

    // Collect all HTML content from descriptions and comments
    if (taskDetails.renderedDescription) {
      allHtmlContent += taskDetails.renderedDescription;
    }

    // Add comments
    taskDetails.comments.forEach((comment) => {
      if (comment.renderedBody) {
        allHtmlContent += comment.renderedBody;
      }
    });

    // Add related issues HTML content
    relatedIssues.forEach((relatedIssue) => {
      if (relatedIssue.renderedDescription) {
        allHtmlContent += relatedIssue.renderedDescription;
      }
    });

    // Download embedded attachments
    if (allHtmlContent) {
      attachmentMap = await tracker.downloadAttachmentsFromContent(
        allHtmlContent,
        attachmentDir,
        attachmentMap,
      );
    }

    if (attachmentMap.size > 0) {
      console.log(`✅ Downloaded ${attachmentMap.size} total attachments to: ${attachmentDir}`);
    }

    if (isMarkdownTaskTracker(tracker)) {
      tracker.writeAgentPrompt(outputFile, task);
      console.log(`\n💾 Saved task details to: ${outputFile}`);
    } else {
      console.log(`\n💾 Saving formatted task details to: ${outputFile}`);
      TaskFormatter.saveFormattedTask(
        taskDetails,
        outputFile,
        process.env.JIRA_BASE_URL!,
        attachmentMap,
      );
    }

    // Create feature branch before running Agent (unless disabled)
    if (options.git) {
      console.log("\n🌿 Creating feature branch...");
      const branchResult = await Utils.createFeatureBranch(workflowKey, effectiveTargetBranch);

      if (branchResult.success) {
        console.log(`✅ ${branchResult.message}`);
      } else {
        // Branch creation failed - this is critical for safety
        console.error(`\n❌ Failed to create feature branch: ${branchResult.message}`);

        if (branchResult.message.includes("uncommitted changes")) {
          console.error("Please commit or stash your changes before running devintern.");
          console.error('You can use: git add . && git commit -m "your commit message"');
        } else {
          console.error(
            "Cannot proceed without a feature branch to prevent accidental commits to main/master.",
          );
          console.error(`\nPlease create a feature branch manually:`);
          console.error(`   git checkout -b feature/${workflowKey.toLowerCase()}`);
          console.error(`\nThen run devintern again with --no-git flag:`);
          console.error(`   devintern ${taskKey} --no-git`);
        }

        // Release lock before exiting
        if (lockManager) {
          lockManager.release();
        }
        process.exit(1);
      }
    }

    // Run clarity check first (unless skipped)
    if (!options.skipClarityCheck) {
      console.log("\n🔍 Running basic feasibility assessment...");
      if (!isMarkdownTaskTracker(tracker)) {
        console.log(
          "   (Checking for fundamental requirements only - technical details will be inferred from code)",
        );
      }

      const clarityInputFile = isMarkdownTaskTracker(tracker)
        ? outputFile
        : join(require("os").tmpdir(), `clarity-${workflowKey.toLowerCase()}-${Date.now()}.md`);

      if (!isMarkdownTaskTracker(tracker)) {
        TaskFormatter.saveClarityAssessment(
          taskDetails,
          clarityInputFile,
          process.env.JIRA_BASE_URL!,
          attachmentMap,
        );
      }

      try {
        const assessment = await runClarityCheck(
          clarityInputFile,
          resolvedAgent.harness,
          resolvedAgent.path,
          workflowKey,
          tracker,
          options.skipComments,
        );

        if (assessment && !assessment.isImplementable) {
          if (totalTasks > 1) {
            console.log(
              `\n⚠️  Task ${workflowKey} failed clarity assessment but continuing with batch processing...`,
            );
          } else {
            if (lockManager) {
              lockManager.release();
            }
            process.exit(1);
          }
        }

        if (!isMarkdownTaskTracker(tracker)) {
          try {
            require("fs").unlinkSync(clarityInputFile);
          } catch {
            /* ignore */
          }
        }
      } catch (clarityError) {
        console.warn("⚠️  Feasibility check failed, continuing with implementation:", clarityError);
        console.log("   You can skip feasibility checks with --skip-clarity-check");

        if (!isMarkdownTaskTracker(tracker)) {
          try {
            require("fs").unlinkSync(clarityInputFile);
          } catch {
            /* ignore */
          }
        }
      }
    }

    // Transition task to "In Progress" now that we're actually starting implementation
    if (isMarkdownTaskTracker(tracker)) {
      const raw = task.raw as MarkdownTaskRaw;
      if (raw.hasStatusField) {
        try {
          console.log(`\n🔄 Updating status in ${basename(raw.filePath)} to 'In Progress'...`);
          await tracker.transitionStatus(workflowKey, "In Progress");
        } catch (statusError) {
          console.warn(`⚠️  Failed to update status: ${(statusError as Error).message}`);
        }
      }
    } else if (!options.skipComments) {
      const inProgressStatus = getInProgressStatusForProject(projectKey, projectSettings);
      if (inProgressStatus && inProgressStatus.trim()) {
        try {
          console.log(`\n🔄 Transitioning ${workflowKey} to '${inProgressStatus}'...`);
          await tracker.transitionStatus(workflowKey, inProgressStatus.trim());
          console.log(`✅ Task moved to '${inProgressStatus}'`);
        } catch (statusError) {
          console.warn(
            `⚠️  Failed to transition task to '${inProgressStatus}': ${
              (statusError as Error).message
            }`,
          );
          console.log("   Continuing with task processing...");
        }
      }
    }

    // Get GitHub App author info for commits if configured
    let gitAuthor: { name: string; email: string } | undefined;
    if (options.git && options.autoCommit && !process.env.GITHUB_TOKEN) {
      const githubAppAuth = GitHubAppAuth.fromEnvironment();
      if (githubAppAuth) {
        try {
          gitAuthor = await githubAppAuth.getGitAuthor();
          console.log(`🤖 Commits will be authored by: ${gitAuthor.name}`);
        } catch (error) {
          console.warn(`⚠️  Could not get GitHub App author info: ${(error as Error).message}`);
          console.log("   Commits will use local git config instead.");
        }
      }
    }

    if (isMarkdownTaskTracker(tracker)) {
      for (const summaryName of [
        "implementation-summary.md",
        "implementation-summary-incomplete.md",
      ]) {
        try {
          unlinkSync(join(taskDir, summaryName));
        } catch {
          /* not present */
        }
      }
    }

    console.log(`\n🤖 Running ${resolvedAgent.harness.displayName} with task details...`);
    await runAgentHarness(
      outputFile,
      resolvedAgent.harness,
      resolvedAgent.path,
      Number.parseInt(options.maxTurns),
      workflowKey,
      taskDetails.summary,
      options.git && options.autoCommit,
      task,
      options.createPr,
      effectiveTargetBranch,
      tracker,
      options.skipComments,
      Number.parseInt(options.hookRetries),
      projectSettings,
      gitAuthor,
      options.autoReview,
      Number.parseInt(options.autoReviewIterations),
    );

    if (isMarkdownTaskTracker(tracker)) {
      await tracker.markDoneIfSuccessful(workflowKey, taskDir);
    }
  } catch (error) {
    // Usage limit: don't treat as a task failure. Propagate in batch so the
    // loop aborts the remaining tasks; for a single task, exit 0 (no-op).
    if (error instanceof UsageLimitError) {
      console.warn(`\n⏳ ${error.message}. Stopping; will retry on the next scheduled run.`);
      if (totalTasks > 1) {
        throw error;
      }
      if (lockManager) {
        lockManager.release();
      }
      process.exit(0);
    }

    const err = error as Error;
    const taskPrefix = totalTasks > 1 ? `[${taskIndex + 1}/${totalTasks}] ` : "";
    console.error(`${taskPrefix}❌ Error processing ${taskKey}: ${err.message}`);
    if (options.verbose && err.stack) {
      console.error(err.stack);
    }

    // For batch processing, throw the error to be handled by the main function
    // For single task processing, exit immediately
    if (totalTasks > 1) {
      throw error;
    }
    process.exit(1);
  }
}

// Global lock manager instance
let lockManager: LockManager | null = null;

/** CLI entry: parse args, acquire lock, and process task key(s) or JQL results. */
async function main(): Promise<void> {
  try {
    // Acquire lock to prevent multiple instances
    lockManager = new LockManager();
    const lockResult = lockManager.acquire();

    if (!lockResult.success) {
      console.error(`❌ ${lockResult.message}`);
      console.error("   Please wait for the other instance to complete or stop it manually.");
      if (lockResult.pid) {
        console.error(`   You can stop the other instance with: kill ${lockResult.pid}`);
      }
      process.exit(1);
    }

    // Check for flags that require specific tracker support before env validation
    const activeTrackerType = (process.env.TASK_TRACKER || "jira").toLowerCase();
    if (options.query && !supportsQuery(activeTrackerType)) {
      console.error(
        `❌ Error: --query is not supported for the '${activeTrackerType}' task tracker. ` +
          `Trackers with query support: ${trackersSupportingQuery().join(", ")}.`,
      );
      process.exit(1);
    }
    if (options.estimate && !supportsEstimate(activeTrackerType)) {
      console.error(
        `❌ Error: --estimate is not supported for the '${activeTrackerType}' task tracker. ` +
          `Trackers with estimation support: ${trackersSupportingEstimate().join(", ")}.`,
      );
      process.exit(1);
    }

    // Validate environment — skip when every argument is a local markdown file path
    // (those tasks need no PM credentials)
    const needsTrackerEnv = options.query || taskKeys.some((k) => !isMarkdownFilePath(k));
    if (needsTrackerEnv) {
      validateEnvironment();
    }

    // License check — interactive use is free under FSL; only unattended
    // execution (systemd, cron, CI) requires an automation license.
    if (isAutomatedEnvironment()) {
      const supabaseConfig = loadSupabaseConfig();
      const licenseResult = await checkLicense({
        productKey: "devintern/code",
        supabaseConfig,
        requireAutomation: true,
      });
      requireLicense(licenseResult);
    }

    // Pull latest changes from remote (unless git is disabled)
    if (options.git) {
      const prTargetBranchSource = program.getOptionValueSource("prTargetBranch");
      if (prTargetBranchSource === "default") {
        options.prTargetBranch = await Utils.getMainBranchName();
        console.log(`   Default branch detected as '${options.prTargetBranch}'`);
      }

      console.log("\n📥 Pulling latest changes from remote...");
      const pullResult = await Utils.pullLatestChanges(options.prTargetBranch, {
        verbose: options.verbose,
      });

      if (pullResult.success) {
        console.log(`✅ ${pullResult.message}`);
      } else {
        // Don't fail the entire workflow if pull fails - just warn the user
        console.log(`⚠️  ${pullResult.message}`);
        console.log("   Continuing without pulling latest changes...");
        console.log("   You may want to pull manually before processing tasks.\n");
      }
    }

    let tasksToProcess: string[] = [];

    // Determine which tasks to process
    if (options.query) {
      console.log(`🔍 Searching task tracker with query: ${options.query}`);

      const tracker = new TaskTrackerManager().getClient();

      const searchResult = await tracker.searchTasks(options.query);

      if (searchResult.tasks.length === 0) {
        console.log("⚠️  No tasks found matching the query");
        return;
      }

      tasksToProcess = searchResult.tasks.map((task) => task.key);
      console.log(
        `📋 Found ${tasksToProcess.length} tasks to process: ${tasksToProcess.join(", ")}`,
      );
    } else if (taskKeys.length > 0) {
      // Individual task keys / file paths mode.
      // File-path arguments are kept as-is; PM task keys are normalised (e.g. Trello ref parsing).
      const pmArgs = taskKeys.filter((k) => !isMarkdownFilePath(k));
      const fileArgs = taskKeys.filter(isMarkdownFilePath);
      tasksToProcess = [...normalizeTaskKeys(pmArgs), ...fileArgs];
      console.log(`📋 Processing ${tasksToProcess.length} task(s): ${tasksToProcess.join(", ")}`);
    } else {
      // No tasks specified
      console.error(
        "❌ Error: No tasks specified. Provide task keys as arguments or use --query option.",
      );
      console.error("   Examples:");
      console.error("     devintern PROJ-123");
      console.error("     devintern PROJ-123 PROJ-124 PROJ-125");
      console.error("     devintern --query \"project = PROJ AND status = 'To Do'\"");
      console.error("     devintern ./tasks/feature-spec.md --no-git");
      console.error("     devintern ./epic.md ./subtask-a.md --no-git");
      process.exit(1);
    }

    // Estimation mode: separate code path
    if (options.estimate) {
      console.log("\n📊 Running in estimation mode...");

      const tracker = new TaskTrackerManager().getClient();

      const projectSettings = loadProjectSettings();
      const estimationResults = {
        total: 0,
        estimated: 0,
        skipped: 0,
        failed: 0,
        errors: [] as Array<{ taskKey: string; error: string }>,
      };

      for (const taskKey of tasksToProcess) {
        try {
          console.log(`\n${"=".repeat(60)}`);
          console.log(`📊 Estimating: ${taskKey}`);

          // Fetch task to check creation date
          const task = await tracker.getTask(taskKey);

          // Skip tasks created less than 24 hours ago
          const createdDate = new Date(task.created);
          const now = new Date();
          const hoursAgo = (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60);

          if (hoursAgo < 24) {
            console.log(`⏭️  Skipping ${taskKey} — created ${hoursAgo.toFixed(1)}h ago (< 24h)`);
            estimationResults.skipped++;
            continue;
          }

          // Check if task already has an estimation comment
          const existingEstimation = await tracker.findEstimationComment(taskKey);
          let existingCommentId: string | undefined;

          if (existingEstimation) {
            // Compare estimation comment date with task updated date
            const estimationDate = new Date(existingEstimation.created);
            const taskUpdated = new Date(task.updated);

            if (taskUpdated <= estimationDate) {
              console.log(`⏭️  Skipping ${taskKey} — already estimated and not updated since`);
              estimationResults.skipped++;
              continue;
            }

            console.log(`🔄 Re-estimating ${taskKey} — task updated since last estimate`);
            existingCommentId = existingEstimation.commentId;
          }

          estimationResults.total++;

          // Fetch comments and linked resources
          const comments = await tracker.getComments(taskKey);
          const linkedResources = tracker.extractLinkedResources(task);
          const relatedIssues = await tracker.getRelatedWorkItems(task);

          // Format task details
          const taskDetails = tracker.formatTaskDetails(
            task,
            comments,
            linkedResources,
            relatedIssues,
          );

          // Create estimation prompt file
          const { tmpdir } = require("os");
          const estimationFile = join(
            tmpdir(),
            `estimation-${taskKey.toLowerCase()}-${Date.now()}.md`,
          );
          TaskFormatter.saveEstimationPrompt(
            taskDetails,
            estimationFile,
            process.env.JIRA_BASE_URL!,
          );

          // Run estimation
          const result = await runEstimation(
            estimationFile,
            resolvedAgent.harness,
            resolvedAgent.path,
            taskKey,
            tracker,
            projectSettings,
            options.skipComments,
            existingCommentId,
          );

          // Clean up temp file
          try {
            require("fs").unlinkSync(estimationFile);
          } catch {
            // Ignore cleanup errors
          }

          if (result) {
            estimationResults.estimated++;
          } else {
            estimationResults.failed++;
            estimationResults.errors.push({
              taskKey,
              error: "Failed to parse estimation response",
            });
          }
        } catch (error) {
          // Usage limit is account-global — abort the rest of the estimation
          // batch and exit 0 so the scheduler retries next window.
          if (error instanceof UsageLimitError) {
            console.warn(`\n⏳ ${error.message}. Aborting estimation batch; will retry next run.`);
            if (lockManager) {
              lockManager.release();
            }
            process.exit(0);
          }

          estimationResults.failed++;
          estimationResults.errors.push({
            taskKey,
            error: (error as Error).message,
          });
          console.error(`❌ Failed to estimate ${taskKey}: ${(error as Error).message}`);
        }
      }

      // Print summary
      console.log(`\n${"=".repeat(60)}`);
      console.log("📊 Estimation Summary:");
      console.log(`   Estimated: ${estimationResults.estimated}`);
      console.log(`   Skipped (< 24h old): ${estimationResults.skipped}`);
      console.log(`   Failed: ${estimationResults.failed}`);

      if (estimationResults.errors.length > 0) {
        console.log("\n❌ Failed estimations:");
        estimationResults.errors.forEach(({ taskKey, error }) => {
          console.log(`   - ${taskKey}: ${error}`);
        });
      }

      // Release lock and exit
      if (lockManager) {
        lockManager.release();
      }
      if (estimationResults.failed > 0) {
        process.exit(1);
      }
      return;
    }

    // Process tasks sequentially
    const results = {
      total: tasksToProcess.length,
      successful: 0,
      failed: 0,
      errors: [] as Array<{ taskKey: string; error: string }>,
    };

    for (let i = 0; i < tasksToProcess.length; i++) {
      const taskKey = tasksToProcess[i];

      try {
        await processSingleTask(taskKey, i, tasksToProcess.length);
        results.successful++;

        if (i < tasksToProcess.length - 1) {
          console.log("\n" + "=".repeat(80));
          console.log("⏭️  Moving to next task...\n");
        }
      } catch (error) {
        // Usage limit is account-global: abort the remaining batch instead of
        // hammering tasks that would all fail. Exit 0 so the scheduler retries
        // next window without marking the run failed.
        if (error instanceof UsageLimitError) {
          const remaining = tasksToProcess.length - i - 1;
          console.warn(
            `\n⏳ ${error.message}. Aborting batch — ${remaining} task(s) left, ` +
              `will resume on the next scheduled run.`,
          );
          if (lockManager) {
            lockManager.release();
          }
          process.exit(0);
        }

        results.failed++;
        results.errors.push({
          taskKey,
          error: (error as Error).message,
        });

        console.log("⚠️  Continuing with remaining tasks...\n");
      }
    }

    // Print summary for batch operations
    if (tasksToProcess.length > 1) {
      console.log("\n" + "=".repeat(80));
      console.log("📊 Batch Processing Summary:");
      console.log(`   Total tasks: ${results.total}`);
      console.log(`   ✅ Successful: ${results.successful}`);
      console.log(`   ❌ Failed: ${results.failed}`);

      if (results.errors.length > 0) {
        console.log("\n❌ Failed tasks:");
        results.errors.forEach(({ taskKey, error }) => {
          console.log(`   - ${taskKey}: ${error}`);
        });
      }

      if (results.failed > 0) {
        // Release lock before exiting
        if (lockManager) {
          lockManager.release();
        }
        process.exit(1);
      }
    }

    // Release lock on successful completion
    if (lockManager) {
      lockManager.release();
    }
  } catch (error) {
    const err = error as Error;
    console.error(`❌ Error: ${err.message}`);
    if (options.verbose && err.stack) {
      console.error(err.stack);
    }
    // Release lock before exiting on error
    if (lockManager) {
      lockManager.release();
    }
    process.exit(1);
  }
}

/**
 * Run a short agent session to assess task clarity and post results to JIRA.
 *
 * @param clarityFile - Path to the clarity assessment prompt file
 * @param harness - Agent harness configuration
 * @param executablePath - Agent CLI executable path
 * @param taskKey - Task tracker issue key
 * @param tracker - Task tracker client
 * @param skipComments - When true, skip posting the assessment comment
 */
async function runClarityCheck(
  clarityFile: string,
  harness: AgentHarness,
  executablePath: string,
  taskKey: string,
  tracker: TaskTrackerClient | undefined,
  skipComments = false,
): Promise<ClarityAssessment | null> {
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the clarity check.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    // Check if clarity file exists
    if (!existsSync(clarityFile)) {
      reject(new Error(`Clarity assessment file not found: ${clarityFile}`));
      return;
    }

    // Read the clarity assessment content
    const clarityContent = readFileSync(clarityFile, "utf8");

    const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

    const clarityArgs = harness.buildArgs({
      maxTurns: 10,
      skipPermissions: true,
      workingDir: process.cwd(),
    });
    console.log(`🔍 Running feasibility assessment with ${harness.displayName}...`);
    console.log(`   Command: ${executablePath} ${clarityArgs.join(" ")}`);
    console.log(`   Input: ${clarityFile}`);

    let stdoutOutput = "";
    let stderrOutput = "";
    let timedOut = false;

    // Spawn agent process for clarity check
    const clarityAgent: ChildProcess = spawnReapable(resolvedPath, clarityArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(
      () => {
        timedOut = true;
        console.error(
          `\n⏰ ${harness.displayName} process timed out after ${timeoutMinutes} minutes, killing...`,
        );
        reapTree(clarityAgent, "SIGTERM");
        setTimeout(() => {
          if (!clarityAgent.killed) {
            reapTree(clarityAgent, "SIGKILL");
          }
        }, 10_000);
      },
      timeoutMinutes * 60 * 1000,
    );

    // Capture stdout for parsing JSON response
    if (clarityAgent.stdout) {
      clarityAgent.stdout.on("data", (data: Buffer) => {
        stdoutOutput += data.toString();
      });
    }

    // Capture stderr for error handling
    if (clarityAgent.stderr) {
      clarityAgent.stderr.on("data", (data: Buffer) => {
        stderrOutput += data.toString();
      });
    }

    // Handle errors
    clarityAgent.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `${harness.displayName} CLI not found at: ${executablePath}\nPlease install ${harness.displayName} or specify the correct path with --agent-path`,
          ),
        );
      } else {
        reject(new Error(`Failed to run ${harness.displayName} clarity check: ${error.message}`));
      }
    });

    // Handle process exit
    clarityAgent.on("close", async (code: number | null) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `${harness.displayName} clarity check timed out after ${timeoutMinutes} minutes`,
          ),
        );
        return;
      }
      if (code === 0) {
        try {
          // Parse the JSON response from agent
          const assessment = parseClarityResponse(stdoutOutput);

          // Save assessment results to task directory for debugging
          try {
            const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
            const taskDir = join(baseOutputDir, taskKey.toLowerCase());
            const assessmentResultFile = join(taskDir, "feasibility-assessment.md");

            // Format assessment as readable markdown
            let assessmentContent = `# Feasibility Assessment Results\n\n`;
            assessmentContent += `**Status**: ${assessment.isImplementable ? "✅ Implementable" : "❌ Not Implementable"}\n`;
            assessmentContent += `**Clarity Score**: ${assessment.clarityScore}/10\n\n`;
            assessmentContent += `## Summary\n\n${assessment.summary}\n\n`;

            if (assessment.issues.length > 0) {
              assessmentContent += `## Issues\n\n`;
              assessment.issues.forEach((issue) => {
                const severityIcon =
                  issue.severity === "critical" ? "🔴" : issue.severity === "major" ? "🟡" : "🔵";
                assessmentContent += `### ${severityIcon} ${issue.category} (${issue.severity})\n\n`;
                assessmentContent += `${issue.description}\n\n`;
              });
            }

            if (assessment.recommendations.length > 0) {
              assessmentContent += `## Recommendations\n\n`;
              assessment.recommendations.forEach((rec, index) => {
                assessmentContent += `${index + 1}. ${rec}\n`;
              });
              assessmentContent += `\n`;
            }

            // Also save raw JSON for programmatic access
            assessmentContent += `## Raw JSON\n\n\`\`\`json\n${JSON.stringify(assessment, null, 2)}\n\`\`\`\n`;

            writeFileSync(assessmentResultFile, assessmentContent, "utf8");
            console.log(`\n💾 Saved feasibility assessment to: ${assessmentResultFile}`);
          } catch (saveError) {
            console.warn(`⚠️  Failed to save feasibility assessment: ${saveError}`);
          }

          if (assessment.isImplementable) {
            console.log("\n✅ Task feasibility assessment passed");
            console.log(`📊 Clarity Score: ${assessment.clarityScore}/10 (threshold: 4/10)`);
            console.log(`📝 Summary: ${assessment.summary}`);
            if (assessment.clarityScore < 7) {
              console.log("💡 Note: Some details may need to be inferred from existing codebase");
            }

            // Post successful assessment to task tracker as well for feedback
            if (tracker && !skipComments) {
              console.log("\n💬 Posting feasibility assessment to task tracker...");
              await postClarityComment(tracker, taskKey, assessment);
            } else {
              console.log("\n⏭️  Skipping feasibility assessment comment (--skip-comments)");
            }
          } else {
            console.log("\n❌ Task feasibility assessment failed");
            console.log(`📊 Clarity Score: ${assessment.clarityScore}/10 (threshold: 4/10)`);
            console.log(`📝 Summary: ${assessment.summary}`);

            if (assessment.issues.length > 0) {
              console.log("\n🚨 Critical issues identified:");
              assessment.issues.forEach((issue) => {
                const severityIcon =
                  issue.severity === "critical" ? "🔴" : issue.severity === "major" ? "🟡" : "🔵";
                console.log(`   ${severityIcon} ${issue.category}: ${issue.description}`);
              });
            }

            if (assessment.recommendations.length > 0) {
              console.log("\n💡 Recommendations:");
              assessment.recommendations.forEach((rec, index) => {
                console.log(`   ${index + 1}. ${rec}`);
              });
            }

            // Post comment to task tracker with clarity issues
            if (tracker && !skipComments) {
              await postClarityComment(tracker, taskKey, assessment);
            } else {
              console.log("\n⏭️  Skipping failed assessment comment (--skip-comments)");
            }

            console.log("\n🛑 Stopping execution - fundamental requirements unclear");
            console.log("   Please address the critical issues and run again");
            console.log("   Or use --skip-clarity-check to bypass this assessment");
          }

          resolve(assessment);
        } catch (parseError) {
          console.warn("Failed to parse clarity assessment response:", parseError);
          console.log("Raw Agent output:", stdoutOutput);

          // Save failed assessment output for debugging
          try {
            const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
            const taskDir = join(baseOutputDir, taskKey.toLowerCase());
            const failedAssessmentFile = join(taskDir, "feasibility-assessment-failed.txt");

            writeFileSync(failedAssessmentFile, stdoutOutput, "utf8");
            console.log(`\n💾 Saved failed assessment output to: ${failedAssessmentFile}`);
          } catch (saveError) {
            console.warn(`⚠️  Failed to save assessment output: ${saveError}`);
          }

          // Check if Agent reached max turns or had other issues
          if (detectMaxTurnsReached(stdoutOutput, stderrOutput)) {
            console.log("\n⚠️  Clarity assessment reached maximum conversation turns");
            console.log("   This may indicate task complexity or insufficient details");
            if (!skipComments) {
              console.log(
                "   Will attempt to proceed with implementation but posting failure to task tracker...\n",
              );

              // Post assessment failure to task tracker
              try {
                if (tracker)
                  await postAssessmentFailure(tracker, taskKey, "max-turns", stdoutOutput);
              } catch (trackerError) {
                console.warn("Failed to post assessment failure to task tracker:", trackerError);
              }
            } else {
              console.log(
                "   Will attempt to proceed with implementation (skipping tracker comment)...\n",
              );
            }
          } else {
            console.log("\n⚠️  Could not parse clarity assessment response");
            if (!skipComments) {
              console.log(
                "   Will attempt to proceed with implementation but posting failure to task tracker...\n",
              );

              // Post assessment failure to task tracker
              try {
                if (tracker)
                  await postAssessmentFailure(tracker, taskKey, "parse-error", stdoutOutput);
              } catch (trackerError) {
                console.warn("Failed to post assessment failure to task tracker:", trackerError);
              }
            } else {
              console.log(
                "   Will attempt to proceed with implementation (skipping tracker comment)...\n",
              );
            }
          }

          resolve(null); // Continue with implementation if parsing fails
        }
      } else {
        reject(new Error(`Agent clarity check exited with code ${code}`));
      }
    });

    // Send clarity assessment content to Agent
    if (clarityAgent.stdin) {
      clarityAgent.stdin.write(clarityContent);
      clarityAgent.stdin.end();
    }
  });
}

/**
 * Parse JSON clarity assessment output from the agent.
 *
 * @param output - Raw agent stdout
 * @throws When JSON is missing or required fields are invalid
 */
function parseClarityResponse(output: string): ClarityAssessment {
  // Extract JSON from Agent's response
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    // Provide more specific error based on output content
    if (detectMaxTurnsReached(output, "")) {
      throw new Error("warn: Agent reached max turns - no JSON assessment available");
    }
    if (output.trim().length === 0) {
      throw new Error("warn: Empty response from Agent");
    }
    throw new Error("warn: No JSON found in Agent response");
  }

  try {
    const assessment = JSON.parse(jsonMatch[1]);

    // Validate required fields
    if (
      typeof assessment.isImplementable !== "boolean" ||
      typeof assessment.clarityScore !== "number" ||
      !Array.isArray(assessment.issues) ||
      !Array.isArray(assessment.recommendations) ||
      typeof assessment.summary !== "string"
    ) {
      throw new Error("warn: Invalid assessment structure - missing required fields");
    }

    return assessment;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`warn: Malformed JSON in Agent response: ${error.message}`);
    }
    throw new Error(`warn: Failed to parse assessment: ${error}`);
  }
}

/**
 * Post a successful implementation summary comment to the task tracker.
 *
 * @param tracker - Task tracker client
 * @param taskKey - Task tracker issue key
 * @param agentOutput - Agent stdout
 * @param taskSummary - Optional issue summary line
 */
async function postImplementationComment(
  tracker: TaskTrackerClient,
  taskKey: string,
  agentOutput: string,
  taskSummary?: string,
): Promise<void> {
  try {
    await tracker.postImplementationComment(taskKey, agentOutput, taskSummary);
    console.log(`✅ Implementation summary posted to ${taskKey}`);
  } catch (error) {
    throw new Error(`Failed to post implementation comment: ${error}`);
  }
}

/**
 * Post a task tracker comment when clarity assessment fails (max turns or parse error).
 *
 * @param tracker - Task tracker client
 * @param taskKey - Task tracker issue key
 * @param failureType - Failure reason category
 * @param rawOutput - Raw agent output
 */
async function postAssessmentFailure(
  tracker: TaskTrackerClient,
  taskKey: string,
  failureType: "max-turns" | "parse-error",
  rawOutput: string,
): Promise<void> {
  try {
    await tracker.postAssessmentFailure(taskKey, failureType, rawOutput);
  } catch (error) {
    console.warn("Failed to post assessment failure:", error);
  }
}

/**
 * Post a clarity assessment comment to the task tracker when the check passes thresholds.
 *
 * @param tracker - Task tracker client
 * @param taskKey - Task tracker issue key
 * @param assessment - Parsed clarity assessment
 */
async function postClarityComment(
  tracker: TaskTrackerClient,
  taskKey: string,
  assessment: ClarityAssessment,
): Promise<void> {
  try {
    await tracker.postClarityComment(taskKey, assessment);
  } catch (error) {
    console.warn("Failed to post clarity comment:", error);
  }
}

/**
 * Run the agent to estimate story points and update the task tracker (field + comment).
 *
 * @param estimationFile - Path to the estimation prompt file
 * @param harness - Agent harness configuration
 * @param executablePath - Agent CLI executable path
 * @param taskKey - Task tracker issue key
 * @param tracker - Task tracker client
 * @param projectSettings - Per-project custom field overrides
 */
async function runEstimation(
  estimationFile: string,
  harness: AgentHarness,
  executablePath: string,
  taskKey: string,
  tracker: TaskTrackerClient,
  settings: ProjectSettings | null,
  skipComments = false,
  existingCommentId?: string,
): Promise<EstimationResult | null> {
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the estimation.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    if (!existsSync(estimationFile)) {
      reject(new Error(`Estimation file not found: ${estimationFile}`));
      return;
    }

    const estimationContent = readFileSync(estimationFile, "utf8");
    const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

    const estimationArgs = harness.buildArgs({
      maxTurns: 10,
      skipPermissions: true,
      workingDir: process.cwd(),
    });
    console.log(`📊 Running story points estimation with ${harness.displayName}...`);
    console.log(`   Command: ${executablePath} ${estimationArgs.join(" ")}`);

    let stdoutOutput = "";
    let stderrOutput = "";
    let timedOut = false;

    const estimationAgent: ChildProcess = spawnReapable(resolvedPath, estimationArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(
      () => {
        timedOut = true;
        console.error(
          `\n⏰ ${harness.displayName} estimation timed out after ${timeoutMinutes} minutes, killing...`,
        );
        reapTree(estimationAgent, "SIGTERM");
        setTimeout(() => {
          if (!estimationAgent.killed) {
            reapTree(estimationAgent, "SIGKILL");
          }
        }, 10_000);
      },
      timeoutMinutes * 60 * 1000,
    );

    if (estimationAgent.stdout) {
      estimationAgent.stdout.on("data", (data: Buffer) => {
        stdoutOutput += data.toString();
      });
    }

    if (estimationAgent.stderr) {
      estimationAgent.stderr.on("data", (data: Buffer) => {
        stderrOutput += data.toString();
      });
    }

    estimationAgent.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `${harness.displayName} CLI not found at: ${executablePath}\nPlease install ${harness.displayName} or specify the correct path with --agent-path`,
          ),
        );
      } else {
        reject(new Error(`Failed to run ${harness.displayName} estimation: ${error.message}`));
      }
    });

    estimationAgent.on("close", async (code: number | null) => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error(`Agent estimation timed out after ${timeoutMinutes} minutes`));
        return;
      }

      const usage = detectUsageLimit(stdoutOutput, stderrOutput);
      if (usage.limited) {
        reject(new UsageLimitError(usage.resetsAt));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Agent estimation exited with code ${code}`));
        return;
      }

      try {
        // Parse JSON from Agent's response
        const result = parseEstimationResponse(stdoutOutput);

        console.log(`\n📊 Estimation Result for ${taskKey}:`);
        console.log(`   Story Points: ${result.storyPoints}`);
        console.log(`   Confidence: ${result.confidence}`);
        const implLabel =
          result.implementationConfidence >= 9
            ? "Almost certain"
            : result.implementationConfidence >= 7
              ? "High chance"
              : result.implementationConfidence >= 5
                ? "May need guidance"
                : result.implementationConfidence >= 3
                  ? "Significant ambiguity"
                  : "Needs human judgment";
        console.log(`   AI Can Implement: ${result.implementationConfidence}/10 — ${implLabel}`);
        console.log(`   Summary: ${result.summary}`);

        if (result.risks.length > 0) {
          console.log(`   Risks: ${result.risks.join("; ")}`);
        }
        if (result.unclearAreas.length > 0) {
          console.log(`   Unclear Areas: ${result.unclearAreas.join("; ")}`);
        }

        // Discover or use configured estimation field
        const projectKey = taskKey.split("-")[0];
        const configuredField = getStoryPointsFieldForProject(projectKey, settings);
        if (configuredField) {
          console.log(`📊 Using configured story points field: ${configuredField}`);
        }
        const fieldId = configuredField || (await tracker.discoverEstimationField(taskKey));

        // Update story points
        if (fieldId) {
          try {
            await tracker.updateEstimation(taskKey, fieldId, result.storyPoints);
          } catch (updateError) {
            console.warn(`⚠️  Failed to set story points field: ${updateError}`);
          }
        } else {
          console.log("⚠️  No story points field found — skipping field update");
          console.log(
            '   Configure storyPointsField in .devintern-code/settings.json or ensure your tracker has a "Story Points" field',
          );
        }

        // Post or update estimation comment
        if (!skipComments) {
          try {
            if (existingCommentId) {
              await tracker.updateEstimationComment(taskKey, existingCommentId, result);
            } else {
              await tracker.postEstimationComment(taskKey, result);
            }
          } catch (commentError) {
            console.warn(
              `⚠️  Failed to ${existingCommentId ? "update" : "post"} estimation comment: ${commentError}`,
            );
          }
        } else {
          console.log("⏭️  Skipping estimation comment (--skip-comments)");
        }

        // Save estimation result to task directory
        try {
          const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
          const taskDir = join(baseOutputDir, taskKey.toLowerCase());
          mkdirSync(taskDir, { recursive: true });
          const resultFile = join(taskDir, "estimation-result.json");
          writeFileSync(resultFile, JSON.stringify(result, null, 2), "utf8");
          console.log(`💾 Saved estimation result to: ${resultFile}`);
        } catch (saveError) {
          console.warn(`⚠️  Failed to save estimation result: ${saveError}`);
        }

        resolve(result);
      } catch (parseError) {
        console.warn("Failed to parse estimation response:", parseError);
        console.log("Raw Agent output:", stdoutOutput);
        resolve(null);
      }
    });

    if (estimationAgent.stdin) {
      estimationAgent.stdin.write(estimationContent);
      estimationAgent.stdin.end();
    }
  });
}

/**
 * Parse and validate JSON story-point estimation output from the agent.
 *
 * @param output - Raw agent stdout
 * @throws When JSON is invalid or values are out of range
 */
function parseEstimationResponse(output: string): EstimationResult {
  // Try to find JSON in the response — with or without code fences
  let jsonStr: string | null = null;

  const fencedMatch = output.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fencedMatch) {
    jsonStr = fencedMatch[1];
  } else {
    // Try to extract a raw JSON object containing "storyPoints".
    // We find the last "storyPoints" in the output, then try { positions
    // before it (nearest first) paired with the last } after it, letting
    // JSON.parse decide validity. This avoids greedy-regex issues when
    // the surrounding text contains stray braces (e.g. URL templates).
    const spIdx = output.lastIndexOf('"storyPoints"');
    if (spIdx !== -1) {
      const endIdx = output.lastIndexOf("}");
      if (endIdx > spIdx) {
        for (let i = output.lastIndexOf("{", spIdx); i >= 0; i = output.lastIndexOf("{", i - 1)) {
          const candidate = output.substring(i, endIdx + 1);
          try {
            JSON.parse(candidate);
            jsonStr = candidate;
            break;
          } catch {
            continue;
          }
        }
      }
    }
  }

  if (!jsonStr) {
    throw new Error("No JSON found in estimation response");
  }

  const parsed = JSON.parse(jsonStr);

  // Validate required fields
  const validPoints = [1, 2, 3, 5, 8, 13, 21];
  if (!validPoints.includes(parsed.storyPoints)) {
    throw new Error(
      `Invalid story points value: ${parsed.storyPoints}. Must be one of: ${validPoints.join(", ")}`,
    );
  }

  if (!["high", "medium", "low"].includes(parsed.confidence)) {
    throw new Error(`Invalid confidence level: ${parsed.confidence}. Must be high, medium, or low`);
  }

  // Clamp implementationConfidence to 0-10, default to 5 if missing
  let implConf =
    typeof parsed.implementationConfidence === "number" ? parsed.implementationConfidence : 5;
  implConf = Math.max(0, Math.min(10, Math.round(implConf)));

  return {
    storyPoints: parsed.storyPoints,
    confidence: parsed.confidence,
    implementationConfidence: implConf,
    reasoning: parsed.reasoning || "",
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    unclearAreas: Array.isArray(parsed.unclearAreas) ? parsed.unclearAreas : [],
    summary: parsed.summary || "",
  };
}

/**
 * Append a git hook failure record to the per-task hook error log file.
 *
 * @param taskKey - JIRA issue key
 * @param hookType - Hook phase (`commit` or `push`)
 * @param attempt - Retry attempt number
 * @param error - Hook error output
 * @param fixed - Whether the agent subsequently fixed the issue
 */
function logHookErrorToFile(
  taskKey: string,
  hookType: string,
  attempt: number,
  error: string,
  fixed: boolean,
): void {
  try {
    const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
    const taskDir = join(baseOutputDir, taskKey.toLowerCase());
    const hookErrorFile = join(taskDir, "git-hook-errors.log");

    const timestamp = new Date().toISOString();
    const status = fixed ? "FIXED" : "FAILED";
    const logEntry = `
${"=".repeat(80)}
Timestamp: ${timestamp}
Hook Type: ${hookType}
Attempt: ${attempt}
Status: ${status}
Error:
${error}
${"=".repeat(80)}
`;

    // Append to log file
    const existingContent = existsSync(hookErrorFile)
      ? readFileSync(hookErrorFile, "utf8")
      : "# Git Hook Errors Log\n\n";

    writeFileSync(hookErrorFile, existingContent + logEntry, "utf8");
    console.log(`💾 Hook error logged to: ${hookErrorFile}`);
  } catch (saveError) {
    console.warn(`⚠️  Failed to save hook error to file: ${saveError}`);
  }
}

/**
 * Detect plan-only agent behavior and extract a plan file path if present.
 *
 * @param agentOutput - Raw agent stdout
 * @returns Plan file path, or `null` when implementation appears complete
 */
function detectPlanOnlyBehavior(agentOutput: string): string | null {
  // Check for common plan creation patterns (specific phrases first)
  const planCreationPatterns = [
    /I'?ve created (a|an|the) (comprehensive )?(implementation )?plan/i,
    /created a plan for/i,
    /plan has been created/i,
    /implementation plan is (now )?ready/i,
    /The plan is (now )?ready/i,
    /plan is ready for (your )?review/i,
    /Here'?s a summary:?\s*\n+##.*plan/i,
    /drafted a plan/i,
    /wrote out a plan/i,
    /plan (file )?(is )?(available|saved)/i,
    /##.*plan.*summary/i,
  ];

  const hasPlanCreationLanguage = planCreationPatterns.some((pattern) => pattern.test(agentOutput));

  // Fallback: if "plan" appears with context suggesting plan-only behavior
  // (since this function is only called when there are no changes to commit)
  const hasPlanFallback =
    !hasPlanCreationLanguage &&
    /\bplan\b/i.test(agentOutput) &&
    /summary|review|ready|created|implementation|approach|steps|changes (required|needed)/i.test(
      agentOutput,
    );

  if (!hasPlanCreationLanguage && !hasPlanFallback) {
    return null;
  }

  // Try to extract the plan file path
  // Common patterns:
  // - "available at `/path/to/plan.md`"
  // - "available at /path/to/plan.md"
  // - "saved to: /path/to/plan.md"
  // - ~/.claude/plans/something.md
  const pathPatterns = [
    /(?:available at|saved to:?)\s*[`"]?((?:\/[^\s`"]+|~\/\.claude\/plans\/[^\s`"]+)\.md)[`"]?/i,
    /[`"]((?:\/home\/[^\s`"]+|~)\/\.claude\/plans\/[^\s`"]+\.md)[`"]/,
    /(\/home\/[^\s]+\/\.claude\/plans\/[^\s]+\.md)/,
  ];

  for (const pattern of pathPatterns) {
    const match = agentOutput.match(pattern);
    if (match && match[1]) {
      let planPath = match[1];
      // Expand ~ to home directory
      if (planPath.startsWith("~")) {
        const homeDir = process.env.HOME || "/tmp";
        planPath = planPath.replace("~", homeDir);
      }
      return planPath;
    }
  }

  // If we detected plan creation language but couldn't extract the path,
  // return a sentinel value to indicate plan-only behavior
  return "PLAN_DETECTED_NO_PATH";
}

/**
 * Build a follow-up prompt asking the agent to implement an existing plan file.
 *
 * @param planPath - Plan markdown path, or sentinel when path unknown
 * @param originalTaskContent - Original formatted task prompt for context
 */
function createPlanImplementationPrompt(
  planPath: string | null,
  originalTaskContent: string,
): string {
  const planInstructions =
    planPath && planPath !== "PLAN_DETECTED_NO_PATH"
      ? `You previously created an implementation plan at: ${planPath}

Please read this plan file and implement it NOW. Do not create another plan - actually write the code and make the changes described in the plan.`
      : `You previously created an implementation plan but did not implement it.

Please implement the task NOW. Do not just plan or describe what needs to be done - actually write the code and make the changes.`;

  return `${planInstructions}

IMPORTANT: You MUST actually implement the changes, not just plan them. Create/modify files as needed. Do not exit until actual code changes have been made.

For reference, here is the original task:
---
${originalTaskContent}
---

Now implement the solution. Write the actual code.`;
}

/**
 * Run the main agent harness implementation session for a formatted task.
 *
 * @param taskFile - Path to the formatted task markdown prompt
 * @param harness - Agent harness configuration
 * @param executablePath - Agent CLI executable path
 * @param maxTurns - Maximum agent turns
 * @param taskKey - Task tracker issue key
 * @param taskSummary - Issue summary for commits and comments
 * @param enableGit - When false, skip git branch/commit workflow
 * @param task - Generic task object (for PR creation and description extraction)
 * @param createPr - Create a pull request after implementation
 * @param prTargetBranch - Base branch for the PR
 * @param tracker - Task tracker client for status transitions and comments
 * @param skipComments - Skip posting tracker comments
 * @param hookRetries - Max retries for git hook auto-fix
 * @param projectSettings - Per-project workflow settings
 * @param gitAuthor - Optional bot author for commits
 * @param autoReview - Run post-PR auto-review loop
 * @param autoReviewIterations - Max auto-review iterations
 * @param isPlanRetry - Whether this run follows a plan-only retry
 */
async function runAgentHarness(
  taskFile: string,
  harness: AgentHarness,
  executablePath: string,
  maxTurns = 500,
  taskKey?: string,
  taskSummary?: string,
  enableGit = true,
  task?: any,
  createPr = false,
  prTargetBranch = "main",
  tracker?: TaskTrackerClient,
  skipComments = false,
  hookRetries = 10,
  projectSettings: ProjectSettings | null = null,
  gitAuthor?: { name: string; email: string },
  autoReview = false,
  autoReviewIterations = 5,
  isPlanRetry = false,
): Promise<void> {
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the run.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    // Check if task file exists
    if (!existsSync(taskFile)) {
      reject(new Error(`Task file not found: ${taskFile}`));
      return;
    }

    // Load project settings
    const projectSettings = loadProjectSettings();

    // Read the task content
    const taskContent = readFileSync(taskFile, "utf8");

    const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

    const agentArgs = harness.buildArgs({
      maxTurns,
      skipPermissions: true,
      workingDir: process.cwd(),
    });
    console.log(`🚀 Launching ${harness.displayName}...`);
    console.log(`   Command: ${executablePath} ${agentArgs.join(" ")} --verbose`);
    console.log(`   Input: ${taskFile}`);
    console.log(`   Timeout: ${timeoutMinutes} minutes`);
    console.log(
      `   Output: All ${harness.displayName} output will be displayed below in real-time`,
    );
    console.log("\n" + "=".repeat(60));

    // Capture stderr to detect max turns error and stdout for JIRA comment
    let stderrOutput = "";
    let stdoutOutput = "";
    let timedOut = false;

    // Spawn agent process with enhanced permissions and max turns
    const codeAgent: ChildProcess = spawnReapable(resolvedPath, agentArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(
      () => {
        timedOut = true;
        console.error(
          `\n⏰ ${harness.displayName} process timed out after ${timeoutMinutes} minutes, killing...`,
        );
        reapTree(codeAgent, "SIGTERM");
        setTimeout(() => {
          if (!codeAgent.killed) {
            reapTree(codeAgent, "SIGKILL");
          }
        }, 10_000);
      },
      timeoutMinutes * 60 * 1000,
    );

    // Capture and display stdout output
    if (codeAgent.stdout) {
      codeAgent.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutOutput += output;
        process.stdout.write(output);
      });
    }

    // Capture stderr output for error detection while ensuring it's visible to user
    if (codeAgent.stderr) {
      codeAgent.stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrOutput += output;
        process.stderr.write(output);
      });
    }

    // Handle errors
    codeAgent.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `${harness.displayName} CLI not found at: ${executablePath}\nPlease install ${harness.displayName} or specify the correct path with --agent-path`,
          ),
        );
      } else {
        reject(new Error(`Failed to run ${harness.displayName}: ${error.message}`));
      }
    });

    // Handle process exit
    codeAgent.on("close", async (code: number | null) => {
      clearTimeout(timeout);
      console.log("\n" + "=".repeat(60));

      if (timedOut) {
        console.log(`⏰ ${harness.displayName} timed out after ${timeoutMinutes} minutes`);
        reject(new Error(`${harness.displayName} timed out after ${timeoutMinutes} minutes`));
        return;
      }

      // A usage/rate limit is account-global — abort the batch rather than
      // treating this task as a normal failure (every other task would fail too).
      const usage = detectUsageLimit(stdoutOutput, stderrOutput);
      if (usage.limited) {
        console.log(
          `\n⏳ ${harness.displayName} hit a usage limit${
            usage.resetsAt ? ` (resets ${usage.resetsAt})` : ""
          }`,
        );
        reject(new UsageLimitError(usage.resetsAt));
        return;
      }

      const maxTurnsReached = detectMaxTurnsReached(stdoutOutput, stderrOutput);

      if (maxTurnsReached) {
        console.log("⚠️  Agent reached maximum turns limit without completing the task");
        console.log("   The task may be too complex or require more turns to complete");
        console.log("   Consider breaking it into smaller tasks or increasing the max-turns limit");

        // Save incomplete implementation for analysis
        if (taskKey && stdoutOutput.trim()) {
          try {
            const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
            const taskDir = join(baseOutputDir, taskKey.toLowerCase());
            const summaryFile = join(taskDir, "implementation-summary-incomplete.md");

            writeFileSync(summaryFile, stdoutOutput, "utf8");
            console.log(`\n💾 Saved incomplete implementation to: ${summaryFile}`);

            // Post incomplete implementation comment (no duplicate check here
            // since we already skip tasks with existing incomplete comments)
            if (tracker && !skipComments && task) {
              try {
                const descriptionText = tracker.extractDescriptionText(task);

                await tracker.postIncompleteImplementationComment(
                  taskKey,
                  stdoutOutput,
                  taskSummary,
                  descriptionText,
                );
              } catch (commentError) {
                console.warn(
                  `⚠️  Failed to post incomplete implementation comment to JIRA: ${commentError}`,
                );
              }
            }

            // Transition back to "To Do" status if configured
            if (tracker && !skipComments && taskKey && projectSettings) {
              const projectKey = resolveProjectKey(taskKey, task);
              const todoStatus = getTodoStatusForProject(projectKey, projectSettings);
              if (todoStatus && todoStatus.trim()) {
                try {
                  console.log(
                    `\n🔄 Moving ${taskKey} back to '${todoStatus}' due to max turns reached...`,
                  );
                  await tracker.transitionStatus(taskKey, todoStatus.trim());
                  console.log(`✅ Task moved to '${todoStatus}'`);
                } catch (statusError) {
                  console.warn(
                    `⚠️  Failed to transition task to '${todoStatus}': ${
                      (statusError as Error).message
                    }`,
                  );
                }
              }
            }
          } catch (saveError) {
            console.warn(`⚠️  Failed to save implementation summary: ${saveError}`);
          }
        }

        console.log("\n⏭️  Skipping commit and moving to next task (if any)...");

        // Resolve instead of reject to allow batch processing to continue
        resolve();
        return;
      }

      if (code === 0) {
        // Even if exit code is 0, check if Agent actually completed meaningful work.
        // Only inspect stdout: stderr often contains transient "Error:" lines from
        // recovered tool failures (especially with Cursor CLI).
        const { incomplete: seemsIncomplete, reasons: incompleteReasons } =
          detectIncompleteImplementation(stdoutOutput);

        // Save implementation summary to task directory (even if incomplete for analysis)
        if (taskKey && stdoutOutput.trim()) {
          try {
            const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
            const taskDir = join(baseOutputDir, taskKey.toLowerCase());
            const summaryFile = join(
              taskDir,
              seemsIncomplete
                ? "implementation-summary-incomplete.md"
                : "implementation-summary.md",
            );

            writeFileSync(summaryFile, stdoutOutput, "utf8");
            console.log(`\n💾 Saved implementation summary to: ${summaryFile}`);
          } catch (saveError) {
            console.warn(`⚠️  Failed to save implementation summary: ${saveError}`);
          }
        }

        if (seemsIncomplete) {
          console.log("⚠️  Agent execution completed but appears to be incomplete or failed");
          console.log(`   Reasons: ${incompleteReasons.join("; ")}`);
          console.log("   Check the output above for specific issues");
          console.log("\n⏭️  Skipping commit and moving to next task (if any)...");

          // Post incomplete implementation comment (no duplicate check here
          // since we already skip tasks with existing incomplete comments)
          if (tracker && !skipComments && taskKey && stdoutOutput.trim() && task) {
            try {
              const descriptionText = tracker.extractDescriptionText(task);

              await tracker.postIncompleteImplementationComment(
                taskKey,
                stdoutOutput,
                taskSummary,
                descriptionText,
              );
            } catch (commentError) {
              console.warn(
                `⚠️  Failed to post incomplete implementation comment to JIRA: ${commentError}`,
              );
            }
          }

          // Transition back to "To Do" status if configured
          if (tracker && !skipComments && taskKey && projectSettings) {
            const projectKey = resolveProjectKey(taskKey, task);
            const todoStatus = getTodoStatusForProject(projectKey, projectSettings);
            if (todoStatus && todoStatus.trim()) {
              try {
                console.log(
                  `\n🔄 Moving ${taskKey} back to '${todoStatus}' due to incomplete implementation...`,
                );
                await tracker.transitionStatus(taskKey, todoStatus.trim());
                console.log(`✅ Task moved to '${todoStatus}'`);
              } catch (statusError) {
                console.warn(
                  `⚠️  Failed to transition task to '${todoStatus}': ${
                    (statusError as Error).message
                  }`,
                );
              }
            }
          }

          // Don't commit or continue processing when implementation is incomplete
          // Just resolve to allow batch processing to continue
          resolve();
          return;
        } else {
          console.log("✅ Agent execution completed successfully");
        }

        // --- Shared helpers for hook validation, push, and PR creation ---
        const validatePrePushHook = async (phase: string) => {
          let attempt = 0;
          while (attempt <= hookRetries) {
            attempt++;
            const hookResult = await Utils.runPrePushHookLocally({
              verbose: options.verbose,
            });
            if (hookResult.success) {
              if (attempt === 1) {
                console.log(`✅ ${hookResult.message}`);
              } else {
                console.log(`✅ Pre-push hook passed after ${attempt} attempt(s)`);
              }
              return { success: true, result: hookResult };
            }
            if (hookResult.hookError && attempt <= hookRetries) {
              console.log(
                `\n⚠️  Pre-push hook failed during ${phase} (attempt ${attempt}/${hookRetries + 1})`,
              );
              const fixed = await runAgentHarnessToFixGitHook(
                "push",
                harness,
                executablePath,
                maxTurns,
              );
              logHookErrorToFile(
                taskKey ?? "unknown",
                "push-local-validation",
                attempt,
                hookResult.hookError,
                fixed,
              );
              if (fixed) {
                console.log(
                  `\n🔄 Retrying local hook validation after ${harness.displayName} fixed the issues...`,
                );
                continue;
              } else {
                console.log("\n❌ Could not fix pre-push hook errors automatically");
                return { success: false, result: hookResult };
              }
            } else {
              if (attempt > hookRetries) {
                console.log(`\n❌ Max retries (${hookRetries}) exceeded for pre-push hook fixes`);
              }
              console.log(`⚠️  ${hookResult.message}`);
              return { success: false, result: hookResult };
            }
          }
          return {
            success: false,
            result: { message: "Max retries exceeded" },
          };
        };

        const pushWithHookRetry = async () => {
          console.log("\n📤 Pushing branch to remote...");
          let attempt = 0;
          while (attempt <= hookRetries) {
            attempt++;
            const pushResult = await Utils.pushCurrentBranch({
              verbose: options.verbose,
            });
            if (pushResult.success) {
              console.log(`✅ ${pushResult.message}`);
              return { success: true, result: pushResult };
            }
            if (pushResult.hookError && attempt <= hookRetries) {
              console.log(
                `\n⚠️  Git pre-push hook failed during push (attempt ${attempt}/${hookRetries + 1})`,
              );
              const fixed = await runAgentHarnessToFixGitHook(
                "push",
                harness,
                executablePath,
                maxTurns,
              );
              logHookErrorToFile(
                taskKey ?? "unknown",
                "push",
                attempt,
                pushResult.hookError,
                fixed,
              );
              if (fixed) {
                console.log(
                  `\n🔄 Retrying push after ${harness.displayName} fixed and amended the commit...`,
                );
                continue;
              } else {
                console.log("\n❌ Could not fix git pre-push hook errors automatically");
                return { success: false, result: pushResult };
              }
            } else {
              if (attempt > hookRetries) {
                console.log(`\n❌ Max retries (${hookRetries}) exceeded for git hook fixes`);
              }
              console.log(`⚠️  ${pushResult.message}`);
              return { success: false, result: pushResult };
            }
          }
          return {
            success: false,
            result: { message: "Max retries exceeded" },
          };
        };

        const createPrAndTransition = async (
          implementationOutput: string,
          autoReviewRan = false,
        ) => {
          console.log("\n🔀 Creating pull request...");
          try {
            const prManager = new PRManager();
            const branchForPr = await Utils.getCurrentBranch();

            if (!branchForPr) {
              console.log("⚠️  Could not determine current branch for PR creation");
              return;
            }
            if (await Utils.isProtectedBranch(branchForPr)) {
              console.error(`\n❌ Cannot create PR from protected branch '${branchForPr}'`);
              console.error("   This indicates a bug - feature branch was not created properly.");
              return;
            }

            // Ensure the PR target branch actually exists on the remote. A wrong or
            // missing target (e.g. `--pr-target-branch main` on a `master` repo) makes
            // GitHub reject the PR with "Validation Failed", leaving a pushed branch
            // and no PR. Fall back to the repo's real default branch in that case.
            let effectivePrTargetBranch = prTargetBranch;
            if (!(await Utils.remoteBranchExists(prTargetBranch, { verbose: options.verbose }))) {
              const defaultBranch = await Utils.getMainBranchName();
              if (defaultBranch !== prTargetBranch) {
                console.log(
                  `⚠️  Target branch '${prTargetBranch}' not found on remote, falling back to '${defaultBranch}'`,
                );
                effectivePrTargetBranch = defaultBranch;
              }
            }

            const prResult = await prManager.createPullRequest(
              task,
              branchForPr,
              effectivePrTargetBranch,
              implementationOutput,
            );

            if (prResult.success) {
              console.log(`✅ Pull request created: ${prResult.url}`);

              if (taskKey && tracker && !skipComments) {
                const projectKey = resolveProjectKey(taskKey, task);
                const prStatus = getPrStatusForProject(projectKey, projectSettings);
                if (prStatus && prStatus.trim()) {
                  try {
                    console.log("\n🔄 Transitioning JIRA status after PR creation...");
                    await tracker.transitionStatus(taskKey, prStatus.trim());
                  } catch (statusError) {
                    console.warn(
                      `⚠️  Failed to transition JIRA status: ${(statusError as Error).message}`,
                    );
                    console.log("   PR was created successfully, but status transition failed");
                  }
                }
              } else if (skipComments) {
                console.log("\n⏭️  Skipping task tracker status transition (--skip-comments)");
              }

              if (autoReviewRan) {
                console.log(
                  "\n✅ Auto-review was completed before push (see summary file for details)",
                );
              }
            } else {
              console.log(`⚠️  PR creation failed: ${prResult.message}`);
            }
          } catch (prError) {
            console.log(`⚠️  PR creation failed: ${(prError as Error).message}`);
          }
        };
        // --- End shared helpers ---

        // Commit changes if git is enabled and we have task details
        if (enableGit && taskKey && taskSummary) {
          console.log("\n📝 Committing changes...");

          // Try committing with retry logic for git hook failures
          const handleCommitWithRetry = async () => {
            let attempt = 0;

            while (attempt <= hookRetries) {
              attempt++;
              const commitResult = await Utils.commitChanges(taskKey, taskSummary, {
                verbose: options.verbose,
                author: gitAuthor,
              });

              if (commitResult.success) {
                console.log(`✅ ${commitResult.message}`);
                return { success: true, result: commitResult };
              }

              // Check if this is a git hook error that we can try to fix
              if (commitResult.hookError && attempt <= hookRetries) {
                console.log(`\n⚠️  Git hook failed (attempt ${attempt}/${hookRetries + 1})`);

                // Try to fix the hook error with agent
                const fixed = await runAgentHarnessToFixGitHook(
                  "commit",
                  harness,
                  executablePath,
                  maxTurns,
                );

                // Log the hook error to file
                logHookErrorToFile(taskKey, "commit", attempt, commitResult.hookError, fixed);

                if (fixed) {
                  if (await isCommitAlreadyComplete()) {
                    console.log("✅ Commit already completed during hook fix");
                    return {
                      success: true,
                      result: {
                        message: `Successfully committed changes for ${taskKey} (via hook fix)`,
                      },
                    };
                  }

                  console.log("\n🔄 Retrying commit after Agent fixed the issues...");
                  continue;
                } else {
                  console.log("\n❌ Could not fix git hook errors automatically");
                  return { success: false, result: commitResult };
                }
              } else {
                // Not a hook error or out of retries
                if (attempt > hookRetries) {
                  console.log(`\n❌ Max retries (${hookRetries}) exceeded for git hook fixes`);
                }
                console.log(`⚠️  ${commitResult.message}`);
                return { success: false, result: commitResult };
              }
            }

            return {
              success: false,
              result: { message: "Max retries exceeded" },
            };
          };

          handleCommitWithRetry()
            .then(async ({ success, result }) => {
              if (!success) {
                // Check if this is a "plan only" scenario - Agent created a plan but didn't implement
                const noChangesToCommit = result.message === "No changes to commit";
                const planPath = noChangesToCommit ? detectPlanOnlyBehavior(stdoutOutput) : null;

                if (noChangesToCommit && planPath && !isPlanRetry) {
                  // Agent only created a plan - run it again with instructions to implement
                  console.log(
                    "\n🔄 Agent created a plan but didn't implement it. Re-running to execute the plan...",
                  );

                  if (planPath !== "PLAN_DETECTED_NO_PATH") {
                    console.log(`   Plan file detected: ${planPath}`);
                  }

                  // Create a new prompt to implement the plan
                  const implementationPrompt = createPlanImplementationPrompt(
                    planPath,
                    taskContent,
                  );

                  // Spawn agent again with the implementation prompt. Re-resolve
                  // the CLI path here (rather than reusing the first spawn's) — a
                  // long agent run may straddle an auto-update, so wait out any
                  // swap in progress before this second spawn.
                  const retryArgs = harness.buildArgs({
                    maxTurns,
                    skipPermissions: true,
                    workingDir: process.cwd(),
                  });
                  const retryResolvedPath = await resolveExecutablePathWithRetry(executablePath, {
                    displayName: harness.displayName,
                  });
                  const retryProcess: ChildProcess = spawnReapable(retryResolvedPath, retryArgs, {
                    stdio: ["pipe", "pipe", "pipe"],
                  });

                  let retryStdoutOutput = "";
                  let retryStderrOutput = "";

                  if (retryProcess.stdout) {
                    retryProcess.stdout.on("data", (data: Buffer) => {
                      const output = data.toString();
                      retryStdoutOutput += output;
                      process.stdout.write(output);
                    });
                  }

                  if (retryProcess.stderr) {
                    retryProcess.stderr.on("data", (data: Buffer) => {
                      const output = data.toString();
                      retryStderrOutput += output;
                      process.stderr.write(output);
                    });
                  }

                  if (retryProcess.stdin) {
                    retryProcess.stdin.write(implementationPrompt);
                    retryProcess.stdin.end();
                  }

                  retryProcess.on("close", async (retryCode: number | null) => {
                    console.log("\n" + "=".repeat(60));

                    if (retryCode === 0) {
                      console.log("✅ Plan implementation completed");

                      // Save updated implementation summary
                      if (taskKey && retryStdoutOutput.trim()) {
                        try {
                          const summaryFile = join(dirname(taskFile), "implementation-summary.md");
                          writeFileSync(
                            summaryFile,
                            `# Plan Implementation Output\n\n${retryStdoutOutput}`,
                            "utf8",
                          );
                          console.log(`\n💾 Updated implementation summary: ${summaryFile}`);
                        } catch (saveError) {
                          console.warn(`⚠️  Failed to save implementation summary: ${saveError}`);
                        }
                      }

                      // Try to commit the changes from plan implementation
                      console.log("\n📝 Committing plan implementation changes...");
                      const retryCommitResult = await Utils.commitChanges(taskKey, taskSummary, {
                        verbose: options.verbose,
                        author: gitAuthor,
                      });

                      if (retryCommitResult.success) {
                        console.log(`✅ ${retryCommitResult.message}`);

                        // Continue with PR creation if requested
                        if (createPr && task) {
                          // Validate pre-push hook locally BEFORE pushing
                          console.log("\n🔍 Validating pre-push hook locally (before pushing)...");
                          const planHookValidation = await validatePrePushHook(
                            "plan implementation validation",
                          );
                          if (!planHookValidation.success) {
                            console.log(
                              "   Cannot proceed without passing pre-push hook validation",
                            );
                            resolve();
                            return;
                          }

                          const planPushOutcome = await pushWithHookRetry();

                          if (planPushOutcome.success) {
                            if (tracker && !skipComments && retryStdoutOutput.trim()) {
                              try {
                                await postImplementationComment(
                                  tracker,
                                  taskKey,
                                  retryStdoutOutput,
                                  taskSummary,
                                );
                              } catch (commentError) {
                                console.warn(
                                  `⚠️  Failed to post implementation comment: ${commentError}`,
                                );
                              }
                            }

                            await createPrAndTransition(retryStdoutOutput);
                          }
                        }
                      } else {
                        console.log(`⚠️  ${retryCommitResult.message}`);
                        console.log(
                          'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
                        );
                      }
                    } else {
                      console.log("⚠️  Plan implementation failed");
                    }

                    resolve();
                  });

                  retryProcess.on("error", (error: Error) => {
                    console.error(`❌ Failed to re-run Agent: ${error.message}`);
                    resolve();
                  });

                  return;
                }

                console.log(
                  'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
                );
                resolve();
                return;
              }

              // Create pull request if requested
              if (createPr && task) {
                // Step 1: Validate pre-push hook locally BEFORE any push
                console.log("\n🔍 Validating pre-push hook locally (before pushing)...");
                const initialHookValidation = await validatePrePushHook("initial validation");

                if (!initialHookValidation.success) {
                  console.log("   Cannot proceed without passing pre-push hook validation");
                  resolve();
                  return;
                }

                // Step 2: Run auto-review with skipPush if enabled
                const currentBranch = await Utils.getCurrentBranch();
                let autoReviewRan = false;

                if (autoReview && currentBranch) {
                  try {
                    console.log("\n🔄 Running auto-review loop (without pushing)...");

                    const baseOutputDir =
                      process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
                    const taskDir = taskKey
                      ? join(baseOutputDir, taskKey.toLowerCase())
                      : join(baseOutputDir, `auto-review-${Date.now()}`);

                    const autoReviewResult = await runAutoReviewLoop({
                      repository: "local/repo",
                      prNumber: 0,
                      prBranch: currentBranch,
                      baseBranch: prTargetBranch,
                      harness,
                      executablePath,
                      maxIterations: autoReviewIterations,
                      minPriority: "medium",
                      workingDir: process.cwd(),
                      outputDir: taskDir,
                      skipPush: true,
                    });

                    const summaryPath = join(taskDir, "auto-review-summary.json");
                    writeFileSync(summaryPath, JSON.stringify(autoReviewResult, null, 2));
                    console.log(`\n📄 Auto-review summary saved to: ${summaryPath}`);

                    autoReviewRan = true;

                    // Step 3: After auto-review, validate hooks again
                    console.log(
                      "\n🔍 Re-validating pre-push hook after auto-review improvements...",
                    );
                    const postAutoReviewValidation = await validatePrePushHook(
                      "post auto-review validation",
                    );

                    if (!postAutoReviewValidation.success) {
                      console.log(
                        "   Cannot proceed - auto-review changes failed pre-push hook validation",
                      );
                      resolve();
                      return;
                    }
                  } catch (autoReviewError) {
                    console.warn(
                      `\n⚠️  Auto-review loop failed: ${(autoReviewError as Error).message}`,
                    );
                    console.log("   Continuing with push and PR creation...");
                  }
                }

                // Step 4: Push with hook retry
                const pushOutcome = await pushWithHookRetry();

                if (pushOutcome.success) {
                  if (taskKey && tracker && stdoutOutput.trim() && !skipComments) {
                    try {
                      console.log("\n💬 Posting implementation summary to task tracker...");
                      await postImplementationComment(tracker, taskKey, stdoutOutput, taskSummary);
                    } catch (commentError) {
                      console.warn(
                        `⚠️  Failed to post implementation comment to task tracker: ${commentError}`,
                      );
                      console.log("   Push succeeded, but task tracker comment failed");
                    }
                  } else if (skipComments && taskKey) {
                    console.log("\n⏭️  Skipping task tracker comment posting (--skip-comments)");
                  }

                  await createPrAndTransition(stdoutOutput, autoReviewRan);
                } else {
                  console.log("   Cannot create PR without pushing branch to remote");
                }
              } else {
                // No PR requested, but commit succeeded - post to task tracker here
                if (taskKey && tracker && stdoutOutput.trim() && !skipComments) {
                  try {
                    console.log("\n💬 Posting implementation summary to task tracker...");
                    await postImplementationComment(tracker, taskKey, stdoutOutput, taskSummary);
                  } catch (commentError) {
                    console.warn(
                      `⚠️  Failed to post implementation comment to task tracker: ${commentError}`,
                    );
                    console.log("   Commit succeeded, but task tracker comment failed");
                  }
                } else if (skipComments && taskKey) {
                  console.log("\n⏭️  Skipping task tracker comment posting (--skip-comments)");
                }
              }
              resolve();
            })
            .catch((commitError) => {
              console.log(`⚠️  Failed to commit changes: ${commitError.message}`);
              console.log(
                'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
              );
              resolve(); // Still resolve since Agent succeeded
            });
        } else {
          resolve();
        }
      } else {
        console.log(`❌ Agent exited with non-zero code ${code}`);
        console.log("   No JIRA comment will be posted due to execution failure");
        reject(new Error(`Agent exited with code ${code}`));
      }
    });

    // Send task content to Agent
    if (codeAgent.stdin) {
      codeAgent.stdin.write(taskContent);
      codeAgent.stdin.end();
    }
  });
}

// Handle uncaught errors
process.on("unhandledRejection", (error: Error) => {
  console.error("❌ Unhandled error:", error.message);
  if (options.verbose && error.stack) {
    console.error(error.stack);
  }
  // Release lock before exiting
  if (lockManager) {
    lockManager.release();
  }
  process.exit(1);
});

// Handle process termination signals
process.on("SIGINT", () => {
  console.log("\n\n⚠️  Received SIGINT (Ctrl+C), cleaning up...");
  if (lockManager) {
    lockManager.release();
  }
  process.exit(130); // Standard exit code for SIGINT
});

process.on("SIGTERM", () => {
  console.log("\n\n⚠️  Received SIGTERM, cleaning up...");
  if (lockManager) {
    lockManager.release();
  }
  process.exit(143); // Standard exit code for SIGTERM
});

// Handle uncaught exceptions
process.on("uncaughtException", (error: Error) => {
  console.error("❌ Uncaught exception:", error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  // Release lock before exiting
  if (lockManager) {
    lockManager.release();
  }
  process.exit(1);
});

// Run the main function (only if not running a subcommand)
if (require.main === module && !isSubcommand) {
  main();
}

export {
  main,
  JiraTaskTrackerClient,
  JiraTaskTrackerClient as JiraClient,
  TaskFormatter,
  TaskTrackerManager,
};
export type { TaskTrackerClient };
