/**
 * GitLab-backed workspace worker fixture.
 *
 * Runs the real built CLI as a long-lived `devintern worker` against one
 * disposable GitLab project. The worker receives the same environment a real
 * workspace would: the GitLab code-host opt-in, a Developer project token for
 * API and Git access, and a workspace whose only repo points at the project.
 */

import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GitLab, GitLabProject, MergeRequest } from "../providers/gitlab";
import { checkedCommand } from "./process";
import { WorkerFixture } from "./worker";
import type { WorkerFixtureOptions } from "./worker";

const packageRoot = resolve(import.meta.dir, "..");
const fixture = join(packageRoot, "fixtures/simple-project");
const DEFAULT_PR_LABEL = "devintern-e2e";

interface ProjectToken {
  token: string;
  user_id: number;
}

interface Discussion {
  id: string;
  notes: Array<{ body: string; author: { id: number } }>;
}

export interface GitLabWorkerOptions extends WorkerFixtureOptions {
  /** Tracker used for the workspace query; defaults to markdown injection-only. */
  tracker?: "markdown" | "gitlab";
  /** Ready-tasks query for a polling workspace. Injected-only workspaces omit it. */
  taskQuery?: string;
  /** Enable the worker's GitLab CI repair acquirer. */
  ciFailureFix?: boolean;
  /** Conflict policy passed through to the workspace. */
  conflictResolution?: "auto" | "scheduled" | "disabled";
  /** PR labels written to the repo config; defaults to `devintern-e2e`. */
  prLabels?: string[];
  /** Worker poll interval in seconds; defaults to 1 for fast tests. */
  pollIntervalSeconds?: number;
  /** Suppress tracker comments/status transitions; defaults to true. */
  skipComments?: boolean;
}

/**
 * Worker daemon backed by a disposable GitLab project.
 *
 * Call {@link setup}, enqueue work, then {@link start}. Always call
 * {@link dispose} in `finally` so the daemon stops and the project is
 * permanently removed.
 */
export class GitLabWorkerFixture extends WorkerFixture {
  readonly id = `e2e-${crypto.randomUUID()}`;
  readonly gitlab: GitLab;
  project?: GitLabProject;
  private codeHostToken = "";
  private codeHostUserId = 0;

  constructor(
    gitlab: GitLab,
    private readonly rootToken: string,
    private readonly gitlabOptions: GitLabWorkerOptions = {},
  ) {
    super(gitlabOptions);
    this.gitlab = gitlab;
  }

  /** Developer project identity used by the worker for API and Git operations. */
  get token(): string {
    if (!this.codeHostToken) throw new Error("GitLab worker fixture has not been set up");
    return this.codeHostToken;
  }

  /** Project bot user id, used to distinguish the worker's own review replies. */
  get botUserId(): number {
    if (!this.codeHostUserId) throw new Error("GitLab worker fixture has not been set up");
    return this.codeHostUserId;
  }

  projectId(): number {
    if (!this.project) throw new Error("GitLab project has not been provisioned");
    return this.project.id;
  }

  /**
   * Create the project, seed its base branch, and write an isolated workspace.
   *
   * The project access token mirrors the worker identity documented for
   * GitLab: Developer access, `api` scope, and a short expiry removed with the
   * disposable project.
   */
  async setup(): Promise<void> {
    this.project = await this.gitlab.createProject(this.id);
    if (this.gitlabOptions.ciFailureFix) {
      // The shared fixture disables CI to keep unrelated projects quiet. The
      // CI-repair scenario needs the pipelines/statuses endpoints readable.
      await this.gitlab.request(`/projects/${this.project.id}`, "PUT", {
        builds_access_level: "enabled",
      });
    }
    const remote = new URL(this.project.http_url_to_repo);
    if (
      remote.origin !== new URL(this.gitlab.baseUrl).origin ||
      remote.username ||
      remote.password
    ) {
      throw new Error("GitLab returned an unexpected clone URL");
    }

    // Seed the protected initial branch as the fixture owner. A Developer
    // project token cannot push the initial commit to a protected default
    // branch, but the worker only pushes feature branches after this point.
    this.prepareAgent();
    this.configureGitAuthentication(this.rootToken);
    await this.seedRemote();

    const projectToken = await this.gitlab.request<ProjectToken>(
      `/projects/${this.project.id}/access_tokens`,
      "POST",
      {
        name: "e2e-worker",
        scopes: ["api"],
        access_level: 30,
        expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      },
    );
    this.codeHostToken = projectToken.token;
    this.codeHostUserId = projectToken.user_id;
    this.configureGitAuthentication(this.codeHostToken);
    await this.gitlab.request(`/projects/${this.project.id}`, "PUT", {
      default_branch: this.baseBranch,
    });
    for (const label of this.gitlabOptions.prLabels ?? [DEFAULT_PR_LABEL]) {
      await this.ensureLabel(label);
    }
    this.writeWorkspace(remote.toString());
  }

  /** Create a project label once; GitLab's duplicate response is idempotent. */
  async ensureLabel(name: string): Promise<void> {
    try {
      await this.gitlab.request(`/projects/${this.projectId()}/labels`, "POST", {
        name,
        color: "#ededed",
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("HTTP 409")) throw error;
    }
  }

  /** Create an issue in the fixture project for tracker-polling scenarios. */
  createIssue(input: {
    title: string;
    description: string;
    labels?: string[];
  }): Promise<{ iid: number; web_url: string }> {
    return this.gitlab.request(`/projects/${this.projectId()}/issues`, "POST", {
      title: input.title,
      description: input.description,
      ...(input.labels && input.labels.length > 0 ? { labels: input.labels.join(",") } : {}),
    });
  }

  /** Publish a failed external commit status for the current MR head. */
  async createFailedCommitStatus(sha: string, name: string): Promise<void> {
    await this.gitlab.request(`/projects/${this.projectId()}/statuses/${sha}`, "POST", {
      state: "failed",
      name,
      target_url: `${this.gitlab.baseUrl}/${this.project!.path_with_namespace}/-/jobs/e2e`,
    });
  }

  /**
   * Commit a file to the remote base branch.
   *
   * The fixture owner (not the Developer worker identity) pushes because the
   * project's default branch is protected. Ignored fixture files such as
   * `.devintern-code/settings.json` are force-added so they reach the worker's
   * checkout.
   */
  async writeBaseFile(path: string, contents: string): Promise<string> {
    const env = { ...this.env, E2E_GIT_TOKEN: this.rootToken };
    const git = (...args: string[]) => checkedCommand(["git", ...args], this.seed, env);
    await git("checkout", this.baseBranch);
    const absolute = join(this.seed, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
    await git("add", "-f", path);
    await git("commit", "-m", `Add ${path} to the GitLab worker base branch`);
    await git("push", "origin", this.baseBranch);
    return git("rev-parse", "HEAD").then((sha) => sha.trim());
  }

  /** Advance the remote base branch with a conflicting fixture change. */
  async advanceBase(contents: string): Promise<string> {
    return this.writeBaseFile("src/greeting.ts", contents);
  }

  /** Post a human discussion with the fixture's root identity. */
  postDiscussion(mergeRequestIid: number, body: string): Promise<Discussion> {
    return this.gitlab.request<Discussion>(
      `/projects/${this.projectId()}/merge_requests/${mergeRequestIid}/discussions`,
      "POST",
      { body },
    );
  }

  /** Read one discussion including replies that arrived after creation. */
  getDiscussion(mergeRequestIid: number, discussionId: string): Promise<Discussion> {
    return this.gitlab.request<Discussion>(
      `/projects/${this.projectId()}/merge_requests/${mergeRequestIid}/discussions/${discussionId}`,
    );
  }

  /** Wait for an issue to reach the expected label set. */
  async waitForIssueLabels(
    issueIid: number,
    predicate: (labels: string[]) => boolean,
    timeoutMs = 60_000,
  ): Promise<{ labels: string[]; state: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const issue = await this.gitlab.request<{ labels: string[]; state: string }>(
        `/projects/${this.projectId()}/issues/${issueIid}`,
      );
      if (predicate(issue.labels)) return issue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for issue !${issueIid} labels; got ${JSON.stringify(issue.labels)}\n${this.tail()}`,
        );
      }
      await Bun.sleep(500);
    }
  }

  /** Wait for an MR note whose body contains `text`. */
  async waitForMergeRequestNote(
    mergeRequestIid: number,
    text: string,
    timeoutMs = 60_000,
  ): Promise<{ body: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const notes = await this.gitlab.request<Array<{ body: string }>>(
        `/projects/${this.projectId()}/merge_requests/${mergeRequestIid}/notes?per_page=100`,
      );
      const note = notes.find((candidate) => candidate.body.includes(text));
      if (note) return note;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for an MR note containing ${JSON.stringify(text)}\n${this.tail()}`,
        );
      }
      await Bun.sleep(500);
    }
  }

  /** Wait for an MR to exist, optionally only once it carries `expectedSha`. */
  waitForMergeRequest(branch: string, expectedSha?: string): Promise<MergeRequest> {
    return this.gitlab.waitForMergeRequest(this.projectId(), branch, expectedSha);
  }

  /**
   * Wait for the remote branch itself to move past `previousSha`.
   *
   * GitLab can lag the merge-request `sha` field after a push that was not
   * accompanied by a discussion event; the branch is the authoritative head.
   */
  async waitForBranchHead(
    branch: string,
    previousSha: string,
    timeoutMs = 60_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await this.remoteSha(branch);
      if (current && current !== previousSha) return current;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${branch} to move past ${previousSha}\n${this.tail()}`,
        );
      }
      await Bun.sleep(500);
    }
  }

  /** SHA of a branch in the GitLab remote. */
  async remoteSha(branch: string): Promise<string | undefined> {
    const value = await checkedCommand(
      ["git", "ls-remote", "origin", `refs/heads/${branch}`],
      this.seed,
      this.env,
    );
    return value ? value.split(/\s+/)[0] : undefined;
  }

  /** Exact contents of a file on a remote branch, read through the GitLab API. */
  override async branchFile(branch: string, path: string): Promise<string> {
    const file = await this.gitlab.request<{ content: string }>(
      `/projects/${this.projectId()}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
    );
    // GitLab returns base64 content; strip line wrapping before decoding.
    return Buffer.from(file.content.replace(/\s+/g, ""), "base64").toString();
  }

  /** Stop the daemon, remove the disposable project, and delete temporary paths. */
  override async dispose(): Promise<void> {
    await this.stop();
    try {
      // Project deletion can return a transient 500 while GitLab finishes
      // background work from the just-stopped worker; a 404 means an earlier
      // attempt already removed it.
      let lastError: unknown;
      for (let attempt = 1; this.project && attempt <= 3; attempt++) {
        try {
          await this.gitlab.deleteProject(this.project);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if ((error as Error).message.includes("HTTP 404")) {
            lastError = undefined;
            break;
          }
          if (attempt < 3) await Bun.sleep(1_000 * attempt);
        }
      }
      if (lastError) throw lastError;
    } finally {
      await super.dispose();
    }
  }

  private prepareAgent(): void {
    const agent = join(this.root, "agent.ts");
    cpSync(join(packageRoot, "helpers/fake-agent.ts"), agent);
    chmodSync(agent, 0o700);
    this.env.AGENT_CLI_PATH = agent;
    this.env.E2E_AGENT_INVOCATIONS = join(this.root, "agent-invocations.jsonl");
    // Review/conflict children otherwise share a deterministic /tmp worktree
    // by branch name, letting sequential scenarios collide with each other.
    this.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(this.root, "review-worktree");
  }

  private configureGitAuthentication(token: string): void {
    const askpass = join(this.root, "askpass.sh");
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$E2E_GIT_USERNAME" ;;\n  *Password*) printf "%s\\n" "$E2E_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o700 },
    );
    Object.assign(this.env, {
      DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
      GITLAB_CODE_HOST_URL: this.gitlab.baseUrl,
      GITLAB_CODE_HOST_TOKEN: token,
      E2E_GIT_TOKEN: token,
      E2E_GIT_USERNAME: "x-access-token",
      GIT_ASKPASS: askpass,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "commit.gpgsign",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/dev/null",
    });
  }

  private async seedRemote(): Promise<void> {
    cpSync(fixture, this.seed, { recursive: true });
    const git = (...args: string[]) => checkedCommand(["git", ...args], this.seed, this.env);
    await git("init", "--initial-branch", this.baseBranch);
    await git("remote", "add", "origin", this.project!.http_url_to_repo);
    await git("add", ".");
    await git("commit", "-m", "Seed GitLab worker fixture");
    await git("push", "--set-upstream", "origin", this.baseBranch);
  }

  private writeWorkspace(remoteUrl: string): void {
    const prLabels = this.gitlabOptions.prLabels ?? [DEFAULT_PR_LABEL];
    mkdirSync(this.workspaceDir, { recursive: true });
    writeFileSync(
      join(this.workspaceDir, "workspace.toml"),
      [
        "[workspace]",
        "dashboard = false",
        `ci_failure_fix = ${this.gitlabOptions.ciFailureFix === true}`,
        ...(this.gitlabOptions.conflictResolution
          ? [`conflict_resolution = "${this.gitlabOptions.conflictResolution}"`]
          : []),
        "",
        "[workspace.execution]",
        'isolation = "best_effort_host"',
        `max_concurrency = ${this.gitlabOptions.maxConcurrency ?? 1}`,
        `max_concurrency_per_repo = ${this.gitlabOptions.maxConcurrencyPerRepo ?? 1}`,
        "",
        "[defaults]",
        `tracker = "${this.gitlabOptions.tracker ?? "markdown"}"`,
        ...(this.gitlabOptions.taskQuery
          ? [`task_query = ${JSON.stringify(this.gitlabOptions.taskQuery)}`]
          : []),
        `poll_interval = ${this.gitlabOptions.pollIntervalSeconds ?? 1}`,
        `pr_labels = [${prLabels.map((label) => JSON.stringify(label)).join(", ")}]`,
        `worker_task_args = "--create-pr --skip-clarity-check${
          this.gitlabOptions.skipComments === false ? "" : " --skip-comments"
        }"`,
        "",
        "[[repos]]",
        `name = "${this.repoName}"`,
        `remote = ${JSON.stringify(remoteUrl)}`,
        `default_branch = "${this.baseBranch}"`,
        "",
      ].join("\n"),
    );
  }
}
