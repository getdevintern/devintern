/**
 * Browser-safe pm init metadata and pure helpers.
 *
 * Shared by the CLI wizard, programmatic init (`init-wizard.ts`), and the
 * desktop renderer. Must not import Node builtins, filesystem helpers, or the
 * full `@devintern/task-trackers` entry (those pull API clients into Vite).
 */

/** Mirrors `@devintern/task-trackers` — keep in sync with BUNDLED_TRELLO_API_KEY. */
export const BUNDLED_TRELLO_API_KEY = "b2d5d1ced28b515c6eb66c40187400b0";

/** One credential/config prompt in an init wizard (same shape as task-trackers). */
export interface EnvPromptStep {
  key: string;
  label: string;
  link?: string | ((values: Record<string, string>) => string);
  optional?: boolean;
  example?: string;
  defaultValue?: string;
}

/** Resolve a step's deep link, which may depend on earlier answers. */
export function stepLink(step: EnvPromptStep, values: Record<string, string>): string | undefined {
  if (!step.link) return undefined;
  return typeof step.link === "function" ? step.link(values) : step.link;
}

/** One tracker option for GUI or CLI menus. */
export interface PmTrackerInfo {
  id: string;
  displayName: string;
  /** Setup guide on devintern.com, when one exists. */
  docsUrl?: string;
  /** False for markdown — no credential probe. */
  needsCredentials: boolean;
}

/** Tracker display names, in menu order (matches `.env.example`). */
export const PM_TRACKER_NAMES: Record<string, string> = {
  jira: "Jira",
  linear: "Linear",
  trello: "Trello",
  "azure-devops": "Azure DevOps",
  asana: "Asana",
  github: "GitHub Issues",
  gitlab: "GitLab",
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
  gitlab: "https://devintern.com/docs/pm/gitlab-integration",
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
  gitlab: [
    {
      key: "GITLAB_BASE_URL",
      label: "GitLab instance URL (press Enter for https://gitlab.com)",
      example: "https://gitlab.example.com",
      optional: true,
      defaultValue: "https://gitlab.com",
    },
    {
      key: "GITLAB_TOKEN",
      label:
        "GitLab personal access token (scopes: api, or read_api + write_repository for read/write)",
      link: (values) => {
        const host = (values.GITLAB_BASE_URL || "https://gitlab.com").replace(/\/+$/, "");
        const origin = /^https?:\/\//i.test(host) ? host : `https://${host}`;
        return `${origin}/-/user_settings/personal_access_tokens?name=DevIntern&scopes=api`;
      },
    },
    {
      key: "GITLAB_PROJECT",
      label: "Target project path (subgroups allowed) or numeric project ID",
      example: "group/sub/repo",
    },
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

/** Tracker menu entries in the same order as {@link PM_TRACKER_SETUP}. */
export function listPmTrackers(): PmTrackerInfo[] {
  return Object.keys(PM_TRACKER_SETUP).map((id) => ({
    id,
    displayName: PM_TRACKER_NAMES[id] ?? id,
    docsUrl: PM_TRACKER_DOCS[id],
    needsCredentials: id !== "markdown",
  }));
}

/** Fill blank keys from each step's `defaultValue` (e.g. bundled Trello key). */
export function applyPmTrackerDefaults(
  trackerId: string,
  values: Record<string, string>,
): Record<string, string> {
  const result = { ...values };
  for (const step of PM_TRACKER_SETUP[trackerId] ?? []) {
    const current = result[step.key]?.trim();
    if (!current && step.defaultValue) {
      result[step.key] = step.defaultValue;
    }
  }
  return result;
}

/** Required step keys (no optional / default) that are still empty. */
export function missingRequiredPmFields(
  trackerId: string,
  values: Record<string, string>,
): string[] {
  return (PM_TRACKER_SETUP[trackerId] ?? [])
    .filter((step) => !step.optional && !step.defaultValue && !values[step.key]?.trim())
    .map((step) => step.key);
}
