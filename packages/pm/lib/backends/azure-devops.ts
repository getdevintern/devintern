import { AzureDevOpsClient } from "@devintern/task-trackers";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./types";

/**
 * Azure DevOps backend adapter.
 *
 * @see {@link AzureDevOpsClient} for REST API implementation details.
 */
export class AzureDevOpsBackend implements TaskBackend {
  readonly name = "Azure DevOps";
  readonly supportsIssueTypes = true;
  readonly supportsEpicLinking = true;
  private client: AzureDevOpsClient;
  private defaultProject: string;

  /**
   * Create an Azure DevOps backend from organization credentials.
   *
   * @param config - Organization, PAT, and default project name.
   */
  constructor(config: { organization: string; pat: string; defaultProject: string }) {
    this.client = new AzureDevOpsClient({
      organization: config.organization,
      pat: config.pat,
      defaultProject: config.defaultProject,
    });
    this.defaultProject = config.defaultProject;
  }

  /**
   * Create a work item in Azure DevOps.
   *
   * @param summary - Work item title.
   * @param description - Work item body (markdown converted to HTML).
   * @param issueType - Work item type name (e.g. `User Story`).
   * @param projectKey - Optional project name override.
   * @returns Numeric work item ID and edit URL.
   * @throws When the Azure DevOps API request fails.
   */
  async createTask(
    summary: string,
    description: string,
    issueType: string,
    projectKey?: string,
  ): Promise<CreatedTask> {
    const workItem = await this.client.createWorkItem(summary, description, issueType, projectKey);

    return {
      key: String(workItem.id),
      url: workItem.url,
    };
  }

  /**
   * Create a child Task work item linked to a parent.
   *
   * @param parentKey - Parent work item ID as string.
   * @param summary - Subtask title.
   * @param description - Optional subtask body.
   * @param projectKey - Optional project name override.
   * @returns Created work item ID and URL.
   * @throws When the parent is not found or the API request fails.
   */
  async createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    projectKey?: string,
  ): Promise<CreatedTask> {
    const parentId = await this.client.getWorkItemIdByKey(parentKey);
    if (!parentId) {
      throw new Error(`Parent work item not found: ${parentKey}`);
    }

    const subtask = await this.client.createSubtask(parentId, summary, description, projectKey);

    return {
      key: String(subtask.id),
      url: subtask.url,
    };
  }

  /**
   * Link a work item to a parent epic via hierarchy relation.
   *
   * @param storyKey - Child work item ID as string.
   * @param epicKey - Parent epic work item ID as string.
   * @throws When either work item is not found or linking fails.
   */
  async linkToEpic(storyKey: string, epicKey: string): Promise<void> {
    const storyId = await this.client.getWorkItemIdByKey(storyKey);
    const epicId = await this.client.getWorkItemIdByKey(epicKey);

    if (!storyId || !epicId) {
      throw new Error("Work item not found");
    }

    await this.client.linkToParent(storyId, epicId);
  }

  /**
   * List Azure DevOps projects in the organization.
   *
   * @returns Project name pairs (key and name are both project name).
   * @throws When the Azure DevOps API request fails.
   */
  async getProjects(): Promise<ProjectInfo[]> {
    const projects = await this.client.getProjects();
    return projects.map((p) => ({ key: p.name, name: p.name }));
  }

  /**
   * List work item types defined for a project.
   *
   * @param projectKey - Optional project name override.
   * @returns Work item type display names.
   * @throws When the Azure DevOps API request fails.
   */
  async getIssueTypes(projectKey?: string): Promise<string[]> {
    const types = await this.client.getWorkItemTypes(projectKey);
    return types.map((t) => t.name);
  }
}
