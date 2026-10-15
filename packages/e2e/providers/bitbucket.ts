export interface BitbucketPullRequest {
  id: number;
  title: string;
  description: string;
  state: string;
  source: { branch: { name: string }; commit: { hash: string } };
  destination: { branch: { name: string } };
}

interface Page<T> {
  values: T[];
  next?: string;
}

export class Bitbucket {
  private readonly apiUrl: string;

  constructor(
    readonly repository: string,
    private readonly token: string,
  ) {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      repository.split("/").some((part) => [".", ".."].includes(part))
    ) {
      throw new Error("Bitbucket fixture repository must be workspace/repo");
    }
    this.apiUrl = `https://api.bitbucket.org/2.0/repositories/${repository}`;
  }

  private async response(
    path: string,
    method = "GET",
    accept = "application/json",
  ): Promise<Response> {
    let url = new URL(`${this.apiUrl}${path}`);
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, Accept: accept },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (method !== "GET" || !location) throw new Error("Unexpected Bitbucket redirect");
        const target = new URL(location, url);
        if (
          target.origin !== "https://api.bitbucket.org" ||
          target.username ||
          target.password ||
          target.hash
        ) {
          throw new Error("Unexpected Bitbucket redirect destination");
        }
        await response.body?.cancel();
        url = target;
        continue;
      }
      if (!response.ok) throw new Error(`Bitbucket ${method} ${path}: HTTP ${response.status}`);
      return response;
    }
    throw new Error("Bitbucket redirect limit exceeded");
  }

  async request<T>(path: string, method = "GET"): Promise<T> {
    const response = await this.response(path, method);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  async list<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let next: string | undefined = path;
    for (let pageNumber = 0; next && pageNumber < 100; pageNumber++) {
      const page: Page<T> = await this.request(next);
      values.push(...page.values);
      if (!page.next) return values;
      // Never send the bearer token to a pagination URL outside this repository.
      const url = new URL(page.next);
      if (!url.href.startsWith(`${this.apiUrl}/`) || url.username || url.password || url.hash) {
        throw new Error("Unexpected Bitbucket pagination URL");
      }
      next = url.href.slice(this.apiUrl.length);
    }
    throw new Error("Bitbucket pagination exceeded the safety limit");
  }

  pulls(head: string): Promise<BitbucketPullRequest[]> {
    const query = new URLSearchParams({
      q: `source.branch.name=${JSON.stringify(head)}`,
      pagelen: "50",
    });
    for (const state of ["OPEN", "MERGED", "DECLINED"]) query.append("state", state);
    return this.list(`/pullrequests?${query}`);
  }

  async waitForPull(head: string): Promise<BitbucketPullRequest> {
    const deadline = Date.now() + 30_000;
    do {
      const pulls = await this.pulls(head);
      if (pulls.length > 1) throw new Error(`Duplicate Bitbucket PRs for ${head}`);
      if (pulls.length === 1) return pulls[0];
      await Bun.sleep(1000);
    } while (Date.now() < deadline);
    throw new Error(`No Bitbucket PR appeared for ${head}`);
  }

  async diff(number: number): Promise<string> {
    // The documented PR diff endpoint redirects to the repository diff endpoint.
    const response = await this.response(`/pullrequests/${number}/diff`, "GET", "text/plain");
    return response.text();
  }
}
