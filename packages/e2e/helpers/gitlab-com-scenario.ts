import { GitLab } from "../providers/gitlab";
import type { GitLabProject } from "../providers/gitlab";
import { FixtureWorkspace } from "./fixture-workspace";

export class GitLabComScenario extends FixtureWorkspace {
  project?: GitLabProject;

  constructor(
    readonly gitlab: GitLab,
    private readonly projectPath: string,
  ) {
    super("GITLAB_CODE_HOST_TOKEN");
    if (gitlab.baseUrl !== "https://gitlab.com")
      throw new Error("The hosted GitLab suite requires https://gitlab.com");
  }

  async setup(token: string): Promise<void> {
    const project = await this.gitlab.request<GitLabProject & { default_branch: string | null }>(
      `/projects/${encodeURIComponent(this.projectPath)}`,
    );
    if (!project.default_branch)
      throw new Error(
        "Initialize the dedicated GitLab.com fixture project with a default branch first",
      );
    if (project.path_with_namespace !== this.projectPath)
      throw new Error("GitLab.com returned an unexpected fixture project path");
    this.project = project;
    // Construct the remote from the configured GitLab.com path, never from a server-provided URL.
    await this.prepare(`https://gitlab.com/${this.projectPath}.git`, token, {
      DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
      GITLAB_CODE_HOST_URL: this.gitlab.baseUrl,
      GITLAB_CODE_HOST_TOKEN: token,
    });
  }

  projectId(): number {
    if (!this.project) throw new Error("GitLab.com fixture project is not loaded");
    return this.project.id;
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    if (this.project) {
      try {
        for (const mr of await this.gitlab.mergeRequests(this.project.id, this.head)) {
          if (mr.source_branch !== this.head)
            throw new Error("GitLab returned an MR for an unexpected source branch");
          if (mr.state === "opened") {
            try {
              await this.gitlab.request(
                `/projects/${this.project.id}/merge_requests/${mr.iid}`,
                "PUT",
                { state_event: "close" },
              );
            } catch (error) {
              errors.push(error);
            }
          }
        }
      } catch (error) {
        errors.push(error);
      }
      for (const branch of [this.head, this.base]) {
        try {
          await this.deleteRemoteBranch(branch);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this.dispose();
    if (errors.length) throw new AggregateError(errors, `GitLab.com cleanup failed for ${this.id}`);
  }
}
