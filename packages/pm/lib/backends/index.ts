import type { Config } from "../config";
import { AsanaBackend } from "./asana";
import { AzureDevOpsBackend } from "./azure-devops";
import { GitHubBackend } from "./github";
import { JiraBackend } from "./jira";
import { LinearBackend } from "./linear";
import { MarkdownBackend } from "./markdown";
import { TrelloBackend } from "./trello";
import type { TaskBackend } from "./types";

export type { TaskBackend, CreatedTask, ProjectInfo } from "./types";

/**
 * Create a {@link TaskBackend} implementation for the configured task tracker.
 *
 * @param config - Loaded application configuration.
 * @returns Backend instance for Jira, Linear, Trello, Azure DevOps, Asana, GitHub, or Markdown.
 * @throws When the backend type is unknown or required backend config is missing.
 */
export async function createBackend(config: Config): Promise<TaskBackend> {
  switch (config.backend.type) {
    case "jira": {
      if (!config.jira) {
        throw new Error(
          "Jira backend selected but Jira configuration is missing. " +
            "Please set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_DEFAULT_PROJECT_KEY.",
        );
      }
      return new JiraBackend(config.jira);
    }
    case "linear": {
      if (!config.linear) {
        throw new Error(
          "Linear backend selected but Linear configuration is missing. " +
            "Please set LINEAR_API_KEY.",
        );
      }
      return new LinearBackend(config.linear);
    }
    case "trello": {
      if (!config.trello) {
        throw new Error(
          "Trello backend selected but Trello configuration is missing. " +
            "Please set TRELLO_API_KEY and TRELLO_API_TOKEN.",
        );
      }
      return new TrelloBackend(config.trello);
    }
    case "azure-devops": {
      if (!config.azureDevOps) {
        throw new Error(
          "Azure DevOps backend selected but Azure DevOps configuration is missing. " +
            "Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT.",
        );
      }
      return new AzureDevOpsBackend(config.azureDevOps);
    }
    case "asana": {
      if (!config.asana) {
        throw new Error(
          "Asana backend selected but Asana configuration is missing. " +
            "Please set ASANA_API_TOKEN.",
        );
      }
      return new AsanaBackend(config.asana);
    }
    case "github": {
      if (!config.github) {
        throw new Error(
          "GitHub backend selected but GitHub configuration is missing. " +
            "Please set GITHUB_TOKEN and GITHUB_REPO (owner/repo).",
        );
      }
      return new GitHubBackend(config.github);
    }
    case "markdown": {
      return new MarkdownBackend({
        directory: config.backend.directory || ".devintern-pm/tasks",
      });
    }
    default:
      throw new Error(
        `Unknown backend type: ${(config.backend as { type: string }).type}. ` +
          `Supported: jira, linear, trello, azure-devops, asana, github, markdown`,
      );
  }
}
