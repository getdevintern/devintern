import { GitLabClient } from "@devintern/task-trackers";
import { DEFAULT_ISSUE_TYPES } from "../issue-types.js";
import type { CreatedTask, LabelListResult, ProjectInfo, TaskBackend } from "./types";

/**
 * GitLab backend adapter (gitlab.com and self-hosted instances).
 *
 * @see {@link GitLabClient} for REST API implementation details.
 */
export class GitLabBackend implements TaskBackend {
  readonly name = "GitLab";
  readonly supportsIssueTypes = true;
  // Project issues have no native epic hierarchy; linkToEpic only adds a
  // "Part of #N" text reference, so epic linking is treated as unsupported.
  readonly supportsEpicLinking = false;
  readonly supportsLabels = true;
  readonly supportsFreeformLabels = false;
  /** Issue notes carry no first-class local-file upload API in this integration. */
  readonly supportsAttachments = false;
  private client: GitLabClient;

  /**
   * Create a GitLab backend for one project on an instance.
   *
   * @param config - PAT, project path/id, and instance base URL.
   */
  constructor(config: { token: string; projectPath: string; baseUrl: string }) {
    this.client = new GitLabClient({
      token: config.token,
      projectPath: config.projectPath,
      baseUrl: config.baseUrl,
    });
  }

  /**
   * Create a GitLab issue with optional type-to-label mapping.
   *
   * @param summary - Issue title.
   * @param description - Issue body (markdown).
   * @param issueType - Logical type mapped to labels (`Story` → `enhancement`, etc.).
   * @param _projectKey - Ignored; backend is bound to one project.
   * @returns Issue iid and web URL.
   * @throws When the GitLab API request fails.
   */
  async createTask(
    summary: string,
    description: string,
    issueType: string,
    _projectKey?: string,
  ): Promise<CreatedTask> {
    const labels: string[] = [];

    // Map common issue types to GitLab labels
    const labelMap: Record<string, string> = {
      Story: "enhancement",
      Bug: "bug",
      Task: "task",
      Epic: "epic",
    };

    const mappedLabel = labelMap[issueType];
    if (mappedLabel) {
      labels.push(mappedLabel);
    }

    const issue = await this.client.createIssue(summary, description, labels);

    return {
      key: String(issue.iid),
      url: issue.web_url,
    };
  }

  /**
   * Create a sub-issue and append it to the parent's subtasks checklist.
   *
   * @param parentKey - Parent issue iid as string.
   * @param summary - Sub-issue title.
   * @param description - Optional sub-issue body.
   * @param _projectKey - Ignored.
   * @returns Sub-issue iid and web URL.
   * @throws When `parentKey` is not a valid issue iid or API calls fail.
   */
  async createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    _projectKey?: string,
  ): Promise<CreatedTask> {
    const parentIid = parseInt(parentKey, 10);
    if (isNaN(parentIid)) {
      throw new Error(`Invalid parent issue number: ${parentKey}`);
    }

    const subtask = await this.client.createSubtask(parentIid, summary, description);

    return {
      key: String(subtask.iid),
      url: subtask.web_url,
    };
  }

  /**
   * Add an epic reference (`Part of #N`) to the issue body.
   *
   * @param storyKey - Child issue iid as string.
   * @param epicKey - Epic issue iid as string.
   * @throws When either key is not a valid issue iid or update fails.
   */
  async linkToEpic(storyKey: string, epicKey: string): Promise<void> {
    const storyIid = parseInt(storyKey, 10);
    const epicIid = parseInt(epicKey, 10);

    if (isNaN(storyIid) || isNaN(epicIid)) {
      throw new Error("Invalid issue number");
    }

    await this.client.linkToEpic(storyIid, epicIid);
  }

  /**
   * List projects accessible to the authenticated user.
   *
   * @returns Full path (`group/sub/repo`) and display name pairs.
   * @throws When the GitLab API request fails.
   */
  async getProjects(): Promise<ProjectInfo[]> {
    const projects = await this.client.getProjects();
    return projects.map((p) => ({
      key: p.path_with_namespace,
      name: p.name,
    }));
  }

  /**
   * Return static issue-type names for UI compatibility.
   *
   * @returns Default GitLab-oriented type names.
   */
  async getIssueTypes(): Promise<string[]> {
    return [...DEFAULT_ISSUE_TYPES];
  }

  /**
   * List labels defined on the configured project.
   *
   * @returns Label refs keyed by name (GitLab uses names as ids), plus truncation.
   * @throws When the GitLab API request fails.
   */
  async getLabels(
    _projectKey?: string,
    options?: { maxLabels?: number },
  ): Promise<LabelListResult> {
    const result = await this.client.getLabels(options?.maxLabels);
    return {
      labels: result.labels.map((label) => ({ id: label.name, name: label.name })),
      truncated: result.truncated,
    };
  }

  /**
   * Add labels to an issue without removing existing ones.
   *
   * Callers (engine) must pass names from {@link getLabels}; unknown names are
   * rejected before this method runs so GitLab cannot auto-create labels.
   *
   * @param taskKey - Issue iid as string.
   * @param labelIds - Existing label names to add.
   * @throws When `taskKey` is not a valid issue iid or the API request fails.
   */
  async applyLabels(taskKey: string, labelIds: string[]): Promise<void> {
    if (labelIds.length === 0) return;
    const issueIid = parseInt(taskKey, 10);
    if (isNaN(issueIid)) {
      throw new Error(`Invalid issue number: ${taskKey}`);
    }
    await this.client.addLabels(issueIid, labelIds);
  }
}
