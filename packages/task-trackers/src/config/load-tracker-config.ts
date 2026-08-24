import { readFile } from "node:fs/promises";
import { findEnvFile } from "@devintern/utils";
import { DEFAULT_GITLAB_BASE_URL } from "../clients/gitlab.ts";
import { getMissingRequiredEnv, isTrackerId } from "./tracker-meta.ts";
import type { TrackerConfig, TrackerType } from "./types.ts";

export const BUNDLED_TRELLO_API_KEY = "b2d5d1ced28b515c6eb66c40187400b0";

/**
 * Throw when `TRACKER_META.requiredEnv` entries are missing for `backendType`.
 * Trello keeps a custom authorize-URL message; other trackers share one format.
 */
function assertRequiredTrackerEnv(backendType: string): void {
  if (!isTrackerId(backendType)) return;

  const missing = getMissingRequiredEnv(backendType, process.env);
  if (missing.length === 0) return;

  if (backendType === "trello") {
    const apiKey = process.env.TRELLO_API_KEY || BUNDLED_TRELLO_API_KEY;
    const authorizeUrl = apiKey
      ? `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=${apiKey}`
      : "https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=YOUR_API_KEY";
    throw new Error(
      `Trello backend requires TRELLO_API_TOKEN.\n` +
        `Generate one by visiting:\n${authorizeUrl}\n` +
        `Then set TRELLO_API_TOKEN in your .env`,
    );
  }

  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}\n` +
      "Please copy .env.example to .env and fill in the values.",
  );
}

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
 * Normalize a GitLab instance URL.
 *
 * Unlike Jira domains, GitLab needs the protocol kept (self-hosted instances
 * may run on plain http). Adds `https://` when no protocol is present and
 * strips trailing slashes; blank values fall back to
 * {@link DEFAULT_GITLAB_BASE_URL}.
 *
 * @param raw - Raw `GITLAB_BASE_URL` value (may be empty).
 * @returns Instance root URL suitable for API requests (e.g. `https://gitlab.com`).
 */
export function sanitizeGitlabBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_GITLAB_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

/**
 * Normalize a `GITLAB_PROJECT` value into an API project path.
 *
 * Accepts `group/repo`, subgroup paths (`group/sub/repo`), numeric project
 * IDs, and pasted web URLs (`https://host/group/repo/-/issues`). The `/-/`
 * suffix and everything after it is dropped.
 *
 * @param value - Raw `GITLAB_PROJECT` environment variable value.
 * @returns Project path for API URLs (encoded later by {@link GitLabClient}).
 * @throws When the value does not identify a project.
 */
export function parseGitLabProject(value: string): string {
  const trimmed = value.trim();
  // Drop the instance origin from pasted web URLs, then cut at "/-/".
  let path = trimmed.replace(/^https?:\/\/[^/]+/i, "");
  const dashIndex = path.indexOf("/-/");
  if (dashIndex >= 0) {
    path = path.slice(0, dashIndex);
  }
  path = path
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .join("/");

  if (/^\d+$/.test(path)) {
    return path;
  }

  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(path)) {
    throw new Error(
      `Invalid GITLAB_PROJECT "${value}". Expected group/repo (subgroups allowed, ` +
        "e.g. acme/team/my-app) or a numeric project ID.",
    );
  }

  return path;
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
 * Searches upward from `baseDir` (default: current working directory), checking
 * `{configDirName}/.env` first, then a plain `.env`, at each level.
 * Existing process env vars are overwritten for keys present in the file.
 * Missing or unreadable files are ignored.
 *
 * @param configDirName - Config folder name (e.g. `.devintern-pm`).
 * @param baseDir - Directory to start the upward search from (defaults to cwd).
 * @returns Resolves when loading completes.
 */
export async function loadEnvFromConfigDir(
  configDirName: string,
  baseDir: string = process.cwd(),
): Promise<void> {
  const envPath = findEnvFile({ configDirName, startDir: baseDir });

  if (!envPath) {
    return;
  }

  try {
    const envContent = await readFile(envPath, "utf8");
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
  let gitlabConfig: TrackerConfig["gitlab"];

  // Markdown keeps MARKDOWN_TASKS_DIR optional here (backends default the path);
  // other trackers validate against TRACKER_META.requiredEnv.
  if (backendType !== "markdown") {
    assertRequiredTrackerEnv(backendType);
  }

  if (backendType === "jira") {
    jiraConfig = {
      domain: sanitizeDomain(process.env.JIRA_BASE_URL!),
      email: process.env.JIRA_EMAIL!,
      apiToken: process.env.JIRA_API_TOKEN!,
      defaultProjectKey: process.env.JIRA_DEFAULT_PROJECT_KEY!,
      verbose,
    };
  }

  if (backendType === "linear") {
    linearConfig = {
      apiKey: process.env.LINEAR_API_KEY!,
      defaultTeamKey: process.env.LINEAR_DEFAULT_TEAM_KEY,
    };
  }

  if (backendType === "trello") {
    const apiKey = process.env.TRELLO_API_KEY || BUNDLED_TRELLO_API_KEY;
    trelloConfig = {
      apiKey,
      apiToken: process.env.TRELLO_API_TOKEN!,
      defaultBoardId: process.env.TRELLO_DEFAULT_BOARD_ID,
      defaultListName: process.env.TRELLO_DEFAULT_LIST_NAME,
    };
  }

  if (backendType === "azure-devops") {
    azureDevOpsConfig = {
      organization: process.env.AZURE_DEVOPS_ORG!,
      pat: process.env.AZURE_DEVOPS_PAT!,
      defaultProject: process.env.AZURE_DEVOPS_PROJECT!,
    };
  }

  if (backendType === "asana") {
    asanaConfig = {
      apiToken: process.env.ASANA_API_TOKEN!,
      defaultProjectGid: process.env.ASANA_DEFAULT_PROJECT_GID,
    };
  }

  if (backendType === "github") {
    const { owner, repo, repository } = parseGitHubRepo(
      process.env.GITHUB_REPO!,
      process.env.GITHUB_OWNER,
    );

    githubConfig = {
      token: process.env.GITHUB_TOKEN!,
      owner,
      repo,
      repository,
    };
  }

  if (backendType === "gitlab") {
    gitlabConfig = {
      token: process.env.GITLAB_TOKEN!,
      projectPath: parseGitLabProject(process.env.GITLAB_PROJECT!),
      baseUrl: sanitizeGitlabBaseUrl(process.env.GITLAB_BASE_URL),
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
    gitlab: gitlabConfig,
  };
}

/**
 * Load tracker configuration from a project config directory.
 *
 * Reads `{configDirName}/.env` first, then validates backend-specific required vars.
 *
 * @param configDirName - Config folder name (e.g. `.devintern-pm`).
 * @param baseDir - Directory to start the upward search from (defaults to cwd).
 * @returns Fully resolved {@link TrackerConfig} for the selected task tracker.
 * @throws When required environment variables for the chosen backend are missing or invalid.
 */
export async function loadTrackerConfig(
  configDirName: string,
  baseDir?: string,
): Promise<TrackerConfig> {
  await loadEnvFromConfigDir(configDirName, baseDir);
  return parseTrackerConfigFromEnv();
}
