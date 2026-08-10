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

/** Existing tracker label available for selection when creating a ticket. */
export interface LabelRef {
  /**
   * Tracker-native identifier used when applying the label.
   * For name-keyed trackers (Jira, GitHub) this equals {@link name}.
   */
  id: string;
  /** Human-readable label name shown in the UI. */
  name: string;
}

/** Result of listing tracker labels, including soft-cap truncation. */
export interface LabelListResult {
  labels: LabelRef[];
  /**
   * True when listing stopped at the soft catalog cap while more labels may
   * exist upstream (picker is incomplete; create-time validation must not
   * treat missing ids as unknown without an exhaustive check).
   */
  truncated: boolean;
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
  /**
   * Whether the tracker can list existing labels and apply them to created
   * tickets via {@link getLabels} / {@link applyLabels}. When true,
   * {@link getLabels} must be implemented (enforced by createBackend).
   */
  readonly supportsLabels: boolean;
  /**
   * Whether callers may invent label names that are not in {@link getLabels}.
   *
   * Remote trackers that auto-create on write (Jira/GitHub) keep this `false`
   * so the engine allowlists against the catalog. Local markdown sets `true`
   * so frontmatter labels need no prior seeding.
   */
  readonly supportsFreeformLabels: boolean;
  /**
   * Whether the tracker can upload local files onto a created ticket via
   * {@link uploadAttachment}. When true, `uploadAttachment` must be implemented.
   */
  readonly supportsAttachments: boolean;

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

  /**
   * List existing labels for the current project/repo/board/team context.
   *
   * @param projectKey - Optional project/team/board override.
   * @param options.maxLabels - Soft catalog cap (default 500). Pass
   *   `Number.POSITIVE_INFINITY` to page until exhausted (create-time checks).
   */
  getLabels?(projectKey?: string, options?: { maxLabels?: number }): Promise<LabelListResult>;

  /**
   * Apply existing labels to a created ticket.
   *
   * @param taskKey - Tracker key returned from {@link createTask}.
   * @param labelIds - Label ids from {@link LabelRef.id} (names for Jira/GitHub).
   */
  applyLabels?(taskKey: string, labelIds: string[]): Promise<void>;

  /**
   * Upload a local file onto an existing ticket.
   *
   * @param taskKey - Tracker key returned from {@link createTask}.
   * @param filePath - Absolute path to the local file.
   * @param options - Optional filename / MIME overrides.
   */
  uploadAttachment?(
    taskKey: string,
    filePath: string,
    options?: { filename?: string; mimeType?: string },
  ): Promise<void>;
}
