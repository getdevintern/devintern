/**
 * Loopback GitLab v4 stand-in for offline conflict-resolution tests.
 *
 * Serves only the endpoints the worker conflict path actually calls, and
 * reads branch SHAs from a local bare repository. `diff_refs.base_sha` is
 * the merge base of the two tips, and `start_sha` is the target tip.
 * Mergeability is `git merge-tree --write-tree` of the source tip into the
 * target tip: a clean result is `mergeable`, and a conflicted result is
 * `conflict`. A git failure is thrown so the handler returns 500 instead of
 * a false conflict. No token, header, or body is written to the request log.
 *
 * With the optional `review` discussion the same MR also serves the
 * address-review path: one unresolved reviewer discussion, plus replies posted
 * to it. With the optional `ci` failure it also serves the CI-repair reads:
 * one pipeline with one job (failed unless `setCiStatus` says otherwise) for a
 * pinned head SHA, that job's trace, and an empty commit-status list. Requests
 * no route serves get a 404 and are recorded in `unexpected`.
 */

import { spawnSync } from "node:child_process";

export const FAKE_GITLAB_TOKEN = "e2e-local-forge-token";

const PROJECT_ID = 1;
const PROJECT_PATH = "fixture/repo";
const USER_ID = 7;
const REVIEWER_ID = 42;

export interface ForgeRequest {
  method: string;
  path: string;
}

/** One unresolved reviewer discussion served on MR !1 (address-review path). */
export interface FakeGitlabReviewDiscussion {
  /** GitLab discussion id (an opaque hex string upstream). */
  discussionId: string;
  /** Note id of the reviewer's comment. */
  noteId: number;
  /** Reviewer comment body that should reach the agent prompt. */
  body: string;
  /** Reviewer username; never the forge's own bot user. */
  reviewer: string;
}

/**
 * One failed pipeline and job served for a single commit (CI-repair path).
 *
 * `GET pipelines?sha=<sha>` lists the pipeline only for `sha`, so a commit
 * pushed by the repair run (or any other SHA) has no pipelines.
 */
export interface FakeGitlabCiFailure {
  /** Head SHA the failed pipeline ran on. */
  sha: string;
  pipelineId: number;
  jobId: number;
  /** Failed job name that should reach the agent prompt. */
  jobName: string;
  /** Raw job trace served from `jobs/<jobId>/trace`. */
  trace: string;
}

/** Pipeline and job status {@link FakeGitlabForge.setCiStatus} can serve. */
export type FakeGitlabCiStatus = "failed" | "running" | "success";

/** A reply the review run posted to a served discussion. */
export interface FakeGitlabDiscussionReply {
  discussionId: string;
  body: string;
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
  /**
   * Serve this unresolved discussion from `merge_requests/1/discussions` and
   * accept replies to it. Without it the MR has no discussions (conflict path).
   */
  review?: FakeGitlabReviewDiscussion;
  /**
   * Serve one failed pipeline/job and its trace for `ci.sha`. Without it the
   * pipeline, job, trace, and commit-status routes stay unserved (404).
   */
  ci?: FakeGitlabCiFailure;
}

/** Minimal local GitLab API bound to `127.0.0.1`. */
export class FakeGitlabForge {
  readonly requests: ForgeRequest[] = [];
  readonly notes: string[] = [];
  readonly authFailures: string[] = [];
  /** Replies posted to the `review` discussion, in order. */
  readonly discussionReplies: FakeGitlabDiscussionReply[] = [];
  /** Requests that matched no served route (answered 404). */
  readonly unexpected: ForgeRequest[] = [];
  readonly baseUrl: string;
  readonly mergeRequestUrl: string;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly options: Required<Pick<FakeGitlabForgeOptions, "token">> &
    FakeGitlabForgeOptions;
  private ciStatus: FakeGitlabCiStatus = "failed";

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

  /**
   * Serve the `ci` pipeline and its job with `status` from now on (default
   * `failed`), so one run can show a passing pipeline before a failing one.
   */
  setCiStatus(status: FakeGitlabCiStatus): void {
    this.ciStatus = status;
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
    if (!routed) return this.notFound(request.method, path);
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
    if (mr?.[1] === "discussions" && request.method === "GET") return json(this.discussions());
    if (mr?.[1] === "notes" && request.method === "POST") return this.postNote(request);
    if (mr?.[1] === "merge") return json({ message: "not found" }, 404);

    const reply = rest.match(/^\/merge_requests\/1\/discussions\/([^/]+)\/notes$/);
    const discussionId = reply?.[1] ? decodeURIComponent(reply[1]) : undefined;
    if (
      discussionId !== undefined &&
      discussionId === this.options.review?.discussionId &&
      request.method === "POST"
    ) {
      return this.postDiscussionReply(request, discussionId);
    }

    const branch = rest.match(/^\/repository\/branches\/(.+)$/);
    if (branch?.[1] && request.method === "GET") {
      const name = decodeURIComponent(branch[1]);
      if (!this.refExists(name)) return json({ message: "not found" }, 404);
      return json({ name, can_push: true });
    }

    const url = new URL(request.url);
    const ci = this.options.ci;
    if (ci && request.method === "GET") {
      const served = this.routeCi(ci, rest, url.searchParams);
      if (served) return served;
    }
    return this.notFound(request.method, `${url.pathname}${url.search}`);
  }

  /** CI-repair reads for the opt-in failed pipeline. `null` leaves the 404 path. */
  private routeCi(ci: FakeGitlabCiFailure, rest: string, query: URLSearchParams): Response | null {
    if (rest === "/pipelines") {
      if (query.get("sha") !== ci.sha) return json([]);
      return json([
        {
          id: ci.pipelineId,
          sha: ci.sha,
          ref: this.options.sourceBranch,
          status: this.ciStatus,
          web_url: `${this.baseUrl}/${PROJECT_PATH}/-/pipelines/${ci.pipelineId}`,
        },
      ]);
    }
    if (rest === `/pipelines/${ci.pipelineId}/jobs`) {
      return json([
        {
          id: ci.jobId,
          name: ci.jobName,
          status: this.ciStatus,
          allow_failure: false,
          web_url: `${this.baseUrl}/${PROJECT_PATH}/-/jobs/${ci.jobId}`,
        },
      ]);
    }
    if (rest === `/jobs/${ci.jobId}/trace`) {
      return new Response(ci.trace, { headers: { "content-type": "text/plain" } });
    }
    const statuses = rest.match(/^\/repository\/commits\/([^/]+)\/statuses$/);
    if (statuses?.[1]) return json([]);
    return null;
  }

  /** Strict routing: answer 404 and remember the request (method and path only). */
  private notFound(method: string, path: string): Response {
    this.unexpected.push({ method, path });
    return json({ message: "not found" }, 404);
  }

  private discussions(): unknown[] {
    const review = this.options.review;
    if (!review) return [];
    return [
      {
        id: review.discussionId,
        individual_note: false,
        notes: [
          {
            id: review.noteId,
            body: review.body,
            author: { id: REVIEWER_ID, username: review.reviewer, state: "active" },
            created_at: "2026-01-01T00:00:00.000Z",
            system: false,
            resolvable: true,
            resolved: false,
            position: null,
          },
          // Replies come from the forge's own user, which the product skips
          // as non-human feedback.
          ...this.discussionReplies.map((entry, index) => ({
            id: review.noteId + index + 1,
            body: entry.body,
            author: { id: USER_ID, username: "e2e-bot", state: "active" },
            created_at: "2026-01-01T00:00:01.000Z",
            system: false,
            resolvable: true,
            resolved: false,
            position: null,
          })),
        ],
      },
    ];
  }

  private async postDiscussionReply(request: Request, discussionId: string): Promise<Response> {
    let body = "";
    try {
      const parsed = (await request.json()) as { body?: unknown };
      body = typeof parsed.body === "string" ? parsed.body : "";
    } catch {
      body = "";
    }
    this.discussionReplies.push({ discussionId, body });
    return json({ id: (this.options.review?.noteId ?? 0) + this.discussionReplies.length, body });
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
    const start = this.revParse(this.options.targetBranch);
    // base_sha is where the branches diverged. The target tip is start_sha.
    // Production copies base_sha into the poll snapshot and compares it with
    // origin/<target>, which is this start SHA once the target has moved on.
    const base = this.mergeBase(this.options.sourceBranch, this.options.targetBranch);
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
      detailed_merge_status: this.detailedMergeStatus(start, head),
      diff_refs: { base_sha: base, start_sha: start, head_sha: head },
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

  /** Commit where `source` and `target` diverged. GitLab calls this `base_sha`. */
  private mergeBase(source: string, target: string): string {
    const result = spawnSync(
      this.options.gitBin,
      [
        "--git-dir",
        this.options.gitDir,
        "merge-base",
        `refs/heads/${source}`,
        `refs/heads/${target}`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      const detail = (
        result.stderr ||
        result.stdout ||
        result.error?.message ||
        "no output"
      ).trim();
      throw new Error(
        `fixture git could not find the merge base of ${source} and ${target}: ${detail}`,
      );
    }
    return result.stdout.trim();
  }

  /**
   * Mergeability of `head` into `base`.
   *
   * `git merge-tree --write-tree` exits 0 when the merge is clean and 1 when
   * the tips conflict. Any other status (missing ref, killed process, wrapper
   * failure) is thrown so {@link handle} returns 500. A nonzero status must
   * not be reported as `conflict`: post-push verification treats a conflict
   * as a dirty landed merge and treats HTTP 500 as unverified.
   */
  private detailedMergeStatus(base: string, head: string): "mergeable" | "conflict" {
    const result = spawnSync(
      this.options.gitBin,
      ["--git-dir", this.options.gitDir, "merge-tree", "--write-tree", base, head],
      { encoding: "utf8" },
    );
    if (result.status === 0) return "mergeable";
    if (result.status === 1) return "conflict";
    const detail = (result.stderr || result.stdout || result.error?.message || "no output").trim();
    throw new Error(`fixture git merge-tree failed (${result.status ?? "signal"}): ${detail}`);
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
