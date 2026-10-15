import { GitLab } from "../providers/gitlab";
import type { GitLabProject } from "../providers/gitlab";
import { FixtureWorkspace } from "./fixture-workspace";

export class GitLabScenario extends FixtureWorkspace {
  project?: GitLabProject;

  constructor(readonly gitlab: GitLab) {
    super("GITLAB_CODE_HOST_TOKEN");
  }

  async setup(token: string): Promise<void> {
    this.project = await this.gitlab.createProject(this.id);
    // Reject a server-provided clone URL pointing at a different host.
    const remote = new URL(this.project.http_url_to_repo);
    if (
      remote.origin !== new URL(this.gitlab.baseUrl).origin ||
      remote.username ||
      remote.password
    ) {
      throw new Error("GitLab returned an unexpected clone URL");
    }
    await this.prepare(remote.toString(), token, {
      DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
      GITLAB_CODE_HOST_URL: this.gitlab.baseUrl,
      GITLAB_CODE_HOST_TOKEN: token,
    });
    await this.gitlab.request(`/projects/${this.project.id}`, "PUT", { default_branch: this.base });
    await this.git("remote", "set-head", "origin", this.base);
  }

  projectId(): number {
    if (!this.project) throw new Error("GitLab project has not been provisioned");
    return this.project.id;
  }

  async cleanup(): Promise<void> {
    try {
      if (this.project) await this.gitlab.deleteProject(this.project);
    } finally {
      this.dispose();
    }
  }
}
