import type { AtlassianDocument, JiraIssue } from "../../types/jira";
import type { Task } from "../../types/task-tracker";
import { buildPrBody } from "./pr-body";
import type { PRInfo, PRResult } from "./shared";

export abstract class PRClient {
  protected token: string;
  protected baseUrl: string;

  /**
   * @param token - Platform API token
   * @param baseUrl - REST API base URL
   */
  constructor(token: string, baseUrl: string) {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  /** Create a pull request on the target platform. */
  abstract createPullRequest(prInfo: PRInfo): Promise<PRResult>;

  /**
   * Build a standard PR title from task metadata.
   *
   * @param taskKey - Task tracker issue key
   * @param taskSummary - Issue summary line
   */
  protected createPRTitle(taskKey: string, taskSummary: string): string {
    return `[${taskKey}] ${taskSummary}`;
  }

  /**
   * Extract plain text from an Atlassian Document or string body.
   *
   * @param doc - ADF document or plain string
   */
  protected convertAtlassianDocumentToString(doc: AtlassianDocument | string): string {
    if (typeof doc === "string") {
      return doc;
    }

    // Simple conversion - extract text content from Atlassian Document Format
    const extractText = (nodes: any[]): string => {
      if (!nodes) return "";

      return nodes
        .map((node) => {
          if (node.type === "text") {
            return node.text || "";
          }
          if (node.content) {
            return extractText(node.content);
          }
          return "";
        })
        .join("");
    };

    return extractText(doc.content);
  }

  /**
   * Build the structured PR body template from task tracker details.
   *
   * @param task - Source task (JIRA issue or generic Task)
   * @param implementationSummary - Optional agent implementation summary
   * @param explanation - Optional reviewer explanation from a pipeline plugin
   */
  protected createPRBody(
    task: Task | JiraIssue,
    implementationSummary?: string,
    explanation?: string,
  ): string {
    const key = (task as Task).key || (task as JiraIssue).key;
    const summary = (task as Task).summary || (task as JiraIssue).fields?.summary || "Unknown";

    return buildPrBody({ taskKey: key, taskSummary: summary, implementationSummary, explanation });
  }
}
