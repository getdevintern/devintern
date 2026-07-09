import { findEnvFile } from "@devintern/utils";
import type { TrackerConfig, TrackerType } from "./types.ts";

export const BUNDLED_TRELLO_API_KEY = "b2d5d1ced28b515c6eb66c40187400b0";

/**
 * Sanitize a Jira domain by removing protocol and trailing slashes.
 *
 * @param domain - Raw Jira base URL or hostname.
 * @returns Hostname suitable for API requests (e.g. `your-org.atlassian.net`).
 */
export function sanitizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Parse `GITHUB_REPO` into owner and repo name.
 *
 * Accepts `owner/repo` (preferred) or a repo name with `GITHUB_OWNER` (legacy).
 *
 * @param repoValue - Value of the `GITHUB_REPO` environment variable.
 * @param legacyOwner - Optional `GITHUB_OWNER` fallback when `repoValue` has no slash.
 * @returns Parsed owner, repo, and combined `owner/repo` string.
 * @throws When the value cannot be parsed into a valid repository reference.
 */
export function parseGitHubRepo(
  repoValue: string,
  legacyOwner?: string,
): { owner: string; repo: string; repository: string } {
  const trimmed = repoValue.trim();

  if (trimmed.includes("/")) {
    const slashIndex = trimmed.indexOf("/");
    const owner = trimmed.slice(0, slashIndex);
    const repo = trimmed.slice(slashIndex + 1);
    if (!owner || !repo) {
      throw new Error(
        `Invalid GITHUB_REPO "${repoValue}". Expected owner/repo (e.g. acme/my-app).`,
      );
    }
    return { owner, repo, repository: `${owner}/${repo}` };
  }

  if (legacyOwner?.trim()) {
    const owner = legacyOwner.trim();
    return { owner, repo: trimmed, repository: `${owner}/${trimmed}` };
  }

  throw new Error(
    `Invalid GITHUB_REPO "${repoValue}". Set GITHUB_REPO=owner/repo (e.g. acme/my-app).`,
  );
}

/**
 * Load environment variables from the nearest `.env` file.
 *
 * Searches upward from the current working directory, checking
 * `{configDirName}/.env` first, then a plain `.env`, at each level.
 * Existing process env vars are overwritten for keys present in the file.
 * Missing or unreadable files are ignored.
 *
 * @param configDirName - Config folder name (e.g. `.devintern-pm`).
 * @returns Resolves when loading completes.
 */
export async function loadEnvFromConfigDir(configDirName: string): Promise<void> {
  const envPath = findEnvFile({ configDirName });

  if (!envPath) {
    return;
  }

  try {
    const envFile = Bun.file(envPath);
    const envContent = await envFile.text();
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0) {
          let value = valueParts.join("=").trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          process.env[key.trim()] = value;
        }
      }
    }
  } catch {
    // Optional .env file
  }
}

/**
 * Parse tracker configuration from the current process environment.
 *
 * Call {@link loadEnvFromConfigDir} first when loading from a project config directory.
 *
 * @returns Resolved {@link TrackerConfig} for the selected task tracker.
 * @throws When required environment variables for the chosen backend are missing or invalid.
 */
export function parseTrackerConfigFromEnv(): TrackerConfig {
  const backendType = (process.env.TASK_TRACKER || "jira") as TrackerType;
  const verbose = process.env.DEVINTERN_VERBOSE === "1" || process.env.DEVINTERN_VERBOSE === "true";
  const backendConfig: TrackerConfig["backend"] = {
    type: backendType,
    directory: process.env.MARKDOWN_TASKS_DIR,
  };

  let jiraConfig: TrackerConfig["jira"];
  let linearConfig: TrackerConfig["linear"];
  let trelloConfig: TrackerConfig["trello"];
  let azureDevOpsConfig: TrackerConfig["azureDevOps"];
  let asanaConfig: TrackerConfig["asana"];
  let githubConfig: TrackerConfig["github"];

  if (backendType === "jira") {
    const required = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_DEFAULT_PROJECT_KEY"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\n` +
          "Please copy .env.example to .env and fill in the values.",
      );
    }

    const jiraBaseUrl = process.env.JIRA_BASE_URL;
    const jiraEmail = process.env.JIRA_EMAIL;
    const jiraApiToken = process.env.JIRA_API_TOKEN;
    const jiraDefaultProjectKey = process.env.JIRA_DEFAULT_PROJECT_KEY;

    if (!jiraBaseUrl || !jiraEmail || !jiraApiToken || !jiraDefaultProjectKey) {
      throw new Error("Configuration was expected but missing after validation.");
    }

    jiraConfig = {
      domain: sanitizeDomain(jiraBaseUrl),
      email: jiraEmail,
      apiToken: jiraApiToken,
      defaultProjectKey: jiraDefaultProjectKey,
      verbose,
    };
  }

  if (backendType === "linear") {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Linear backend selected but LINEAR_API_KEY is missing. " +
          "Please set LINEAR_API_KEY in your environment.",
      );
    }

    linearConfig = {
      apiKey,
      defaultTeamKey: process.env.LINEAR_DEFAULT_TEAM_KEY,
    };
  }

  if (backendType === "trello") {
    const apiKey = process.env.TRELLO_API_KEY || BUNDLED_TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_API_TOKEN;

    if (!apiToken) {
      const authorizeUrl = apiKey
        ? `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=${apiKey}`
        : "https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=YOUR_API_KEY";
      throw new Error(
        `Trello backend requires TRELLO_API_TOKEN.\n` +
          `Generate one by visiting:\n${authorizeUrl}\n` +
          `Then set TRELLO_API_TOKEN in your .env`,
      );
    }

    if (!apiKey) {
      throw new Error(
        "TRELLO_API_KEY is required. Register a Power-Up at https://trello.com/power-ups/admin to get one.",
      );
    }

    trelloConfig = {
      apiKey,
      apiToken,
      defaultBoardId: process.env.TRELLO_DEFAULT_BOARD_ID,
      defaultListName: process.env.TRELLO_DEFAULT_LIST_NAME,
    };
  }

  if (backendType === "azure-devops") {
    const required = ["AZURE_DEVOPS_ORG", "AZURE_DEVOPS_PAT", "AZURE_DEVOPS_PROJECT"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\n` +
          "Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT in your environment.",
      );
    }

    const azureOrg = process.env.AZURE_DEVOPS_ORG;
    const azurePat = process.env.AZURE_DEVOPS_PAT;
    const azureProject = process.env.AZURE_DEVOPS_PROJECT;

    if (!azureOrg || !azurePat || !azureProject) {
      throw new Error("Azure DevOps configuration was expected but missing after validation.");
    }

    azureDevOpsConfig = {
      organization: azureOrg,
      pat: azurePat,
      defaultProject: azureProject,
    };
  }

  if (backendType === "asana") {
    const apiToken = process.env.ASANA_API_TOKEN;
    if (!apiToken) {
      throw new Error(
        "Asana backend selected but ASANA_API_TOKEN is missing. " +
          "Please set ASANA_API_TOKEN in your environment.",
      );
    }

    asanaConfig = {
      apiToken,
      defaultProjectGid: process.env.ASANA_DEFAULT_PROJECT_GID,
    };
  }

  if (backendType === "github") {
    const required = ["GITHUB_TOKEN", "GITHUB_REPO"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\n` +
          "Please set GITHUB_TOKEN and GITHUB_REPO (owner/repo) in your environment.",
      );
    }

    const githubToken = process.env.GITHUB_TOKEN;
    const githubRepoValue = process.env.GITHUB_REPO;

    if (!githubToken || !githubRepoValue) {
      throw new Error("GitHub configuration was expected but missing after validation.");
    }

    const { owner, repo, repository } = parseGitHubRepo(githubRepoValue, process.env.GITHUB_OWNER);

    githubConfig = {
      token: githubToken,
      owner,
      repo,
      repository,
    };
  }

  return {
    backend: backendConfig,
    verbose,
    jira: jiraConfig,
    linear: linearConfig,
    trello: trelloConfig,
    azureDevOps: azureDevOpsConfig,
    asana: asanaConfig,
    github: githubConfig,
  };
}

/**
 * Load tracker configuration from a project config directory.
 *
 * Reads `{configDirName}/.env` first, then validates backend-specific required vars.
 *
 * @param configDirName - Config folder name relative to cwd (e.g. `.devintern-pm`).
 * @returns Fully resolved {@link TrackerConfig} for the selected task tracker.
 * @throws When required environment variables for the chosen backend are missing or invalid.
 */
export async function loadTrackerConfig(configDirName: string): Promise<TrackerConfig> {
  await loadEnvFromConfigDir(configDirName);
  return parseTrackerConfigFromEnv();
}
