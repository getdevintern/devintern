/**
 * GitLab REST API v4 client for Issues
 *
 * Works against GitLab Cloud (gitlab.com) and self-hosted instances: every
 * request goes through the instance base URL (`GITLAB_BASE_URL`, default
 * https://gitlab.com).
 *
 * API docs:
 * - Create issue: https://docs.gitlab.com/ee/api/issues.html#new-issue
 * - Get single issue: https://docs.gitlab.com/ee/api/issues.html#single-issue
 * - Edit issue: https://docs.gitlab.com/ee/api/issues.html#edit-issue
 * - List project issues: https://docs.gitlab.com/ee/api/issues.html#list-project-issues
 * - Comments (notes): https://docs.gitlab.com/ee/api/notes.html#list-project-issue-notes
 * - Labels: https://docs.gitlab.com/ee/api/labels.html#list-labels
 */

/** Default instance used when `GITLAB_BASE_URL` is unset. */
export const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com";

export interface GitLabIssue {
  id: number;
  /** Project-scoped issue number used in URLs and references. */
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  /** `opened` or `closed`. */
  state?: string;
  /** Label names (plain array; `with_labels_details` is not requested). */
  labels?: string[];
  author?: { username: string };
  assignees?: Array<{ username: string }>;
  created_at?: string;
  updated_at?: string;
  web_url: string;
  references?: { full: string };
}

export interface GitLabIssueComment {
  id: number;
  /** Comment body in markdown. */
  body: string;
  author: { username: string } | null;
  /** True for system-generated notes (status changes, assignments, …). */
  system?: boolean;
  created_at: string;
  updated_at: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  /** Full path including subgroups, e.g. `group/sub/repo`. */
  path_with_namespace: string;
}

export interface GitLabLabel {
  id: number;
  name: string;
  description: string | null;
}

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

export interface GitLabClientConfig {
  token: string;
  /** Project path with optional subgroups (`group/sub/repo`) or numeric id. */
  projectPath: string;
  /** Instance root (default {@link DEFAULT_GITLAB_BASE_URL}); no `/api/v4` suffix. */
  baseUrl?: string;
}

export class GitLabClient {
  private token: string;
  private projectPath: string;
  private baseUrl: string;
  private currentUser: GitLabUser | null = null;

  /**
   * Create a GitLab REST v4 client bound to one project.
   *
   * @param config - PAT, target project path/id, and optional instance base URL.
   */
  constructor(config: GitLabClientConfig) {
    this.token = config.token;
    this.projectPath = config.projectPath;
    this.baseUrl = (config.baseUrl?.trim() || DEFAULT_GITLAB_BASE_URL).replace(/\/+$/, "");
  }

  /**
   * Send an authenticated request to the GitLab REST API v4.
   *
   * @param endpoint - API path after `/api/v4` (e.g. `/projects/42/issues`).
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
    const url = `${this.baseUrl}/api/v4${endpoint}`;
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": this.token,
      Accept: "application/json",
    };

    const options: RequestInit = { method, headers };

    if (body && method !== "GET") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitLab API error (${response.status}): ${errorText}`);
    }

    return response.json() as T;
  }

  /**
   * Project-scoped API prefix with the URL-encoded project path/id.
   *
   * Subgroup paths (`group/sub/repo`) must be encoded with encodeURIComponent
   * so slashes become `%2F`.
   */
  private get projectEndpoint(): string {
    return `/projects/${encodeURIComponent(this.projectPath)}`;
  }

  /**
   * Fetch the authenticated user (used for `assignee:@me` queries).
   *
   * @returns Current user record (cached after the first call).
   * @throws When the token is invalid or the API request fails.
   */
  async getCurrentUser(): Promise<GitLabUser> {
    this.currentUser ??= await this.request<GitLabUser>("/user");
    return this.currentUser;
  }

  /**
   * Create an issue in the configured project.
   *
   * @param title - Issue title.
   * @param description - Issue body (markdown).
   * @param labels - Optional label names to apply.
   * @returns Created issue metadata.
   * @throws When the GitLab API request fails.
   */
  async createIssue(title: string, description: string, labels?: string[]): Promise<GitLabIssue> {
    const data: Record<string, unknown> = { title };

    // GitLab rejects empty-string descriptions on create; omit instead.
    if (description && description.trim()) {
      data.description = description;
    }
    if (labels && labels.length > 0) {
      data.labels = labels.join(",");
    }

    return this.request<GitLabIssue>(`${this.projectEndpoint}/issues`, "POST", data);
  }

  /**
   * Fetch an issue by project-scoped number (iid).
   *
   * @param issueIid - Issue iid in the configured project.
   * @returns Issue metadata.
   * @throws When the issue is not found or the API request fails.
   */
  async getIssue(issueIid: number): Promise<GitLabIssue> {
    return this.request<GitLabIssue>(`${this.projectEndpoint}/issues/${issueIid}`);
  }

  /**
   * Partially update an existing issue.
   *
   * @param issueIid - Issue iid to update.
   * @param updates - Fields to patch (title, description, labels, state).
   *   Passing `labels` replaces the full label set; use {@link addLabels} /
   *   {@link removeLabel} for additive edits. `state: "opened"` reopens a
   *   closed issue and `state: "closed"` closes an open one.
   * @returns Updated issue metadata.
   * @throws When the GitLab API request fails.
   */
  async updateIssue(
    issueIid: number,
    updates: {
      title?: string;
      description?: string;
      labels?: string[];
      state?: "opened" | "closed";
    },
  ): Promise<GitLabIssue> {
    const data: Record<string, unknown> = {};
    if (updates.title !== undefined) data.title = updates.title;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.labels) data.labels = updates.labels.join(",");
    if (updates.state === "closed") data.state_event = "close";
    if (updates.state === "opened") data.state_event = "reopen";

    return this.request<GitLabIssue>(`${this.projectEndpoint}/issues/${issueIid}`, "PUT", data);
  }

  /**
   * Create a sub-issue and append a task-list reference on the parent issue.
   *
   * @param parentIid - Parent issue iid.
   * @param title - Sub-issue title.
   * @param description - Optional sub-issue body.
   * @returns Created sub-issue metadata.
   * @throws When issue creation or parent update fails.
   */
  async createSubtask(
    parentIid: number,
    title: string,
    description?: string,
  ): Promise<GitLabIssue> {
    // Create the subtask as a new issue
    const subtask = await this.createIssue(title, description || "");

    // Add a task list item to the parent issue body
    const parent = await this.getIssue(parentIid);
    const parentBody = parent.description || "";
    const taskListItem = `- [ ] #${subtask.iid}`;

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

    await this.updateIssue(parentIid, { description: newBody });

    return subtask;
  }

  /**
   * Add a `Part of #N` epic reference to an issue body (idempotent).
   *
   * @param issueIid - Child issue iid.
   * @param epicIid - Epic issue iid.
   * @throws When the GitLab API request fails.
   */
  async linkToEpic(issueIid: number, epicIid: number): Promise<void> {
    // Add a reference to the epic in the issue body
    const issue = await this.getIssue(issueIid);
    const currentBody = issue.description || "";

    const epicReference = `Part of #${epicIid}`;

    // Avoid duplicate references
    if (currentBody.includes(epicReference)) {
      return;
    }

    const newBody = currentBody ? `${currentBody}\n\n${epicReference}` : epicReference;

    await this.updateIssue(issueIid, { description: newBody });
  }

  /**
   * List projects accessible to the authenticated user.
   *
   * @returns Up to 100 project records ordered by last activity.
   * @throws When the GitLab API request fails.
   */
  async getProjects(): Promise<GitLabProject[]> {
    return this.request<GitLabProject[]>(
      "/projects?membership=true&order_by=last_activity_at&per_page=100",
    );
  }

  /**
   * List labels defined on the configured project (paginated until exhausted or cap).
   *
   * Soft-capped at {@link maxLabels} (default 500). When `truncated` is true,
   * more labels may exist — validation of a selected set should page without
   * the cap rather than rejecting missing names as unknown.
   *
   * @param maxLabels - Soft upper bound on labels returned (default 500).
   * @returns Label records plus whether the soft cap truncated the catalog.
   * @throws When the GitLab API request fails.
   */
  async getLabels(maxLabels: number = 500): Promise<{ labels: GitLabLabel[]; truncated: boolean }> {
    const labels: GitLabLabel[] = [];
    // Keep per_page fixed: GitLab's `page` offset is relative to per_page, so
    // shrinking the last request would re-fetch earlier items.
    const pageSize = 100;
    let page = 1;
    let truncated = false;

    while (labels.length < maxLabels) {
      const batch = await this.request<GitLabLabel[]>(
        `${this.projectEndpoint}/labels?with_counts=false&per_page=${pageSize}&page=${page}`,
      );
      labels.push(...batch);
      if (batch.length < pageSize) {
        break;
      }
      page += 1;
      if (labels.length >= maxLabels) {
        // Full page hit the soft cap — probe one more page before claiming
        // truncation (exact multiples of pageSize would otherwise false-positive).
        const sentinel = await this.request<GitLabLabel[]>(
          `${this.projectEndpoint}/labels?per_page=${pageSize}&page=${page}`,
        );
        truncated = sentinel.length > 0;
        break;
      }
    }

    // A short final page can overshoot the soft cap before we break; slicing
    // must still report truncated so callers exhaust before treating misses as unknown.
    return {
      labels: labels.slice(0, maxLabels),
      truncated: truncated || labels.length > maxLabels,
    };
  }

  /**
   * Add labels to an issue (does not remove existing labels).
   *
   * @param issueIid - Target issue iid.
   * @param labels - Label names to add.
   * @throws When the GitLab API request fails.
   */
  async addLabels(issueIid: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.request(`${this.projectEndpoint}/issues/${issueIid}`, "PUT", {
      add_labels: labels.join(","),
    });
  }

  /**
   * Remove a label from an issue. Missing labels are ignored.
   *
   * @param issueIid - Target issue iid.
   * @param label - Label name to remove.
   * @throws When the GitLab API request fails for reasons other than 404.
   */
  async removeLabel(issueIid: number, label: string): Promise<void> {
    try {
      await this.request(`${this.projectEndpoint}/issues/${issueIid}`, "PUT", {
        remove_labels: label,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) {
        return;
      }
      throw error;
    }
  }

  /**
   * List comments (notes) on an issue (oldest first).
   *
   * System-generated notes (status changes, assignments, label edits) are
   * filtered out per page so callers see human comments only. Pagination runs
   * until exhausted so dedup checks never miss older comments on busy issues.
   *
   * @param issueIid - Target issue iid.
   * @returns All human comment records.
   * @throws When the GitLab API request fails.
   */
  async listIssueComments(issueIid: number): Promise<GitLabIssueComment[]> {
    const comments: GitLabIssueComment[] = [];
    // Keep per_page fixed: GitLab's `page` offset is relative to per_page, so
    // shrinking the last request would re-fetch earlier items.
    const pageSize = 100;
    let page = 1;

    while (true) {
      const batch = await this.request<GitLabIssueComment[]>(
        `${this.projectEndpoint}/issues/${issueIid}/notes?sort=asc&order_by=created_at&per_page=${pageSize}&page=${page}`,
      );
      comments.push(...batch.filter((note) => !note.system));
      if (batch.length < pageSize) {
        break;
      }
      page += 1;
    }

    return comments;
  }

  /**
   * Post a markdown comment on an issue.
   *
   * @param issueIid - Target issue iid.
   * @param body - Comment body (markdown).
   * @returns Created comment record.
   * @throws When the GitLab API request fails.
   */
  async createIssueComment(issueIid: number, body: string): Promise<GitLabIssueComment> {
    return this.request<GitLabIssueComment>(
      `${this.projectEndpoint}/issues/${issueIid}/notes`,
      "POST",
      { body },
    );
  }

  /**
   * Update an existing issue comment's markdown body.
   *
   * The Notes API is noteable-scoped, so the request must address both the
   * issue and the note: `PUT /projects/:id/issues/:iid/notes/:note_id`.
   *
   * @param issueIid - Issue iid the comment belongs to.
   * @param commentId - Note id (not the issue iid).
   * @param body - New comment body (markdown).
   * @throws When the GitLab API request fails.
   */
  async updateIssueComment(issueIid: number, commentId: number, body: string): Promise<void> {
    await this.request(`${this.projectEndpoint}/issues/${issueIid}/notes/${commentId}`, "PUT", {
      body,
    });
  }

  /**
   * Search issues in the configured project using GitHub-style qualifiers.
   *
   * Supported qualifiers (case-insensitive keys):
   *   `is:open` / `state:opened`     — open issues
   *   `is:closed` / `state:closed`   — closed issues
   *   `label:name`                   — repeatable; ANDed together
   *   `assignee:@me`                 — resolved to the token's username
   *   `assignee:username`            — single assignee username
   *   `updated:>=2026-01-01T00:00Z`  — updated_after filter
   * Anything else (quoted phrases supported) becomes a free-text `search`.
   *
   * Unlike GitHub's global search, results are always scoped to the
   * configured project; there is no `repo:` qualifier.
   *
   * @param query - Qualifier string (e.g. `is:open label:bug`).
   * @returns Matching issues (first 100) and the total match count.
   * @throws When the GitLab API request fails.
   */
  async searchIssues(query: string): Promise<{ issues: GitLabIssue[]; total: number }> {
    const params = new URLSearchParams();
    params.set("per_page", "100");

    const labels: string[] = [];
    const freeText: string[] = [];

    for (const token of tokenizeQuery(query)) {
      const colon = token.indexOf(":");
      const key = colon >= 0 ? token.slice(0, colon).toLowerCase() : "";
      const value = colon >= 0 ? token.slice(colon + 1) : "";
      switch (key) {
        case "is":
        case "state": {
          const lowered = value.toLowerCase();
          if (lowered === "open" || lowered === "opened") params.set("state", "opened");
          else if (lowered === "closed") params.set("state", "closed");
          else freeText.push(token);
          break;
        }
        case "label":
        case "labels":
          if (value) labels.push(stripQuotes(value));
          break;
        case "assignee":
        case "assigned": {
          const name = stripQuotes(value);
          if (!name) break;
          const username =
            name.toLowerCase() === "@me" ? (await this.getCurrentUser()).username : name;
          params.set("assignee_username", username);
          break;
        }
        case "updated": {
          // GitHub syntax: updated:>=<date>
          const match = value.match(/^>=\s*(.+)$/);
          const iso = match ? match[1] : value;
          if (iso) params.set("updated_after", normalizeIsoDate(iso));
          break;
        }
        case "updated_after":
          if (value) params.set("updated_after", normalizeIsoDate(value));
          break;
        default:
          freeText.push(token);
      }
    }

    if (labels.length > 0) {
      params.set("labels", labels.join(","));
    }
    if (freeText.length > 0) {
      params.set("search", freeText.map(stripQuotes).join(" ").trim());
    }

    const url = `${this.baseUrl}/api/v4${this.projectEndpoint}/issues?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { "PRIVATE-TOKEN": this.token, Accept: "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitLab API error (${response.status}): ${errorText}`);
    }

    const issues = (await response.json()) as GitLabIssue[];
    // X-Total carries the unpaginated match count; missing on some proxies.
    const totalHeader = response.headers.get("x-total");
    const total = Number.parseInt(totalHeader ?? "", 10);

    return { issues, total: Number.isFinite(total) ? total : issues.length };
  }
}

/**
 * Tokenize a query string on whitespace while keeping quoted phrases intact,
 * including qualifiers attached to them (e.g. `is:open "login flow"`
 * `label:"needs review"`).
 */
function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  const pattern = /(?:[^\s":]+:)?"[^"]*"|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

/**
 * Normalize a date literal to the ISO-8601 form GitLab expects.
 * Bare dates (`2026-01-31`) pass through unchanged; other values are parsed
 * and re-serialized, falling back to the input when unparseable.
 */
function normalizeIsoDate(value: string): string {
  const trimmed = stripQuotes(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
}
