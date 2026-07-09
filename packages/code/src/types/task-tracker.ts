/**
 * Platform-agnostic task tracker domain types for `@devintern/code`.
 *
 * These types are normalized representations that do not couple to any
 * particular tracker (JIRA, Linear, Trello, etc.).
 */

export interface TaskTrackerConfig {
  type: string;
  // Tracker-specific configuration is added by concrete implementations
}

/** Normalized task/issue representation. */
export interface Task {
  key: string;
  summary: string;
  description?: unknown;
  renderedDescription?: string;
  issueType: string;
  status: string;
  priority?: string;
  assignee?: string;
  reporter: string;
  created: string;
  updated: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  /** Platform-specific raw payload — used by concrete implementations. */
  raw: unknown;
}

/** Generic comment shape, free of tracker-specific formats like ADF. */
export interface Comment {
  id: string;
  author: string;
  body: unknown;
  renderedBody?: string;
  created: string;
  updated: string;
}

export interface LinkedResource {
  type: string;
  field?: string;
  url?: string;
  description: string;
  linkType?: string;
  issueKey?: string;
  summary?: string;
}

export interface DetailedRelatedIssue {
  key: string;
  summary: string;
  description?: unknown;
  renderedDescription?: string;
  issueType: string;
  status: string;
  priority?: string;
  assignee?: string;
  reporter: string;
  created: string;
  updated: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  linkType: string;
  relationshipDirection: string;
}

export interface FormattedTaskDetails {
  key: string;
  summary: string;
  description?: unknown;
  renderedDescription?: string;
  issueType: string;
  status: string;
  priority?: string;
  assignee?: string;
  reporter: string;
  created: string;
  updated: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  linkedResources: LinkedResource[];
  relatedIssues: DetailedRelatedIssue[];
  comments: Comment[];
  attachments: Array<{
    filename: string;
    size: number;
    mimeType: string;
    created: string;
    author: string;
    content: string;
  }>;
}

export interface TaskTrackerCommentContent {
  format: "markdown" | "plain" | "html";
  body: string;
}

// ------------------------------------------------------------------
// Error hierarchy
// ------------------------------------------------------------------

export class TaskTrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskTrackerError";
  }
}

export class TaskNotFoundError extends TaskTrackerError {
  constructor(taskKey: string) {
    super(`Task not found: ${taskKey}`);
    this.name = "TaskNotFoundError";
  }
}

export class AuthenticationError extends TaskTrackerError {
  constructor(message = "Authentication failed") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class TransitionError extends TaskTrackerError {
  constructor(statusName: string, taskKey: string) {
    super(`Failed to transition ${taskKey} to "${statusName}"`);
    this.name = "TransitionError";
  }
}
