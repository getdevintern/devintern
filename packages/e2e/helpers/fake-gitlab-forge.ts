/**
 * Loopback GitLab v4 stand-in for offline conflict-resolution tests.
 *
 * Serves only the endpoints the worker conflict path actually calls, and
 * reads branch SHAs from a local bare repository. Mergeability follows the
 * real git history: a single-parent tip is `conflict`, and a merge commit
 * (two parents) is `mergeable`, so post-push verification sees the pushed
 * SHA without a provider recompute delay. No token, header, or body is
 * written to the request log.
 */

import { spawnSync } from "node:child_process";

export const FAKE_GITLAB_TOKEN = "e2e-local-forge-token";

const PROJECT_ID = 1;
const PROJECT_PATH = "fixture/repo";
const USER_ID = 7;

export interface ForgeRequest {
  method: string;
  path: string;
}

export interface FakeGitlabForgeOptions {
  /** Absolute path of the bare repository the MR branches live in. */
  gitDir: string;
  /** Absolute `git` binary. Avoids a test wrapper that records argv. */
  gitBin: string;
  /** MR source branch. */
  sourceBranch: string;
  /** MR target branch. */
  targetBranch: string;
  /** Expected `PRIVATE-TOKEN`. A mismatch is recorded without the value. */
  token?: string;
}

/** Minimal local GitLab API bound to `127.0.0.1`. */
export class FakeGitlabForge {
  readonly requests: ForgeRequest[] = [];
  readonly notes: string[] = [];
  readonly authFailures: string[] = [];
  readonly baseUrl: string;
  readonly mergeRequestUrl: string;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly options: Required<Pick<FakeGitlabForgeOptions, "token">> &
    FakeGitlabForgeOptions;

  constructor(options: FakeGitlabForgeOptions) {
    this.options = { token: FAKE_GITLAB_TOKEN, ...options };
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    const port = this.server.port;
    if (port === undefined || port === 0) {
      this.server.stop(true);
      throw new Error("Fake GitLab forge did not receive a loopback port");
    }
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.mergeRequestUrl = `${this.baseUrl}/${PROJECT_PATH}/-/merge_requests/1`;
  }

  /** Non-GET calls, which is where a merge, close, or note would show up. */
  mutations(): ForgeRequest[] {
    return this.requests.filter((request) => request.method !== "GET" && request.method !== "HEAD");
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    this.requests.push({ method: request.method, path });

    const presented = request.headers.get("private-token");
    if (presented !== this.options.token) {
      this.authFailures.push(presented === null ? "absent" : "mismatch");
      return json({ message: "unauthorized" }, 401);
    }

    if (url.pathname === "/api/v4/user" && request.method === "GET") {
      return json({ id: USER_ID, username: "e2e-bot", state: "active" });
    }

    const routed = routeProject(url.pathname);
    if (!routed) return json({ message: "not found" }, 404);
    try {
      return await this.routeProject(request, routed.rest);
    } catch {
      return json({ message: "fixture git read failed" }, 500);
    }
  }

  private async routeProject(request: Request, rest: string): Promise<Response> {
    if (rest === "" && request.method === "GET") {
      return json(this.project());
    }

    const mr = rest.match(/^\/merge_requests\/1(?:\/(discussions|notes|merge))?$/);
    if (mr && request.method === "GET" && !mr[1]) return json(this.mergeRequest());
    if (mr?.[1] === "discussions" && request.method === "GET") return json([]);
    if (mr?.[1] === "notes" && request.method === "POST") return this.postNote(request);
    if (mr?.[1] === "merge") return json({ message: "not found" }, 404);

    const branch = rest.match(/^\/repository\/branches\/(.+)$/);
    if (branch?.[1] && request.method === "GET") {
      const name = decodeURIComponent(branch[1]);
      if (!this.refExists(name)) return json({ message: "not found" }, 404);
      return json({ name, can_push: true });
    }

    return json({ message: "not found" }, 404);
  }

  private async postNote(request: Request): Promise<Response> {
    let body = "";
    try {
      const parsed = (await request.json()) as { body?: unknown };
      body = typeof parsed.body === "string" ? parsed.body : "";
    } catch {
      body = "";
    }
    this.notes.push(body);
    return json({ id: this.notes.length, body });
  }

  private project(): unknown {
    return {
      id: PROJECT_ID,
      path_with_namespace: PROJECT_PATH,
      permissions: { project_access: { access_level: 40 }, group_access: null },
    };
  }

  private mergeRequest(): unknown {
    const head = this.revParse(this.options.sourceBranch);
    const base = this.revParse(this.options.targetBranch);
    const parents = this.parentCount(this.options.sourceBranch);
    return {
      iid: 1,
      title: "Conflict PR",
      state: "opened",
      sha: head,
      source_branch: this.options.sourceBranch,
      target_branch: this.options.targetBranch,
      source_project_id: PROJECT_ID,
      target_project_id: PROJECT_ID,
      web_url: this.mergeRequestUrl,
      reviewers: [],
      detailed_merge_status: parents >= 2 ? "mergeable" : "conflict",
      diff_refs: { base_sha: base, head_sha: head },
    };
  }

  private refExists(branch: string): boolean {
    const result = spawnSync(
      this.options.gitBin,
      [
        "--git-dir",
        this.options.gitDir,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ],
      { encoding: "utf8" },
    );
    return result.status === 0;
  }

  private revParse(branch: string): string {
    const result = spawnSync(
      this.options.gitBin,
      ["--git-dir", this.options.gitDir, "rev-parse", `refs/heads/${branch}`],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`fixture git could not resolve ${branch}`);
    }
    return result.stdout.trim();
  }

  private parentCount(branch: string): number {
    const result = spawnSync(
      this.options.gitBin,
      [
        "--git-dir",
        this.options.gitDir,
        "rev-list",
        "--parents",
        "-n",
        "1",
        `refs/heads/${branch}`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) return 0;
    return result.stdout.trim().split(/\s+/).filter(Boolean).length - 1;
  }
}

/**
 * Split `/api/v4/projects/<id-or-path>/...` for the fixture project.
 *
 * Bun may leave `%2F` encoded or decode it to a slash. Both forms map to
 * project id `1` or path `fixture/repo`.
 */
function routeProject(pathname: string): { rest: string } | null {
  const marker = "/api/v4/projects/";
  if (!pathname.startsWith(marker)) return null;
  const remainder = pathname.slice(marker.length);
  const prefixes = ["1", "fixture%2Frepo", "fixture/repo"];
  for (const prefix of prefixes) {
    if (remainder === prefix) return { rest: "" };
    if (remainder.startsWith(`${prefix}/`)) {
      return { rest: remainder.slice(prefix.length) };
    }
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
