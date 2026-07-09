/**
 * GitHub REST API client for Issues
 *
 * API docs:
 * - Create issue: https://docs.github.com/en/rest/issues/issues#create-an-issue
 * - Get issue: https://docs.github.com/en/rest/issues/issues#get-an-issue
 * - Update issue: https://docs.github.com/en/rest/issues/issues#update-an-issue
 * - List repositories: https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user
 * - List repository labels: https://docs.github.com/en/rest/issues/labels#list-labels-for-a-repository
 */

export interface GitHubIssue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state?: "open" | "closed";
  labels?: Array<{ name: string }>;
  assignee?: { login: string } | null;
  user?: { login: string } | null;
  created_at?: string;
  updated_at?: string;
}

export interface GitHubIssueComment {
  id: number;
  /** Comment body in markdown. */
  body: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
}

export interface GitHubLabel {
  name: string;
  description: string | null;
}

export class GitHubClient {
  private token: string;
  private owner: string;
  private repo: string;
  private baseUrl = "https://api.github.com";

  /**
   * Create a GitHub REST API client for a single repository.
   *
   * @param config - PAT and target `owner`/`repo`.
   */
  constructor(config: { token: string; owner: string; repo: string }) {
    this.token = config.token;
    this.owner = config.owner;
    this.repo = config.repo;
  }

  /**
   * Send an authenticated request to the GitHub REST API.
   *
   * @param endpoint - API path (e.g. `/repos/owner/repo/issues`).
   * @param method - HTTP method (default `GET`).
   * @param body - Optional JSON request body.
   * @returns Parsed JSON response body.
   * @throws When the response status is not OK.
   */
  private async request<T>(
    endpoint: string,
    method: string = "GET",
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const options: RequestInit = { method, headers };

    if (body && method !== "GET") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${errorText}`);
    }

    return response.json() as T;
  }

  /**
   * Create an issue in the configured repository.
   *
   * @param title - Issue title.
   * @param body - Issue body (markdown).
   * @param labels - Optional label names to apply.
   * @returns Created issue number, URL, title, and body.
   * @throws When the GitHub API request fails.
   */
  async createIssue(title: string, body: string, labels?: string[]): Promise<GitHubIssue> {
    const data: Record<string, unknown> = {
      title,
      body,
    };

    if (labels && labels.length > 0) {
      data.labels = labels;
    }

    return this.request<GitHubIssue>(`/repos/${this.owner}/${this.repo}/issues`, "POST", data);
  }

  /**
   * Fetch an issue by number.
   *
   * @param issueNumber - Issue number in the configured repo.
   * @returns Issue metadata.
   * @throws When the issue is not found or the API request fails.
   */
  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}`);
  }

  /**
   * Partially update an existing issue.
   *
   * @param issueNumber - Issue number to update.
   * @param updates - Fields to patch (title, body, labels).
   * @returns Updated issue metadata.
   * @throws When the GitHub API request fails.
   */
  async updateIssue(
    issueNumber: number,
    updates: {
      title?: string;
      body?: string;
      labels?: string[];
      state?: "open" | "closed";
    },
  ): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
      "PATCH",
      updates,
    );
  }

  /**
   * Create a sub-issue and append a task-list reference on the parent issue.
   *
   * @param parentNumber - Parent issue number.
   * @param title - Sub-issue title.
   * @param description - Optional sub-issue body.
   * @returns Created sub-issue metadata.
   * @throws When issue creation or parent update fails.
   */
  async createSubtask(
    parentNumber: number,
    title: string,
    description?: string,
  ): Promise<GitHubIssue> {
    // Create the subtask as a new issue
    const subtask = await this.createIssue(title, description || "");

    // Add a task list item to the parent issue body
    const parent = await this.getIssue(parentNumber);
    const parentBody = parent.body || "";
    const taskListItem = `- [ ] #${subtask.number}`;

    // Check if there's already a subtasks section
    const subtasksHeader = "## Subtasks";
    let newBody: string;

    if (parentBody.includes(subtasksHeader)) {
      // Append to existing subtasks section
      newBody = parentBody.replace(subtasksHeader, `${subtasksHeader}\n${taskListItem}`);
    } else {
      // Add new subtasks section
      newBody = parentBody
        ? `${parentBody}\n\n${subtasksHeader}\n${taskListItem}`
        : `${subtasksHeader}\n${taskListItem}`;
    }

    await this.updateIssue(parentNumber, { body: newBody });

    return subtask;
  }

  /**
   * Add a `Part of #N` epic reference to an issue body (idempotent).
   *
   * @param issueNumber - Child issue number.
   * @param epicNumber - Epic issue number.
   * @throws When the GitHub API request fails.
   */
  async linkToEpic(issueNumber: number, epicNumber: number): Promise<void> {
    // Add a reference to the epic in the issue body
    const issue = await this.getIssue(issueNumber);
    const currentBody = issue.body || "";

    const epicReference = `Part of #${epicNumber}`;

    // Avoid duplicate references
    if (currentBody.includes(epicReference)) {
      return;
    }

    const newBody = currentBody ? `${currentBody}\n\n${epicReference}` : epicReference;

    await this.updateIssue(issueNumber, { body: newBody });
  }

  /**
   * List repositories for the authenticated user.
   *
   * @returns Up to 100 repository records.
   * @throws When the GitHub API request fails.
   */
  async getRepositories(): Promise<GitHubRepository[]> {
    return this.request<GitHubRepository[]>("/user/repos?per_page=100");
  }

  /**
   * List labels defined on the configured repository.
   *
   * @returns Up to 100 label records.
   * @throws When the GitHub API request fails.
   */
  async getLabels(): Promise<GitHubLabel[]> {
    return this.request<GitHubLabel[]>(`/repos/${this.owner}/${this.repo}/labels?per_page=100`);
  }

  /**
   * Add labels to an issue (does not remove existing labels).
   *
   * @param issueNumber - Target issue number.
   * @param labels - Label names to add.
   * @throws When the GitHub API request fails.
   */
  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.request(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels`, "POST", {
      labels,
    });
  }

  /**
   * List comments on an issue (oldest first).
   *
   * @param issueNumber - Target issue number.
   * @returns Up to 100 comment records.
   * @throws When the GitHub API request fails.
   */
  async listIssueComments(issueNumber: number): Promise<GitHubIssueComment[]> {
    return this.request<GitHubIssueComment[]>(
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments?per_page=100`,
    );
  }

  /**
   * Post a markdown comment on an issue.
   *
   * @param issueNumber - Target issue number.
   * @param body - Comment body (markdown).
   * @returns Created comment record.
   * @throws When the GitHub API request fails.
   */
  async createIssueComment(issueNumber: number, body: string): Promise<GitHubIssueComment> {
    return this.request<GitHubIssueComment>(
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`,
      "POST",
      { body },
    );
  }

  /**
   * Update an existing issue comment's markdown body.
   *
   * @param commentId - Comment id (not the issue number).
   * @param body - New comment body (markdown).
   * @throws When the GitHub API request fails.
   */
  async updateIssueComment(commentId: number, body: string): Promise<void> {
    await this.request(`/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`, "PATCH", {
      body,
    });
  }

  /**
   * Remove a label from an issue. Missing labels are ignored.
   *
   * @param issueNumber - Target issue number.
   * @param label - Label name to remove.
   * @throws When the GitHub API request fails for reasons other than 404.
   */
  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.request(
        `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
        "DELETE",
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) {
        return;
      }
      throw error;
    }
  }

  /**
   * Search issues using GitHub's issue search syntax.
   *
   * Query syntax: GitHub search qualifiers scoped to this repository, e.g.
   *   `is:open label:bug`
   *   `is:open assignee:@me`
   *   `is:open "some text"`
   *
   * The client automatically prepends `repo:<owner>/<repo> is:issue` unless
   * the query already contains a `repo:` qualifier, so callers only need to
   * supply additional filter qualifiers.
   *
   * Note: the search API is rate-limited to 30 requests/minute and returns at
   * most 100 results per page (only the first page is fetched).
   *
   * Full syntax: https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
   *
   * @param query - GitHub search qualifiers.
   * @returns Matching issues (first 100) and the total match count.
   * @throws When the GitHub API request fails.
   */
  async searchIssues(query: string): Promise<{ issues: GitHubIssue[]; total: number }> {
    const scoped = query.includes("repo:")
      ? query
      : `repo:${this.owner}/${this.repo} is:issue ${query}`.trim();

    const data = await this.request<{ total_count: number; items: GitHubIssue[] }>(
      `/search/issues?q=${encodeURIComponent(scoped)}&per_page=100`,
    );

    // The search endpoint also matches pull requests when `is:issue` is
    // overridden by the caller; filter anything carrying a pull_request key.
    const issues = data.items.filter(
      (item) => !("pull_request" in (item as unknown as Record<string, unknown>)),
    );

    return { issues, total: data.total_count };
  }
}
