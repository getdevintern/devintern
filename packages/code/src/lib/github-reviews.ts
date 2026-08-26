/**
 * GitHub Reviews API Client
 *
 * Handles fetching and responding to PR review comments via the GitHub API.
 */

import type { GitHubReviewComment, ProcessedReviewComment } from "../types/github-webhooks";
import { GitHubAppAuth } from "./github-app-auth";
import { Utils } from "./utils";

export interface ReviewsClientConfig {
  token?: string;
  appAuth?: GitHubAppAuth;
  /**
   * Prefer GitHub App auth over a personal access token when both are
   * available. Used by the webhook server so the bot identity resolves
   * (`slug[bot]`), which is required for @mention matching and bot-attributed
   * commits. Default behavior (CLI) keeps the token taking precedence.
   */
  preferAppAuth?: boolean;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  head: {
    ref: string;
    sha: string;
    /** Head repository; differs from the base repo for fork PRs. */
    repo?: { full_name: string } | null;
  };
  base: {
    ref: string;
    sha: string;
  };
  html_url: string;
  /** Whether maintainers may push to a fork PR's branch. */
  maintainer_can_modify?: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
}

/** Actions check run on a commit (subset of the API shape the watcher needs). */
export interface CheckRunSummary {
  id: number;
  name: string;
  /** `queued`, `in_progress`, or `completed`. */
  status: string;
  /** Terminal outcome; null while the run is still executing. */
  conclusion: string | null;
  html_url?: string;
  details_url?: string;
  /** The workflow run this check belongs to (for job/log lookup). */
  check_suite?: { id: number };
}

/** Classic commit status (non-Actions CI reporter). */
export interface CombinedStatus {
  state: "error" | "failure" | "pending" | "success";
  total_count: number;
  statuses: Array<{
    id: number;
    state: string;
    context?: string;
    target_url?: string | null;
    description?: string | null;
  }>;
}

/** One job of an Actions workflow run. */
export interface ActionJob {
  id: number;
  run_id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** Download URL for the job's log archive. */
  logs_url?: string;
  steps?: Array<{
    name: string;
    number: number;
    conclusion: string | null;
  }>;
}

/** Actions workflow run associated with a commit SHA (subset). */
export interface WorkflowRunSummary {
  id: number;
  name?: string;
  status?: string;
  conclusion: string | null;
}

/** Annotation attached to a check run (log-download fallback). */
export interface CheckAnnotation {
  path?: string;
  start_line?: number;
  message: string;
  annotation_level?: string;
}

/**
 * Client for interacting with GitHub's PR review APIs.
 */
export class GitHubReviewsClient {
  private baseUrl = "https://api.github.com";
  private token?: string;
  private appAuth?: GitHubAppAuth;

  /**
   * Create a GitHub reviews API client.
   *
   * @param config - Optional PAT or GitHub App auth (falls back to env)
   */
  constructor(config: ReviewsClientConfig = {}) {
    if (config.preferAppAuth) {
      // App-first: use GitHub App auth when available, falling back to a token
      // only if no App credentials are configured. The two are kept mutually
      // exclusive so getToken() routes through the App.
      this.appAuth = config.appAuth ?? GitHubAppAuth.fromEnvironment() ?? undefined;
      if (!this.appAuth) {
        this.token = config.token || process.env.GITHUB_TOKEN;
      }
      return;
    }

    // Default (token-first) behavior.
    this.token = config.token || process.env.GITHUB_TOKEN;
    this.appAuth = config.appAuth;

    // Try to initialize app auth from environment if no token provided
    if (!this.token && !this.appAuth) {
      this.appAuth = GitHubAppAuth.fromEnvironment() ?? undefined;
    }
  }

  /**
   * Resolve a bearer token for API requests to a repository.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns GitHub API bearer token
   * @throws When no auth is configured
   */
  private async getToken(owner: string, repo: string): Promise<string> {
    if (this.token) {
      return this.token;
    }

    if (this.appAuth) {
      return await this.appAuth.getTokenForRepository(owner, repo);
    }

    throw new Error(
      "No GitHub authentication configured. Set GITHUB_TOKEN or configure GitHub App.",
    );
  }

  /**
   * Determine the bot username for the current auth mode.
   *
   * @param owner - Repository owner (unused for App auth)
   * @param repo - Repository name (unused for App auth)
   * @returns Bot login (e.g. `my-app[bot]`), or `null` for PAT/non-bot users
   */
  async getBotUsername(owner: string, repo: string): Promise<string | null> {
    try {
      // For GitHub App auth, get the app info directly
      if (this.appAuth) {
        const appInfo = await this.appAuth.getAppInfo();
        return `${appInfo.slug}[bot]`;
      }

      // For personal access tokens, try /user endpoint
      if (this.token) {
        const response = await Utils.fetchWithRetry(`${this.baseUrl}/user`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "devintern",
          },
        });

        if (!response.ok) {
          return null;
        }

        const user = (await response.json()) as { login: string; type: string };

        // Only return if it's a Bot type
        if (user.type === "Bot") {
          return user.login;
        }
      }

      return null;
    } catch (error) {
      // Failed to determine bot username, return null
      return null;
    }
  }

  /**
   * Make an authenticated GitHub REST request with retry on transient failures.
   *
   * @param method - HTTP method
   * @param path - API path including leading slash
   * @param owner - Repository owner (for token resolution)
   * @param repo - Repository name
   * @param body - Optional JSON request body
   * @returns Parsed JSON response
   * @throws When the API returns a non-OK status
   */
  private async apiRequest<T>(
    method: string,
    path: string,
    owner: string,
    repo: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getToken(owner, repo);
    const url = `${this.baseUrl}${path}`;

    const response = await Utils.fetchWithRetry(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "devintern",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({
        message: "Unknown error",
      }))) as { message?: string };
      throw new Error(
        `GitHub API error (${response.status}): ${error.message || response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Conditional GET with a stored ETag.
   *
   * A `304 Not Modified` response does not count against the GitHub rate
   * limit, which is what makes polling many PRs on a short interval cheap.
   *
   * @param path - API path (starting with `/repos/...`)
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param etag - ETag from the previous response, if any
   * @returns `notModified: true` (data null) on 304; otherwise the parsed
   *          body and the new ETag to store
   */
  async conditionalGet<T>(
    path: string,
    owner: string,
    repo: string,
    etag?: string,
  ): Promise<{ data: T | null; etag?: string; notModified: boolean }> {
    const token = await this.getToken(owner, repo);
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "devintern",
    };
    if (etag) {
      headers["If-None-Match"] = etag;
    }

    const response = await Utils.fetchWithRetry(url, { method: "GET", headers });

    if (response.status === 304) {
      return { data: null, etag, notModified: true };
    }

    if (!response.ok) {
      const error = (await response.json().catch(() => ({
        message: "Unknown error",
      }))) as { message?: string };
      throw new Error(
        `GitHub API error (${response.status}): ${error.message || response.statusText}`,
      );
    }

    return {
      data: (await response.json()) as T,
      etag: response.headers.get("etag") ?? undefined,
      notModified: false,
    };
  }

  /**
   * Fetch pull request metadata.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   */
  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo> {
    return this.apiRequest<PullRequestInfo>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
      owner,
      repo,
    );
  }

  /**
   * Fetch a user's permission level on a repository.
   *
   * Used to gate mention-triggered automation: only users who can push
   * (write/maintain/admin) may direct the agent.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param username - GitHub login to check
   * @returns `admin`, `write`, `read`, or `none`; `role_name` carries
   *          fine-grained roles like `maintain`/`triage` when present
   */
  async getCollaboratorPermission(
    owner: string,
    repo: string,
    username: string,
  ): Promise<{ permission: string; roleName?: string }> {
    const response = await this.apiRequest<{
      permission: string;
      role_name?: string;
    }>("GET", `/repos/${owner}/${repo}/collaborators/${username}/permission`, owner, repo);
    return { permission: response.permission, roleName: response.role_name };
  }

  /**
   * Check whether a user can push to the repository (write/maintain/admin).
   * Fails closed: an API error is reported as no push access.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param username - GitHub login to check
   */
  async userHasPushAccess(owner: string, repo: string, username: string): Promise<boolean> {
    try {
      const { permission, roleName } = await this.getCollaboratorPermission(owner, repo, username);
      if (permission === "admin" || permission === "write") {
        return true;
      }
      return roleName === "maintain" || roleName === "write" || roleName === "admin";
    } catch {
      return false;
    }
  }

  /**
   * Fetch all inline review comments on a pull request (paginated).
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   */
  async getPullRequestReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GitHubReviewComment[]> {
    // GitHub paginates results, so we need to fetch all pages
    const comments: GitHubReviewComment[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const pageComments = await this.apiRequest<GitHubReviewComment[]>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=${perPage}&page=${page}`,
        owner,
        repo,
      );

      comments.push(...pageComments);

      if (pageComments.length < perPage) {
        break;
      }

      page++;
    }

    return comments;
  }

  /**
   * Fetch all submitted reviews on a pull request.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   */
  async getReviews(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<
    Array<{
      id: number;
      state: string;
      body: string | null;
      user: { login: string };
      submitted_at: string;
    }>
  > {
    return this.apiRequest<
      Array<{
        id: number;
        state: string;
        body: string | null;
        user: { login: string };
        submitted_at: string;
      }>
    >("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, owner, repo);
  }

  /**
   * Fetch review comments belonging to a specific review submission.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @param reviewId - Review submission ID
   */
  async getReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: number,
  ): Promise<GitHubReviewComment[]> {
    // Get all PR comments and filter by review ID
    const allComments = await this.getPullRequestReviewComments(owner, repo, prNumber);
    return allComments.filter((c) => c.pull_request_review_id === reviewId);
  }

  /**
   * Post a threaded reply to an existing review comment.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @param commentId - Parent review comment ID
   * @param body - Reply markdown body
   */
  async replyToComment(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<GitHubReviewComment> {
    return this.apiRequest<GitHubReviewComment>(
      "POST",
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      owner,
      repo,
      { body },
    );
  }

  /**
   * Create a new inline review comment on a diff line.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @param body - Comment markdown body
   * @param commitId - HEAD commit SHA for the comment anchor
   * @param path - File path in the diff
   * @param line - Line number in the diff
   * @param side - Diff side (`LEFT` or `RIGHT`)
   */
  async createReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    commitId: string,
    path: string,
    line: number,
    side: "LEFT" | "RIGHT" = "RIGHT",
  ): Promise<GitHubReviewComment> {
    return this.apiRequest<GitHubReviewComment>(
      "POST",
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      owner,
      repo,
      {
        body,
        commit_id: commitId,
        path,
        line,
        side,
      },
    );
  }

  /**
   * Post a general issue comment on the pull request conversation tab.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @param body - Comment markdown body
   */
  async postPullRequestComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<void> {
    await this.apiRequest(
      "POST",
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      owner,
      repo,
      { body },
    );
  }

  /**
   * Fetch conversation-tab issue comments on a pull request.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   */
  async getIssueComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<
    Array<{
      id: number;
      body: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
    }>
  > {
    return this.apiRequest<
      Array<{
        id: number;
        body: string;
        user: { login: string };
        created_at: string;
        updated_at: string;
      }>
    >("GET", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, owner, repo);
  }

  /**
   * Add a reaction to a pull request review comment.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param commentId - Review comment ID
   * @param reaction - Reaction name (e.g. `hooray`, `+1`)
   */
  async addReactionToComment(
    owner: string,
    repo: string,
    commentId: number,
    reaction: string,
  ): Promise<void> {
    await this.apiRequest(
      "POST",
      `/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`,
      owner,
      repo,
      { content: reaction },
    );
  }

  /**
   * List reactions on a pull request review comment.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param commentId - Review comment ID
   */
  async getCommentReactions(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<Array<{ content: string; user: { login: string } }>> {
    return this.apiRequest<Array<{ content: string; user: { login: string } }>>(
      "GET",
      `/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`,
      owner,
      repo,
    );
  }

  /**
   * Add a reaction to an issue (conversation) comment.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param commentId - Issue comment ID
   * @param reaction - Reaction name (e.g. `hooray`)
   */
  async addReactionToIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    reaction: string,
  ): Promise<void> {
    await this.apiRequest(
      "POST",
      `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      owner,
      repo,
      { content: reaction },
    );
  }

  /**
   * List reactions on an issue (conversation) comment.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param commentId - Issue comment ID
   */
  async getIssueCommentReactions(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<Array<{ content: string; user: { login: string } }>> {
    return this.apiRequest<Array<{ content: string; user: { login: string } }>>(
      "GET",
      `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      owner,
      repo,
    );
  }

  /**
   * Request re-review from one or more GitHub users.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @param reviewers - GitHub usernames to request review from
   */
  async requestReReview(
    owner: string,
    repo: string,
    prNumber: number,
    reviewers: string[],
  ): Promise<void> {
    await this.apiRequest(
      "POST",
      `/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
      owner,
      repo,
      { reviewers },
    );
  }

  /**
   * Fetch the unified diff for a pull request.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Raw diff text
   * @throws When the diff request fails
   */
  async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    const token = await this.getToken(owner, repo);
    const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`;

    const response = await Utils.fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3.diff",
        "User-Agent": "devintern",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get PR diff: ${response.statusText}`);
    }

    return response.text();
  }

  /**
   * Fetch file contents at a specific git ref.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param path - File path in the repository
   * @param ref - Branch, tag, or commit SHA
   * @returns Decoded file content, or `null` when the file is missing
   */
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<FileContent | null> {
    try {
      const data = await this.apiRequest<{
        path: string;
        sha: string;
        content: string;
        encoding: string;
      }>("GET", `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, owner, repo);

      // GitHub returns base64-encoded content
      const content =
        data.encoding === "base64"
          ? Buffer.from(data.content, "base64").toString("utf-8")
          : data.content;

      return {
        path: data.path,
        content,
        sha: data.sha,
      };
    } catch (error) {
      // File might not exist in this ref
      return null;
    }
  }

  /**
   * Fetch the Actions check runs for a commit SHA (ETag-cached).
   *
   * A `304 Not Modified` response does not count against the rate limit,
   * which makes per-tick polling of many watched PRs cheap.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param sha - Commit SHA (usually the PR head)
   * @param etag - ETag from the previous response, if any
   */
  async getCheckRuns(
    owner: string,
    repo: string,
    sha: string,
    etag?: string,
  ): Promise<{
    data: CheckRunSummary[] | null;
    etag?: string;
    notModified: boolean;
  }> {
    const result = await this.conditionalGet<{
      total_count: number;
      check_runs: CheckRunSummary[];
    }>(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, owner, repo, etag);
    return {
      data: result.data ? result.data.check_runs : null,
      etag: result.etag,
      notModified: result.notModified,
    };
  }

  /**
   * Fetch the combined commit status for a SHA (ETag-cached).
   *
   * Covers classic commit statuses (non-Actions CI reporters).
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param sha - Commit SHA (usually the PR head)
   * @param etag - ETag from the previous response, if any
   */
  async getCombinedStatus(
    owner: string,
    repo: string,
    sha: string,
    etag?: string,
  ): Promise<{ data: CombinedStatus | null; etag?: string; notModified: boolean }> {
    return this.conditionalGet<CombinedStatus>(
      `/repos/${owner}/${repo}/commits/${sha}/status`,
      owner,
      repo,
      etag,
    );
  }

  /**
   * Fetch the Actions jobs of a workflow run (to locate failing jobs).
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param runId - Workflow run id
   */
  async getWorkflowRunJobs(owner: string, repo: string, runId: number): Promise<ActionJob[]> {
    const data = await this.apiRequest<{ jobs: ActionJob[] }>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
      owner,
      repo,
    );
    return data.jobs;
  }

  /**
   * List Actions workflow runs for a commit SHA.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param sha - Commit SHA (usually the PR head)
   */
  async getWorkflowRunsForSha(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<WorkflowRunSummary[]> {
    const data = await this.apiRequest<{ workflow_runs: WorkflowRunSummary[] }>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=20`,
      owner,
      repo,
    );
    return data.workflow_runs;
  }

  /**
   * Download the log archive text of one Actions job.
   *
   * The job's `logs_url` answers with a redirect to log storage; plain
   * authenticated GET follows it and yields plain text.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param logsUrl - Absolute `logs_url` of the job
   * @returns Log text, or `null` on 403/404 (insufficient scope or expired)
   */
  async getJobLogs(owner: string, repo: string, logsUrl: string): Promise<string | null> {
    let token: string | null;
    try {
      token = await this.getToken(owner, repo);
    } catch {
      return null;
    }
    const response = await Utils.fetchWithRetry(logsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "devintern",
      },
      // Logs live behind a redirect to storage; follow it.
      redirect: "follow",
    });
    if (!response.ok) {
      return null;
    }
    return response.text();
  }

  /**
   * Fetch annotations of one check run.
   *
   * Used as a fallback when job-log download fails (403/404): annotations
   * carry the lint/test failure messages GitHub surfaced on the check.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param checkRunId - Check run id
   */
  async getCheckRunAnnotations(
    owner: string,
    repo: string,
    checkRunId: number,
  ): Promise<CheckAnnotation[]> {
    return this.apiRequest<CheckAnnotation[]>(
      "GET",
      `/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`,
      owner,
      repo,
    );
  }

  /**
   * Map raw GitHub review comments to the internal processed shape.
   *
   * @param comments - Raw API review comments
   */
  processComments(comments: GitHubReviewComment[]): ProcessedReviewComment[] {
    return comments.map((comment) => ({
      id: comment.id,
      path: comment.path,
      line: comment.line ?? comment.original_line,
      side: comment.side,
      diffHunk: comment.diff_hunk,
      body: comment.body,
      reviewer: comment.user.login,
      isReply: comment.in_reply_to_id !== undefined,
    }));
  }

  /**
   * Return review comments not yet replied to by the PR author.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @param prAuthor - Login of the pull request author
   */
  async getUnaddressedComments(
    owner: string,
    repo: string,
    prNumber: number,
    prAuthor: string,
  ): Promise<ProcessedReviewComment[]> {
    const allComments = await this.getPullRequestReviewComments(owner, repo, prNumber);

    // Build a set of comment IDs that have been addressed
    // (i.e., the PR author has replied to them)
    const addressedCommentIds = new Set<number>();

    for (const comment of allComments) {
      if (comment.user.login === prAuthor && comment.in_reply_to_id !== undefined) {
        addressedCommentIds.add(comment.in_reply_to_id);
      }
    }

    // Filter to unaddressed comments from reviewers (not the PR author)
    const unaddressed = allComments.filter(
      (comment) =>
        comment.user.login !== prAuthor &&
        !addressedCommentIds.has(comment.id) &&
        !comment.in_reply_to_id, // Don't include reply chains
    );

    return this.processComments(unaddressed);
  }
}
