export interface PullRequest {
  number: number;
  state: string;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels: Array<{ name: string }>;
}

/** A GitHub issue search hit (pull requests share the same endpoint). */
export interface GitHubSearchIssue {
  number: number;
  html_url: string;
  pull_request?: unknown;
}

export class GitHub {
  constructor(
    readonly repository: string,
    private readonly token: string,
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
      throw new Error("E2E_GITHUB_REPOSITORY must be owner/repo");
    }
  }

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    return this.performFetch<T>(
      `https://api.github.com/repos/${this.repository}${path}`,
      path,
      method,
      body,
    );
  }

  /**
   * Search issues with GitHub's provider-native query language.
   *
   * The query is scoped to the fixture repository unless it already contains a
   * `repo:` qualifier, mirroring the CLI's own `searchIssues` behavior.
   */
  async searchIssues(query: string): Promise<GitHubSearchIssue[]> {
    const scoped = /(^|\s)repo:/.test(query) ? query : `repo:${this.repository} is:issue ${query}`;
    const result = await this.performFetch<{ items: GitHubSearchIssue[] }>(
      `https://api.github.com/search/issues?q=${encodeURIComponent(scoped)}&per_page=100`,
      "/search/issues",
      "GET",
    );
    return result.items;
  }

  pulls(head: string): Promise<PullRequest[]> {
    const owner = this.repository.split("/")[0];
    return this.request(
      `/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}&per_page=100`,
    );
  }

  /**
   * Ensure a label exists on the fixture repository.
   *
   * PR creation applies labels best-effort, so a missing label would otherwise
   * make the live assertion indistinguishable from an unlabeled PR. Labels are
   * shared repository configuration and are intentionally not deleted.
   */
  async ensureLabel(name: string, color = "ededed"): Promise<void> {
    try {
      await this.request("/labels", "POST", { name, color });
    } catch (error) {
      // GitHub reports an existing label as 422 `already_exists`; any other
      // rejection (invalid payload, lost permissions) must surface.
      if (!(error instanceof Error) || !error.message.includes("already_exists")) {
        if (error instanceof Error && /^GitHub POST \/labels: HTTP 403\b/.test(error.message)) {
          throw new Error(
            `${error.message}\nCreating labels requires Issues: write on the fixture repository; ` +
              "update E2E_GITHUB_TOKEN (see packages/e2e/README.md).",
            { cause: error },
          );
        }
        throw error;
      }
    }
  }

  /**
   * Wait for the pull request for `head`.
   *
   * The code host is shared across scenarios, and a deterministic tracker key
   * (`feature/2` for a fresh GitLab project) can reuse a head ref deleted by a
   * foreign run. GitHub retains the closed PR for a deleted head ref, so
   * `state=all` can return several PRs for one head. Passing this run's unique
   * `base` scopes the lookup to the PR this run created, instead of treating a
   * foreign-run PR that shares the head as a duplicate.
   */
  async waitForPull(head: string, base?: string): Promise<PullRequest> {
    const deadline = Date.now() + 30_000;
    do {
      const pulls = await this.pulls(head);
      const candidates =
        base === undefined ? pulls : pulls.filter((pull) => pull.base.ref === base);
      if (candidates.length > 1) throw new Error(`Duplicate PRs for ${head}`);
      if (candidates.length === 1) return candidates[0];
      await Bun.sleep(1000);
    } while (Date.now() < deadline);
    throw new Error(`No PR appeared for ${head}`);
  }

  async deleteBranch(branch: string): Promise<void> {
    // Every caller supplies the exact unique ref it created; never sweep a prefix.
    try {
      await this.request(`/git/refs/heads/${encodeURIComponent(branch)}`, "DELETE");
    } catch (error) {
      // Deletion is idempotent only when a follow-up confirms absence.
      const refs = await this.request<Array<{ ref: string }>>(
        `/git/matching-refs/heads/${encodeURIComponent(branch)}`,
      );
      if (refs.some((ref) => ref.ref === `refs/heads/${branch}`)) throw error;
    }
  }

  private async performFetch<T>(
    url: string,
    label: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      // Keep the provider's error body so callers can distinguish a benign
      // duplicate (e.g. `already_exists`) from a real payload rejection.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `GitHub ${method} ${label}: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
}
