/**
 * GitLab implementation of the platform-agnostic {@link TaskTrackerClient}.
 *
 * Delegates REST calls to {@link GitLabClient} from `@devintern/task-trackers`.
 * Issue bodies and comments are markdown, so shared markdown comment
 * formatters are posted as-is.
 *
 * Status transitions are label-based: transitioning to a status adds the
 * matching project label and removes other configured status labels (see
 * `statusLabels`). Transitioning to `closed`/`done` closes the issue instead.
 * Estimation has no native field, so estimation runs in comment-only mode.
 */

import { GitLabClient, sanitizeGitlabBaseUrl } from "@devintern/task-trackers";
import type { GitLabIssue } from "@devintern/task-trackers";
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
} from "../shared/markdown-comment-formatter";
import type {
  ClarityAssessmentLike,
  EstimationResultLike,
} from "../shared/markdown-comment-formatter";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

/** Status names treated as "close the issue" rather than a label swap. */
const CLOSE_STATUS_NAMES = new Set(["closed", "done", "complete", "completed"]);

/**
 * URL patterns for GitLab-hosted attachments embedded in issue markdown.
 * Uploads live under `<instance>/<project>(/-/)uploads/<hash>/<filename>`;
 * any absolute URL containing an `/uploads/` path segment is matched.
 */
const GITLAB_ATTACHMENT_URL_REGEX = /https?:\/\/[^\s)"'\]]+\/uploads\/[^\s)"'\]]+/g;

/**
 * Extract a GitLab issue iid from a raw CLI argument, accepting `123`,
 * `#123`, `group/sub/repo#123`, and full issue URLs (with or without the
 * `/-/` path segment).
 *
 * The `group/sub/repo#n` shape is distinct from GitHub's `owner/repo#n`
 * because subgroups make multi-segment paths unambiguous — but both parsers
 * accept bare numbers, so callers must not mix tracker ids.
 *
 * @returns Issue iid as a string, or `null` when the value has none of those shapes.
 */
export function parseGitLabIssueReference(value: string): string | null {
  const urlMatch = value.match(/\/([^/]+(?:\/[^/]+)+)\/(?:-\/)?issues\/(\d+)/);
  if (urlMatch) return urlMatch[2];

  // A project path prefix must contain at least one slash so Jira-style keys
  // like `PROJ-123` are never mistaken for issue numbers.
  const refMatch = value.match(/^(?:[\w.-]+(?:\/[\w.-]+)+)?#?(\d+)$/);
  if (refMatch && /[#/]/.test(value)) return refMatch[1];

  const bareMatch = value.match(/^#?(\d+)$/);
  return bareMatch ? bareMatch[1] : null;
}

export class GitLabTaskTrackerClient implements TaskTrackerClient {
  private gitlabClient: GitLabClient;
  private token: string;
  private baseUrl: string;
  /** Mutually exclusive status label names swapped on transition. */
  private statusLabels: string[];

  constructor(
    token: string,
    projectPath: string,
    options?: { baseUrl?: string; statusLabels?: string[] },
  ) {
    this.token = token;
    this.baseUrl = sanitizeGitlabBaseUrl(options?.baseUrl);
    this.gitlabClient = new GitLabClient({ token, projectPath, baseUrl: this.baseUrl });
    this.statusLabels = options?.statusLabels ?? [];
  }

  // ------------------------------------------------------------------
  // Core task operations
  // ------------------------------------------------------------------

  async getTask(taskKey: string): Promise<Task> {
    const issue = await this.gitlabClient.getIssue(this.toIssueIid(taskKey));
    return this.normalizeIssue(issue);
  }

  async searchTasks(query: string): Promise<{ tasks: Task[]; total: number }> {
    const result = await this.gitlabClient.searchIssues(query);
    return {
      tasks: result.issues.map((issue) => this.normalizeIssue(issue)),
      total: result.total,
    };
  }

  /**
   * Create a new issue in the configured project (issue-creation capability
   * used by preset automations; see `IssueCreatableClient`).
   */
  async createIssue(input: { title: string; body: string; labels?: string[] }): Promise<{
    key: string;
    url?: string;
  }> {
    const issue = await this.gitlabClient.createIssue(input.title, input.body, input.labels);
    return { key: String(issue.iid), url: issue.web_url };
  }

  async getComments(taskKey: string): Promise<Comment[]> {
    const comments = await this.gitlabClient.listIssueComments(this.toIssueIid(taskKey));
    const filtered = comments.filter((c) => !isDevInternCommentText(c.body || ""));

    const filteredCount = comments.length - filtered.length;
    if (filteredCount > 0) {
      console.log(`🔍 Filtered out ${filteredCount} @devintern/code comment(s) from #${taskKey}`);
    }

    return filtered.map((c) => ({
      id: String(c.id),
      author: c.author?.username || "Unknown",
      body: c.body || "",
      created: c.created_at,
      updated: c.updated_at,
    }));
  }

  async transitionStatus(taskKey: string, statusName: string): Promise<void> {
    const issueIid = this.toIssueIid(taskKey);

    if (CLOSE_STATUS_NAMES.has(statusName.toLowerCase())) {
      await this.gitlabClient.updateIssue(issueIid, { state: "closed" });
      return;
    }

    // Status transitions need an authoritative catalog — the picker soft-cap
    // (default 500) can omit a configured status label that exists further on.
    let { labels: projectLabels, truncated } = await this.gitlabClient.getLabels();
    let target = projectLabels.find((l) => l.name.toLowerCase() === statusName.toLowerCase());
    if (!target && truncated) {
      ({ labels: projectLabels } = await this.gitlabClient.getLabels(Number.POSITIVE_INFINITY));
      target = projectLabels.find((l) => l.name.toLowerCase() === statusName.toLowerCase());
    }

    if (!target) {
      const available = projectLabels.map((l) => l.name).join(", ");
      throw new TaskTrackerError(
        `Label "${statusName}" not found in the project. Available labels: ${available}. ` +
          "Create the label or update the status names in .devintern-code/settings.json.",
      );
    }

    // Swap out other configured status labels so only one status is active.
    const issue = await this.gitlabClient.getIssue(issueIid);
    const currentLabels = issue.labels ?? [];
    const otherStatusLabels = currentLabels.filter(
      (name) =>
        name.toLowerCase() !== target.name.toLowerCase() &&
        this.statusLabels.some((s) => s.toLowerCase() === name.toLowerCase()),
    );

    await this.gitlabClient.addLabels(issueIid, [target.name]);
    for (const label of otherStatusLabels) {
      await this.gitlabClient.removeLabel(issueIid, label);
    }

    // Moving back to an open status reopens a closed issue.
    if (issue.state === "closed") {
      await this.gitlabClient.updateIssue(issueIid, { state: "opened" });
    }
  }

  extractDescriptionText(task: Task): string {
    return (task.raw as GitLabIssue).description || "";
  }

  // ------------------------------------------------------------------
  // Related work
  // ------------------------------------------------------------------

  extractLinkedResources(task: Task): LinkedResource[] {
    const issue = task.raw as GitLabIssue;
    const resources: LinkedResource[] = [];

    const urlRegex = /(https?:\/\/[^\s)]+)/g;
    const body = issue.description || "";
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
  // Attachments (scan upload links embedded in the issue body)
  // ------------------------------------------------------------------

  async downloadAttachments(taskKey: string, outputDir: string): Promise<Map<string, string>> {
    const issue = await this.gitlabClient.getIssue(this.toIssueIid(taskKey));
    return this.downloadAttachmentsFromContent(issue.description || "", outputDir);
  }

  async downloadAttachmentsFromContent(
    htmlContent: string,
    outputDir: string,
    existingMap?: Map<string, string>,
  ): Promise<Map<string, string>> {
    const result = existingMap ?? new Map<string, string>();
    const urls = htmlContent.match(GITLAB_ATTACHMENT_URL_REGEX) || [];
    // Issue bodies are attacker-writable: only same-instance upload links may
    // be fetched (with the PAT); external hosts are skipped entirely.
    const instanceOrigin = new URL(this.baseUrl).origin;

    for (const url of urls) {
      try {
        const parsed = new URL(url);
        if (parsed.origin !== instanceOrigin) continue;
        let filename = path.basename(parsed.pathname);
        try {
          filename = decodeURIComponent(filename);
        } catch {
          // Malformed percent-encoding: skip this link, keep the rest.
          continue;
        }
        if (!filename || filename === "/" || result.has(filename)) continue;
        const response = await fetch(url, {
          headers: { "PRIVATE-TOKEN": this.token },
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
    await this.gitlabClient.createIssueComment(this.toIssueIid(taskKey), content.body);
  }

  async postImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void> {
    const body = formatImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.gitlabClient.createIssueComment(this.toIssueIid(taskKey), body);
    console.log(`✅ Successfully posted implementation comment to #${taskKey}`);
  }

  async postClarityComment(taskKey: string, assessment: unknown): Promise<void> {
    const body = formatClarityAssessmentMarkdown(assessment as ClarityAssessmentLike);
    await this.gitlabClient.createIssueComment(this.toIssueIid(taskKey), body);
    console.log(`✅ Successfully posted clarity assessment to #${taskKey}`);
  }

  async postIncompleteImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void> {
    const body = formatIncompleteImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.gitlabClient.createIssueComment(this.toIssueIid(taskKey), body);
    console.log(`✅ Successfully posted incomplete implementation comment to #${taskKey}`);
  }

  async hasIncompleteImplementationMarker(taskKey: string): Promise<boolean> {
    try {
      const comments = await this.gitlabClient.listIssueComments(this.toIssueIid(taskKey));
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
    await this.gitlabClient.createIssueComment(
      this.toIssueIid(taskKey),
      formatAssessmentFailureMarkdown(failureType),
    );
  }

  // ------------------------------------------------------------------
  // Estimation (comment-only; GitLab issues have no estimation field)
  // ------------------------------------------------------------------

  async findEstimationComment(
    taskKey: string,
  ): Promise<{ commentId: string; created: string } | null> {
    try {
      const comments = await this.gitlabClient.listIssueComments(this.toIssueIid(taskKey));
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
      "GitLab issues have no estimation field. Estimates are posted as comments only.",
    );
  }

  async postEstimationComment(taskKey: string, result: unknown): Promise<void> {
    const body = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.gitlabClient.createIssueComment(this.toIssueIid(taskKey), body);
  }

  async updateEstimationComment(
    taskKey: string,
    commentId: string,
    result: unknown,
  ): Promise<void> {
    const body = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.gitlabClient.updateIssueComment(this.toIssueIid(taskKey), Number(commentId), body);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private toIssueIid(taskKey: string): number {
    const parsed = parseGitLabIssueReference(taskKey);
    const issueIid = Number(parsed ?? taskKey);
    if (!Number.isInteger(issueIid) || issueIid <= 0) {
      throw new TaskTrackerError(
        `Invalid GitLab issue reference: "${taskKey}". Use an issue number (123, #123) or issue URL.`,
      );
    }
    return issueIid;
  }

  private normalizeIssue(issue: GitLabIssue): Task {
    return {
      key: String(issue.iid),
      summary: issue.title,
      description: issue.description || undefined,
      issueType: "Issue",
      status: issue.state || "",
      assignee: issue.assignees?.[0]?.username,
      reporter: issue.author?.username || "Unknown",
      created: issue.created_at || "",
      updated: issue.updated_at || "",
      labels: (issue.labels ?? []).filter(Boolean),
      components: [],
      fixVersions: [],
      raw: issue,
    };
  }
}
