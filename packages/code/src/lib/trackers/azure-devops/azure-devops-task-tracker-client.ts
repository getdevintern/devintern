/**
 * Azure DevOps implementation of the platform-agnostic {@link TaskTrackerClient}.
 *
 * Delegates REST calls to {@link AzureDevOpsClient} from
 * `@devintern/task-trackers`. Descriptions and comments are HTML: the raw
 * HTML is exposed via `renderedDescription`/`renderedBody` so
 * {@link TaskFormatter} converts it to markdown, and outgoing markdown
 * comments are converted with `markdownToHtmlDescription`. Estimation is
 * fully supported via the `Microsoft.VSTS.Scheduling.StoryPoints` field.
 */

import {
  AzureDevOpsClient,
  type AzureDevOpsComment,
  type AzureDevOpsWorkItemDetail,
} from "@devintern/task-trackers";
import { markdownToHtmlDescription } from "@devintern/text-formatter";
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

/** Default story points field for Agile/Scrum process templates. */
const DEFAULT_STORY_POINTS_FIELD = "Microsoft.VSTS.Scheduling.StoryPoints";

/**
 * Extract an Azure DevOps work item ID from a raw CLI argument, accepting
 * bare numeric IDs and dev.azure.com work item URLs.
 *
 * @returns Work item ID as a string, or `null` when the value has neither
 *   shape.
 */
export function parseAzureDevOpsWorkItemReference(value: string): string | null {
  const urlMatch = value.match(/dev\.azure\.com\/[^/]+\/[^/]+\/_workitems\/edit\/(\d+)/);
  if (urlMatch) return urlMatch[1];

  const bareMatch = value.match(/^#?(\d+)$/);
  if (bareMatch) return bareMatch[1];

  return null;
}

/** Strip HTML tags and decode common entities for plain-text extraction. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export class AzureDevOpsTaskTrackerClient implements TaskTrackerClient {
  private azureClient: AzureDevOpsClient;

  constructor(organization: string, pat: string, defaultProject: string) {
    this.azureClient = new AzureDevOpsClient({ organization, pat, defaultProject });
  }

  // ------------------------------------------------------------------
  // Core task operations
  // ------------------------------------------------------------------

  async getTask(taskKey: string): Promise<Task> {
    const workItem = await this.azureClient.getWorkItemDetail(taskKey);
    return this.normalizeWorkItem(workItem);
  }

  async searchTasks(query: string): Promise<{ tasks: Task[]; total: number }> {
    const result = await this.azureClient.queryWorkItems(query);
    return {
      tasks: result.workItems.map((item) => ({
        key: String(item.id),
        summary: item.title || `Work item ${item.id}`,
        issueType: "Work Item",
        status: "",
        reporter: "Unknown",
        created: "",
        updated: "",
        labels: [],
        components: [],
        fixVersions: [],
        raw: item,
      })),
      total: result.total,
    };
  }

  async getComments(taskKey: string): Promise<Comment[]> {
    const comments = await this.fetchRawComments(taskKey);
    const filtered = comments.filter((c) => !isDevInternCommentText(c.text || ""));

    const filteredCount = comments.length - filtered.length;
    if (filteredCount > 0) {
      console.log(`🔍 Filtered out ${filteredCount} @devintern/code comment(s) from ${taskKey}`);
    }

    return filtered.map((c) => ({
      id: String(c.id),
      author: c.createdBy?.displayName || "Unknown",
      body: htmlToPlainText(c.text || ""),
      renderedBody: c.text || "",
      created: c.createdDate,
      updated: c.modifiedDate || c.createdDate,
    }));
  }

  async transitionStatus(taskKey: string, statusName: string): Promise<void> {
    const id = this.toWorkItemId(taskKey);
    try {
      await this.azureClient.updateWorkItemState(id, statusName);
    } catch (error) {
      throw new TaskTrackerError(
        `Failed to move work item ${taskKey} to state "${statusName}": ${
          error instanceof Error ? error.message : error
        }. Check that the state exists for this work item type.`,
      );
    }
  }

  extractDescriptionText(task: Task): string {
    const workItem = task.raw as AzureDevOpsWorkItemDetail;
    return htmlToPlainText((workItem.fields["System.Description"] as string) || "");
  }

  // ------------------------------------------------------------------
  // Related work
  // ------------------------------------------------------------------

  extractLinkedResources(task: Task): LinkedResource[] {
    const workItem = task.raw as AzureDevOpsWorkItemDetail;
    const resources: LinkedResource[] = [];

    const description = (workItem.fields["System.Description"] as string) || "";
    const urlRegex = /href="(https?:\/\/[^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(description)) !== null) {
      resources.push({
        type: "description_link",
        url: match[1],
        description: match[1],
      });
    }

    for (const relation of workItem.relations) {
      if (relation.rel === "Hyperlink") {
        resources.push({
          type: "hyperlink",
          url: relation.url,
          description: (relation.attributes?.comment as string) || relation.url,
        });
      }
    }

    return resources;
  }

  async getRelatedWorkItems(task: Task): Promise<DetailedRelatedIssue[]> {
    const workItem = task.raw as AzureDevOpsWorkItemDetail;
    const related: DetailedRelatedIssue[] = [];

    for (const relation of workItem.relations) {
      const linkMatch = relation.rel.match(
        /^System\.LinkTypes\.(Hierarchy-Forward|Hierarchy-Reverse|Related)/,
      );
      if (!linkMatch) continue;

      const idMatch = relation.url.match(/\/workItems\/(\d+)$/i);
      if (!idMatch) continue;

      try {
        const detail = await this.azureClient.getWorkItemDetail(idMatch[1]);
        related.push({
          key: String(detail.id),
          summary: (detail.fields["System.Title"] as string) || "",
          description: htmlToPlainText((detail.fields["System.Description"] as string) || ""),
          issueType: (detail.fields["System.WorkItemType"] as string) || "Work Item",
          status: (detail.fields["System.State"] as string) || "",
          reporter: this.identityName(detail.fields["System.CreatedBy"]),
          created: (detail.fields["System.CreatedDate"] as string) || "",
          updated: (detail.fields["System.ChangedDate"] as string) || "",
          labels: this.parseTags(detail.fields["System.Tags"]),
          components: [],
          fixVersions: [],
          linkType:
            linkMatch[1] === "Hierarchy-Forward"
              ? "child"
              : linkMatch[1] === "Hierarchy-Reverse"
                ? "parent"
                : "related",
          relationshipDirection: linkMatch[1] === "Hierarchy-Reverse" ? "inward" : "outward",
        });
      } catch {
        // Skip related items the token cannot read
      }
    }

    return related;
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
    const workItem = await this.azureClient.getWorkItemDetail(taskKey);
    const result = new Map<string, string>();

    for (const relation of workItem.relations) {
      if (relation.rel !== "AttachedFile") continue;
      const filename =
        (relation.attributes?.name as string) || path.basename(new URL(relation.url).pathname);
      try {
        const buffer = await this.azureClient.downloadAttachment(relation.url);
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
  // Comments (markdown converted to HTML)
  // ------------------------------------------------------------------

  async postComment(taskKey: string, content: TaskTrackerCommentContent): Promise<void> {
    const html = content.format === "html" ? content.body : markdownToHtmlDescription(content.body);
    await this.azureClient.addComment(this.toWorkItemId(taskKey), html);
  }

  async postImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void> {
    const markdown = formatImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.azureClient.addComment(
      this.toWorkItemId(taskKey),
      markdownToHtmlDescription(markdown),
    );
    console.log(`✅ Successfully posted implementation comment to ${taskKey}`);
  }

  async postClarityComment(taskKey: string, assessment: unknown): Promise<void> {
    const markdown = formatClarityAssessmentMarkdown(assessment as ClarityAssessmentLike);
    await this.azureClient.addComment(
      this.toWorkItemId(taskKey),
      markdownToHtmlDescription(markdown),
    );
    console.log(`✅ Successfully posted clarity assessment to ${taskKey}`);
  }

  async postIncompleteImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
    taskDescription?: string,
  ): Promise<void> {
    const markdown = formatIncompleteImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.azureClient.addComment(
      this.toWorkItemId(taskKey),
      markdownToHtmlDescription(markdown),
    );
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
      return comments.some((c) => isIncompleteImplementationCommentText(c.text || ""));
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
    await this.azureClient.addComment(
      this.toWorkItemId(taskKey),
      markdownToHtmlDescription(formatAssessmentFailureMarkdown(failureType)),
    );
  }

  // ------------------------------------------------------------------
  // Estimation (Story Points field)
  // ------------------------------------------------------------------

  async findEstimationComment(
    taskKey: string,
  ): Promise<{ commentId: string; created: string } | null> {
    try {
      const comments = await this.fetchRawComments(taskKey);
      const existing = comments.find((c) => (c.text || "").includes(ESTIMATION_COMMENT_MARKER));
      return existing ? { commentId: String(existing.id), created: existing.createdDate } : null;
    } catch (error) {
      console.warn(`⚠️  Failed to check for estimation comment on ${taskKey}: ${error}`);
      return null;
    }
  }

  async discoverEstimationField(_taskKey?: string): Promise<string | null> {
    return DEFAULT_STORY_POINTS_FIELD;
  }

  async updateEstimation(taskKey: string, fieldId: string, value: number): Promise<void> {
    await this.azureClient.updateWorkItemField(this.toWorkItemId(taskKey), fieldId, value);
  }

  async postEstimationComment(taskKey: string, result: unknown): Promise<void> {
    const markdown = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.azureClient.addComment(
      this.toWorkItemId(taskKey),
      markdownToHtmlDescription(markdown),
    );
  }

  async updateEstimationComment(
    taskKey: string,
    commentId: string,
    result: unknown,
  ): Promise<void> {
    const markdown = formatEstimationCommentMarkdown(result as EstimationResultLike);
    await this.azureClient.updateComment(
      this.toWorkItemId(taskKey),
      Number(commentId),
      markdownToHtmlDescription(markdown),
    );
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private toWorkItemId(taskKey: string): number {
    const parsed = parseAzureDevOpsWorkItemReference(taskKey);
    const id = Number(parsed ?? taskKey);
    if (!Number.isInteger(id) || id <= 0) {
      throw new TaskTrackerError(
        `Invalid Azure DevOps work item reference: "${taskKey}". Use a numeric ID or work item URL.`,
      );
    }
    return id;
  }

  private async fetchRawComments(taskKey: string): Promise<AzureDevOpsComment[]> {
    return this.azureClient.getComments(this.toWorkItemId(taskKey));
  }

  private identityName(identity: unknown): string {
    if (identity && typeof identity === "object" && "displayName" in identity) {
      return String((identity as { displayName: unknown }).displayName);
    }
    return "Unknown";
  }

  private parseTags(tags: unknown): string[] {
    if (typeof tags !== "string" || !tags) return [];
    return tags
      .split(";")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  private normalizeWorkItem(workItem: AzureDevOpsWorkItemDetail): Task {
    const fields = workItem.fields;
    const descriptionHtml = (fields["System.Description"] as string) || "";
    return {
      key: String(workItem.id),
      summary: (fields["System.Title"] as string) || "",
      description: htmlToPlainText(descriptionHtml) || undefined,
      renderedDescription: descriptionHtml || undefined,
      issueType: (fields["System.WorkItemType"] as string) || "Work Item",
      status: (fields["System.State"] as string) || "",
      priority:
        fields["Microsoft.VSTS.Common.Priority"] !== undefined
          ? String(fields["Microsoft.VSTS.Common.Priority"])
          : undefined,
      assignee:
        fields["System.AssignedTo"] !== undefined
          ? this.identityName(fields["System.AssignedTo"])
          : undefined,
      reporter: this.identityName(fields["System.CreatedBy"]),
      created: (fields["System.CreatedDate"] as string) || "",
      updated: (fields["System.ChangedDate"] as string) || "",
      labels: this.parseTags(fields["System.Tags"]),
      components: [],
      fixVersions: [],
      raw: workItem,
    };
  }
}
