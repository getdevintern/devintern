export interface GitLabProject {
  id: number;
  path_with_namespace: string;
  http_url_to_repo: string;
}

export interface MergeRequest {
  iid: number;
  state: string;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  sha: string;
}

class GitLabRequestError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    super(`GitLab ${method} ${path}: HTTP ${status}`);
  }
}

export class GitLab {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "GitLab E2E URL must be an HTTP(S) instance URL without credentials, query or fragment",
      );
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
  }

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v4${path}`, {
      method,
      headers: { "PRIVATE-TOKEN": this.token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new GitLabRequestError(response.status, method, path);
    return ([202, 204].includes(response.status) ? undefined : await response.json()) as T;
  }

  createProject(name: string): Promise<GitLabProject> {
    return this.request("/projects", "POST", {
      name,
      path: name,
      visibility: "private",
      initialize_with_readme: false,
      auto_devops_enabled: false,
      builds_access_level: "disabled",
    });
  }

  mergeRequests(projectId: number, head: string): Promise<MergeRequest[]> {
    return this.request(
      `/projects/${projectId}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(head)}`,
    );
  }

  async waitForMergeRequest(projectId: number, head: string): Promise<MergeRequest> {
    const deadline = Date.now() + 30_000;
    do {
      const changes = await this.mergeRequests(projectId, head);
      if (changes.length > 1) throw new Error(`Duplicate merge requests for ${head}`);
      if (changes.length === 1) return changes[0];
      await Bun.sleep(1000);
    } while (Date.now() < deadline);
    throw new Error(`No merge request appeared for ${head}`);
  }

  async deleteProject(project: GitLabProject): Promise<void> {
    if (!/^e2e-[\da-f-]{36}$/.test(project.path_with_namespace.split("/").at(-1) ?? "")) {
      throw new Error("Refusing to delete a project without an E2E-generated name");
    }
    await this.request(`/projects/${project.id}`, "DELETE");
    let pending: GitLabProject;
    try {
      pending = await this.request<GitLabProject>(`/projects/${project.id}`);
    } catch (error) {
      if (error instanceof GitLabRequestError && error.status === 404) return;
      throw error;
    }
    const expectedPath = `${project.path_with_namespace}-deletion_scheduled-${project.id}`;
    if (
      pending.id !== project.id ||
      ![project.path_with_namespace, expectedPath].includes(pending.path_with_namespace)
    ) {
      throw new Error(`Refusing permanent deletion after unexpected project rename: ${project.id}`);
    }
    await this.request(
      `/projects/${project.id}?permanently_remove=true&full_path=${encodeURIComponent(pending.path_with_namespace)}`,
      "DELETE",
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await this.request(`/projects/${project.id}`);
      } catch (error) {
        if (error instanceof GitLabRequestError && error.status === 404) return;
        throw error;
      }
      await Bun.sleep(1000);
    }
    throw new Error(`GitLab project deletion did not finish: ${project.id}`);
  }
}
