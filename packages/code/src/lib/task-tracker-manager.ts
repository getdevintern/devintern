/**
 * Task tracker factory / manager.
 *
 * Resolves the correct concrete {@link TaskTrackerClient} implementation
 * from environment variables, following the {@link PRManager} pattern in
 * `src/lib/pr-client.ts`.
 */

import { isMarkdownFilePath } from "@devintern/task-trackers";
import type { TaskTrackerClient } from "./task-tracker-client";
import { JiraTaskTrackerClient } from "./trackers/jira/jira-task-tracker-client";
import { AsanaTaskTrackerClient } from "./trackers/asana/asana-task-tracker-client";
import { AzureDevOpsTaskTrackerClient } from "./trackers/azure-devops/azure-devops-task-tracker-client";
import { GitHubTaskTrackerClient } from "./trackers/github/github-task-tracker-client";
import { LinearTaskTrackerClient } from "./trackers/linear/linear-task-tracker-client";
import { MarkdownTaskTrackerClient } from "./trackers/markdown/markdown-task-tracker-client";
import { TrelloTaskTrackerClient } from "./trackers/trello/trello-task-tracker-client";

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

    const trackerType = (process.env.TASK_TRACKER || "jira").toLowerCase();

    switch (trackerType) {
      case "jira": {
        const baseUrl = process.env.JIRA_BASE_URL;
        const email = process.env.JIRA_EMAIL;
        const apiToken = process.env.JIRA_API_TOKEN;

        if (!baseUrl || !email || !apiToken) {
          throw new Error(
            "Missing required JIRA credentials. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN environment variables.",
          );
        }

        this.client = new JiraTaskTrackerClient(baseUrl, email, apiToken);
        break;
      }

      case "linear": {
        const apiKey = process.env.LINEAR_API_KEY;

        if (!apiKey) {
          throw new Error(
            "Missing required Linear credentials. Set the LINEAR_API_KEY environment variable.",
          );
        }

        this.client = new LinearTaskTrackerClient(apiKey);
        break;
      }

      case "asana": {
        const apiToken = process.env.ASANA_API_TOKEN;

        if (!apiToken) {
          throw new Error(
            "Missing required Asana credentials. Set the ASANA_API_TOKEN environment variable.",
          );
        }

        this.client = new AsanaTaskTrackerClient(apiToken, {
          defaultProjectGid: process.env.ASANA_DEFAULT_PROJECT_GID,
          storyPointsFieldName: process.env.ASANA_STORY_POINTS_FIELD,
        });
        break;
      }

      case "azure-devops": {
        const organization = process.env.AZURE_DEVOPS_ORG;
        const pat = process.env.AZURE_DEVOPS_PAT;
        const project = process.env.AZURE_DEVOPS_PROJECT;

        if (!organization || !pat || !project) {
          throw new Error(
            "Missing required Azure DevOps credentials. Set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.",
          );
        }

        this.client = new AzureDevOpsTaskTrackerClient(organization, pat, project);
        break;
      }

      case "github": {
        const token = process.env.GITHUB_TOKEN;
        const repoValue = process.env.GITHUB_REPO;

        if (!token || !repoValue) {
          throw new Error(
            "Missing required GitHub credentials. Set GITHUB_TOKEN and GITHUB_REPO (owner/repo) environment variables.",
          );
        }

        const [owner, repo] = repoValue.split("/");
        if (!owner || !repo) {
          throw new Error(`Invalid GITHUB_REPO "${repoValue}". Expected owner/repo format.`);
        }

        const statusLabels = (process.env.GITHUB_STATUS_LABELS || "")
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean);

        this.client = new GitHubTaskTrackerClient(token, owner, repo, { statusLabels });
        break;
      }

      case "trello": {
        const apiKey = process.env.TRELLO_API_KEY;
        const apiToken = process.env.TRELLO_API_TOKEN;

        if (!apiKey || !apiToken) {
          throw new Error(
            "Missing required Trello credentials. Set TRELLO_API_KEY and TRELLO_API_TOKEN environment variables.",
          );
        }

        this.client = new TrelloTaskTrackerClient(apiKey, apiToken, {
          defaultBoardId: process.env.TRELLO_DEFAULT_BOARD_ID,
          defaultListName: process.env.TRELLO_DEFAULT_LIST_NAME,
        });
        break;
      }

      case "markdown": {
        const tasksDirectory = process.env.MARKDOWN_TASKS_DIR;
        if (!tasksDirectory) {
          throw new Error(
            "Missing MARKDOWN_TASKS_DIR. Set it to the directory containing markdown task files.",
          );
        }

        this.client = new MarkdownTaskTrackerClient({ tasksDirectory });
        break;
      }

      default:
        throw new Error(
          `Unsupported task tracker: "${trackerType}". Supported values: jira, linear, github, azure-devops, asana, trello, markdown`,
        );
    }

    return this.client;
  }

  /** Reset cached clients (useful for testing). */
  reset(): void {
    this.client = undefined;
    this.markdownClient = undefined;
  }
}
