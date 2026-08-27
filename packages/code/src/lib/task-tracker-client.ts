/**
 * Task tracker client contract for `@devintern/code`.
 *
 * Defines the normalized interface that core workflow code depends on.
 * Concrete implementations (e.g. {@link JiraTaskTrackerClient}) translate
 * platform-specific APIs into this common contract.
 *
 * Pattern follows {@link TaskBackend} in `@devintern/pm`.
 */

import type {
  Comment,
  DetailedRelatedIssue,
  FormattedTaskDetails,
  LinkedResource,
  Task,
  TaskTrackerCommentContent,
} from "../types/task-tracker";

// --------------------------------------------------------------------
// Issue creation (optional capability — see {@linkcode IssueCreatableClient})
// --------------------------------------------------------------------

/** Normalized payload for creating a tracker issue. */
export interface CreateIssueInput {
  title: string;
  /** Markdown body. */
  body: string;
  labels?: string[];
}

/** Normalized result of a created tracker issue. */
export interface CreatedIssue {
  /** Tracker-native key (issue number, iid, ...). */
  key: string;
  url?: string;
}

/**
 * Optional capability interface for trackers that can create issues.
 *
 * Implementations ({@link GitHubTaskTrackerClient},
 * {@link GitLabTaskTrackerClient}) duck-type against
 * {@link TaskTrackerClient}; callers feature-detect with
 * `supportsIssueCreation()` before casting.
 */
export interface IssueCreatableClient {
  createIssue(input: CreateIssueInput): Promise<CreatedIssue>;
}

export interface TaskTrackerClient {
  // ------------------------------------------------------------------
  // Core task operations
  // ------------------------------------------------------------------

  /** Fetch a single task by its tracker-specific key. */
  getTask(taskKey: string): Promise<Task>;

  /** Search tasks using a tracker-native query string. */
  searchTasks(query: string): Promise<{ tasks: Task[]; total: number }>;

  /** List comments for a task, excluding automation noise where possible. */
  getComments(taskKey: string): Promise<Comment[]>;

  /** Transition a task to a named workflow status. */
  transitionStatus(taskKey: string, statusName: string): Promise<void>;

  /** Extract plain text from a task's description field. */
  extractDescriptionText(task: Task): string;

  // ------------------------------------------------------------------
  // Related work
  // ------------------------------------------------------------------

  /** Extract linked resources (URLs, issue links, etc.) from a task. */
  extractLinkedResources(task: Task): LinkedResource[];

  /** Fetch and format detailed related work items for a task. */
  getRelatedWorkItems(task: Task): Promise<DetailedRelatedIssue[]>;

  /** Assemble a normalized {@link FormattedTaskDetails} from raw task data. */
  formatTaskDetails(
    task: Task,
    comments: Comment[],
    linkedResources: LinkedResource[],
    relatedIssues: DetailedRelatedIssue[],
  ): FormattedTaskDetails;

  // ------------------------------------------------------------------
  // Attachments
  // ------------------------------------------------------------------

  /** Download all direct attachments on a task to a local directory. */
  downloadAttachments(taskKey: string, outputDir: string): Promise<Map<string, string>>;

  /** Download attachments referenced by URLs embedded in HTML content. */
  downloadAttachmentsFromContent(
    htmlContent: string,
    outputDir: string,
    existingMap?: Map<string, string>,
  ): Promise<Map<string, string>>;

  // ------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------

  /** Post a generic comment to a task. */
  postComment(taskKey: string, content: TaskTrackerCommentContent): Promise<void>;

  /** Post a rich implementation-success comment. */
  postImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void>;

  /** Post a clarity / feasibility assessment comment. */
  postClarityComment(taskKey: string, assessment: unknown): Promise<void>;

  /** Post an incomplete-implementation comment. */
  postIncompleteImplementationComment(
    taskKey: string,
    agentOutput: string,
    taskSummary?: string,
  ): Promise<void>;

  /**
   * Check whether an automation failure marker comment (incomplete
   * implementation or processing failure) exists on the task. The retry gate
   * treats its absence as "the ticket's failure comment was removed", which
   * unlocks a retry. Bookkeeping lives in lib/retry-state.ts.
   */
  hasIncompleteImplementationMarker(taskKey: string): Promise<boolean>;

  /** Post a comment when an assessment fails (max turns or parse error). */
  postAssessmentFailure(
    taskKey: string,
    failureType: "max-turns" | "parse-error",
    rawOutput: string,
  ): Promise<void>;

  // ------------------------------------------------------------------
  // Estimation (optional — trackers without estimation fields can no-op or throw)
  // ------------------------------------------------------------------

  /** Find a previously-posted automated estimation comment. */
  findEstimationComment(taskKey: string): Promise<{ commentId: string; created: string } | null>;

  /**
   * Discover the editable estimation field for a task.
   * @returns Field identifier, or `null` when none found.
   */
  discoverEstimationField(taskKey?: string): Promise<string | null>;

  /**
   * Update an estimation value on a task.
   * @throws When the field is not editable or the update fails.
   */
  updateEstimation(taskKey: string, fieldId: string, value: number): Promise<void>;

  /** Post a new automated estimation comment. */
  postEstimationComment(taskKey: string, result: unknown): Promise<void>;

  /** Update an existing automated estimation comment in place. */
  updateEstimationComment(taskKey: string, commentId: string, result: unknown): Promise<void>;
}
