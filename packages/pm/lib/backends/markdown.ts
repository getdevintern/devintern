import { copyFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  parseMarkdownFrontmatter,
  parseMarkdownLabelList,
  updateMarkdownFrontmatterField,
} from "@devintern/task-trackers";
import { DEFAULT_ISSUE_TYPES } from "../issue-types.js";
import { readFile, writeFile, pathExists, mkdir } from "../runtime/fs.js";
import type { CreatedTask, LabelListResult, ProjectInfo, TaskBackend } from "./types";

export interface MarkdownBackendConfig {
  directory: string;
}

/**
 * Local markdown file backend for task storage (no external API).
 */
export class MarkdownBackend implements TaskBackend {
  readonly name = "Markdown";
  readonly supportsIssueTypes = true;
  // Local markdown files have no real epic hierarchy; linkToEpic only records
  // a frontmatter note, so epic linking is treated as unsupported.
  readonly supportsEpicLinking = false;
  readonly supportsLabels = true;
  readonly supportsFreeformLabels = true;
  readonly supportsAttachments = true;
  private dir: string;

  /**
   * Create a markdown backend targeting a tasks directory.
   *
   * @param config - Directory path for `.md` task files (resolved to absolute).
   */
  constructor(config: MarkdownBackendConfig) {
    this.dir = resolve(config.directory);
  }

  /**
   * Convert text to a filesystem-safe slug segment.
   *
   * @param text - Raw title or label text.
   * @returns Lowercase hyphenated slug truncated to 50 characters.
   */
  private sanitizeFilename(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 50);
  }

  /**
   * Generate a unique task key from timestamp and random suffix.
   *
   * @returns Key string suitable for filenames and frontmatter.
   */
  private generateKey(): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").substring(0, 19);
    const random = Math.random().toString(36).substring(2, 6);
    return `${timestamp}-${random}`;
  }

  /**
   * Ensure the tasks output directory exists.
   *
   * @returns Resolves when the directory is created or already present.
   */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dir);
  }

  /**
   * Build the absolute path for a task markdown file.
   *
   * @param key - Task filename stem (without extension).
   * @returns Absolute path to the `.md` file.
   */
  private filePath(key: string): string {
    return join(this.dir, `${key}.md`);
  }

  /**
   * Write a new markdown task file with YAML frontmatter.
   *
   * @param summary - Task title (H1 heading).
   * @param description - Task body markdown.
   * @param issueType - Issue type stored in frontmatter.
   * @param _projectKey - Ignored; markdown backend has no projects.
   * @returns Filename key and absolute file path as URL.
   */
  async createTask(
    summary: string,
    description: string,
    issueType: string,
    _projectKey?: string,
  ): Promise<CreatedTask> {
    await this.ensureDir();
    const key = this.generateKey();
    const filename = `${key}-${this.sanitizeFilename(summary)}`;
    const filePath = this.filePath(filename);
    const now = new Date().toISOString();

    const content = `---
key: ${key}
type: ${issueType}
created_at: ${now}
---

# ${summary}

${description}
`;

    await writeFile(filePath, content);
    return {
      key: filename,
      url: filePath,
    };
  }

  /**
   * Append a checkbox subtask line to the parent markdown file.
   *
   * @param parentKey - Parent task filename stem.
   * @param summary - Subtask title.
   * @param description - Optional first-line description preview.
   * @param _projectKey - Ignored.
   * @returns Composite subtask key and parent file path.
   * @throws When the parent task file does not exist.
   */
  async createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    _projectKey?: string,
  ): Promise<CreatedTask> {
    await this.ensureDir();

    const parentPath = join(this.dir, `${parentKey}.md`);

    if (!(await pathExists(parentPath))) {
      throw new Error(`Parent task not found: ${parentKey}`);
    }

    let parentContent = await readFile(parentPath);
    const subtaskSection = "\n## Subtasks\n\n";

    if (!parentContent.includes(subtaskSection)) {
      parentContent += subtaskSection;
    }

    const subtaskLine = description
      ? `- [ ] **${summary}**: ${description.split("\n")[0]}\n`
      : `- [ ] **${summary}**\n`;

    parentContent += subtaskLine;

    await writeFile(parentPath, parentContent);

    return {
      key: `${parentKey}-subtask`,
      url: parentPath,
    };
  }

  /**
   * Record an epic reference in frontmatter or as a blockquote prefix.
   *
   * @param storyKey - Task filename stem to update.
   * @param epicKey - Epic task key to link.
   * @throws When the task file does not exist.
   */
  async linkToEpic(storyKey: string, epicKey: string): Promise<void> {
    const filePath = join(this.dir, `${storyKey}.md`);

    if (!(await pathExists(filePath))) {
      throw new Error(`Task not found: ${storyKey}`);
    }

    let content = await readFile(filePath);

    if (content.startsWith("---")) {
      const frontmatterEnd = content.indexOf("---", 3);
      if (frontmatterEnd !== -1) {
        const frontmatter = content.substring(0, frontmatterEnd + 3);
        const rest = content.substring(frontmatterEnd + 3);

        let updatedFrontmatter: string;
        if (frontmatter.includes("epic:")) {
          updatedFrontmatter = frontmatter.replace(/epic: .*/, `epic: ${epicKey}`);
        } else {
          const lines = frontmatter.split("\n");
          lines.splice(lines.length - 1, 0, `epic: ${epicKey}`);
          updatedFrontmatter = lines.join("\n");
        }

        content = updatedFrontmatter + rest;
        await writeFile(filePath, content);
        return;
      }
    }

    content = `> Epic: ${epicKey}\n\n${content}`;
    await writeFile(filePath, content);
  }

  /**
   * Markdown backend has no external projects.
   *
   * @returns Empty array.
   */
  async getProjects(): Promise<ProjectInfo[]> {
    return [];
  }

  /**
   * Return supported issue type labels for UI compatibility.
   *
   * @returns Static list of type names.
   */
  async getIssueTypes(): Promise<string[]> {
    return [...DEFAULT_ISSUE_TYPES];
  }

  /**
   * Collect existing labels from task frontmatter in the tasks directory.
   *
   * Suggestions only — {@link supportsFreeformLabels} is true, so the engine
   * and picker also accept names that are not yet present on any file.
   *
   * Scans `labels:` (preferred) and `tags:` CSV fields across `.md` files.
   * Name-keyed (`id === name`). Soft-capped like remote trackers.
   *
   * @param _projectKey - Ignored.
   * @param options.maxLabels - Soft catalog cap (default 500).
   * @returns Deduped label refs sorted by name, plus truncation.
   */
  async getLabels(
    _projectKey?: string,
    options?: { maxLabels?: number },
  ): Promise<LabelListResult> {
    const maxLabels = options?.maxLabels ?? 500;
    const seen = new Map<string, string>();

    if (!(await pathExists(this.dir))) {
      return { labels: [], truncated: false };
    }

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return { labels: [], truncated: false };
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      let content: string;
      try {
        content = await readFile(join(this.dir, entry));
      } catch {
        continue;
      }
      const { frontmatter } = parseMarkdownFrontmatter(content);
      for (const name of parseMarkdownLabelList(frontmatter)) {
        const key = name.toLowerCase();
        if (!seen.has(key)) {
          seen.set(key, name);
        }
      }
    }

    const all = [...seen.values()].sort((a, b) => a.localeCompare(b));
    return {
      labels: all.slice(0, maxLabels).map((name) => ({ id: name, name })),
      truncated: all.length > maxLabels,
    };
  }

  /**
   * Write labels into a task file's frontmatter as a CSV `labels:` field.
   *
   * @param taskKey - Task filename stem.
   * @param labelIds - Label names from {@link getLabels}.
   * @throws When the task file does not exist or has no frontmatter block.
   */
  async applyLabels(taskKey: string, labelIds: string[]): Promise<void> {
    if (labelIds.length === 0) return;

    const filePath = this.filePath(taskKey);
    if (!(await pathExists(filePath))) {
      throw new Error(`Task not found: ${taskKey}`);
    }

    const content = await readFile(filePath);
    const value = labelIds
      .map((id) => id.trim())
      .filter(Boolean)
      .join(", ");
    const updated = updateMarkdownFrontmatterField(content, "labels", value);
    if (!updated) {
      throw new Error(`Task has no frontmatter to store labels: ${taskKey}`);
    }
    await writeFile(filePath, updated);
  }

  /**
   * Copy a local file into `attachments/` next to the task and link it in the body.
   *
   * @param taskKey - Task filename stem.
   * @param filePath - Absolute path to the local file.
   * @param options - Optional filename override.
   */
  async uploadAttachment(
    taskKey: string,
    filePath: string,
    options?: { filename?: string; mimeType?: string },
  ): Promise<void> {
    const mdPath = this.filePath(taskKey);
    if (!(await pathExists(mdPath))) {
      throw new Error(`Task not found: ${taskKey}`);
    }

    const attachmentsDir = join(this.dir, "attachments", taskKey);
    await mkdir(attachmentsDir);

    const filename = (options?.filename || basename(filePath)).replace(/[^a-zA-Z0-9._-]/g, "_");
    const destPath = join(attachmentsDir, filename);
    await copyFile(filePath, destPath);

    const relativeLink = `attachments/${taskKey}/${filename}`;
    const isImage = /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(filename);
    const linkLine = isImage
      ? `- ![${filename}](${relativeLink})`
      : `- [${filename}](${relativeLink})`;

    let content = await readFile(mdPath);
    const heading = "\n## Attachments\n\n";
    if (!content.includes(heading) && !content.includes("\n## Attachments\n")) {
      content = content.trimEnd() + heading + linkLine + "\n";
    } else {
      content = content.trimEnd() + "\n" + linkLine + "\n";
    }
    await writeFile(mdPath, content);
  }
}
