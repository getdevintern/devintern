import { GitHub } from "./github";
import type { TrackerFixture, TrackerTicket } from "./tracker";

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

  /** Reject anything but a positive GitHub numeric id before URL interpolation. */
  private numericId(value: string, kind: string): number {
    if (!/^\d+$/.test(value)) {
      throw new Error(`Invalid GitHub ${kind} id: "${value}"`);
    }
    return Number(value);
  }
}
