/**
 * GitHub.com-backed workspace worker fixture.
 *
 * Runs the real built CLI as a long-lived `devintern worker` against the
 * dedicated, shared GitHub fixture repository (`E2E_GITHUB_REPOSITORY`). The
 * worker authenticates in plain token mode: `GITHUB_TOKEN` only, no GitHub App
 * credentials and no relay, so it opens PRs, polls CI and posts escalation
 * comments as the token's own identity.
 *
 * Because the repository is shared, every ref this fixture touches is unique
 * to the run: the base is `e2e/base-<uuid>` and the injected task title starts
 * with a short run id so the worker's `feature/local-<slug>` head is unique
 * too. Every branch and PR is recorded the moment it is created or expected,
 * and {@link GitHubWorkerFixture.dispose} closes those PRs and deletes those
 * branches only. Commit statuses cannot be deleted; they stay scoped to the
 * run's unique head SHAs and unique contexts.
 */

import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitHub, PullRequest } from "../providers/github";
import { collectGitHubCleanupFailures, throwCleanupFailures } from "./cleanup";
import { checkedCommand } from "./process";
import { WorkerFixture } from "./worker";
import type { WorkerFixtureOptions } from "./worker";

const packageRoot = resolve(import.meta.dir, "..");
const fixture = join(packageRoot, "fixtures/simple-project");

/**
 * Poll GitHub Issues of the fixture repository instead of the default
 * credential-free markdown tracker. The issues live in the same repository
 * the worker opens PRs on (the tracker repository doubles as code host).
 */
export interface GitHubIssuesPolling {
  /** `[defaults].task_query`, in GitHub search syntax. */
  query: string;
  /** Status labels written to `[trackers.github.projects."<repo>"]`. */
  statuses: { todoStatus: string; inProgressStatus: string; prStatus: string };
  /** Mutually-exclusive status label set (`GITHUB_STATUS_LABELS`). */
  statusLabels: string[];
}

export interface GitHubWorkerOptions extends WorkerFixtureOptions {
  /** Enable the worker's CI repair acquirer (`[workspace] ci_failure_fix`). */
  ciFailureFix?: boolean;
  /** Worker poll interval in seconds; defaults to 1 for fast tests. */
  pollIntervalSeconds?: number;
  /**
   * Poll GitHub Issues with tracker comments and status transitions on.
   * Use a poll interval of several seconds: every poll is a GitHub search
   * request, and search allows 30 requests per minute.
   */
  issues?: GitHubIssuesPolling;
}

/**
 * Worker daemon backed by unique refs in the shared GitHub fixture repository.
 *
 * Call {@link setup}, enqueue work with {@link addRunTask}, then `start()`.
 * Always call {@link dispose} in `finally`.
 */
export class GitHubWorkerFixture extends WorkerFixture {
  readonly id = `e2e-${crypto.randomUUID()}`;
  /** Unique base branch seeded by this run; never the repo default branch. */
  readonly base = `e2e/base-${this.id}`;
  /** Every remote branch this run created or expects the worker to create. */
  readonly ownedBranches = new Set<string>();
  /** Every PR number this run observed for its own branches. */
  readonly ownedPulls = new Set<number>();
  /** Statuses posted by this run (not deletable; reported for traceability). */
  readonly postedStatuses: Array<{ sha: string; context: string }> = [];

  constructor(
    readonly github: GitHub,
    private readonly token: string,
    private readonly githubOptions: GitHubWorkerOptions = {},
  ) {
    super({ rootPrefix: "devintern-e2e-github-worker-", ...githubOptions });
  }

  /** Short run id placed first in task titles so `local-<slug>` keys stay unique. */
  get shortId(): string {
    return this.id.slice(4, 12);
  }

  /**
   * Preflight the repository, seed the unique base branch, and write an
   * isolated workspace pointing the worker at it.
   */
  async setup(): Promise<void> {
    await this.github.assertWritable();
    this.prepareAgent();
    this.configureGitHubAuthentication();
    if (this.githubOptions.issues) {
      Object.assign(this.env, {
        TASK_TRACKER: "github",
        GITHUB_REPO: this.github.repository,
        GITHUB_STATUS_LABELS: this.githubOptions.issues.statusLabels.join(","),
      });
    }
    await this.seedRemote();
    this.writeWorkspace();
  }

  /**
   * Enqueue an injected task whose key (and so its head branch) is unique to
   * this run, and record that head as owned before the worker can push it.
   */
  async addRunTask(input: { title: string; body: string }) {
    const task = await this.addTask({
      title: `E2E ${this.shortId} ${input.title}`,
      body: input.body,
    });
    if (!task.task_key.includes(this.shortId)) {
      throw new Error(`Injected task key ${task.task_key} is not unique to run ${this.id}`);
    }
    this.ownedBranches.add(`feature/${task.task_key}`);
    return task;
  }

  /** Record a branch the worker actually used (for example an `-attempt-N` head). */
  ownBranch(branch: string): void {
    this.ownedBranches.add(branch);
  }

  /** Wait for this run's PR on `head` (scoped to the unique base) and record it. */
  async waitForPull(head: string): Promise<PullRequest> {
    this.ownBranch(head);
    const pull = await this.github.waitForPull(head, this.base);
    this.ownedPulls.add(pull.number);
    return pull;
  }

  /** Post a `failure` commit status with a unique context on one of this run's heads. */
  async postFailedStatus(sha: string, context: string): Promise<void> {
    this.postedStatuses.push({ sha, context });
    await this.github.createCommitStatus(sha, { state: "failure", context });
  }

  /** Remote SHA of one of this run's branches. */
  remoteSha(branch: string): Promise<string | undefined> {
    return this.github.branchSha(branch);
  }

  /** Wait for a remote branch to move past `previousSha`. */
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
      await Bun.sleep(1_000);
    }
  }

  /** Wait for a PR conversation comment whose body contains `text`. */
  async waitForPullComment(
    number: number,
    text: string,
    timeoutMs = 90_000,
  ): Promise<{ body: string; user: { login: string } }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const comment = (await this.github.issueComments(number)).find((candidate) =>
        candidate.body.includes(text),
      );
      if (comment) return comment;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for a PR comment containing ${JSON.stringify(text)}\n${this.tail()}`,
        );
      }
      await Bun.sleep(1_000);
    }
  }

  /** Whether the worker recorded a CI failure id as handled in `processed_events`. */
  isProcessed(source: string, externalId: string): boolean {
    return (
      this.query<{ one: number }>(
        "SELECT 1 AS one FROM processed_events WHERE source = ? AND external_id = ?",
        [source, externalId],
      ).length > 0
    );
  }

  /** CI-fix invocations recorded by the deterministic agent. */
  ciInvocations(): number {
    return this.agentInvocations().filter((invocation) => invocation.mode === "ci").length;
  }

  /** File contents on a remote branch, read through the GitHub API. */
  override branchFile(branch: string, path: string): Promise<string> {
    return this.github.fileContents(path, branch);
  }

  /** Worker log tail with the token (raw and URL-encoded) redacted. */
  override tail(): string {
    return redact(super.tail(), this.token);
  }

  /**
   * Stop the daemon, close this run's open PRs and delete its branches, then
   * remove temporary paths. Every step is attempted; failures name resources.
   */
  override async dispose(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.stop();
    } catch (error) {
      errors.push(error);
    }
    const failures = await collectGitHubCleanupFailures(this.github, this.ownedBranches, this.base);
    // A PR recorded by number whose head ref differs (should not happen) is
    // still closed explicitly.
    for (const number of this.ownedPulls) {
      try {
        const pull = await this.github.request<PullRequest>(`/pulls/${number}`);
        if (pull.state === "open") {
          await this.github.request(`/pulls/${number}`, "PATCH", { state: "closed" });
        }
      } catch (error) {
        failures.push({ resource: `pull:#${number}`, error });
      }
    }
    try {
      await super.dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      throwCleanupFailures(
        `GitHub worker cleanup failed for ${this.id}; branches ${[...this.ownedBranches].join(", ")}`,
        failures,
      );
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(errors, `GitHub worker cleanup failed for ${this.id}`);
    }
  }

  private prepareAgent(): void {
    const agent = join(this.root, "agent.ts");
    cpSync(join(packageRoot, "helpers/fake-agent.ts"), agent);
    chmodSync(agent, 0o700);
    this.env.AGENT_CLI_PATH = agent;
    this.env.E2E_AGENT_INVOCATIONS = join(this.root, "agent-invocations.jsonl");
    // Review/CI children otherwise share a deterministic /tmp worktree by branch.
    this.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(this.root, "review-worktree");
  }

  /**
   * Token-mode GitHub identity. The isolated environment is an allowlist, so
   * the developer shell's `GITHUB_APP_*`, `DEVINTERN_GITHUB_AUTH_MODE`,
   * `GITHUB_BOT_ALIASES`, relay and proxy settings never reach the worker; only
   * `GITHUB_TOKEN` is set here on purpose. Git reads the token through askpass,
   * never from a URL or argv.
   */
  private configureGitHubAuthentication(): void {
    const askpass = join(this.root, "askpass.sh");
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$E2E_GIT_USERNAME" ;;\n  *Password*) printf "%s\\n" "$E2E_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o700 },
    );
    Object.assign(this.env, {
      GITHUB_TOKEN: this.token,
      E2E_GIT_TOKEN: this.token,
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

  private get remoteUrl(): string {
    return `https://github.com/${this.github.repository}.git`;
  }

  private async seedRemote(): Promise<void> {
    cpSync(fixture, this.seed, { recursive: true });
    const git = (...args: string[]) => checkedCommand(["git", ...args], this.seed, this.env);
    await git("init", "--initial-branch", this.base);
    await git("remote", "add", "origin", this.remoteUrl);
    await git("add", ".");
    await git("commit", "-m", "Seed GitHub worker E2E fixture");
    // Own the base before pushing so a partially failed push is still cleaned.
    this.ownBranch(this.base);
    await git("push", "--set-upstream", "origin", this.base);
  }

  private writeWorkspace(): void {
    const issues = this.githubOptions.issues;
    // Issue polling keeps tracker comments and status labels on; the injected
    // markdown tasks have no tracker to comment on.
    const taskArgs = issues
      ? `--create-pr --skip-clarity-check --pr-target-branch ${this.base}`
      : `--create-pr --skip-clarity-check --skip-comments --pr-target-branch ${this.base}`;
    mkdirSync(this.workspaceDir, { recursive: true });
    writeFileSync(
      join(this.workspaceDir, "workspace.toml"),
      [
        "[workspace]",
        "dashboard = false",
        `ci_failure_fix = ${this.githubOptions.ciFailureFix === true}`,
        "",
        "[workspace.execution]",
        'isolation = "best_effort_host"',
        `max_concurrency = ${this.githubOptions.maxConcurrency ?? 1}`,
        `max_concurrency_per_repo = ${this.githubOptions.maxConcurrencyPerRepo ?? 1}`,
        "",
        "[defaults]",
        `tracker = ${JSON.stringify(issues ? "github" : "markdown")}`,
        ...(issues ? [`task_query = ${JSON.stringify(issues.query)}`] : []),
        `poll_interval = ${this.githubOptions.pollIntervalSeconds ?? 1}`,
        // The task subprocess resolves an implicit PR target from the remote
        // HEAD (the shared repository's real default branch), not from
        // `[[repos]].default_branch`. Pin the run's unique base so a PR can
        // never target the shared default branch.
        `worker_task_args = ${JSON.stringify(taskArgs)}`,
        "",
        "[[repos]]",
        `name = "${this.repoName}"`,
        `remote = ${JSON.stringify(this.remoteUrl)}`,
        `default_branch = ${JSON.stringify(this.base)}`,
        "",
        ...(issues
          ? [
              `[trackers.github.projects.${JSON.stringify(this.github.repository)}]`,
              `todo_status = ${JSON.stringify(issues.statuses.todoStatus)}`,
              `in_progress_status = ${JSON.stringify(issues.statuses.inProgressStatus)}`,
              `pr_status = ${JSON.stringify(issues.statuses.prStatus)}`,
              "",
            ]
          : []),
      ].join("\n"),
    );
  }
}

/** Replace a token and its URL-encoded form in diagnostic text. */
export function redact(text: string, token: string): string {
  if (!token) return text;
  let result = text.split(token).join("[REDACTED]");
  const encoded = encodeURIComponent(token);
  if (encoded !== token) result = result.split(encoded).join("[REDACTED]");
  return result;
}
