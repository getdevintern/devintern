/**
 * Task backend abstraction for @devintern/pm
 * Supports multiple task trackers: Jira, Markdown files, and future services.
 */

export interface CreatedTask {
  key: string;
  url: string;
}

export interface ProjectInfo {
  key: string;
  name: string;
}

export interface TaskBackend {
  readonly name: string;
  readonly supportsIssueTypes: boolean;
  /**
   * Whether the tracker can persist a real epic/parent link via {@link linkToEpic}.
   *
   * `false` for trackers that only fake the relationship (e.g. an attachment,
   * a text reference, or a local frontmatter note). When `false`, the epic
   * linking step is skipped in interactive mode and no link is attempted.
   */
  readonly supportsEpicLinking: boolean;

  createTask(
    summary: string,
    description: string,
    issueType: string,
    projectKey?: string,
  ): Promise<CreatedTask>;

  createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    projectKey?: string,
  ): Promise<CreatedTask>;

  linkToEpic?(storyKey: string, epicKey: string): Promise<void>;

  getProjects?(): Promise<ProjectInfo[]>;

  getIssueTypes?(projectKey?: string): Promise<string[]>;
}
