/**
 * GitHub Issues implementation of the platform-agnostic {@link TaskTrackerClient}.
 *
 * Delegates REST calls to {@link GitHubClient} from `@devintern/task-trackers`.
 * Issue bodies and comments are markdown, so shared markdown comment
 * formatters are posted as-is.
 *
 * Status transitions are label-based: transitioning to a status adds the
 * matching repo label and removes other configured status labels (see
 * `statusLabels`). Transitioning to `closed`/`done` closes the issue instead.
 * Estimation has no native field, so estimation runs in comment-only mode.
 */

import { GitHubClient, type GitHubIssue, type GitHubIssueComment } from "@devintern/task-trackers";
import type {
  Comment,
  DetailedRelatedIssue,
  FormattedTaskDetails,
  LinkedResource,
  Task,
  TaskTrackerCommentContent,
} from "../../../types/task-tracker";
import { TaskTrackerError } from "../../../types/task-tracker";
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

/** Status names treated as "close the issue" rather than a label swap. */
const CLOSE_STATUS_NAMES = new Set(["closed", "done", "complete", "completed"]);

/** URL patterns for GitHub-hosted attachments embedded in issue markdown. */
const GITHUB_ATTACHMENT_URL_REGEX =
  /https:\/\/(?:github\.com\/user-attachments\/(?:assets|files)\/[^\s)"'\]]+|user-images\.githubusercontent\.com\/[^\s)"'\]]+)/g;

/**
 * Extract a GitHub issue number from a raw CLI argument, accepting `123`,
 * `#123`, `owner/repo#123`, and full issue URLs.
 *
 * @returns Issue number as a string, or `null` when the value has none of
 *   those shapes.
 */
export function parseGitHubIssueReference(value: string): string | null {
  const urlMatch = value.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  if (urlMatch) return urlMatch[1];

  const refMatch = value.match(/^(?:[\w.-]+\/[\w.-]+)?#?(\d+)$/);
  if (refMatch) return refMatch[1];

  return null;
}

export class GitHubTaskTrackerClient implements TaskTrackerClient {
  private githubClient: GitHubClient;
  private token: string;
  /** Mutually exclusive status label names swapped on transition. */
  private statusLabels: string[];

  constructor(token: string, owner: string, repo: string, options?: { statusLabels?: string[] }) {
    this.token = token;
    this.githubClient = new GitHubClient({ token, owner, repo });
    this.statusLabels = options?.statusLabels ?? [];
  }

  // ------------------------------------------------------------------
  // Core task operations
  // ------------------------------------------------------------------

  async getTask(taskKey: string): Promise<Task> {
    const issue = await this.githubClient.getIssue(this.toIssueNumber(taskKey));
    return this.normalizeIssue(issue);
  }

  async searchTasks(query: string): Promise<{ tasks: Task[]; total: number }> {
    const result = await this.githubClient.searchIssues(query);
    return {
      tasks: result.issues.map((issue) => this.normalizeIssue(issue)),
      total: result.total,
    };
  }

  async getComments(taskKey: string): Promise<Comment[]> {
    const comments = await this.githubClient.listIssueComments(this.toIssueNumber(taskKey));
    const filtered = comments.filter((c) => !isDevInternCommentText(c.body || ""));

    const filteredCount = comments.length - filtered.length;
    if (filteredCount > 0) {
      console.log(`🔍 Filtered out ${filteredCount} @devintern/code comment(s) from #${taskKey}`);
    }

    return filtered.map((c) => ({
      id: String(c.id),
      author: c.user?.login || "Unknown",
      body: c.body || "",
      created: c.created_at,
      updated: c.updated_at,
    }));
  }

  async transitionStatus(taskKey: string, statusName: string): Promise<void> {
    const issueNumber = this.toIssueNumber(taskKey);

    if (CLOSE_STATUS_NAMES.has(statusName.toLowerCase())) {
      await this.githubClient.updateIssue(issueNumber, { state: "closed" });
      return;
    }

    const repoLabels = await this.githubClient.getLabels();
    const target = repoLabels.find((l) => l.name.toLowerCase() === statusName.toLowerCase());

    if (!target) {
      const available = repoLabels.map((l) => l.name).join(", ");
      throw new TaskTrackerError(
        `Label "${statusName}" not found in the repository. Available labels: ${available}. ` +
          "Create the label or update the status names in .devintern-code/settings.json.",
      );
    }

    // Swap out other configured status labels so only one status is active.
    const issue = await this.githubClient.getIssue(issueNumber);
    const currentLabels = (issue.labels ?? []).map((l) => l.name);
    const otherStatusLabels = currentLabels.filter(
      (name) =>
        name.toLowerCase() !== target.name.toLowerCase() &&
        this.statusLabels.some((s) => s.toLowerCase() === name.toLowerCase()),
    );

    await this.githubClient.addLabels(issueNumber, [target.name]);
    for (const label of otherStatusLabels) {
      await this.githubClient.removeLabel(issueNumber, label);
    }

    // Moving back to an open status reopens a closed issue.
    if (issue.state === "closed") {
      await this.githubClient.updateIssue(issueNumber, { state: "open" });
    }
  }

  extractDescriptionText(task: Task): string {
    return (task.raw as GitHubIssue).body || "";
  }

  // ------------------------------------------------------------------
  // Related work
  // ------------------------------------------------------------------

  extractLinkedResources(task: Task): LinkedResource[] {
    const issue = task.raw as GitHubIssue;
    const resources: LinkedResource[] = [];

    const urlRegex = /(https?:\/\/[^\s)]+)/g;
    const body = issue.body || "";
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(body)) !== null) {
      resources.push({
        type: "description_link",
        url: match[1],
        description: match[1],
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
  // Attachments (GitHub has no attachment API; scan body/content URLs)
  // ------------------------------------------------------------------

  async downloadAttachments(taskKey: string, outputDir: string): Promise<Map<string, string>> {
    const issue = await this.githubClient.getIssue(this.toIssueNumber(taskKey));
    return this.downloadAttachmentsFromContent(issue.body || "", outputDir);
  }

  async downloadAttachmentsFromContent(
    htmlContent: string,
    outputDir: string,
    existingMap?: Map<string, string>,
  ): Promise<Map<string, string>> {
    const result = existingMap ?? new Map<string, string>();
    const urls = htmlContent.match(GITHUB_ATTACHMENT_URL_REGEX) || [];

    for (const url of urls) {
      const filename = path.basename(new URL(url).pathname);
      if (result.has(filename)) continue;
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        mkdirSync(outputDir, { recursive: true });
        const filePath = path.join(outputDir, filename);
        writeFileSync(filePath, Buffer.from(buffer));
        result.set(filename, filePath);
      } catch {
        // Skip attachments that fail to download
      }
    }

    return result;
  }

  // ------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------

  async postComment(taskKey: string, content: TaskTrackerCommentContent): Promise<void> {
    await this.githubClient.createIssueComment(this.toIssueNumber(taskKey), content.body);
  }

  async postImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void> {
    const body = formatImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.githubClient.createIssueComment(this.toIssueNumber(taskKey), body);
    console.log(`✅ Successfully posted implementation comment to #${taskKey}`);
  }

  async postClarityComment(taskKey: string, assessment: unknown): Promise<void> {
    const body = formatClarityAssessmentMarkdown(assessment as ClarityAssessmentLike);
    await this.githubClient.createIssueComment(this.toIssueNumber(taskKey), body);
    console.log(`✅ Successfully posted clarity assessment to #${taskKey}`);
  }

  async postIncompleteImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
    taskDescription?: string,
  ): Promise<void> {
    const body = formatIncompleteImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.githubClient.createIssueComment(this.toIssueNumber(taskKey), body);
    console.log(`✅ Successfully posted incomplete implementation comment to #${taskKey}`);

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

      const comments = await this.githubClient.listIssueComments(this.toIssueNumber(taskKey));
      return comments.some((c) => isIncompleteImplementationCommentText(c.body || ""));
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
    await this.githubClient.createIssueComment(
      this.toIssueNumber(taskKey),
      formatAssessmentFailureMarkdown(failureType),
    );
  }

  // ------------------------------------------------------------------
  // Estimation (comment-only; GitHub has no estimation field)
  // ------------------------------------------------------------------

  async findEstimationComment(
    taskKey: string,
  ): Promise<{ commentId: string; created: string } | null> {
    try {
      const comments = await this.githubClient.listIssueComments(this.toIssueNumber(taskKey));
      const existing = comments.find((c) => (c.body || "").includes(ESTIMATION_COMMENT_MARKER));
      return existing ? { commentId: String(existing.id), created: existing.created_at } : null;
    } catch (error) {
      console.warn(`⚠️  Failed to check for estimation comment on #${taskKey}: ${error}`);
      return null;
    }
  }

  async discoverEstimationField(_taskKey?: string): Promise<string | null> {
    return null;
  }

  async updateEstimation(_taskKey: string, _fieldId: string, _value: number): Promise<void> {
    throw new TaskTrackerError(
      "GitHub Issues has no estimation field. Estimates are posted as comments only.",
    );
  }

  async postEstimationComment(taskKey: string, result: unknown): Promise<void> {
    const body = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.githubClient.createIssueComment(this.toIssueNumber(taskKey), body);
  }

  async updateEstimationComment(
    _taskKey: string,
    commentId: string,
    result: unknown,
  ): Promise<void> {
    const body = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.githubClient.updateIssueComment(Number(commentId), body);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private toIssueNumber(taskKey: string): number {
    const parsed = parseGitHubIssueReference(taskKey);
    const issueNumber = Number(parsed ?? taskKey);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new TaskTrackerError(
        `Invalid GitHub issue reference: "${taskKey}". Use an issue number (123, #123) or issue URL.`,
      );
    }
    return issueNumber;
  }

  private normalizeIssue(issue: GitHubIssue): Task {
    return {
      key: String(issue.number),
      summary: issue.title,
      description: issue.body || undefined,
      issueType: "Issue",
      status: issue.state || "",
      assignee: issue.assignee?.login,
      reporter: issue.user?.login || "Unknown",
      created: issue.created_at || "",
      updated: issue.updated_at || "",
      labels: (issue.labels ?? []).map((l) => l.name).filter(Boolean),
      components: [],
      fixVersions: [],
      raw: issue,
    };
  }
}
