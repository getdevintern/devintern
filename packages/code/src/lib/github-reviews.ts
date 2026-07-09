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
  };
  base: {
    ref: string;
  };
  html_url: string;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
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
