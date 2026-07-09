import { AsanaClient } from "@devintern/task-trackers";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./types";

/**
 * Asana backend adapter.
 *
 * @see {@link AsanaClient} for REST API implementation details.
 */
export class AsanaBackend implements TaskBackend {
  readonly name = "Asana";
  readonly supportsIssueTypes = false;
  readonly supportsEpicLinking = true;
  private client: AsanaClient;
  private defaultProjectGid?: string;

  /**
   * Create an Asana backend from API credentials.
   *
   * @param config - Personal access token and optional default project GID.
   */
  constructor(config: { apiToken: string; defaultProjectGid?: string }) {
    this.client = new AsanaClient({
      apiToken: config.apiToken,
    });
    this.defaultProjectGid = config.defaultProjectGid;
  }

  /**
   * Resolve project GID from override or configured default.
   *
   * @param projectKey - Optional project GID override.
   * @returns Project GID or `undefined` for workspace-level tasks.
   */
  private async resolveProjectGid(projectKey?: string): Promise<string | undefined> {
    if (projectKey) {
      return projectKey;
    }
    return this.defaultProjectGid;
  }

  /**
   * Create an Asana task, optionally in a project.
   *
   * @param summary - Task name.
   * @param description - Task notes (markdown converted to HTML when supported).
   * @param _issueType - Ignored; Asana does not use Jira-style issue types.
   * @param projectKey - Optional project GID override.
   * @returns Task GID and permalink URL.
   * @throws When the Asana API request fails.
   */
  async createTask(
    summary: string,
    description: string,
    _issueType: string,
    projectKey?: string,
  ): Promise<CreatedTask> {
    const projectGid = await this.resolveProjectGid(projectKey);
    const task = await this.client.createTask(summary, description, projectGid);

    return {
      key: task.gid,
      url: task.permalink_url,
    };
  }

  /**
   * Create an Asana subtask under a parent task.
   *
   * @param parentKey - Parent task GID.
   * @param summary - Subtask name.
   * @param description - Optional subtask notes.
   * @param _projectKey - Ignored for subtasks.
   * @returns Subtask GID and permalink URL.
   * @throws When the parent task is not found or creation fails.
   */
  async createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    _projectKey?: string,
  ): Promise<CreatedTask> {
    // Verify parent exists
    try {
      await this.client.getTask(parentKey);
    } catch {
      throw new Error(`Parent task not found: ${parentKey}`);
    }

    const subtask = await this.client.createSubtask(parentKey, summary, description);

    return {
      key: subtask.gid,
      url: subtask.permalink_url,
    };
  }

  /**
   * Set a task's parent to link it under an epic task.
   *
   * @param storyKey - Child task GID.
   * @param epicKey - Parent epic task GID.
   * @throws When the Asana API request fails.
   */
  async linkToEpic(storyKey: string, epicKey: string): Promise<void> {
    await this.client.setParent(storyKey, epicKey);
  }

  /**
   * List Asana projects accessible to the token.
   *
   * @returns Project GID/name pairs.
   * @throws When the Asana API request fails.
   */
  async getProjects(): Promise<ProjectInfo[]> {
    const projects = await this.client.getProjects();
    return projects.map((p) => ({ key: p.gid, name: p.name }));
  }

  /**
   * Return static issue-type labels for UI compatibility.
   *
   * @returns Default Asana-oriented type names.
   */
  async getIssueTypes(): Promise<string[]> {
    return ["Task", "Milestone"];
  }
}
