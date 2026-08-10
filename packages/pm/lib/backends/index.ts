import { resolve } from "node:path";
import type { Config } from "../config";
import { AsanaBackend } from "./asana";
import { AzureDevOpsBackend } from "./azure-devops";
import { GitHubBackend } from "./github";
import { JiraBackend } from "./jira";
import { LinearBackend } from "./linear";
import { MarkdownBackend } from "./markdown";
import { TrelloBackend } from "./trello";
import type { TaskBackend } from "./types";

export type { TaskBackend, CreatedTask, ProjectInfo, LabelRef, LabelListResult } from "./types";

/**
 * Create a {@link TaskBackend} implementation for the configured task tracker.
 *
 * @param config - Loaded application configuration.
 * @param baseDir - Base directory for resolving relative paths like the
 *   markdown tasks directory (defaults to cwd; desktop hosts pass the project dir).
 * @returns Backend instance for Jira, Linear, Trello, Azure DevOps, Asana, GitHub, or Markdown.
 * @throws When the backend type is unknown or required backend config is missing.
 */
export async function createBackend(config: Config, baseDir?: string): Promise<TaskBackend> {
  let backend: TaskBackend;
  switch (config.backend.type) {
    case "jira": {
      if (!config.jira) {
        throw new Error(
          "Jira backend selected but Jira configuration is missing. " +
            "Please set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_DEFAULT_PROJECT_KEY.",
        );
      }
      backend = new JiraBackend(config.jira);
      break;
    }
    case "linear": {
      if (!config.linear) {
        throw new Error(
          "Linear backend selected but Linear configuration is missing. " +
            "Please set LINEAR_API_KEY.",
        );
      }
      backend = new LinearBackend(config.linear);
      break;
    }
    case "trello": {
      if (!config.trello) {
        throw new Error(
          "Trello backend selected but Trello configuration is missing. " +
            "Please set TRELLO_API_KEY and TRELLO_API_TOKEN.",
        );
      }
      backend = new TrelloBackend(config.trello);
      break;
    }
    case "azure-devops": {
      if (!config.azureDevOps) {
        throw new Error(
          "Azure DevOps backend selected but Azure DevOps configuration is missing. " +
            "Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT.",
        );
      }
      backend = new AzureDevOpsBackend(config.azureDevOps);
      break;
    }
    case "asana": {
      if (!config.asana) {
        throw new Error(
          "Asana backend selected but Asana configuration is missing. " +
            "Please set ASANA_API_TOKEN.",
        );
      }
      backend = new AsanaBackend(config.asana);
      break;
    }
    case "github": {
      if (!config.github) {
        throw new Error(
          "GitHub backend selected but GitHub configuration is missing. " +
            "Please set GITHUB_TOKEN and GITHUB_REPO (owner/repo).",
        );
      }
      backend = new GitHubBackend(config.github);
      break;
    }
    case "markdown": {
      backend = new MarkdownBackend({
        directory: resolve(
          baseDir ?? process.cwd(),
          config.backend.directory || ".devintern-pm/tasks",
        ),
      });
      break;
    }
    default:
      throw new Error(
        `Unknown backend type: ${(config.backend as { type: string }).type}. ` +
          `Supported: jira, linear, trello, azure-devops, asana, github, markdown`,
      );
  }

  if (backend.supportsLabels && !backend.getLabels) {
    throw new Error(`${backend.name} reports supportsLabels but does not implement getLabels`);
  }

  if (backend.supportsAttachments && !backend.uploadAttachment) {
    throw new Error(
      `${backend.name} reports supportsAttachments but does not implement uploadAttachment`,
    );
  }

  return backend;
}
