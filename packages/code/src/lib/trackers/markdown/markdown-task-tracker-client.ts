/**
 * Local markdown file implementation of {@link TaskTrackerClient}.
 *
 * Supports arbitrary `.md` file paths and keys resolved from `MARKDOWN_TASKS_DIR`.
 */

import {
  extractMarkdownTitle,
  isMarkdownFilePath,
  markdownFilenameStem,
  parseMarkdownFrontmatter,
  resolveMarkdownTaskPath,
  sanitizeMarkdownTaskKey,
  updateMarkdownFrontmatterField,
} from "@devintern/task-trackers";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
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

export interface MarkdownTaskRaw {
  filePath: string;
  fullContent: string;
  frontmatter: Record<string, string>;
  hasFrontmatter: boolean;
  hasStatusField: boolean;
  body: string;
}

export interface MarkdownTaskTrackerOptions {
  /** Directory for key-based lookups when `TASK_TRACKER=markdown`. */
  tasksDirectory?: string;
  /** Working directory for resolving relative file paths. */
  cwd?: string;
}

const IMPLEMENTATION_INSTRUCTIONS = `## Implementation Instructions

Please analyze the above task description and implement the requested functionality.
`;

export class MarkdownTaskTrackerClient implements TaskTrackerClient {
  private readonly tasksDirectory?: string;
  private readonly cwd: string;
  private readonly filePathByKey = new Map<string, string>();

  constructor(options: MarkdownTaskTrackerOptions = {}) {
    this.tasksDirectory = options.tasksDirectory;
    this.cwd = options.cwd ?? process.cwd();
  }

  /** Whether this client reads tasks from local markdown files. */
  static isMarkdownClient(client: TaskTrackerClient): client is MarkdownTaskTrackerClient {
    return client instanceof MarkdownTaskTrackerClient;
  }

  getTaskFilePath(taskKey: string): string | undefined {
    return this.filePathByKey.get(taskKey);
  }

  async getTask(taskRef: string): Promise<Task> {
    const filePath = resolveMarkdownTaskPath(taskRef, this.tasksDirectory, this.cwd);

    if (!existsSync(filePath)) {
      throw new TaskTrackerError(`File not found: ${filePath}`);
    }

    let fileContent: string;
    try {
      fileContent = readFileSync(filePath, "utf8");
    } catch (err) {
      throw new TaskTrackerError(`Cannot read file: ${filePath}: ${(err as Error).message}`);
    }

    if (!fileContent.trim()) {
      throw new TaskTrackerError(`File is empty: ${filePath}`);
    }

    if (fileContent.includes("\0")) {
      throw new TaskTrackerError(`File appears to be binary, not a markdown file: ${filePath}`);
    }

    const { frontmatter, body, hasFrontmatter } = parseMarkdownFrontmatter(fileContent);
    const hasStatusField =
      hasFrontmatter && Object.prototype.hasOwnProperty.call(frontmatter, "status");

    const filenameStem = markdownFilenameStem(filePath);
    const rawTaskKey = frontmatter.key ?? filenameStem;
    const taskKey = sanitizeMarkdownTaskKey(rawTaskKey);
    const title = extractMarkdownTitle(body) ?? extractMarkdownTitle(fileContent) ?? filenameStem;

    this.filePathByKey.set(taskKey, filePath);
    if (taskRef !== taskKey) {
      this.filePathByKey.set(taskRef, filePath);
    }

    const raw: MarkdownTaskRaw = {
      filePath,
      fullContent: fileContent,
      frontmatter,
      hasFrontmatter,
      hasStatusField,
      body,
    };

    return {
      key: taskKey,
      summary: title,
      description: fileContent,
      issueType: frontmatter.type ?? "Task",
      status: frontmatter.status ?? "Unknown",
      reporter: "local",
      created: frontmatter.created_at ?? "",
      updated: frontmatter.created_at ?? "",
      labels: [],
      components: [],
      fixVersions: [],
      raw,
    };
  }

  /**
   * Search markdown task files by frontmatter filters.
   *
   * Query syntax: space-separated `key=value` pairs matched against
   * frontmatter fields (case-insensitive values, quotes allowed), e.g.
   * `status=todo` or `status="In Progress" type=bug`. Remaining free text
   * matches the task title (case-insensitive contains).
   */
  async searchTasks(query: string): Promise<{ tasks: Task[]; total: number }> {
    if (!this.tasksDirectory) {
      throw new TaskTrackerError(
        "Markdown task search requires MARKDOWN_TASKS_DIR to be set (TASK_TRACKER=markdown).",
      );
    }
    if (!existsSync(this.tasksDirectory)) {
      throw new TaskTrackerError(`Markdown tasks directory not found: ${this.tasksDirectory}`);
    }

    const { filters, text } = parseMarkdownTaskQuery(query);

    const files = readdirSync(this.tasksDirectory)
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort();

    const tasks: Task[] = [];
    for (const name of files) {
      const filePath = join(this.tasksDirectory, name);
      let task: Task;
      try {
        task = await this.getTask(filePath);
      } catch {
        continue; // Skip unreadable/empty files
      }

      const raw = task.raw as MarkdownTaskRaw;
      const matchesFilters = Object.entries(filters).every(
        ([key, value]) => (raw.frontmatter[key] ?? "").toLowerCase() === value.toLowerCase(),
      );
      if (!matchesFilters) continue;

      if (text && !task.summary.toLowerCase().includes(text.toLowerCase())) continue;

      tasks.push(task);
    }

    return { tasks, total: tasks.length };
  }

  async getComments(_taskKey: string): Promise<Comment[]> {
    return [];
  }

  async transitionStatus(taskKey: string, statusName: string): Promise<void> {
    const filePath = this.resolveFilePath(taskKey);
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, hasFrontmatter } = parseMarkdownFrontmatter(content);
    const hasStatusField =
      hasFrontmatter && Object.prototype.hasOwnProperty.call(frontmatter, "status");

    if (!hasStatusField) {
      return;
    }

    const updated = updateMarkdownFrontmatterField(content, "status", statusName);
    if (!updated) {
      return;
    }

    writeFileSync(filePath, updated, "utf8");
    console.log(`✅ Status updated to '${statusName}'`);
  }

  extractDescriptionText(task: Task): string {
    const raw = task.raw as MarkdownTaskRaw;
    return raw?.fullContent ?? "";
  }

  extractLinkedResources(_task: Task): LinkedResource[] {
    return [];
  }

  async getRelatedWorkItems(_task: Task): Promise<DetailedRelatedIssue[]> {
    return [];
  }

  formatTaskDetails(
    task: Task,
    _comments: Comment[],
    linkedResources: LinkedResource[],
    relatedIssues: DetailedRelatedIssue[],
  ): FormattedTaskDetails {
    return {
      key: task.key,
      summary: task.summary,
      description: task.description,
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
      comments: [],
      attachments: [],
    };
  }

  async downloadAttachments(_taskKey: string, _outputDir: string): Promise<Map<string, string>> {
    return new Map();
  }

  async downloadAttachmentsFromContent(
    _htmlContent: string,
    _outputDir: string,
    existingMap?: Map<string, string>,
  ): Promise<Map<string, string>> {
    return existingMap ?? new Map();
  }

  async postComment(_taskKey: string, _content: TaskTrackerCommentContent): Promise<void> {
    /* local files do not receive tracker comments */
  }

  async postImplementationComment(
    _taskKey: string,
    _agentOutput: string,
    _taskSummary?: string,
  ): Promise<void> {
    /* no-op */
  }

  async postClarityComment(_taskKey: string, _assessment: unknown): Promise<void> {
    /* no-op */
  }

  async postIncompleteImplementationComment(
    _taskKey: string,
    _agentOutput: string,
    _taskSummary?: string,
    _taskDescription?: string,
  ): Promise<void> {
    /* no-op */
  }

  async hasIncompleteImplementationComment(
    _taskKey: string,
    _currentDescription: string,
  ): Promise<boolean> {
    return false;
  }

  async postAssessmentFailure(
    _taskKey: string,
    _failureType: "max-turns" | "parse-error",
    _rawOutput: string,
  ): Promise<void> {
    /* no-op */
  }

  async findEstimationComment(
    _taskKey: string,
  ): Promise<{ commentId: string; created: string } | null> {
    return null;
  }

  async discoverEstimationField(_taskKey?: string): Promise<string | null> {
    return null;
  }

  async updateEstimation(_taskKey: string, _fieldId: string, _value: number): Promise<void> {
    throw new TaskTrackerError("Markdown tasks do not support estimation fields");
  }

  async postEstimationComment(_taskKey: string, _result: unknown): Promise<void> {
    /* no-op */
  }

  async updateEstimationComment(
    _taskKey: string,
    _commentId: string,
    _result: unknown,
  ): Promise<void> {
    /* no-op */
  }

  /**
   * Write the agent prompt file, preserving the source markdown and appending
   * implementation instructions when they are not already present.
   */
  writeAgentPrompt(outputPath: string, task: Task): void {
    const raw = task.raw as MarkdownTaskRaw;
    const content = raw.fullContent;
    const hasInstructions = content.includes("## Implementation Instructions");
    const prompt = hasInstructions ? content : `${content}\n\n${IMPLEMENTATION_INSTRUCTIONS}\n`;
    writeFileSync(outputPath, prompt, "utf8");
  }

  /**
   * Transition to Done when a successful implementation summary exists.
   */
  async markDoneIfSuccessful(taskKey: string, taskDir: string): Promise<void> {
    const raw = await this.getRawForKey(taskKey);
    if (!raw?.hasStatusField) {
      return;
    }

    const summaryFile = join(taskDir, "implementation-summary.md");
    if (!existsSync(summaryFile)) {
      return;
    }

    console.log(`\n🔄 Updating status in ${basename(raw.filePath)} to 'Done'...`);
    await this.transitionStatus(taskKey, "Done");
  }

  private resolveFilePath(taskKey: string): string {
    const filePath = this.filePathByKey.get(taskKey);
    if (!filePath) {
      throw new TaskTrackerError(`Unknown markdown task key: ${taskKey}`);
    }
    return filePath;
  }

  private async getRawForKey(taskKey: string): Promise<MarkdownTaskRaw | undefined> {
    const filePath = this.filePathByKey.get(taskKey);
    if (!filePath) {
      return undefined;
    }

    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body, hasFrontmatter } = parseMarkdownFrontmatter(content);
    return {
      filePath,
      fullContent: content,
      frontmatter,
      hasFrontmatter,
      hasStatusField: hasFrontmatter && Object.prototype.hasOwnProperty.call(frontmatter, "status"),
      body,
    };
  }
}

/**
 * Parse a markdown task query into frontmatter filters and free text.
 * Exported for testing.
 */
export function parseMarkdownTaskQuery(query: string): {
  filters: Record<string, string>;
  text?: string;
} {
  const filters: Record<string, string> = {};
  const remainder: string[] = [];

  const tokenRegex = /([\w.-]+)=(?:"([^"]*)"|(\S+))|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(query)) !== null) {
    const [, key, quoted, bare, free] = match;
    if (free !== undefined) {
      remainder.push(free);
      continue;
    }
    filters[key] = quoted ?? bare ?? "";
  }

  return {
    filters,
    text: remainder.length > 0 ? remainder.join(" ") : undefined,
  };
}

/** Convenience helper for callers that only have the interface type. */
export function isMarkdownTaskTracker(
  client: TaskTrackerClient,
): client is MarkdownTaskTrackerClient {
  return MarkdownTaskTrackerClient.isMarkdownClient(client);
}

/**
 * Return true when a task reference should use the markdown tracker client.
 */
export function isMarkdownTaskInput(taskRef: string): boolean {
  return isMarkdownFilePath(taskRef);
}
