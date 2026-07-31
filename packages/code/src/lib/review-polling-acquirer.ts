/**
 * Review polling acquirer (worker Mode 1, Tier 1): watch the agent's own PRs.
 *
 * Each tick, for every open PR in the `agent_prs` registry:
 * 1. Conditional GET on the PR itself — closed/merged PRs leave the watch
 *    list; 304s (rate-limit-free) skip all further work for the PR.
 * 2. Conditional GET on the review list — a new `changes_requested` review
 *    by a human is implicitly addressed to the agent (its own PR), no
 *    @mention required.
 * 3. `since`-windowed GET on inline review comments — new human comments
 *    count as feedback too.
 * 4. When anything actionable is new, run `devintern address-review` for
 *    the PR (once per tick per PR), which fetches unaddressed comments,
 *    runs the agent, pushes, and replies.
 *
 * Review/comment ids dedupe via `processed_events`, so webhook redeliveries
 * or window overlap never double-run. ETags and comment cursors persist per
 * PR in `cursors`.
 */

import { spawn } from "child_process";

import type { WebhookQueue } from "./webhook-queue";
import type { WorkerState } from "./worker-state";
import type { Acquirer } from "../worker";

export interface PolledReview {
  id: number;
  state: string;
  user: { login: string; type: string };
}

export interface PolledComment {
  id: number;
  user: { login: string; type: string };
  created_at: string;
}

export interface ConditionalResult<T> {
  data: T | null;
  etag?: string;
  notModified: boolean;
}

export interface PolledPr {
  state: string;
  /** GitHub's computed merge state; `"dirty"` means merge conflicts. */
  mergeable_state?: string;
  head?: { sha: string };
  base?: { sha: string };
}

/** GitHub access used by the poller (injected for tests). */
export interface ReviewPollingGitHub {
  fetchPr(repo: string, prNumber: number, etag?: string): Promise<ConditionalResult<PolledPr>>;
  fetchReviews(
    repo: string,
    prNumber: number,
    etag?: string,
  ): Promise<ConditionalResult<PolledReview[]>>;
  fetchReviewCommentsSince(
    repo: string,
    prNumber: number,
    sinceIso: string,
  ): Promise<PolledComment[]>;
}

export interface ReviewPollingAcquirerOptions {
  intervalSeconds: number;
  workerState: WorkerState;
  queue: WebhookQueue;
  github: ReviewPollingGitHub;
  /** Handle feedback on one PR; returns success (injected for tests). */
  addressPr: (repo: string, prNumber: number) => Promise<boolean>;
  /**
   * Resolve merge conflicts on one of the agent's own PRs (injected for
   * tests). Omit to disable automatic conflict resolution.
   */
  resolveConflicts?: (repo: string, prNumber: number) => Promise<boolean>;
  verbose?: boolean;
}

/** Dedupe source for review/comment ids. */
const SOURCE = "github:reviews";

/**
 * Run `devintern address-review` for a PR as a CLI subprocess, reusing the
 * whole manual flow (worktree, agent, push, replies, reactions).
 *
 * @param repo - `owner/repo` slug
 * @param prNumber - Pull request number
 */
export function runAddressReviewViaCli(repo: string, prNumber: number): Promise<boolean> {
  return runSubcommandViaCli("address-review", repo, prNumber);
}

/**
 * Run `devintern resolve-conflicts` for a PR as a CLI subprocess.
 *
 * @param repo - `owner/repo` slug
 * @param prNumber - Pull request number
 */
export function runResolveConflictsViaCli(repo: string, prNumber: number): Promise<boolean> {
  return runSubcommandViaCli("resolve-conflicts", repo, prNumber);
}

function runSubcommandViaCli(subcommand: string, repo: string, prNumber: number): Promise<boolean> {
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], subcommand, prUrl], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", (error) => {
      console.error(`❌ Failed to spawn ${subcommand} for ${prUrl}: ${error.message}`);
      resolve(false);
    });
  });
}

/**
 * Polls the agent's own PRs for review feedback.
 */
export class ReviewPollingAcquirer implements Acquirer {
  readonly name = "poll:reviews";
  private options: ReviewPollingAcquirerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(options: ReviewPollingAcquirerOptions) {
    this.options = options;
  }

  /** Start polling: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    console.log(
      `🔎 Polling reviews on agent PRs every ${this.options.intervalSeconds}s ` +
        `(watching ${this.options.workerState.listOpenAgentPrs().length} open PR(s))`,
    );
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
  }

  /** Stop polling (an in-flight tick finishes its current PR). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One polling cycle over all watched PRs. Skipped while busy. */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;

    try {
      for (const pr of this.options.workerState.listOpenAgentPrs()) {
        try {
          await this.pollPr(pr.repo, pr.prNumber, pr.createdAt);
        } catch (error) {
          console.warn(
            `⚠️  [${this.name}] polling ${pr.repo}#${pr.prNumber} failed: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Poll a single PR; triggers at most one address-review run. */
  private async pollPr(repo: string, prNumber: number, watchedSinceMs: number): Promise<void> {
    const { workerState, queue, github, addressPr, resolveConflicts, verbose } = this.options;

    // 1. PR state (ETag-cached): unwatch closed/merged PRs.
    const prSource = `github:pr:${repo}#${prNumber}`;
    const prCursor = workerState.getCursor(prSource);
    const prResult = await github.fetchPr(repo, prNumber, prCursor?.etag);
    if (!prResult.notModified) {
      if (prResult.etag) {
        workerState.setCursor(prSource, "state", prResult.etag);
      }
      if (prResult.data && prResult.data.state !== "open") {
        console.log(`👁️  [${this.name}] ${repo}#${prNumber} is ${prResult.data.state}; unwatching`);
        workerState.markAgentPrClosed(repo, prNumber);
        return;
      }

      // 1b. Merge conflicts with the base branch. Deduped per head+base SHA
      // pair, so a failed resolution retries only after either side moves.
      if (
        resolveConflicts &&
        prResult.data?.mergeable_state === "dirty" &&
        prResult.data.head?.sha &&
        prResult.data.base?.sha
      ) {
        const externalId = `conflict:${repo}#${prNumber}:${prResult.data.head.sha}:${prResult.data.base.sha}`;
        if (!queue.hasProcessed(SOURCE, externalId)) {
          queue.markProcessed(SOURCE, externalId);
          console.log(`\n🔀 [${this.name}] ${repo}#${prNumber} has merge conflicts with its base`);
          const ok = await resolveConflicts(repo, prNumber);
          console.log(
            ok
              ? `✅ [${this.name}] ${repo}#${prNumber} conflicts handled`
              : `⚠️  [${this.name}] ${repo}#${prNumber} conflict resolution did not complete`,
          );
        }
      }
    }

    let actionable = false;

    // 2. Reviews (ETag-cached): new human changes_requested reviews.
    const reviewsSource = `github:reviews:${repo}#${prNumber}`;
    const reviewsCursor = workerState.getCursor(reviewsSource);
    const reviewsResult = await github.fetchReviews(repo, prNumber, reviewsCursor?.etag);
    if (!reviewsResult.notModified && reviewsResult.data) {
      if (reviewsResult.etag) {
        workerState.setCursor(reviewsSource, "reviews", reviewsResult.etag);
      }
      for (const review of reviewsResult.data) {
        if (review.state.toLowerCase() !== "changes_requested" || review.user.type === "Bot") {
          continue;
        }
        const externalId = `review:${repo}#${prNumber}:${review.id}`;
        if (queue.hasProcessed(SOURCE, externalId)) {
          continue;
        }
        queue.markProcessed(SOURCE, externalId);
        actionable = true;
      }
    }

    // 3. Inline review comments since the last seen timestamp.
    const commentsSource = `github:prcomments:${repo}#${prNumber}`;
    const commentsCursor = workerState.getCursor(commentsSource);
    const sinceIso = commentsCursor?.cursorValue ?? new Date(watchedSinceMs).toISOString();
    const comments = await github.fetchReviewCommentsSince(repo, prNumber, sinceIso);
    let maxCreatedAt = sinceIso;
    for (const comment of comments) {
      if (comment.created_at > maxCreatedAt) {
        maxCreatedAt = comment.created_at;
      }
      if (comment.user.type === "Bot") {
        continue;
      }
      const externalId = `comment:${repo}#${prNumber}:${comment.id}`;
      if (queue.hasProcessed(SOURCE, externalId)) {
        continue;
      }
      queue.markProcessed(SOURCE, externalId);
      actionable = true;
    }
    if (maxCreatedAt !== sinceIso) {
      workerState.setCursor(commentsSource, maxCreatedAt);
    }

    if (!actionable) {
      if (verbose) {
        console.log(`   [${this.name}] ${repo}#${prNumber}: no new feedback`);
      }
      return;
    }

    console.log(`\n📌 [${this.name}] new review feedback on ${repo}#${prNumber}`);
    const ok = await addressPr(repo, prNumber);
    console.log(
      ok
        ? `✅ [${this.name}] ${repo}#${prNumber} feedback addressed`
        : `⚠️  [${this.name}] ${repo}#${prNumber} feedback run did not complete cleanly`,
    );
  }
}
