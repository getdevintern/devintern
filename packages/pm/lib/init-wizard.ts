/**
 * Interactive `devpm init` wizard: pick a tracker, paste tokens with a deep
 * link to each provider's token-creation page and the matching setup guide on
 * devintern.com, validate the connection, then write `.devintern-pm/.env`.
 *
 * Prompt-loop mechanics and credential probes are shared with
 * `devintern init` via `@devintern/task-trackers`.
 *
 * Runs only in interactive terminals; `devpm init --yes` (or piped stdin)
 * falls back to the non-interactive template scaffold in `init.ts`.
 */

import { join } from "node:path";
import {
  BUNDLED_TRELLO_API_KEY,
  type EnvPromptStep,
  defaultProbe,
  extractExistingTrackerConfig,
  promptForTracker,
  promptReuseExistingConfig,
  promptSteps,
  stepLink,
  validateConnection,
} from "@devintern/task-trackers";
import { ensureGitignore } from "./init";

export { isInteractive } from "@devintern/task-trackers";

type PromptFn = (question: string) => Promise<string>;
type ProbeFn = (trackerId: string, env: Record<string, string>) => Promise<void>;

export interface PmInitWizardDeps {
  /** Reads one line of user input; defaults to node:readline over stdin. */
  prompt?: PromptFn;
  /** Credential probe; defaults to a cheap authenticated API call per tracker. */
  probe?: ProbeFn;
  /** Working directory; defaults to `process.cwd()`. */
  cwd?: string;
  log?: (message: string) => void;
}

/** Tracker display names, in menu order (matches `.env.example`). */
export const PM_TRACKER_NAMES: Record<string, string> = {
  jira: "Jira",
  linear: "Linear",
  trello: "Trello",
  "azure-devops": "Azure DevOps",
  asana: "Asana",
  github: "GitHub Issues",
  markdown: "Markdown files",
};

/** Per-tracker setup guides on the DevIntern website. */
export const PM_TRACKER_DOCS: Record<string, string> = {
  jira: "https://devintern.com/docs/pm/jira-integration",
  linear: "https://devintern.com/docs/pm/linear-integration",
  trello: "https://devintern.com/docs/pm/trello-integration",
  "azure-devops": "https://devintern.com/docs/pm/azure-devops-integration",
  asana: "https://devintern.com/docs/pm/asana-integration",
  github: "https://devintern.com/docs/pm/github-integration",
};

/** Per-tracker credential prompts. Env keys match `loadTrackerConfig` and the backends. */
export const PM_TRACKER_SETUP: Record<string, EnvPromptStep[]> = {
  jira: [
    {
      key: "JIRA_BASE_URL",
      label: "Jira instance URL (without trailing slash)",
      example: "https://your-company.atlassian.net",
    },
    { key: "JIRA_EMAIL", label: "Jira account email", example: "you@company.com" },
    {
      key: "JIRA_API_TOKEN",
      label: "Jira API token",
      link: "https://id.atlassian.com/manage-profile/security/api-tokens",
    },
    {
      key: "JIRA_DEFAULT_PROJECT_KEY",
      label: "Default Jira project key (PROJ in PROJ-123)",
      example: "PROJ",
    },
  ],
  linear: [
    {
      key: "LINEAR_API_KEY",
      label: "Linear personal API key (Settings > API > Personal API keys)",
      link: "https://linear.app/settings/api",
    },
    {
      key: "LINEAR_DEFAULT_TEAM_KEY",
      label: "Default Linear team key",
      example: "ENG",
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
      label: "Trello API token (click Allow, then paste the token shown)",
      link: (values) =>
        `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=${
          values.TRELLO_API_KEY || BUNDLED_TRELLO_API_KEY
        }`,
    },
    {
      key: "TRELLO_DEFAULT_BOARD_ID",
      label: "Default Trello board ID (short ID from the board URL)",
      example: "abc123",
      optional: true,
    },
    {
      key: "TRELLO_DEFAULT_LIST_NAME",
      label: "Default Trello list name",
      example: "To Do",
      optional: true,
    },
  ],
  "azure-devops": [
    { key: "AZURE_DEVOPS_ORG", label: "Azure DevOps organization name", example: "my-org" },
    {
      key: "AZURE_DEVOPS_PAT",
      label:
        "Azure DevOps personal access token (Work Items: Read & write; Project and Team: Read)",
      link: (values) =>
        `https://dev.azure.com/${values.AZURE_DEVOPS_ORG || "your-org"}/_usersSettings/tokens`,
    },
    { key: "AZURE_DEVOPS_PROJECT", label: "Azure DevOps project name", example: "MyProject" },
  ],
  asana: [
    {
      key: "ASANA_API_TOKEN",
      label: "Asana personal access token",
      link: "https://app.asana.com/0/developer-console",
    },
    {
      key: "ASANA_DEFAULT_PROJECT_GID",
      label: "Default Asana project GID",
      example: "1200000000000000",
      optional: true,
    },
  ],
  github: [
    {
      key: "GITHUB_TOKEN",
      label: "GitHub personal access token (fine-grained: Issues Read & write + Metadata Read)",
      link: "https://github.com/settings/personal-access-tokens/new",
    },
    { key: "GITHUB_REPO", label: "Target repository", example: "owner/repo" },
  ],
  markdown: [
    {
      key: "MARKDOWN_TASKS_DIR",
      label: "Directory for markdown task files",
      example: ".devintern-pm/tasks",
      defaultValue: ".devintern-pm/tasks",
    },
  ],
};

/** Shared documentation tail appended to the generated `.env` (mirrors `.env.example`). */
const ENV_COMMON_TAIL = `# Agent Harness Configuration
# Which AI agent to use: claude-code | opencode | codex | cursor | grok | deepseek
# (also: antigravity | kimi | qwen | goose | kilo-code | cline | pi)
# Legacy: gemini still resolves to antigravity with a deprecation warning
# Defaults to 'claude-code' if not specified
AGENT_HARNESS=claude-code

# Optional: Path to the agent CLI executable.
# Leave unset — by default devintern uses the harness's standard command
# (e.g. 'claude' for claude-code, 'grok' for grok, 'agy' for antigravity,
# 'reasonix' for deepseek) and locates it on your PATH automatically.
# Only set this if the CLI is NOT on your PATH or uses a non-standard name,
# in which case provide the command name or a full path.
# AGENT_CLI_PATH=/custom/path/to/claude
`;

/**
 * Render `.devintern-pm/.env` for the chosen tracker with values collected by
 * the wizard. Skipped optional vars are written commented-out so users can
 * find them later.
 */
export function renderPmEnvFile(trackerId: string, values: Record<string, string>): string {
  const displayName = PM_TRACKER_NAMES[trackerId] ?? trackerId;
  const steps = PM_TRACKER_SETUP[trackerId] ?? [];
  const lines: string[] = [
    "# @devintern/pm Environment Configuration",
    "# Generated by 'devpm init'",
    "",
    `TASK_TRACKER=${trackerId}`,
    "",
    `# ${displayName} configuration`,
  ];
  const docs = PM_TRACKER_DOCS[trackerId];
  if (docs) {
    lines.push(`# Setup guide: ${docs}`);
  }

  for (const step of steps) {
    const value = values[step.key];
    if (value) {
      lines.push(`${step.key}=${value}`);
    } else {
      lines.push(`# ${step.key}=${step.example ?? ""}`);
    }
  }

  return lines.join("\n") + "\n\n" + ENV_COMMON_TAIL;
}

/** Run the interactive `devpm init` wizard end to end. */
export async function runPmInitWizard(deps: PmInitWizardDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const probe = deps.probe ?? defaultProbe;

  log("🚀 Initializing @devintern/pm for this project...");

  let rl: import("node:readline/promises").Interface | undefined;
  let prompt = deps.prompt;
  if (!prompt) {
    const { createInterface } = await import("node:readline/promises");
    rl = createInterface({ input: process.stdin, output: process.stdout });
    prompt = (question: string) => rl!.question(question);
  }

  try {
    const configDir = join(cwd, ".devintern-pm");
    const envPath = join(configDir, ".env");
    if (await Bun.file(envPath).exists()) {
      log(`\n⚠️  Configuration already exists: ${envPath}`);
      const answer = (await prompt("Overwrite it? (y/N): ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        log("❌ Initialization cancelled");
        return;
      }
    }

    const values: Record<string, string> = {};
    let trackerId: string | undefined;

    // Fast track: reuse tracker credentials from an existing @devintern/code
    // config in the same project (env var names are shared).
    const codeEnvFile = Bun.file(join(cwd, ".devintern-code", ".env"));
    if (await codeEnvFile.exists()) {
      const existing = extractExistingTrackerConfig(await codeEnvFile.text(), PM_TRACKER_SETUP);
      if (existing) {
        const reused = await promptReuseExistingConfig(existing, {
          sourceLabel: "@devintern/code configuration (.devintern-code/.env)",
          trackerName: PM_TRACKER_NAMES[existing.trackerId] ?? existing.trackerId,
          steps: PM_TRACKER_SETUP[existing.trackerId] ?? [],
          prompt,
          log,
          values,
        });
        if (reused) trackerId = existing.trackerId;
      }
    }

    const reusedExisting = trackerId !== undefined;
    if (trackerId === undefined) {
      trackerId = await promptForTracker(
        prompt,
        log,
        Object.keys(PM_TRACKER_SETUP).map((id) => ({
          id,
          displayName: PM_TRACKER_NAMES[id] ?? id,
        })),
      );
    }
    const steps = PM_TRACKER_SETUP[trackerId] ?? [];

    const docs = PM_TRACKER_DOCS[trackerId];
    if (docs) {
      log(`\n📖 Setup guide (tokens, permissions, examples): ${docs}`);
    }

    if (!reusedExisting) {
      await promptSteps(steps, prompt, log, values);
    }

    if (trackerId === "markdown") {
      log("\nℹ️  No credentials needed for the markdown tracker.");
    } else {
      await validateConnection(trackerId, values, steps, prompt, probe, log, ".devintern-pm/.env");
    }

    await Bun.write(envPath, renderPmEnvFile(trackerId, values));
    log(`\n✅ Created configuration file: ${envPath}`);

    await ensureGitignore(cwd, log);

    log("\n🎉 Project initialized successfully!");
    log("\n📝 Next steps:");
    log("   1. Run 'devpm login' to sign in");
    log("   2. Run 'devpm --interactive' to create your first task");
    if (docs) {
      log(`   3. Read the setup guide if anything is unclear: ${docs}`);
    }
  } finally {
    rl?.close();
  }
}

export { stepLink };
