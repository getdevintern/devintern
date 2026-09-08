/**
 * Task tracker factory / manager.
 *
 * Resolves the correct concrete {@link TaskTrackerClient} implementation
 * from environment variables, following the {@link PRManager} pattern in
 * `src/lib/pr-client.ts`.
 *
 * Client construction is also available as {@link createTrackerClient} over
 * an explicit env map, so multi-team workspaces can build one client per
 * team (isolated credentials) without mutating `process.env`.
 */

import { isMarkdownFilePath } from "@devintern/task-trackers";
import type { TaskTrackerClient } from "./task-tracker-client";
import { JiraTaskTrackerClient } from "./trackers/jira/jira-task-tracker-client";
import { AsanaTaskTrackerClient } from "./trackers/asana/asana-task-tracker-client";
import { AzureDevOpsTaskTrackerClient } from "./trackers/azure-devops/azure-devops-task-tracker-client";
import { GitHubTaskTrackerClient } from "./trackers/github/github-task-tracker-client";
import { GitLabTaskTrackerClient } from "./trackers/gitlab/gitlab-task-tracker-client";
import { LinearTaskTrackerClient } from "./trackers/linear/linear-task-tracker-client";
import { MarkdownTaskTrackerClient } from "./trackers/markdown/markdown-task-tracker-client";
import { TrelloTaskTrackerClient } from "./trackers/trello/trello-task-tracker-client";

/** Env var names each tracker reads its configuration/credentials from. */
const TRACKER_ENV_KEYS: Record<string, string[]> = {
  jira: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
  linear: ["LINEAR_API_KEY"],
  asana: ["ASANA_API_TOKEN"],
  "azure-devops": ["AZURE_DEVOPS_ORG", "AZURE_DEVOPS_PAT", "AZURE_DEVOPS_PROJECT"],
  github: ["GITHUB_TOKEN", "GITHUB_REPO"],
  gitlab: ["GITLAB_TOKEN", "GITLAB_PROJECT"],
  trello: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"],
  markdown: ["MARKDOWN_TASKS_DIR"],
};

/**
 * Whether a tracker's required variables are present in an env map.
 *
 * Used to fail fast (with a clear message) when a workspace team's composed
 * environment lacks the credentials its tracker needs.
 */
export function trackerEnvComplete(
  trackerType: string,
  env: Record<string, string | undefined>,
): boolean {
  const keys = TRACKER_ENV_KEYS[trackerType];
  if (!keys) {
    return false;
  }
  return keys.every((key) => Boolean(env[key]));
}

/** Names of the variables a tracker requires, for error messages. */
export function trackerRequiredEnv(trackerType: string): string[] {
  return TRACKER_ENV_KEYS[trackerType] ?? [];
}

/**
 * Build a concrete tracker client from an explicit tracker type and env map.
 *
 * Pure lookup: never reads or writes `process.env`, so callers can hold
 * several clients with isolated credentials side by side.
 *
 * @param trackerType - `TASK_TRACKER`-style value (default `jira`)
 * @param env - Environment providing the tracker's credentials
 * @returns A ready-to-use {@link TaskTrackerClient}
 * @throws When credentials are missing or the tracker type is unknown.
 */
export function createTrackerClient(
  trackerType: string,
  env: Record<string, string | undefined>,
): TaskTrackerClient {
  switch (trackerType.toLowerCase()) {
    case "jira": {
      const baseUrl = env.JIRA_BASE_URL;
      const email = env.JIRA_EMAIL;
      const apiToken = env.JIRA_API_TOKEN;

      if (!baseUrl || !email || !apiToken) {
        throw new Error(
          "Missing required JIRA credentials. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN environment variables.",
        );
      }

      return new JiraTaskTrackerClient(baseUrl, email, apiToken);
    }

    case "linear": {
      const apiKey = env.LINEAR_API_KEY;

      if (!apiKey) {
        throw new Error(
          "Missing required Linear credentials. Set the LINEAR_API_KEY environment variable.",
        );
      }

      return new LinearTaskTrackerClient(apiKey);
    }

    case "asana": {
      const apiToken = env.ASANA_API_TOKEN;

      if (!apiToken) {
        throw new Error(
          "Missing required Asana credentials. Set the ASANA_API_TOKEN environment variable.",
        );
      }

      return new AsanaTaskTrackerClient(apiToken, {
        defaultProjectGid: env.ASANA_DEFAULT_PROJECT_GID,
        storyPointsFieldName: env.ASANA_STORY_POINTS_FIELD,
      });
    }

    case "azure-devops": {
      const organization = env.AZURE_DEVOPS_ORG;
      const pat = env.AZURE_DEVOPS_PAT;
      const project = env.AZURE_DEVOPS_PROJECT;

      if (!organization || !pat || !project) {
        throw new Error(
          "Missing required Azure DevOps credentials. Set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.",
        );
      }

      return new AzureDevOpsTaskTrackerClient(organization, pat, project);
    }

    case "github": {
      const token = env.GITHUB_TOKEN;
      const repoValue = env.GITHUB_REPO;

      if (!token || !repoValue) {
        throw new Error(
          "Missing required GitHub credentials. Set GITHUB_TOKEN and GITHUB_REPO (owner/repo) environment variables.",
        );
      }

      const [owner, repo] = repoValue.split("/");
      if (!owner || !repo) {
        throw new Error(`Invalid GITHUB_REPO "${repoValue}". Expected owner/repo format.`);
      }

      const statusLabels = (env.GITHUB_STATUS_LABELS || "")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);

      return new GitHubTaskTrackerClient(token, owner, repo, { statusLabels });
    }

    case "gitlab": {
      const token = env.GITLAB_TOKEN;
      const projectPath = env.GITLAB_PROJECT;
      if (!token || !projectPath) {
        throw new Error(
          "Missing required GitLab credentials. Set GITLAB_TOKEN and GITLAB_PROJECT (group/repo) environment variables.",
        );
      }
      const statusLabels = (env.GITLAB_STATUS_LABELS || "")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);
      return new GitLabTaskTrackerClient(token, projectPath, {
        baseUrl: env.GITLAB_BASE_URL,
        statusLabels,
      });
    }

    case "trello": {
      const apiKey = env.TRELLO_API_KEY;
      const apiToken = env.TRELLO_API_TOKEN;

      if (!apiKey || !apiToken) {
        throw new Error(
          "Missing required Trello credentials. Set TRELLO_API_KEY and TRELLO_API_TOKEN environment variables.",
        );
      }

      return new TrelloTaskTrackerClient(apiKey, apiToken, {
        defaultBoardId: env.TRELLO_DEFAULT_BOARD_ID,
        defaultListName: env.TRELLO_DEFAULT_LIST_NAME,
      });
    }

    case "markdown": {
      const tasksDirectory = env.MARKDOWN_TASKS_DIR;
      if (!tasksDirectory) {
        throw new Error(
          "Missing MARKDOWN_TASKS_DIR. Set it to the directory containing markdown task files.",
        );
      }

      return new MarkdownTaskTrackerClient({ tasksDirectory });
    }

    default:
      throw new Error(
        `Unsupported task tracker: "${trackerType}". Supported values: jira, linear, github, gitlab, azure-devops, asana, trello, markdown`,
      );
  }
}

export class TaskTrackerManager {
  private client?: TaskTrackerClient;
  private markdownClient?: MarkdownTaskTrackerClient;

  /**
   * Lazily instantiate and cache the tracker client.
   *
   * When `taskRef` is a local markdown file path, returns a dedicated markdown
   * client that does not require PM credentials.
   */
  getClient(taskRef?: string): TaskTrackerClient {
    if (taskRef && isMarkdownFilePath(taskRef)) {
      if (!this.markdownClient) {
        this.markdownClient = new MarkdownTaskTrackerClient({
          tasksDirectory: process.env.MARKDOWN_TASKS_DIR,
        });
      }
      return this.markdownClient;
    }

    if (this.client) {
      return this.client;
    }

    this.client = createTrackerClient(process.env.TASK_TRACKER || "jira", process.env);
    return this.client;
  }

  /** Reset cached clients (useful for testing). */
  reset(): void {
    this.client = undefined;
    this.markdownClient = undefined;
  }
}
