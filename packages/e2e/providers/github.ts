export interface PullRequest {
  number: number;
  state: string;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string };
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
    const response = await fetch(`https://api.github.com/repos/${this.repository}${path}`, {
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
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  pulls(head: string): Promise<PullRequest[]> {
    const owner = this.repository.split("/")[0];
    return this.request(
      `/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}&per_page=100`,
    );
  }

  async waitForPull(head: string): Promise<PullRequest> {
    const deadline = Date.now() + 30_000;
    do {
      const pulls = await this.pulls(head);
      if (pulls.length > 1) throw new Error(`Duplicate PRs for ${head}`);
      if (pulls.length === 1) return pulls[0];
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
}
