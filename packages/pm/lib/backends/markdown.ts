import { join, resolve } from "node:path";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./types";

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
    await Bun.$`mkdir -p ${this.dir}`;
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

    await Bun.write(filePath, content);
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
    const parentFile = Bun.file(parentPath);

    if (!(await parentFile.exists())) {
      throw new Error(`Parent task not found: ${parentKey}`);
    }

    let parentContent = await parentFile.text();
    const subtaskSection = "\n## Subtasks\n\n";

    if (!parentContent.includes(subtaskSection)) {
      parentContent += subtaskSection;
    }

    const subtaskLine = description
      ? `- [ ] **${summary}**: ${description.split("\n")[0]}\n`
      : `- [ ] **${summary}**\n`;

    parentContent += subtaskLine;

    await Bun.write(parentPath, parentContent);

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
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      throw new Error(`Task not found: ${storyKey}`);
    }

    let content = await file.text();

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
        await Bun.write(filePath, content);
        return;
      }
    }

    content = `> Epic: ${epicKey}\n\n${content}`;
    await Bun.write(filePath, content);
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
    return ["Task", "Story", "Bug", "Epic"];
  }
}
