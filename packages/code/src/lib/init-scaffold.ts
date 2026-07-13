/**
 * Scaffolding for `devintern init`: per-tracker credential step tables,
 * `.env` / `.env.example` rendering, and the `.devintern-code/` writer shared
 * by the interactive wizard and the non-interactive fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { BUNDLED_TRELLO_API_KEY, type EnvPromptStep, stepLink } from "@devintern/task-trackers";
import { TRACKER_CAPABILITIES } from "./tracker-capabilities";

export type { EnvPromptStep };

/** Per-tracker setup guides on the DevIntern website. */
export const TRACKER_DOCS: Record<string, string> = {
  jira: "https://devintern.com/docs/code/jira-integration",
  linear: "https://devintern.com/docs/code/linear-integration",
  github: "https://devintern.com/docs/code/github-issues-integration",
  "azure-devops": "https://devintern.com/docs/code/azure-devops-integration",
  asana: "https://devintern.com/docs/code/asana-integration",
  trello: "https://devintern.com/docs/code/trello-integration",
  markdown: "https://devintern.com/docs/code/markdown-tasks",
};

/** Guide for the optional PR-integration GitHub token. */
export const GITHUB_PR_DOCS = "https://devintern.com/docs/code/github-integration";

export const GITHUB_TOKEN_LINK =
  "https://github.com/settings/tokens/new?scopes=repo&description=devintern";

export const TRACKER_SETUP: Record<string, EnvPromptStep[]> = {
  jira: [
    {
      key: "JIRA_BASE_URL",
      label: "JIRA instance URL (without trailing slash)",
      example: "https://your-company.atlassian.net",
    },
    { key: "JIRA_EMAIL", label: "JIRA account email", example: "you@company.com" },
    {
      key: "JIRA_API_TOKEN",
      label: "JIRA API token",
      link: "https://id.atlassian.com/manage-profile/security/api-tokens",
    },
    {
      key: "JIRA_DEFAULT_PROJECT_KEY",
      label: "Default JIRA project key",
      example: "PROJ",
      optional: true,
    },
  ],
  linear: [
    {
      key: "LINEAR_API_KEY",
      label: "Linear personal API key (Settings > Security & access > Personal API keys)",
      link: "https://linear.app/settings/account/security",
    },
    {
      key: "LINEAR_DEFAULT_TEAM_KEY",
      label: "Default Linear team key",
      example: "ENG",
      optional: true,
    },
  ],
  github: [
    {
      key: "GITHUB_TOKEN",
      label: "GitHub personal access token ('repo' scope)",
      link: GITHUB_TOKEN_LINK,
    },
    { key: "GITHUB_REPO", label: "Target repository", example: "owner/repo" },
    {
      key: "GITHUB_STATUS_LABELS",
      label: "Comma-separated status label names",
      example: "todo,in progress,in review",
      optional: true,
    },
  ],
  "azure-devops": [
    { key: "AZURE_DEVOPS_ORG", label: "Azure DevOps organization name", example: "my-org" },
    {
      key: "AZURE_DEVOPS_PAT",
      label: "Azure DevOps personal access token (Work Items: Read & Write)",
      link: (values) =>
        `https://dev.azure.com/${values.AZURE_DEVOPS_ORG || "your-org"}/_usersSettings/tokens`,
    },
    { key: "AZURE_DEVOPS_PROJECT", label: "Azure DevOps project name", example: "MyProject" },
  ],
  asana: [
    {
      key: "ASANA_API_TOKEN",
      label: "Asana personal access token (My apps > Personal access tokens)",
      link: "https://app.asana.com/0/my-apps",
    },
    {
      key: "ASANA_DEFAULT_PROJECT_GID",
      label: "Default Asana project GID",
      example: "1200000000000000",
      optional: true,
    },
  ],
  trello: [
    {
      key: "TRELLO_API_KEY",
      label: "Trello API key (press Enter to use the bundled DevIntern key)",
      optional: true,
      defaultValue: BUNDLED_TRELLO_API_KEY,
    },
    {
      key: "TRELLO_API_TOKEN",
      label: "Trello API token",
      link: (values) =>
        `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=${
          values.TRELLO_API_KEY || BUNDLED_TRELLO_API_KEY
        }`,
    },
    {
      key: "TRELLO_DEFAULT_BOARD_ID",
      label: "Default Trello board ID",
      optional: true,
    },
  ],
  markdown: [
    {
      key: "MARKDOWN_TASKS_DIR",
      label: "Directory containing markdown task files",
      example: "./tasks",
      defaultValue: "./tasks",
    },
  ],
};

/** Optional PR-integration step offered when the chosen tracker is not GitHub. */
export const GITHUB_PR_TOKEN_STEP: EnvPromptStep = {
  key: "GITHUB_TOKEN",
  label: "GitHub token for creating pull requests",
  link: GITHUB_TOKEN_LINK,
  optional: true,
};

/** Shared documentation tail appended to both `.env` and `.env.example`. */
const ENV_COMMON_TAIL = `# Agent Harness Configuration
# Which AI agent to use: claude-code | opencode | codex | cursor | grok | deepseek
# (also: antigravity | kimi | qwen | goose | kilo-code | cline | pi)
# Legacy: gemini still resolves to antigravity with a deprecation warning
# Defaults to 'claude-code' if not specified
AGENT_HARNESS=claude-code

# Optional: Path to the agent CLI executable.
# Leave unset — by default devintern uses the harness's standard command
# (e.g. 'claude' for claude-code) and locates it on your PATH automatically.
# Only set this if the CLI is NOT on your PATH or uses a non-standard name,
# in which case provide the command name or a full path.
# AGENT_CLI_PATH=/custom/path/to/claude

# Backward compatibility: CLAUDE_CLI_PATH is still supported as a fallback
# CLAUDE_CLI_PATH=claude

# Note: Agents will be run with --dangerously-skip-permissions and --max-turns (agent-specific)
# This allows for elevated permissions and extended conversations for complex tasks

# Optional: extra tools for the read-only analysis runs (clarity check, estimation).
# Those runs use the harness's read-only mode when supported; web fetch/search stays
# allowed on Claude Code, but MCP tools are blocked unless listed here
# (comma-separated, harness tool naming; whole-server entries also allow its write tools).
# AGENT_ANALYSIS_ALLOWED_TOOLS=mcp__notion,mcp__figma__get_design_context

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

/**
 * Full multi-tracker `.env.example` template generated from `TRACKER_SETUP`.
 * Everything is commented out except an example `TASK_TRACKER` line.
 */
export function buildEnvExample(): string {
  const sections: string[] = [
    "# @devintern/code Environment Configuration",
    "# Copy this file to .env and update with your actual values",
    "",
    "# Which task tracker to use: " + Object.keys(TRACKER_SETUP).join(" | "),
    "# Run 'devintern init' in an interactive terminal for a guided setup.",
    "TASK_TRACKER=jira",
    "",
  ];

  for (const [trackerId, steps] of Object.entries(TRACKER_SETUP)) {
    const displayName = TRACKER_CAPABILITIES[trackerId]?.displayName ?? trackerId;
    sections.push(`# --- ${displayName} (TASK_TRACKER=${trackerId}) ---`);
    const docs = TRACKER_DOCS[trackerId];
    if (docs) {
      sections.push(`# Setup guide: ${docs}`);
    }
    const placeholders: Record<string, string> = {};
    for (const step of steps) {
      const link = stepLink(step, placeholders);
      sections.push(`# ${step.label}${step.optional ? " (optional)" : ""}`);
      if (link) {
        sections.push(`# Create one at: ${link}`);
      }
      const value = step.example ?? step.defaultValue ?? "";
      sections.push(`# ${step.key}=${value}`);
      if (step.example) placeholders[step.key] = step.example;
    }
    sections.push("");
  }

  return sections.join("\n") + "\n" + ENV_COMMON_TAIL;
}

/**
 * Render a real `.env` for the chosen tracker with values collected by the
 * wizard. Skipped optional vars are written commented-out so users can find
 * them later.
 */
export function renderEnvFile(trackerId: string, values: Record<string, string>): string {
  const displayName = TRACKER_CAPABILITIES[trackerId]?.displayName ?? trackerId;
  const steps = TRACKER_SETUP[trackerId] ?? [];
  const lines: string[] = [
    "# @devintern/code Environment Configuration",
    "# Generated by 'devintern init'",
    "",
    `TASK_TRACKER=${trackerId}`,
    "",
    `# ${displayName} configuration`,
  ];
  const docs = TRACKER_DOCS[trackerId];
  if (docs) {
    lines.push(`# Setup guide: ${docs}`);
  }

  const written = new Set<string>();
  for (const step of steps) {
    const value = values[step.key];
    if (value) {
      lines.push(`${step.key}=${value}`);
    } else {
      lines.push(`# ${step.key}=${step.example ?? ""}`);
    }
    written.add(step.key);
  }

  // Extra values outside the tracker's own steps (e.g. GITHUB_TOKEN for PR
  // creation when the tracker is not GitHub).
  const extras = Object.entries(values).filter(([key, value]) => value && !written.has(key));
  if (extras.length > 0) {
    lines.push("", "# Pull Request integration");
    for (const [key, value] of extras) {
      lines.push(`${key}=${value}`);
    }
  }

  return lines.join("\n") + "\n\n" + ENV_COMMON_TAIL;
}

export interface ScaffoldOptions {
  /** Content for `.devintern-code/.env`; defaults to the full template. */
  envContent?: string;
  /** Working directory; defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Scaffold `.devintern-code/` with env files, settings, and gitignore entries.
 *
 * @returns true when files were written, false when the config dir already
 * existed (nothing touched)
 */
export function scaffoldProject(options: ScaffoldOptions = {}): boolean {
  const cwd = options.cwd ?? process.cwd();
  const configDir = resolve(cwd, ".devintern-code");
  const envFile = join(configDir, ".env");
  const envSampleFile = join(configDir, ".env.example");

  // Check if .devintern-code folder already exists
  if (existsSync(configDir)) {
    console.log(`\n⚠️  Configuration folder already exists: ${configDir}`);

    if (existsSync(envFile)) {
      console.log("✅ .env file found");
    } else {
      console.log("⚠️  .env file not found");
    }

    console.log("\n💡 To reconfigure, either:");
    console.log(`   1. Delete the folder: rm -rf ${configDir}`);
    console.log("   2. Or edit the files directly");
    return false;
  }

  try {
    mkdirSync(configDir, { recursive: true });
    console.log(`✅ Created configuration folder: ${configDir}`);
  } catch (error) {
    console.error(`❌ Failed to create configuration folder: ${error}`);
    process.exit(1);
  }

  const envSampleContent = buildEnvExample();

  try {
    writeFileSync(envSampleFile, envSampleContent, "utf8");
    console.log(`✅ Created template file: ${envSampleFile}`);
  } catch (error) {
    console.error(`❌ Failed to create .env.example: ${error}`);
    process.exit(1);
  }

  try {
    writeFileSync(envFile, options.envContent ?? envSampleContent, "utf8");
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

  try {
    writeFileSync(settingsFile, JSON.stringify(settingsContent, null, 2), "utf8");
    console.log(`✅ Created settings file: ${settingsFile}`);
  } catch (error) {
    console.error(`❌ Failed to create settings.json: ${error}`);
    process.exit(1);
  }

  // Update .gitignore to exclude .devintern-code/.env, lock file, and review worktree
  const gitignorePath = join(cwd, ".gitignore");
  const gitignoreEntries = [
    ".devintern-code/.env",
    ".devintern-code/.env.local",
    ".devintern-code/.pid.lock",
    ".devintern-code/.auth-session.json",
  ];

  try {
    let gitignoreContent = "";
    let gitignoreExists = false;

    if (existsSync(gitignorePath)) {
      gitignoreContent = readFileSync(gitignorePath, "utf8");
      gitignoreExists = true;
    }

    const entriesToAdd = gitignoreEntries.filter((entry) => !gitignoreContent.includes(entry));

    if (entriesToAdd.length > 0) {
      const newEntries = ["", "# @devintern/code - Keep credentials secure", ...entriesToAdd].join(
        "\n",
      );

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

  return true;
}

export { stepLink };
