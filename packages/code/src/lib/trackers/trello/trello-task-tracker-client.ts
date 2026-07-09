/**
 * Trello implementation of the platform-agnostic {@link TaskTrackerClient}.
 *
 * Delegates HTTP calls to {@link TrelloClient} from `@devintern/task-trackers`.
 * Estimation operations are not supported (Trello has no story-points concept).
 */

import {
  TrelloClient,
  type TrelloAction,
  type TrelloAttachment,
  type TrelloCardDetail,
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
  formatAssessmentFailureMarkdown,
  formatClarityAssessmentMarkdown,
  formatImplementationCommentMarkdown,
  formatIncompleteImplementationCommentMarkdown,
  isDevInternCommentText,
  isIncompleteImplementationCommentText,
  matchesSavedIncompleteDescription,
  persistIncompleteDescription,
  type ClarityAssessmentLike,
} from "../shared/markdown-comment-formatter";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

export class TrelloTaskTrackerClient implements TaskTrackerClient {
  private trelloClient: TrelloClient;
  readonly defaultBoardId?: string;
  readonly defaultListName?: string;

  constructor(
    apiKey: string,
    apiToken: string,
    options?: { defaultBoardId?: string; defaultListName?: string },
  ) {
    this.trelloClient = new TrelloClient({ apiKey, apiToken });
    this.defaultBoardId = options?.defaultBoardId;
    this.defaultListName = options?.defaultListName;
  }

  // ------------------------------------------------------------------
  // Core task operations
  // ------------------------------------------------------------------

  async getTask(taskKey: string): Promise<Task> {
    const card = await this.trelloClient.getCardWithDetails(taskKey);
    return this.normalizeCard(card);
  }

  /**
   * Search cards using Trello search operators (e.g. `list:"To Do" is:open`).
   * Scoped to `TRELLO_DEFAULT_BOARD_ID` when configured.
   */
  async searchTasks(query: string): Promise<{ tasks: Task[]; total: number }> {
    const result = await this.trelloClient.searchCards(query, this.defaultBoardId);
    const tasks: Task[] = [];
    for (const card of result.cards) {
      const detail = await this.trelloClient.getCardWithDetails(card.shortLink || card.id);
      tasks.push(this.normalizeCard(detail));
    }
    return { tasks, total: result.total };
  }

  async getComments(taskKey: string): Promise<Comment[]> {
    const actions = await this.trelloClient.getCardComments(taskKey);
    const filtered = actions.filter((a) => !this.isDevInternComment(a));

    const filteredCount = actions.length - filtered.length;
    if (filteredCount > 0) {
      console.log(`🔍 Filtered out ${filteredCount} @devintern/code comment(s) from ${taskKey}`);
    }

    return filtered.map((a) => ({
      id: a.id,
      author: a.memberCreator?.fullName || a.memberCreator?.username || "Unknown",
      body: a.data?.text || "",
      created: a.date,
      updated: a.date,
    }));
  }

  async transitionStatus(taskKey: string, statusName: string): Promise<void> {
    const card = await this.trelloClient.getCardWithDetails(taskKey);
    const lists = await this.trelloClient.getLists(card.idBoard);
    const target = lists.find((l) => l.name.toLowerCase() === statusName.toLowerCase());

    if (!target) {
      const available = lists.map((l) => l.name).join(", ");
      throw new TaskTrackerError(
        `List "${statusName}" not found on board. Available lists: ${available}`,
      );
    }

    await this.trelloClient.moveCardToList(taskKey, target.id);
  }

  extractDescriptionText(task: Task): string {
    return (task.raw as TrelloCardDetail).desc || "";
  }

  // ------------------------------------------------------------------
  // Related work
  // ------------------------------------------------------------------

  extractLinkedResources(task: Task): LinkedResource[] {
    const card = task.raw as TrelloCardDetail;
    const resources: LinkedResource[] = [];

    const urlRegex = /(https?:\/\/[^\s)]+)/g;
    const desc = card.desc || "";
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(desc)) !== null) {
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
    const attachments = await this.trelloClient.getCardAttachments(taskKey);
    const result = new Map<string, string>();

    for (const attachment of attachments) {
      if (!attachment.url) continue;
      try {
        const response = await fetch(attachment.url);
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        const filename = attachment.name || path.basename(attachment.url);
        const filePath = path.join(outputDir, filename);
        mkdirSync(outputDir, { recursive: true });
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
  // Comments
  // ------------------------------------------------------------------

  async postComment(taskKey: string, content: TaskTrackerCommentContent): Promise<void> {
    await this.trelloClient.postCardComment(taskKey, content.body);
  }

  async postImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void> {
    const body = formatImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.trelloClient.postCardComment(taskKey, body);
    console.log(`✅ Successfully posted implementation comment to ${taskKey}`);
  }

  async postClarityComment(taskKey: string, assessment: unknown): Promise<void> {
    const body = formatClarityAssessmentMarkdown(assessment as ClarityAssessmentLike);
    await this.trelloClient.postCardComment(taskKey, body);
    console.log(`✅ Successfully posted clarity assessment to ${taskKey}`);
  }

  async postIncompleteImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
    taskDescription?: string,
  ): Promise<void> {
    const body = formatIncompleteImplementationCommentMarkdown(agentOutput, taskSummary);
    await this.trelloClient.postCardComment(taskKey, body);
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

      const actions = await this.trelloClient.getCardComments(taskKey);
      return actions.some((a) => isIncompleteImplementationCommentText(a.data?.text || ""));
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
    await this.trelloClient.postCardComment(taskKey, formatAssessmentFailureMarkdown(failureType));
  }

  // ------------------------------------------------------------------
  // Estimation (not supported by Trello)
  // ------------------------------------------------------------------

  async findEstimationComment(
    _taskKey: string,
  ): Promise<{ commentId: string; created: string } | null> {
    return null;
  }

  async discoverEstimationField(_taskKey?: string): Promise<string | null> {
    return null;
  }

  async updateEstimation(_taskKey: string, _fieldId: string, _value: number): Promise<void> {
    throw new TaskTrackerError("Estimation fields are not supported for Trello.");
  }

  async postEstimationComment(_taskKey: string, _result: unknown): Promise<void> {
    // Trello has no estimation concept — silently skip.
  }

  async updateEstimationComment(
    _taskKey: string,
    _commentId: string,
    _result: unknown,
  ): Promise<void> {
    // Trello has no estimation concept — silently skip.
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private normalizeCard(card: TrelloCardDetail): Task {
    return {
      key: card.shortLink || card.id,
      summary: card.name,
      description: card.desc || undefined,
      issueType: "Card",
      status: "",
      assignee: undefined,
      reporter: "Unknown",
      created: card.dateLastActivity || "",
      updated: card.dateLastActivity || "",
      labels: card.labels?.map((l) => l.name).filter(Boolean) || [],
      components: [],
      fixVersions: [],
      raw: card,
    };
  }

  private isDevInternComment(action: TrelloAction): boolean {
    return isDevInternCommentText(action.data?.text || "");
  }
}
