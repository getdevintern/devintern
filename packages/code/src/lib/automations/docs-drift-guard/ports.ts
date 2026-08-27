/**
 * Tracker and git-host ports for docs-drift-guard side effects.
 *
 * Ticket mode publishes findings as tracker issues through the normalized
 * issue-creation capability (`IssueCreatableClient`) implemented by
 * `GitHubTaskTrackerClient` and `GitLabTaskTrackerClient`. Pull-request mode
 * searches for an existing open drift-guard PR and reuses it instead of
 * opening duplicates. Tests inject fakes; these defaults are thin adapters.
 */

import { GitHubAppAuth } from "../../github-app-auth";
import { GitHubReviewsClient } from "../../github-reviews";
import { supportsIssueCreation } from "../../tracker-capabilities";
import { Utils } from "../../utils";
import type {
  CreateIssueInput,
  CreatedIssue,
  IssueCreatableClient,
  TaskTrackerClient,
} from "../../task-tracker-client";

/** Marker embedded in every drift ticket body, scoped by finding id. */
export function driftTicketMarker(findingId: string): string {
  return `devintern-docs-drift: ${findingId}`;
}

/** Marker embedded in drift PR bodies, scoped by automation id. */
export function driftPrMarker(automationId: string): string {
  return `devintern-docs-drift-pr automation=${automationId}`;
}

/** Normalized tracker side effects the ticket mode needs. */
export interface DocsDriftTrackerPort {
  /** Open tracker tickets whose body/title carries the exact marker. */
  findOpenWithMarker(marker: string): Promise<Array<{ key: string; url?: string }>>;
  /** Create one ticket. */
  create(input: CreateIssueInput): Promise<CreatedIssue>;
}

/**
 * Build the default tracker port over an active {@link TaskTrackerClient}.
 *
 * Deduplication uses the tracker's task search filtered to open items; the
 * marker string is unique enough that false positives are practically
 * impossible while false negatives just create one duplicate ticket.
 */
export function defaultTrackerPort(client: TaskTrackerClient): DocsDriftTrackerPort {
  return {
    async findOpenWithMarker(marker) {
      const quoted = `"${marker}"`;
      try {
        const { tasks } = await client.searchTasks(`is:open ${quoted}`);
        return tasks.map((task) => ({ key: task.key }));
      } catch (error) {
        // Search is a dedup optimization; a failing search must not block
        // publication (the scheduler lease already prevents concurrent runs).
        console.warn(
          `⚠️  [docs-drift-guard] dedup search failed (${(error as Error).message}); continuing`,
        );
        return [];
      }
    },

    async create(input) {
      const creatable = client as Partial<IssueCreatableClient>;
      if (typeof creatable.createIssue !== "function") {
        throw new Error(
          `The configured tracker cannot create tickets. ` +
            `Issue creation is supported by: ${supportsIssueCreation().join(", ")}. ` +
            `Use output_mode = "pull_request" or a supported tracker.`,
        );
      }
      return creatable.createIssue(input);
    },
  };
}

export interface ExistingDriftPr {
  number: number;
  url?: string;
  headRef: string;
}

/** Normalized git-host pull-request side effects for PR mode. */
export interface DocsDriftPrPort {
  /** The open drift-guard PR for this automation, when one exists. */
  findOpenDriftPr(input: { repository: string; marker: string }): Promise<ExistingDriftPr | null>;
  /** Create a pull request. */
  createPullRequest(input: {
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ number?: number; url?: string }>;
  /** Replace an existing PR's body (used when a drift PR is reused). */
  updatePullRequestBody(input: {
    repository: string;
    prNumber: number;
    body: string;
  }): Promise<void>;
}

/** Resolve a GitHub token for `owner/repo`: PAT first, then GitHub App. */
async function resolveGitHubToken(owner: string, repo: string): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const appAuth = GitHubAppAuth.fromEnvironment();
  if (!appAuth) return null;
  return appAuth.getTokenForRepository(owner, repo);
}

function splitSlug(repository: string): [string, string] {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Repository "${repository}" is not an owner/repo slug; PR mode needs a GitHub remote.`,
    );
  }
  return [owner, repo];
}

/** Default PR port backed by the shared GitHub API clients (App/token aware). */
export function defaultPrPort(): DocsDriftPrPort {
  const github = new GitHubReviewsClient({ preferAppAuth: true });
  const apiRequest = async <T>(
    method: "POST" | "PATCH",
    repository: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> => {
    const [owner, repo] = splitSlug(repository);
    const token = await resolveGitHubToken(owner, repo);
    if (!token) {
      throw new Error(
        "GitHub credentials not configured for PR creation. Set GITHUB_TOKEN or configure " +
          "GITHUB_APP_ID with a private key.",
      );
    }
    const response = await Utils.fetchWithRetry(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "devintern",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(
        `GitHub API error (${response.status}): ${error.message || response.statusText}`,
      );
    }
    return (await response.json()) as T;
  };

  return {
    async findOpenDriftPr({ repository, marker }) {
      const [owner, repo] = splitSlug(repository);
      const { data } = await github.conditionalGet<
        Array<{ number: number; html_url: string; head: { ref?: string }; body: string | null }>
      >(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`, owner, repo);
      const match = (data ?? []).find((pr) => pr.body?.includes(marker));
      if (!match) return null;
      return { number: match.number, url: match.html_url, headRef: match.head.ref ?? "" };
    },

    async createPullRequest(input) {
      const created = await apiRequest<{ number: number; html_url: string }>(
        "POST",
        input.repository,
        `/repos/${splitSlug(input.repository).join("/")}/pulls`,
        { title: input.title, body: input.body, head: input.head, base: input.base },
      );
      return { number: created.number, url: created.html_url };
    },

    async updatePullRequestBody(input) {
      await apiRequest(
        "PATCH",
        input.repository,
        `/repos/${splitSlug(input.repository).join("/")}/pulls/${input.prNumber}`,
        { body: input.body },
      );
    },
  };
}
