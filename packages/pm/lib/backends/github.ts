import { GitHubClient } from "@devintern/task-trackers";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./types";

/**
 * GitHub Issues backend adapter.
 *
 * @see {@link GitHubClient} for REST API implementation details.
 */
export class GitHubBackend implements TaskBackend {
  readonly name = "GitHub";
  readonly supportsIssueTypes = true;
  // GitHub Issues has no native epic hierarchy; linkToEpic only adds a
  // "Part of #N" text reference, so epic linking is treated as unsupported.
  readonly supportsEpicLinking = false;
  private client: GitHubClient;

  /**
   * Create a GitHub Issues backend for a single repository.
   *
   * @param config - PAT and target `owner`/`repo`.
   */
  constructor(config: { token: string; owner: string; repo: string }) {
    this.client = new GitHubClient({
      token: config.token,
      owner: config.owner,
      repo: config.repo,
    });
  }

  /**
   * Create a GitHub issue with optional type-to-label mapping.
   *
   * @param summary - Issue title.
   * @param description - Issue body (markdown).
   * @param issueType - Logical type mapped to labels (`Story` → `enhancement`, etc.).
   * @param _projectKey - Ignored; backend is bound to one repo.
   * @returns Issue number and HTML URL.
   * @throws When the GitHub API request fails.
   */
  async createTask(
    summary: string,
    description: string,
    issueType: string,
    _projectKey?: string,
  ): Promise<CreatedTask> {
    const labels: string[] = [];

    // Map common issue types to GitHub labels
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
      key: String(issue.number),
      url: issue.html_url,
    };
  }

  /**
   * Create a sub-issue and append it to the parent's subtasks checklist.
   *
   * @param parentKey - Parent issue number as string.
   * @param summary - Sub-issue title.
   * @param description - Optional sub-issue body.
   * @param _projectKey - Ignored.
   * @returns Sub-issue number and HTML URL.
   * @throws When `parentKey` is not a valid issue number or API calls fail.
   */
  async createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    _projectKey?: string,
  ): Promise<CreatedTask> {
    const parentNumber = parseInt(parentKey, 10);
    if (isNaN(parentNumber)) {
      throw new Error(`Invalid parent issue number: ${parentKey}`);
    }

    const subtask = await this.client.createSubtask(parentNumber, summary, description);

    return {
      key: String(subtask.number),
      url: subtask.html_url,
    };
  }

  /**
   * Add an epic reference (`Part of #N`) to the issue body.
   *
   * @param storyKey - Child issue number as string.
   * @param epicKey - Epic issue number as string.
   * @throws When either key is not a valid issue number or update fails.
   */
  async linkToEpic(storyKey: string, epicKey: string): Promise<void> {
    const storyNumber = parseInt(storyKey, 10);
    const epicNumber = parseInt(epicKey, 10);

    if (isNaN(storyNumber) || isNaN(epicNumber)) {
      throw new Error("Invalid issue number");
    }

    await this.client.linkToEpic(storyNumber, epicNumber);
  }

  /**
   * List repositories accessible to the authenticated user.
   *
   * @returns Repository full name and display name pairs.
   * @throws When the GitHub API request fails.
   */
  async getProjects(): Promise<ProjectInfo[]> {
    const repos = await this.client.getRepositories();
    return repos.map((r) => ({
      key: r.full_name,
      name: r.name,
    }));
  }

  /**
   * Return static issue-type labels for UI compatibility.
   *
   * @returns Default GitHub-oriented type names.
   */
  async getIssueTypes(): Promise<string[]> {
    return ["Task", "Story", "Bug", "Epic"];
  }
}
