/**
 * Linear implementation of the platform-agnostic {@link TaskTrackerClient}.
 *
 * Delegates GraphQL calls to {@link LinearClient} from `@devintern/task-trackers`.
 * Issue bodies and comments are markdown, so shared markdown comment
 * formatters are posted as-is. Estimation is fully supported via Linear's
 * native `estimate` field.
 */

import { LinearClient, type LinearComment, type LinearIssueDetail } from "@devintern/task-trackers";
import type {
  Comment,
  DetailedRelatedIssue,
  FormattedTaskDetails,
  LinkedResource,
  Task,
  TaskTrackerCommentContent,
} from "../../../types/task-tracker";
import { TaskNotFoundError, TaskTrackerError } from "../../../types/task-tracker";
import type { TaskTrackerClient } from "../../task-tracker-client";
import {
  ESTIMATION_COMMENT_MARKER,
  formatAssessmentFailureMarkdown,
  formatClarityAssessmentMarkdown,
  formatEstimationCommentMarkdown,
  formatImplementationCommentMarkdown,
  formatIncompleteImplementationCommentMarkdown,
  isDevInternCommentText,
  isIncompleteImplementationCommentText,
  matchesSavedIncompleteDescription,
  persistIncompleteDescription,
  type ClarityAssessmentLike,
  type EstimationResultLike,
} from "../shared/markdown-comment-formatter";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

/** URL pattern for Linear-hosted uploads embedded in issue/comment markdown. */
const LINEAR_UPLOAD_URL_REGEX = /https:\/\/uploads\.linear\.app\/[^\s)"'\]]+/g;

/**
 * Extract a Linear issue identifier (e.g. `ENG-42`) from a raw CLI argument,
 * accepting bare identifiers and linear.app issue URLs.
 *
 * @returns Uppercased identifier, or `null` when the value has neither shape.
 */
export function parseLinearIssueReference(value: string): string | null {
  const urlMatch = value.match(/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/);
  if (urlMatch) return urlMatch[1].toUpperCase();

  const bareMatch = value.match(/^([A-Za-z][A-Za-z0-9]*-\d+)$/);
  if (bareMatch) return bareMatch[1].toUpperCase();

  return null;
}

export class LinearTaskTrackerClient implements TaskTrackerClient {
  private linearClient: LinearClient;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.linearClient = new LinearClient({ apiKey });
  }

  // ------------------------------------------------------------------
  // Core task operations
  // ------------------------------------------------------------------

  async getTask(taskKey: string): Promise<Task> {
    const issue = await this.linearClient.getIssueByIdentifier(taskKey);
    if (!issue) {
      throw new TaskNotFoundError(taskKey);
    }
    return this.normalizeIssue(issue);
  }

  async searchTasks(query: string): Promise<{ tasks: Task[]; total: number }> {
    const result = await this.linearClient.searchIssues(query);
    return {
      tasks: result.issues.map((issue) => this.normalizeIssue(issue)),
      total: result.total,
    };
  }

  async getComments(taskKey: string): Promise<Comment[]> {
    const comments = await this.fetchRawComments(taskKey);
    const filtered = comments.filter((c) => !isDevInternCommentText(c.body));

    const filteredCount = comments.length - filtered.length;
    if (filteredCount > 0) {
      console.log(`🔍 Filtered out ${filteredCount} @devintern/code comment(s) from ${taskKey}`);
    }

    return filtered.map((c) => ({
      id: c.id,
      author: c.user?.name || "Unknown",
      body: c.body,
      created: c.createdAt,
      updated: c.updatedAt,
    }));
  }

  async transitionStatus(taskKey: string, statusName: string): Promise<void> {
    const issue = await this.requireIssue(taskKey);
    if (!issue.team) {
      throw new TaskTrackerError(`Cannot resolve team for ${taskKey} to look up workflow states.`);
    }

    const states = await this.linearClient.getWorkflowStates(issue.team.id);
    const target = states.find((s) => s.name.toLowerCase() === statusName.toLowerCase());

    if (!target) {
      const available = states.map((s) => s.name).join(", ");
      throw new TaskTrackerError(
        `Workflow state "${statusName}" not found for team ${issue.team.key}. Available states: ${available}`,
      );
    }

    await this.linearClient.updateIssueState(issue.id, target.id);
  }

  extractDescriptionText(task: Task): string {
    return (task.raw as LinearIssueDetail).description || "";
  }

  // ------------------------------------------------------------------
  // Related work
  // ------------------------------------------------------------------

  extractLinkedResources(task: Task): LinkedResource[] {
    const issue = task.raw as LinearIssueDetail;
    const resources: LinkedResource[] = [];

    const urlRegex = /(https?:\/\/[^\s)]+)/g;
    const description = issue.description || "";
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(description)) !== null) {
      resources.push({
        type: "description_link",
        url: match[1],
        description: match[1],
      });
    }

    for (const attachment of issue.attachments) {
      resources.push({
        type: "attachment_link",
        url: attachment.url,
        description: attachment.title || attachment.url,
      });
    }

    return resources;
  }

  async getRelatedWorkItems(_task: Task): Promise<DetailedRelatedIssue[]> {
    return [];
  }

  formatTaskDetails(
    task: Task,
    comments: Comment[],
    linkedResources: LinkedResource[],
    relatedIssues: DetailedRelatedIssue[],
  ): FormattedTaskDetails {
    return {
      key: task.key,
      summary: task.summary,
      description: task.description,
      renderedDescription: task.renderedDescription,
      issueType: task.issueType,
      status: task.status,
      priority: task.priority,
      assignee: task.assignee,
      reporter: task.reporter,
      created: task.created,
      updated: task.updated,
      labels: task.labels,
      components: task.components,
      fixVersions: task.fixVersions,
      linkedResources,
      relatedIssues,
      comments,
      attachments: [],
    };
  }

  // ------------------------------------------------------------------
  // Attachments
  // ------------------------------------------------------------------

  async downloadAttachments(taskKey: string, outputDir: string): Promise<Map<string, string>> {
    const issue = await this.requireIssue(taskKey);
    const result = new Map<string, string>();

    for (const attachment of issue.attachments) {
      if (!attachment.url.includes("uploads.linear.app")) continue;
      const filename = attachment.title || path.basename(new URL(attachment.url).pathname);
      const filePath = await this.downloadUpload(attachment.url, outputDir, filename);
      if (filePath) result.set(filename, filePath);
    }

    return result;
  }

  async downloadAttachmentsFromContent(
    htmlContent: string,
    outputDir: string,
    existingMap?: Map<string, string>,
  ): Promise<Map<string, string>> {
    const result = existingMap ?? new Map<string, string>();
    const urls = htmlContent.match(LINEAR_UPLOAD_URL_REGEX) || [];

    for (const url of urls) {
      const filename = path.basename(new URL(url).pathname);
      if (result.has(filename)) continue;
      const filePath = await this.downloadUpload(url, outputDir, filename);
      if (filePath) result.set(filename, filePath);
    }

    return result;
  }

  /**
   * Download a Linear-hosted upload. Linear's upload host requires the API
   * key in the Authorization header.
   *
   * @returns Local file path, or `null` when the download fails.
   */
  private async downloadUpload(
    url: string,
    outputDir: string,
    filename: string,
  ): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: { Authorization: this.apiKey },
      });
      if (!response.ok) return null;
      const buffer = await response.arrayBuffer();
      mkdirSync(outputDir, { recursive: true });
      const filePath = path.join(outputDir, filename);
      writeFileSync(filePath, Buffer.from(buffer));
      return filePath;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------

  async postComment(taskKey: string, content: TaskTrackerCommentContent): Promise<void> {
    const issueId = await this.requireIssueId(taskKey);
    await this.linearClient.createComment(issueId, content.body);
  }

  async postImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void> {
    const issueId = await this.requireIssueId(taskKey);
    const body = formatImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.linearClient.createComment(issueId, body);
    console.log(`✅ Successfully posted implementation comment to ${taskKey}`);
  }

  async postClarityComment(taskKey: string, assessment: unknown): Promise<void> {
    const issueId = await this.requireIssueId(taskKey);
    const body = formatClarityAssessmentMarkdown(assessment as ClarityAssessmentLike);
    await this.linearClient.createComment(issueId, body);
    console.log(`✅ Successfully posted clarity assessment to ${taskKey}`);
  }

  async postIncompleteImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
    taskDescription?: string,
  ): Promise<void> {
    const issueId = await this.requireIssueId(taskKey);
    const body = formatIncompleteImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.linearClient.createComment(issueId, body);
    console.log(`✅ Successfully posted incomplete implementation comment to ${taskKey}`);

    if (taskDescription) {
      persistIncompleteDescription(taskKey, taskDescription);
    }
  }

  async hasIncompleteImplementationComment(
    taskKey: string,
    currentDescription: string,
  ): Promise<boolean> {
    try {
      if (!matchesSavedIncompleteDescription(taskKey, currentDescription)) return false;

      const comments = await this.fetchRawComments(taskKey);
      return comments.some((c) => isIncompleteImplementationCommentText(c.body));
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
    const issueId = await this.requireIssueId(taskKey);
    await this.linearClient.createComment(issueId, formatAssessmentFailureMarkdown(failureType));
  }

  // ------------------------------------------------------------------
  // Estimation (native `estimate` field)
  // ------------------------------------------------------------------

  async findEstimationComment(
    taskKey: string,
  ): Promise<{ commentId: string; created: string } | null> {
    try {
      const comments = await this.fetchRawComments(taskKey);
      const existing = comments.find((c) => c.body.includes(ESTIMATION_COMMENT_MARKER));
      return existing ? { commentId: existing.id, created: existing.createdAt } : null;
    } catch (error) {
      console.warn(`⚠️  Failed to check for estimation comment on ${taskKey}: ${error}`);
      return null;
    }
  }

  async discoverEstimationField(_taskKey?: string): Promise<string | null> {
    return "estimate";
  }

  async updateEstimation(taskKey: string, _fieldId: string, value: number): Promise<void> {
    const issueId = await this.requireIssueId(taskKey);
    await this.linearClient.updateIssueEstimate(issueId, value);
  }

  async postEstimationComment(taskKey: string, result: unknown): Promise<void> {
    const issueId = await this.requireIssueId(taskKey);
    const body = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.linearClient.createComment(issueId, body);
  }

  async updateEstimationComment(
    _taskKey: string,
    commentId: string,
    result: unknown,
  ): Promise<void> {
    const body = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.linearClient.updateComment(commentId, body);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async requireIssue(taskKey: string): Promise<LinearIssueDetail> {
    const issue = await this.linearClient.getIssueByIdentifier(taskKey);
    if (!issue) {
      throw new TaskNotFoundError(taskKey);
    }
    return issue;
  }

  private async requireIssueId(taskKey: string): Promise<string> {
    const issueId = await this.linearClient.getIssueIdByIdentifier(taskKey);
    if (!issueId) {
      throw new TaskNotFoundError(taskKey);
    }
    return issueId;
  }

  private async fetchRawComments(taskKey: string): Promise<LinearComment[]> {
    const issueId = await this.requireIssueId(taskKey);
    return this.linearClient.getIssueComments(issueId);
  }

  private normalizeIssue(issue: LinearIssueDetail): Task {
    return {
      key: issue.identifier,
      summary: issue.title,
      description: issue.description || undefined,
      issueType: "Issue",
      status: issue.state?.name || "",
      priority: issue.priorityLabel,
      assignee: issue.assignee?.name,
      reporter: issue.creator?.name || "Unknown",
      created: issue.createdAt,
      updated: issue.updatedAt,
      labels: issue.labels.map((l) => l.name).filter(Boolean),
      components: [],
      fixVersions: [],
      raw: issue,
    };
  }
}
