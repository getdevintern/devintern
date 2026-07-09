/**
 * JIRA implementation of the platform-agnostic {@link TaskTrackerClient}.
 *
 * Delegates HTTP calls to the shared {@link JiraClient} from `@devintern/task-trackers`
 * and uses shared JIRA issue utilities plus code-specific comment formatters.
 */

import {
  JiraClient as BaseJiraClient,
  extractLinkedResources,
  extractTextFromADF,
  formatIssueDetails,
  getRelatedWorkItems,
  type JiraIssue,
} from "@devintern/task-trackers";
import type {
  Comment,
  DetailedRelatedIssue,
  FormattedTaskDetails,
  LinkedResource,
  Task,
  TaskTrackerCommentContent,
} from "../../../types/task-tracker";
import type { TaskTrackerClient } from "../../task-tracker-client";
import { JiraFormatter } from "./jira-formatter";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import path from "path";

export class JiraTaskTrackerClient implements TaskTrackerClient {
  private jiraClient: BaseJiraClient;

  /** Backward-compatible API delegate for tests that mock at the HTTP layer. */
  jiraApiCall = async (method: string, url: string, body?: any): Promise<any> => {
    return this.jiraClient.jiraApiCall(method, url, body);
  };

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.jiraClient = new BaseJiraClient(baseUrl, email, apiToken);

    // Set up a mockable jiraApiCall proxy. When tests override
    // `client.jiraApiCall`, the internal BaseJiraClient also routes
    // through the override so that all higher-level methods use the mock.
    const originalInternal = this.jiraClient.jiraApiCall.bind(this.jiraClient);
    const defaultDelegate = this.jiraApiCall;

    this.jiraClient.jiraApiCall = async (method: string, url: string, body?: any): Promise<any> => {
      if (this.jiraApiCall !== defaultDelegate) {
        return this.jiraApiCall(method, url, body);
      }
      return originalInternal(method, url, body);
    };
  }

  // ------------------------------------------------------------------
  // Core task operations
  // ------------------------------------------------------------------

  async getTask(taskKey: string): Promise<Task> {
    const issue = await this.jiraClient.getIssue(taskKey);
    return this.normalizeIssue(issue);
  }

  async searchTasks(query: string): Promise<{ tasks: Task[]; total: number }> {
    const result = await this.jiraClient.searchIssues(query);
    return {
      tasks: result.issues.map((issue: any) => this.normalizeIssue(issue)),
      total: result.total,
    };
  }

  async getComments(taskKey: string): Promise<Comment[]> {
    const allComments = await this.jiraClient.getIssueComments(taskKey);
    const filtered = allComments.filter((comment) => !this.isDevInternComment(comment));

    const filteredCount = allComments.length - filtered.length;
    if (filteredCount > 0) {
      console.log(`🔍 Filtered out ${filteredCount} @devintern/code comment(s) from ${taskKey}`);
    }

    return filtered.map((comment) => ({
      id: comment.id || "unknown",
      author: comment.author?.displayName || "Unknown",
      body: comment.body,
      renderedBody: comment.renderedBody,
      created: comment.created || "",
      updated: comment.updated || "",
    }));
  }

  async transitionStatus(taskKey: string, statusName: string): Promise<void> {
    await this.jiraClient.transitionIssue(taskKey, statusName);
  }

  extractDescriptionText(task: Task): string {
    const issue = task.raw as JiraIssue;
    return extractTextFromADF(
      issue.fields?.description as Parameters<typeof extractTextFromADF>[0],
    );
  }

  // ------------------------------------------------------------------
  // Related work
  // ------------------------------------------------------------------

  extractLinkedResources(task: Task): LinkedResource[] {
    const issue = task.raw as JiraIssue;
    return extractLinkedResources(issue);
  }

  async getRelatedWorkItems(task: Task): Promise<DetailedRelatedIssue[]> {
    const issue = task.raw as JiraIssue;
    return getRelatedWorkItems(issue, async (key) => this.jiraClient.getIssue(key));
  }

  formatTaskDetails(
    task: Task,
    comments: Comment[],
    linkedResources: LinkedResource[],
    relatedIssues: DetailedRelatedIssue[],
  ): FormattedTaskDetails {
    const issue = task.raw as JiraIssue;
    return formatIssueDetails(issue, comments, linkedResources, relatedIssues);
  }

  // ------------------------------------------------------------------
  // Attachments
  // ------------------------------------------------------------------

  async downloadAttachments(taskKey: string, outputDir: string): Promise<Map<string, string>> {
    return this.jiraClient.downloadIssueAttachments(taskKey, outputDir);
  }

  async downloadAttachmentsFromContent(
    htmlContent: string,
    outputDir: string,
    existingMap?: Map<string, string>,
  ): Promise<Map<string, string>> {
    return this.jiraClient.downloadAttachmentsFromContent(htmlContent, outputDir, existingMap);
  }

  // ------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------

  async postComment(taskKey: string, content: TaskTrackerCommentContent): Promise<void> {
    await this.jiraClient.postComment(taskKey, content.body);
  }

  async postImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void> {
    const content = JiraFormatter.createImplementationCommentADF(agentOutput, taskSummary);
    await this.jiraClient.postCommentADF(taskKey, content);
    console.log(`✅ Successfully posted implementation comment to ${taskKey}`);
  }

  async postClarityComment(taskKey: string, assessment: unknown): Promise<void> {
    const content = JiraFormatter.createClarityAssessmentADF(assessment);
    await this.jiraClient.postCommentADF(taskKey, content);
    console.log(`✅ Successfully posted clarity assessment to ${taskKey}`);
  }

  async postIncompleteImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
    taskDescription?: string,
  ): Promise<void> {
    const content = JiraFormatter.createIncompleteImplementationCommentADF(
      agentOutput,
      taskSummary,
    );
    await this.jiraClient.postCommentADF(taskKey, content);
    console.log(`✅ Successfully posted incomplete implementation comment to ${taskKey}`);

    if (taskDescription) {
      try {
        const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
        const taskDir = path.join(baseOutputDir, taskKey.toLowerCase());
        const descriptionFile = path.join(taskDir, "incomplete-task-description.txt");

        mkdirSync(taskDir, { recursive: true });
        writeFileSync(descriptionFile, taskDescription, "utf8");
      } catch (saveError) {
        console.warn(`⚠️  Failed to save task description for duplicate detection: ${saveError}`);
      }
    }
  }

  async hasIncompleteImplementationComment(
    taskKey: string,
    currentDescription: string,
  ): Promise<boolean> {
    try {
      const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
      const taskDir = path.join(baseOutputDir, taskKey.toLowerCase());
      const descriptionFile = path.join(taskDir, "incomplete-task-description.txt");

      if (!existsSync(descriptionFile)) {
        return false;
      }

      const savedDescription = readFileSync(descriptionFile, "utf8");
      if (savedDescription !== currentDescription) {
        return false;
      }

      const comments = await this.jiraClient.getIssueComments(taskKey);
      return comments.some((comment) => this.isIncompleteImplementationComment(comment));
    } catch (error) {
      console.warn(`Failed to check for duplicate comments: ${error}`);
      return false;
    }
  }

  async postAssessmentFailure(
    taskKey: string,
    failureType: "max-turns" | "parse-error",
    _rawOutput: string,
  ): Promise<void> {
    const content = JiraFormatter.createAssessmentFailureADF(failureType);
    await this.jiraClient.postCommentADF(taskKey, content);
  }

  // ------------------------------------------------------------------
  // Estimation
  // ------------------------------------------------------------------

  async findEstimationComment(
    taskKey: string,
  ): Promise<{ commentId: string; created: string } | null> {
    return this.jiraClient.findEstimationComment(taskKey);
  }

  async discoverEstimationField(taskKey?: string): Promise<string | null> {
    return this.jiraClient.discoverStoryPointsField(taskKey);
  }

  async updateEstimation(taskKey: string, fieldId: string, value: number): Promise<void> {
    await this.jiraClient.updateStoryPoints(taskKey, fieldId, value);
  }

  async postEstimationComment(taskKey: string, result: unknown): Promise<void> {
    await this.jiraClient.postEstimationComment(taskKey, result as any);
  }

  async updateEstimationComment(
    taskKey: string,
    commentId: string,
    result: unknown,
  ): Promise<void> {
    await this.jiraClient.updateEstimationComment(taskKey, commentId, result as any);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private normalizeIssue(issue: any): Task {
    const fields = issue.fields || {};
    return {
      key: issue.key || "Unknown",
      summary: fields.summary || "No summary",
      description: fields.description,
      renderedDescription: issue.renderedFields?.description,
      issueType: fields.issuetype?.name || "Unknown",
      status: fields.status?.name || "Unknown",
      priority: fields.priority?.name,
      assignee: fields.assignee?.displayName,
      reporter: fields.reporter?.displayName || "Unknown",
      created: fields.created || "",
      updated: fields.updated || "",
      labels: fields.labels || [],
      components: fields.components?.map((c: any) => c?.name || "Unknown") || [],
      fixVersions: fields.fixVersions?.map((v: any) => v?.name || "Unknown") || [],
      raw: issue,
    };
  }

  private isDevInternComment(comment: { body?: unknown; renderedBody?: string }): boolean {
    let commentText = "";

    if (comment.renderedBody) {
      commentText = comment.renderedBody;
    } else if (typeof comment.body === "string" && comment.body.length > 0) {
      commentText = comment.body;
    } else if (comment.body && typeof comment.body === "object" && "content" in comment.body) {
      commentText = JSON.stringify(comment.body);
    }

    const devinternCodeMarkers = [
      "Implementation Completed by @devintern/code",
      "Automated Task Feasibility Assessment",
      "Implementation Incomplete",
      "Automated Story Points Estimation",
    ];

    return devinternCodeMarkers.some((marker) => commentText.includes(marker));
  }

  private isIncompleteImplementationComment(comment: {
    body?: unknown;
    renderedBody?: string;
  }): boolean {
    let commentText = "";

    if (comment.renderedBody) {
      commentText = comment.renderedBody;
    } else if (typeof comment.body === "string" && comment.body.length > 0) {
      commentText = comment.body;
    } else if (comment.body && typeof comment.body === "object" && "content" in comment.body) {
      commentText = JSON.stringify(comment.body);
    }

    return (
      commentText.includes("⚠️ Implementation Incomplete") ||
      commentText.includes("Implementation Incomplete") ||
      commentText.includes("Implementation was incomplete")
    );
  }
}
