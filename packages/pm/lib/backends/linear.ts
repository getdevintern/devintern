import { LinearClient } from "@devintern/task-trackers";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./types";

/**
 * Linear backend adapter.
 *
 * @see {@link LinearClient} for GraphQL API implementation details.
 */
export class LinearBackend implements TaskBackend {
  readonly name = "Linear";
  readonly supportsIssueTypes = false;
  readonly supportsEpicLinking = true;
  private client: LinearClient;
  private defaultTeamKey?: string;

  /**
   * Create a Linear backend from API credentials.
   *
   * @param config - Linear API key and optional default team key.
   */
  constructor(config: { apiKey: string; defaultTeamKey?: string }) {
    this.client = new LinearClient({
      apiKey: config.apiKey,
    });
    this.defaultTeamKey = config.defaultTeamKey;
  }

  /**
   * Resolve a Linear team ID from a team key or fall back to the first available team.
   *
   * @param projectKey - Optional team key override.
   * @returns Linear team UUID.
   * @throws When no teams exist in the workspace.
   */
  private async resolveTeamId(projectKey?: string): Promise<string> {
    const teamKey = projectKey || this.defaultTeamKey;
    let teamId: string | undefined;

    if (teamKey) {
      teamId = await this.client.getTeamIdByKey(teamKey);
    }

    if (!teamId) {
      const teams = await this.client.getTeams();
      if (teams.length === 0) {
        throw new Error("No Linear teams found. Please create a team first.");
      }
      teamId = teams[0]!.id;
    }

    return teamId;
  }

  /**
   * Create a Linear issue in the resolved team.
   *
   * @param summary - Issue title.
   * @param description - Issue body (markdown).
   * @param _issueType - Ignored; Linear does not use Jira-style issue types.
   * @param projectKey - Optional team key override.
   * @returns Created issue identifier and URL.
   * @throws When the Linear API request fails.
   */
  async createTask(
    summary: string,
    description: string,
    _issueType: string,
    projectKey?: string,
  ): Promise<CreatedTask> {
    const teamId = await this.resolveTeamId(projectKey);
    const issue = await this.client.createIssue(summary, description, teamId);

    return {
      key: issue.identifier,
      url: issue.url,
    };
  }

  /**
   * Create a Linear sub-issue under a parent issue.
   *
   * @param parentKey - Parent issue identifier (e.g. `ENG-42`).
   * @param summary - Sub-issue title.
   * @param description - Optional sub-issue body.
   * @param projectKey - Optional team key override.
   * @returns Created sub-issue identifier and URL.
   * @throws When the parent issue is not found or the API request fails.
   */
  async createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    projectKey?: string,
  ): Promise<CreatedTask> {
    const parentId = await this.client.getIssueIdByIdentifier(parentKey);
    if (!parentId) {
      throw new Error(`Parent issue not found: ${parentKey}`);
    }

    const teamId = await this.resolveTeamId(projectKey);
    const subIssue = await this.client.createSubIssue(parentId, summary, description || "", teamId);

    return {
      key: subIssue.identifier,
      url: subIssue.url,
    };
  }

  /**
   * Link an issue to a parent epic by updating the parent relationship.
   *
   * @param storyKey - Child issue identifier.
   * @param epicKey - Parent epic identifier.
   * @throws When either issue is not found or the API request fails.
   */
  async linkToEpic(storyKey: string, epicKey: string): Promise<void> {
    const storyId = await this.client.getIssueIdByIdentifier(storyKey);
    const epicId = await this.client.getIssueIdByIdentifier(epicKey);
    if (!storyId || !epicId) {
      throw new Error("Issue not found");
    }
    await this.client.linkToParent(storyId, epicId);
  }

  /**
   * List Linear teams as selectable projects.
   *
   * @returns Team key/name pairs.
   * @throws When the Linear API request fails.
   */
  async getProjects(): Promise<ProjectInfo[]> {
    const teams = await this.client.getTeams();
    return teams.map((t) => ({ key: t.key, name: t.name }));
  }

  /**
   * Return static issue-type labels for UI compatibility.
   *
   * @returns Default Linear-style type names (not enforced by the API).
   */
  async getIssueTypes(): Promise<string[]> {
    return ["Task", "Story", "Bug", "Epic", "Feature", "Improvement"];
  }
}
