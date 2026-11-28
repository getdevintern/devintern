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
 * pinned head SHA, that job's trace, and an empty commit-status list. With the
 * optional `mergeRequestCreation` the forge starts with no MR and serves what
 * `GitLabMRClient.createPullRequest` calls instead: the version check, the
 * project with its default branch, branch reads, project labels, the open-MR
 * lookup, `POST merge_requests`, and the label update on an existing MR. The
 * created MRs are then served from the same read routes. Requests no route
 * serves get a 404 and are recorded in `unexpected`.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export const FAKE_GITLAB_TOKEN = "e2e-local-forge-token";

const PROJECT_ID = 1;
export const FAKE_GITLAB_PROJECT_PATH = "fixture/repo";
const PROJECT_PATH = FAKE_GITLAB_PROJECT_PATH;
const USER_ID = 7;
const REVIEWER_ID = 42;
/** Inside the product's validated GitLab release, so no version warning. */
const FAKE_GITLAB_VERSION = "19.3.0-ee";

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

/**
 * Serve MR creation instead of a pre-registered MR !1.
 *
 * `POST merge_requests` answers 409 while an open MR already exists for the
 * same source branch, the way GitLab does, so a client that falls back to the
 * open-MR lookup reuses it instead of opening a duplicate.
 */
export interface FakeGitlabMergeRequestCreation {
  /** Project labels served from `GET labels`. Defaults to none. */
  labels?: string[];
}

/** One MR the forge holds: pre-registered !1, or one a client created. */
export interface FakeGitlabMergeRequest {
  iid: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  labels: string[];
  webUrl: string;
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
  /**
   * Start with no MR and serve MR creation. Without it MR !1 exists from the
   * start and `POST merge_requests` stays unserved (404).
   */
  mergeRequestCreation?: FakeGitlabMergeRequestCreation;
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
  /**
   * MRs the forge holds, oldest first. Without `mergeRequestCreation` this is
   * the pre-registered !1; with it, only MRs a client created.
   */
  readonly mergeRequests: FakeGitlabMergeRequest[] = [];
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
    this.mergeRequestUrl = this.webUrlFor(1);
    if (!options.mergeRequestCreation) {
      this.mergeRequests.push({
        iid: 1,
        title: "Conflict PR",
        description: "",
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
        labels: [],
        webUrl: this.mergeRequestUrl,
      });
    }
  }

  /** Browser URL of MR `iid` in the fixture project. */
  webUrlFor(iid: number): string {
    return `${this.baseUrl}/${PROJECT_PATH}/-/merge_requests/${iid}`;
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

  /**
   * Serve the `ci` pipeline for `sha` from now on, after a test moved the MR
   * head, so only the new head has a failed pipeline.
   */
  setCiSha(sha: string): void {
    if (!this.options.ci) throw new Error("setCiSha needs the forge's `ci` option");
    this.options.ci = { ...this.options.ci, sha };
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
    if (
      url.pathname === "/api/v4/version" &&
      request.method === "GET" &&
      this.options.mergeRequestCreation
    ) {
      return json({ version: FAKE_GITLAB_VERSION, revision: "e2e" });
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

    const creation = this.options.mergeRequestCreation;
    if (creation) {
      const served = await this.routeCreation(request, rest, creation);
      if (served) return served;
    }

    const served = await this.routeMergeRequest(request, rest);
    if (served) return served;

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

  /**
   * Reads and notes on an MR the forge holds, and replies to the `review`
   * discussion. `null` leaves the request to the remaining routes.
   */
  private async routeMergeRequest(request: Request, rest: string): Promise<Response | null> {
    const mr = rest.match(/^\/merge_requests\/(\d+)(?:\/(discussions|notes|merge))?$/);
    const held = mr?.[1] ? this.findMergeRequest(Number(mr[1])) : undefined;
    if (mr && held && request.method === "GET" && !mr[2]) return json(this.mergeRequest(held));
    if (held && mr?.[2] === "discussions" && request.method === "GET") {
      return json(this.discussions());
    }
    if (held && mr?.[2] === "notes" && request.method === "POST") return this.postNote(request);
    if (held && mr?.[2] === "merge") return json({ message: "not found" }, 404);

    const reply = rest.match(/^\/merge_requests\/1\/discussions\/([^/]+)\/notes$/);
    const discussionId = reply?.[1] ? decodeURIComponent(reply[1]) : undefined;
    if (
      discussionId !== undefined &&
      discussionId === this.options.review?.discussionId &&
      request.method === "POST"
    ) {
      return this.postDiscussionReply(request, discussionId);
    }

    return null;
  }

  /**
   * MR-creation routes (`mergeRequestCreation`). `null` leaves the request to
   * the shared read routes and, failing those, the 404 path.
   */
  private async routeCreation(
    request: Request,
    rest: string,
    creation: FakeGitlabMergeRequestCreation,
  ): Promise<Response | null> {
    const query = new URL(request.url).searchParams;
    if (rest === "/labels" && request.method === "GET") {
      // One page: no `x-next-page`, so the client stops after it.
      return json((creation.labels ?? []).map((name, index) => ({ id: index + 1, name })));
    }
    if (rest === "/merge_requests" && request.method === "GET") {
      const state = query.get("state");
      const source = query.get("source_branch");
      const target = query.get("target_branch");
      return json(
        this.mergeRequests
          .filter(() => state === null || state === "opened")
          .filter((entry) => source === null || entry.sourceBranch === source)
          .filter((entry) => target === null || entry.targetBranch === target)
          .map((entry) => this.mergeRequest(entry)),
      );
    }
    if (rest === "/merge_requests" && request.method === "POST") {
      return this.createMergeRequest(request);
    }
    const update = rest.match(/^\/merge_requests\/(\d+)$/);
    if (update?.[1] && request.method === "PUT") {
      const held = this.findMergeRequest(Number(update[1]));
      if (!held) return null;
      const body = await readJsonBody(request);
      for (const label of splitLabels(body.add_labels)) {
        if (!held.labels.includes(label)) held.labels.push(label);
      }
      return json(this.mergeRequest(held));
    }
    return null;
  }

  /**
   * `POST merge_requests`: 422 for a missing branch, 409 while an open MR
   * already uses the source branch (GitLab's duplicate guard), else create.
   */
  private async createMergeRequest(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const source = typeof body.source_branch === "string" ? body.source_branch : "";
    const target = typeof body.target_branch === "string" ? body.target_branch : "";
    if (!source || !target || !this.refExists(source) || !this.refExists(target)) {
      return json({ message: ["Source or target branch does not exist"] }, 422);
    }
    const open = this.mergeRequests.find((entry) => entry.sourceBranch === source);
    if (open) {
      return json(
        {
          message: [
            `Another open merge request already exists for this source branch: !${open.iid}`,
          ],
        },
        409,
      );
    }
    const iid = this.mergeRequests.length + 1;
    const created: FakeGitlabMergeRequest = {
      iid,
      title: typeof body.title === "string" ? body.title : "",
      description: typeof body.description === "string" ? body.description : "",
      sourceBranch: source,
      targetBranch: target,
      labels: splitLabels(body.labels),
      webUrl: this.webUrlFor(iid),
    };
    this.mergeRequests.push(created);
    return json(this.mergeRequest(created), 201);
  }

  private findMergeRequest(iid: number): FakeGitlabMergeRequest | undefined {
    return this.mergeRequests.find((entry) => entry.iid === iid);
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
      default_branch: this.options.targetBranch,
      web_url: `${this.baseUrl}/${PROJECT_PATH}`,
      permissions: { project_access: { access_level: 40 }, group_access: null },
    };
  }

  private mergeRequest(entry: FakeGitlabMergeRequest): unknown {
    const head = this.revParse(entry.sourceBranch);
    const start = this.revParse(entry.targetBranch);
    // base_sha is where the branches diverged. The target tip is start_sha.
    // Production copies base_sha into the poll snapshot and compares it with
    // origin/<target>, which is this start SHA once the target has moved on.
    const base = this.mergeBase(entry.sourceBranch, entry.targetBranch);
    return {
      iid: entry.iid,
      title: entry.title,
      description: entry.description,
      state: "opened",
      sha: head,
      source_branch: entry.sourceBranch,
      target_branch: entry.targetBranch,
      source_project_id: PROJECT_ID,
      target_project_id: PROJECT_ID,
      labels: entry.labels,
      web_url: entry.webUrl,
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

/** Parse a JSON request body; anything else reads as an empty object. */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** GitLab's comma-separated `labels` / `add_labels` field as names. */
function splitLabels(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** What {@link installForgeGitRewrite} needs from a worker or CLI fixture. */
export interface ForgeGitFixture {
  /** Fixture root; the wrapper lives under `<root>/git-bin`. */
  root: string;
  /** Local bare repository the forge URL is rewritten onto. */
  remote: string;
  /** Child environment; PATH and `GIT_CONFIG_*` are set in place. */
  env: Record<string, string>;
}

/**
 * Put a logging `git` wrapper first on PATH and rewrite `httpUrl` (the forge's
 * `<baseUrl>/<project>.git`) onto the bare repository, with an empty
 * credential helper so git never asks for or stores a credential.
 *
 * `git remote get-url` would apply `insteadOf` and show the bare path, which
 * the GitLab paths compare with the forge project, so the wrapper drops the
 * rewrite for that call only. Fetch and push still use it. Returns the path of
 * the argv log (one line per git call).
 */
export function installForgeGitRewrite(
  fixture: ForgeGitFixture,
  gitBin: string,
  httpUrl: string,
): string {
  const dir = join(fixture.root, "git-bin");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "git-argv.log");
  const wrapper = join(dir, "git");
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${quote(logPath)}`,
      "prev=",
      "strip=0",
      'for arg in "$@"; do',
      '  if [ "$prev" = "remote" ] && [ "$arg" = "get-url" ]; then strip=1; fi',
      "  prev=$arg",
      "done",
      'if [ "$strip" = 1 ]; then',
      "  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 \\",
      "    GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1 GIT_CONFIG_KEY_2 GIT_CONFIG_VALUE_2 \\",
      "    GIT_CONFIG_KEY_3 GIT_CONFIG_VALUE_3",
      "fi",
      `exec ${quote(gitBin)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(wrapper, 0o700);
  fixture.env.PATH = `${dir}${delimiter}${fixture.env.PATH ?? ""}`;
  Object.assign(fixture.env, {
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: `url.${fixture.remote}.insteadOf`,
    GIT_CONFIG_VALUE_3: httpUrl,
  });
  return logPath;
}
