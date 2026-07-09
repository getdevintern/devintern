/**
 * Asana implementation of the platform-agnostic {@link TaskTrackerClient}.
 *
 * Delegates REST calls to {@link AsanaClient} from `@devintern/task-trackers`.
 * Comments are stories posted as rich-text HTML with a plain-text fallback.
 * Status transitions move the task between project sections; `done`-style
 * statuses mark the task complete. Estimation uses a numeric custom field
 * matched by the configured `storyPointsField` name when present, otherwise
 * estimation is comment-only.
 */

import {
  AsanaClient,
  parseAsanaTaskFilters,
  type AsanaStory,
  type AsanaTaskDetail,
} from "@devintern/task-trackers";
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

/** Status names treated as "complete the task" rather than a section move. */
const COMPLETE_STATUS_NAMES = new Set(["done", "complete", "completed", "closed"]);

/**
 * Extract an Asana task GID from a raw CLI argument, accepting bare numeric
 * GIDs and app.asana.com task URLs.
 *
 * @returns Task GID as a string, or `null` when the value has neither shape.
 */
export function parseAsanaTaskReference(value: string): string | null {
  // Modern URLs: https://app.asana.com/1/<workspace>/project/<project>/task/<task>
  const taskPathMatch = value.match(/app\.asana\.com\/.*\/task\/(\d+)/);
  if (taskPathMatch) return taskPathMatch[1];

  // Legacy URLs: https://app.asana.com/0/<project>/<task>(/f)
  const legacyMatch = value.match(/app\.asana\.com\/0\/\d+\/(\d+)/);
  if (legacyMatch) return legacyMatch[1];

  const bareMatch = value.match(/^(\d{6,})$/);
  if (bareMatch) return bareMatch[1];

  return null;
}

export class AsanaTaskTrackerClient implements TaskTrackerClient {
  private asanaClient: AsanaClient;
  private apiToken: string;
  private defaultProjectGid?: string;
  private storyPointsFieldName?: string;

  constructor(
    apiToken: string,
    options?: { defaultProjectGid?: string; storyPointsFieldName?: string },
  ) {
    this.apiToken = apiToken;
    this.asanaClient = new AsanaClient({ apiToken });
    this.defaultProjectGid = options?.defaultProjectGid;
    this.storyPointsFieldName = options?.storyPointsFieldName;
  }

  // ------------------------------------------------------------------
  // Core task operations
  // ------------------------------------------------------------------

  async getTask(taskKey: string): Promise<Task> {
    const task = await this.asanaClient.getTaskDetail(this.toTaskGid(taskKey));
    return this.normalizeTask(task);
  }

  async searchTasks(query: string): Promise<{ tasks: Task[]; total: number }> {
    const filters = parseAsanaTaskFilters(query);
    if (!filters.projectGid) {
      filters.projectGid = this.defaultProjectGid;
    }

    const result = await this.asanaClient.searchTasks(filters);
    return {
      tasks: result.tasks.map((task) => this.normalizeTask(task)),
      total: result.total,
    };
  }

  async getComments(taskKey: string): Promise<Comment[]> {
    const stories = await this.asanaClient.getStories(this.toTaskGid(taskKey));
    const filtered = stories.filter((s) => !isDevInternCommentText(s.text || s.html_text || ""));

    const filteredCount = stories.length - filtered.length;
    if (filteredCount > 0) {
      console.log(`🔍 Filtered out ${filteredCount} @devintern/code comment(s) from ${taskKey}`);
    }

    return filtered.map((s) => ({
      id: s.gid,
      author: s.created_by?.name || "Unknown",
      body: s.text || "",
      renderedBody: s.html_text,
      created: s.created_at,
      updated: s.created_at,
    }));
  }

  async transitionStatus(taskKey: string, statusName: string): Promise<void> {
    const taskGid = this.toTaskGid(taskKey);

    if (COMPLETE_STATUS_NAMES.has(statusName.toLowerCase())) {
      await this.asanaClient.setCompleted(taskGid, true);
      return;
    }

    const projectGid = await this.resolveProjectGid(taskGid);
    if (!projectGid) {
      throw new TaskTrackerError(
        `Cannot resolve a project for task ${taskKey} to look up sections. ` +
          "Set ASANA_DEFAULT_PROJECT_GID or add the task to a project.",
      );
    }

    const sections = await this.asanaClient.getSections(projectGid);
    const target = sections.find((s) => s.name.toLowerCase() === statusName.toLowerCase());

    if (!target) {
      const available = sections.map((s) => s.name).join(", ");
      throw new TaskTrackerError(
        `Section "${statusName}" not found in the project. Available sections: ${available}`,
      );
    }

    await this.asanaClient.moveTaskToSection(target.gid, taskGid);
  }

  extractDescriptionText(task: Task): string {
    return (task.raw as AsanaTaskDetail).notes || "";
  }

  // ------------------------------------------------------------------
  // Related work
  // ------------------------------------------------------------------

  extractLinkedResources(task: Task): LinkedResource[] {
    const asanaTask = task.raw as AsanaTaskDetail;
    const resources: LinkedResource[] = [];

    const urlRegex = /(https?:\/\/[^\s)]+)/g;
    const notes = asanaTask.notes || "";
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(notes)) !== null) {
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
  // Attachments
  // ------------------------------------------------------------------

  async downloadAttachments(taskKey: string, outputDir: string): Promise<Map<string, string>> {
    const attachments = await this.asanaClient.getAttachments(this.toTaskGid(taskKey));
    const result = new Map<string, string>();

    for (const attachment of attachments) {
      if (!attachment.download_url) continue;
      try {
        const response = await fetch(attachment.download_url, {
          headers: { Authorization: `Bearer ${this.apiToken}` },
        });
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        const filename =
          attachment.name || path.basename(new URL(attachment.download_url).pathname);
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

  async downloadAttachmentsFromContent(
    _htmlContent: string,
    _outputDir: string,
    existingMap?: Map<string, string>,
  ): Promise<Map<string, string>> {
    return existingMap ?? new Map();
  }

  // ------------------------------------------------------------------
  // Comments (stories)
  // ------------------------------------------------------------------

  async postComment(taskKey: string, content: TaskTrackerCommentContent): Promise<void> {
    await this.asanaClient.createStory(this.toTaskGid(taskKey), content.body);
  }

  async postImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void> {
    const body = formatImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.asanaClient.createStory(this.toTaskGid(taskKey), body);
    console.log(`✅ Successfully posted implementation comment to ${taskKey}`);
  }

  async postClarityComment(taskKey: string, assessment: unknown): Promise<void> {
    const body = formatClarityAssessmentMarkdown(assessment as ClarityAssessmentLike);
    await this.asanaClient.createStory(this.toTaskGid(taskKey), body);
    console.log(`✅ Successfully posted clarity assessment to ${taskKey}`);
  }

  async postIncompleteImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
    taskDescription?: string,
  ): Promise<void> {
    const body = formatIncompleteImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.asanaClient.createStory(this.toTaskGid(taskKey), body);
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

      const stories = await this.asanaClient.getStories(this.toTaskGid(taskKey));
      return stories.some((s) =>
        isIncompleteImplementationCommentText(s.text || s.html_text || ""),
      );
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
    await this.asanaClient.createStory(
      this.toTaskGid(taskKey),
      formatAssessmentFailureMarkdown(failureType),
    );
  }

  // ------------------------------------------------------------------
  // Estimation (numeric custom field when configured, else comment-only)
  // ------------------------------------------------------------------

  async findEstimationComment(
    taskKey: string,
  ): Promise<{ commentId: string; created: string } | null> {
    try {
      const stories = await this.asanaClient.getStories(this.toTaskGid(taskKey));
      const existing = stories.find((s) =>
        (s.text || s.html_text || "").includes(ESTIMATION_COMMENT_MARKER),
      );
      return existing ? { commentId: existing.gid, created: existing.created_at } : null;
    } catch (error) {
      console.warn(`⚠️  Failed to check for estimation comment on ${taskKey}: ${error}`);
      return null;
    }
  }

  async discoverEstimationField(taskKey?: string): Promise<string | null> {
    if (!this.storyPointsFieldName || !taskKey) return null;

    const task = await this.asanaClient.getTaskDetail(this.toTaskGid(taskKey));
    const field = (task.custom_fields || []).find(
      (f) =>
        f.name.toLowerCase() === this.storyPointsFieldName!.toLowerCase() && f.type === "number",
    );
    return field?.gid ?? null;
  }

  async updateEstimation(taskKey: string, fieldId: string, value: number): Promise<void> {
    await this.asanaClient.updateCustomField(this.toTaskGid(taskKey), fieldId, value);
  }

  async postEstimationComment(taskKey: string, result: unknown): Promise<void> {
    const body = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.asanaClient.createStory(this.toTaskGid(taskKey), body);
  }

  async updateEstimationComment(
    _taskKey: string,
    commentId: string,
    result: unknown,
  ): Promise<void> {
    const body = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.asanaClient.updateStory(commentId, body);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private toTaskGid(taskKey: string): string {
    const parsed = parseAsanaTaskReference(taskKey);
    if (!parsed) {
      throw new TaskTrackerError(
        `Invalid Asana task reference: "${taskKey}". Use a task GID or app.asana.com task URL.`,
      );
    }
    return parsed;
  }

  private async resolveProjectGid(taskGid: string): Promise<string | undefined> {
    const task = await this.asanaClient.getTaskDetail(taskGid);
    const memberships = task.memberships || [];

    if (this.defaultProjectGid) {
      const preferred = memberships.find((m) => m.project?.gid === this.defaultProjectGid);
      if (preferred?.project) return preferred.project.gid;
      return this.defaultProjectGid;
    }

    return memberships[0]?.project?.gid;
  }

  private normalizeTask(task: AsanaTaskDetail): Task {
    const section = (task.memberships || []).find((m) => m.section?.name)?.section;
    return {
      key: task.gid,
      summary: task.name,
      description: task.notes || undefined,
      renderedDescription: task.html_notes,
      issueType: "Task",
      status: task.completed ? "Completed" : section?.name || "",
      assignee: task.assignee?.name ?? undefined,
      reporter: task.created_by?.name || "Unknown",
      created: task.created_at || "",
      updated: task.modified_at || "",
      labels: (task.tags || []).map((t) => t.name).filter(Boolean),
      components: [],
      fixVersions: [],
      raw: task,
    };
  }
}
