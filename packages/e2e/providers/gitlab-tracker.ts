import type { GitLab, GitLabProject } from "./gitlab";
import type { TrackerComment, TrackerFixture, TrackerTicket, TrackerTicketState } from "./tracker";

interface GitLabIssueDetail {
  iid: number;
  web_url: string;
  description: string | null;
  state: string;
  labels: string[];
}

interface GitLabIssueNote {
  id: number;
  body: string;
  system?: boolean;
}

/**
 * Local GitLab Issues tracker fixture.
 *
 * The tracker source is a dedicated private project created by the scenario on
 * the local Self-Managed instance. The code host stays GitHub (see
 * {@link TrackerScenario}), so this fixture never touches repository contents
 * and only manages the project's issues, notes and labels. The project is
 * owned by the fixture and permanently removed in {@link cleanup}.
 */
export class GitLabTracker implements TrackerFixture {
  readonly type = "gitlab";

  constructor(
    private readonly gitlab: GitLab,
    readonly project: GitLabProject,
    private readonly token: string,
    private readonly baseUrl: string,
    private readonly statusLabels: string[] = [],
  ) {
    if (!token.trim()) throw new Error("GitLab tracker token must not be empty");
    if (!Number.isInteger(project.id) || project.id <= 0) {
      throw new Error(`Invalid GitLab project id: "${project.id}"`);
    }
    if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(project.path_with_namespace)) {
      throw new Error(`Invalid GitLab project path: "${project.path_with_namespace}"`);
    }
  }

  /** Tracker credentials/configuration for the isolated CLI subprocess. */
  environment(): Record<string, string> {
    return {
      TASK_TRACKER: this.type,
      GITLAB_TOKEN: this.token,
      GITLAB_PROJECT: this.project.path_with_namespace,
      GITLAB_BASE_URL: this.baseUrl,
      ...(this.statusLabels.length > 0
        ? { GITLAB_STATUS_LABELS: this.statusLabels.join(",") }
        : {}),
    };
  }

  /** Project key `resolveProjectKey` derives for GitLab. */
  projectKey(): string {
    return this.project.path_with_namespace;
  }

  async ensureLabels(labels: string[]): Promise<void> {
    for (const name of labels) {
      try {
        await this.gitlab.request(`/projects/${this.project.id}/labels`, "POST", { name });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("HTTP 409")) throw error;
      }
    }
  }

  async createTicket(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<TrackerTicket> {
    const issue = await this.gitlab.request<{ iid: number; web_url: string }>(
      `/projects/${this.project.id}/issues`,
      "POST",
      {
        title: input.title,
        description: input.body,
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels.join(",") } : {}),
      },
    );
    return { key: String(issue.iid), url: issue.web_url };
  }

  async addComment(ticketKey: string, body: string): Promise<string> {
    const iid = this.issueIid(ticketKey);
    const note = await this.gitlab.request<{ id: number }>(
      `/projects/${this.project.id}/issues/${iid}/notes`,
      "POST",
      { body },
    );
    // GitLab notes are scoped to their issue, so the delete handle records both.
    return `${iid}:${note.id}`;
  }

  async closeTicket(ticketKey: string): Promise<void> {
    await this.gitlab.request(
      `/projects/${this.project.id}/issues/${this.issueIid(ticketKey)}`,
      "PUT",
      { state_event: "close" },
    );
  }

  async deleteComment(commentId: string): Promise<void> {
    const [iid, noteId] = commentId.split(":");
    if (!iid || !noteId || !/^\d+$/.test(iid) || !/^\d+$/.test(noteId)) {
      throw new Error(`Invalid GitLab comment handle: "${commentId}"`);
    }
    await this.gitlab.request(
      `/projects/${this.project.id}/issues/${iid}/notes/${noteId}`,
      "DELETE",
    );
  }

  async getTicket(ticketKey: string): Promise<TrackerTicketState> {
    const issue = await this.gitlab.request<GitLabIssueDetail>(
      `/projects/${this.project.id}/issues/${this.issueIid(ticketKey)}`,
    );
    return {
      state: issue.state,
      labels: issue.labels ?? [],
      body: issue.description ?? "",
    };
  }

  async listComments(ticketKey: string): Promise<TrackerComment[]> {
    const notes = await this.gitlab.request<GitLabIssueNote[]>(
      `/projects/${this.project.id}/issues/${this.issueIid(ticketKey)}/notes?per_page=100`,
    );
    return notes
      .filter((note) => note.system !== true)
      .map((note) => ({ id: String(note.id), body: note.body }));
  }

  /**
   * Provider-native search scoped to the scenario project. GitLab's issue
   * search is eventually consistent, so callers must poll (see
   * {@link TrackerScenario.waitForSelectedTickets}).
   */
  async findTickets(query: string): Promise<TrackerTicket[]> {
    const issues = await this.gitlab.request<Array<{ iid: number; web_url: string }>>(
      `/projects/${this.project.id}/issues?state=opened&search=${encodeURIComponent(query)}&per_page=100`,
    );
    return issues.map((issue) => ({ key: String(issue.iid), url: issue.web_url }));
  }

  /** Permanently remove the scenario-owned issue project and its contents. */
  async cleanup(): Promise<void> {
    await this.gitlab.deleteProject(this.project);
  }

  private issueIid(ticketKey: string): number {
    if (!/^\d+$/.test(ticketKey)) {
      throw new Error(`Invalid GitLab issue id: "${ticketKey}"`);
    }
    return Number(ticketKey);
  }
}
