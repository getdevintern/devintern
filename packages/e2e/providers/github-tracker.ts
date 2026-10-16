import { GitHub } from "./github";
import type { TrackerComment, TrackerFixture, TrackerTicket, TrackerTicketState } from "./tracker";

interface GitHubIssueDetail {
  number: number;
  html_url: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string } | string>;
}

interface GitHubIssueComment {
  id: number;
  body: string;
}

/**
 * GitHub Issues tracker fixture.
 *
 * Reuses the code-host {@link GitHub} REST client (repo-scoped) so the tracker
 * and code host can share one token without a second HTTP implementation. The
 * repository must already exist; this fixture never creates or deletes it and
 * only ever touches tickets it created.
 */
export class GitHubTracker implements TrackerFixture {
  readonly type = "github";
  /** GitHub Issues report active issues as `open`. */
  readonly openState = "open";
  private readonly api: GitHub;

  constructor(
    readonly repository: string,
    token: string,
    private readonly statusLabels: string[] = [],
  ) {
    if (!token.trim()) throw new Error("GitHub tracker token must not be empty");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
      throw new Error(`Invalid GitHub tracker repository: "${repository}"`);
    }
    // GitHub's constructor validates the owner/repo shape before any request.
    this.api = new GitHub(repository, token);
  }

  /** Tracker credentials/configuration for the isolated CLI subprocess. */
  environment(): Record<string, string> {
    return {
      TASK_TRACKER: this.type,
      GITHUB_REPO: this.repository,
      ...(this.statusLabels.length > 0
        ? { GITHUB_STATUS_LABELS: this.statusLabels.join(",") }
        : {}),
    };
  }

  /** Project key `resolveProjectKey` derives for GitHub Issues. */
  projectKey(): string {
    return this.repository;
  }

  async ensureLabels(labels: string[]): Promise<void> {
    for (const name of labels) {
      try {
        await this.api.request("/labels", "POST", { name });
      } catch (error) {
        // A label that already exists is reported as 422; anything else is a
        // real failure the scenario must surface.
        if (!(error instanceof Error) || !error.message.includes("HTTP 422")) throw error;
      }
    }
  }

  async createTicket(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<TrackerTicket> {
    const issue = await this.api.request<{ number: number; html_url: string }>("/issues", "POST", {
      title: input.title,
      body: input.body,
      ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
    });
    return { key: String(issue.number), url: issue.html_url };
  }

  async addComment(ticketKey: string, body: string): Promise<string> {
    const comment = await this.api.request<{ id: number }>(
      `/issues/${this.numericId(ticketKey, "ticket")}/comments`,
      "POST",
      { body },
    );
    return String(comment.id);
  }

  async closeTicket(ticketKey: string): Promise<void> {
    await this.api.request(`/issues/${this.numericId(ticketKey, "ticket")}`, "PATCH", {
      state: "closed",
    });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.api.request(`/issues/comments/${this.numericId(commentId, "comment")}`, "DELETE");
  }

  async getTicket(ticketKey: string): Promise<TrackerTicketState> {
    const issue = await this.api.request<GitHubIssueDetail>(
      `/issues/${this.numericId(ticketKey, "ticket")}`,
    );
    return {
      state: issue.state,
      labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
      body: issue.body ?? "",
    };
  }

  async listComments(ticketKey: string): Promise<TrackerComment[]> {
    const comments = await this.api.request<GitHubIssueComment[]>(
      `/issues/${this.numericId(ticketKey, "ticket")}/comments?per_page=100`,
    );
    return comments.map((comment) => ({ id: String(comment.id), body: comment.body }));
  }

  /**
   * Provider-native search scoped to the fixture repository. Search is
   * eventually consistent, so callers must poll (see
   * {@link TrackerScenario.waitForSelectedTickets}).
   */
  async findTickets(query: string): Promise<TrackerTicket[]> {
    const issues = await this.api.searchIssues(query);
    return issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({ key: String(issue.number), url: issue.html_url }));
  }

  /** Reject anything but a positive GitHub numeric id before URL interpolation. */
  private numericId(value: string, kind: string): number {
    if (!/^\d+$/.test(value)) {
      throw new Error(`Invalid GitHub ${kind} id: "${value}"`);
    }
    return Number(value);
  }
}
