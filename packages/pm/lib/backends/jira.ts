import { JiraClient } from "@devintern/task-trackers";
import type { CreatedTask, LabelListResult, ProjectInfo, TaskBackend } from "./types";

/**
 * Jira backend adapter.
 *
 * @see {@link JiraClient} for REST API implementation details.
 */
export class JiraBackend implements TaskBackend {
  readonly name = "Jira";
  readonly supportsIssueTypes = true;
  readonly supportsEpicLinking = true;
  readonly supportsLabels = true;
  readonly supportsFreeformLabels = false;
  readonly supportsAttachments = true;
  private client: JiraClient;

  /**
   * Create a Jira backend from connection and default project settings.
   *
   * @param config - Jira domain, credentials, and default project key.
   */
  constructor(config: {
    domain: string;
    email: string;
    apiToken: string;
    defaultProjectKey: string;
    verbose?: boolean;
  }) {
    this.client = new JiraClient({
      domain: config.domain,
      email: config.email,
      apiToken: config.apiToken,
      defaultProjectKey: config.defaultProjectKey,
      verbose: config.verbose,
    });
  }

  /**
   * Create a Jira issue (story, task, bug, etc.).
   *
   * @param summary - Issue title.
   * @param description - Issue body (converted to ADF internally).
   * @param issueType - Jira issue type name (e.g. `Story`).
   * @param projectKey - Optional project key; defaults to configured project.
   * @returns Created issue key and browse URL.
   * @throws When the Jira API request fails.
   */
  async createTask(
    summary: string,
    description: string,
    issueType: string,
    projectKey?: string,
  ): Promise<CreatedTask> {
    return this.client.createStory(summary, description, issueType, projectKey);
  }

  /**
   * Create a Jira subtask under a parent issue.
   *
   * @param parentKey - Parent issue key (e.g. `PROJ-123`).
   * @param summary - Subtask title.
   * @param description - Optional subtask body.
   * @param projectKey - Optional project key; defaults to configured project.
   * @returns Created subtask key and browse URL.
   * @throws When the Jira API request fails.
   */
  async createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    projectKey?: string,
  ): Promise<CreatedTask> {
    return this.client.createSubtask(parentKey, summary, description, projectKey);
  }

  /**
   * Link a story to an epic by setting the parent field.
   *
   * @param storyKey - Child issue key.
   * @param epicKey - Epic issue key.
   * @throws When the Jira API request fails.
   */
  async linkToEpic(storyKey: string, epicKey: string): Promise<void> {
    return this.client.linkToEpic(storyKey, epicKey);
  }

  /**
   * List Jira projects accessible to the authenticated user.
   *
   * @returns Project key/name pairs for interactive selection.
   * @throws When the Jira API request fails.
   */
  async getProjects(): Promise<ProjectInfo[]> {
    const projects = await this.client.getProjects();
    return projects.map((p) => ({ key: p.key, name: p.name }));
  }

  /**
   * List non-subtask issue types for a project.
   *
   * @param projectKey - Optional project key; defaults to configured project.
   * @returns Issue type display names.
   * @throws When the Jira API request fails.
   */
  async getIssueTypes(projectKey?: string): Promise<string[]> {
    const types = await this.client.getIssueTypes(projectKey);
    return types.map((t) => t.name);
  }

  /**
   * List existing global Jira labels.
   *
   * @returns Label refs keyed by name, plus whether the soft cap truncated.
   * @throws When the Jira API request fails.
   */
  async getLabels(
    _projectKey?: string,
    options?: { maxLabels?: number },
  ): Promise<LabelListResult> {
    const result = await this.client.getLabels(options?.maxLabels);
    return {
      labels: result.labels.map((name) => ({ id: name, name })),
      truncated: result.truncated,
    };
  }

  /**
   * Set labels on a created Jira issue.
   *
   * Callers (engine) must pass names from {@link getLabels}; unknown names are
   * rejected before this method runs so Jira cannot auto-create labels.
   *
   * @param taskKey - Issue key (e.g. `PROJ-123`).
   * @param labelIds - Existing label names to apply.
   * @throws When the Jira API request fails.
   */
  async applyLabels(taskKey: string, labelIds: string[]): Promise<void> {
    if (labelIds.length === 0) return;
    await this.client.setLabels(taskKey, labelIds);
  }

  /**
   * Upload a local file onto a Jira issue.
   *
   * @param taskKey - Issue key (e.g. `PROJ-123`).
   * @param filePath - Absolute path to the local file.
   * @param options - Optional filename / MIME overrides.
   */
  async uploadAttachment(
    taskKey: string,
    filePath: string,
    options?: { filename?: string; mimeType?: string },
  ): Promise<void> {
    await this.client.uploadAttachment(taskKey, filePath, options);
  }
}
