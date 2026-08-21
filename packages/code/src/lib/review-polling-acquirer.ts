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

import type { RunStore } from "./run-recorder";
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
  head?: { sha: string; ref?: string; repo?: { full_name: string } | null };
  base?: { sha: string; ref?: string };
}

export interface AutomaticResolveResult {
  outcome: "clean" | "resolved" | "skipped" | "failed" | "deferred";
  message: string;
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
  /** Whether the PR head contains the current base SHA; null means unavailable. */
  isBaseIncluded?(repo: string, baseSha: string, headSha: string): Promise<boolean | null>;
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
  resolveConflicts?: (
    repo: string,
    prNumber: number,
    expected: { headSha: string; baseSha: string },
  ) => Promise<AutomaticResolveResult>;
  /** Stable-head window before execution (default 30 seconds). */
  quietPeriodSeconds?: number;
  /** Best-effort automatic-attempt run recorder. */
  runStore?: Pick<RunStore, "createRun" | "finishRun">;
  harness?: string;
  now?: () => number;
  verbose?: boolean;
}

/** Dedupe source for review/comment ids. */
const SOURCE = "github:reviews";
const BASE_SYNC_SOURCE = "github:base-sync";
const prRunTails = new Map<string, Promise<void>>();

/** Serialize automatic pipelines that target the same PR worktree. */
async function serializePrRun<T>(
  repo: string,
  prNumber: number,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${repo.toLowerCase()}#${prNumber}`;
  const previous = prRunTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => tail);
  prRunTails.set(key, chained);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (prRunTails.get(key) === chained) prRunTails.delete(key);
  }
}

/**
 * Run `devintern address-review` for a PR as a CLI subprocess, reusing the
 * whole manual flow (worktree, agent, push, replies, reactions).
 *
 * @param repo - `owner/repo` slug
 * @param prNumber - Pull request number
 * @param opts - Working directory and environment for the subprocess;
 *               workspace mode runs from the repo's base worktree with
 *               per-repo env, single-repo mode inherits both
 */
export function runAddressReviewViaCli(
  repo: string,
  prNumber: number,
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<boolean> {
  return serializePrRun(repo, prNumber, () =>
    runSubcommandViaCli("address-review", repo, prNumber, opts),
  );
}

/**
 * Run `devintern resolve-conflicts` for a PR as a CLI subprocess.
 *
 * @param repo - `owner/repo` slug
 * @param prNumber - Pull request number
 * @param opts - Optional per-repo working directory and environment
 */
export function runResolveConflictsViaCli(
  repo: string,
  prNumber: number,
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    expectedHeadSha?: string;
    expectedBaseSha?: string;
  } = {},
): Promise<AutomaticResolveResult> {
  const args = [
    ...(opts.expectedHeadSha ? ["--expected-head", opts.expectedHeadSha] : []),
    ...(opts.expectedBaseSha ? ["--expected-base", opts.expectedBaseSha] : []),
  ];
  return serializePrRun(repo, prNumber, () => runResolveSubcommand(repo, prNumber, args, opts));
}

function runResolveSubcommand(
  repo: string,
  prNumber: number,
  extraArgs: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<AutomaticResolveResult> {
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  return new Promise((resolve) => {
    let marker: AutomaticResolveResult | null = null;
    let stdout = "";
    const child = spawn(
      process.execPath,
      [process.argv[1], "resolve-conflicts", prUrl, ...extraArgs],
      {
        stdio: ["inherit", "pipe", "inherit"],
        cwd: opts.cwd,
        env: { ...(opts.env ?? process.env), DEVINTERN_RESULT_MARKER: "1" },
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      const output = chunk.toString();
      stdout += output;
      process.stdout.write(output);
    });
    child.on("close", (code) => {
      const markerLine = stdout
        .split("\n")
        .find((line) => line.startsWith("DEVINTERN_RESOLVE_RESULT="));
      if (markerLine) {
        try {
          marker = JSON.parse(markerLine.slice("DEVINTERN_RESOLVE_RESULT=".length));
        } catch {
          // Exit status fallback below.
        }
      }
      resolve(
        marker ?? {
          outcome: code === 0 ? "skipped" : "failed",
          message: code === 0 ? "resolver completed" : `resolver exited with code ${code}`,
        },
      );
    });
    child.on("error", (error) =>
      resolve({ outcome: "failed", message: `failed to spawn resolver: ${error.message}` }),
    );
  });
}

function runSubcommandViaCli(
  subcommand: string,
  repo: string,
  prNumber: number,
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<boolean> {
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], subcommand, prUrl], {
      stdio: "inherit",
      cwd: opts.cwd,
      env: opts.env ?? process.env,
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
    // Deliberately unconditional: a stale PR-resource ETag must never hide a
    // moved base ref. Reviews retain their independent conditional request.
    const prResult = await github.fetchPr(repo, prNumber);
    if (!prResult.notModified) {
      if (prResult.etag) {
        workerState.setCursor(prSource, "state", prResult.etag);
      }
      if (prResult.data && prResult.data.state !== "open") {
        console.log(`👁️  [${this.name}] ${repo}#${prNumber} is ${prResult.data.state}; unwatching`);
        workerState.markAgentPrClosed(repo, prNumber);
        return;
      }

      if (resolveConflicts && prResult.data) {
        await this.maybeSyncBase(repo, prNumber, prResult.data);
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

  private async maybeSyncBase(repo: string, prNumber: number, pr: PolledPr): Promise<void> {
    const { github, queue, resolveConflicts, runStore } = this.options;
    if (!resolveConflicts || !github.isBaseIncluded) return;
    if (!pr.head?.sha || !pr.base?.sha || !pr.head.ref) return;
    const externalId = `base-sync:${repo}#${prNumber}:${pr.base.sha}`;
    if (pr.head.repo?.full_name && pr.head.repo.full_name.toLowerCase() !== repo.toLowerCase()) {
      if (!queue.hasProcessed(BASE_SYNC_SOURCE, externalId)) {
        queue.observeBaseSyncEvent({
          externalId,
          repo,
          prNumber,
          baseSha: pr.base.sha,
          headSha: pr.head.sha,
        });
        queue.completeBaseSyncEvent(BASE_SYNC_SOURCE, externalId);
      }
      return;
    }
    // GitHub reports unknown while recomputing mergeability after a push.
    if (!pr.mergeable_state || pr.mergeable_state === "unknown") return;

    const included = await github.isBaseIncluded(repo, pr.base.sha, pr.head.sha);
    if (included === null || included) return;

    if (queue.hasProcessed(BASE_SYNC_SOURCE, externalId)) return;
    const now = this.options.now?.() ?? Date.now();
    const event = queue.observeBaseSyncEvent({
      externalId,
      repo,
      prNumber,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      now,
    });
    if (event.status !== "pending") return;
    const quietMs = (this.options.quietPeriodSeconds ?? 30) * 1000;
    if (now - event.headObservedAt < quietMs) return;

    // Re-fetch immediately before execution. Any movement leaves the event
    // pending and consumes no retry; the next tick observes the new state.
    const freshResult = await github.fetchPr(repo, prNumber);
    const fresh = freshResult.data;
    if (
      !fresh ||
      fresh.state !== "open" ||
      fresh.head?.sha !== pr.head.sha ||
      fresh.base?.sha !== pr.base.sha
    ) {
      if (fresh?.head?.sha && fresh.base?.sha === pr.base.sha) {
        queue.observeBaseSyncEvent({
          externalId,
          repo,
          prNumber,
          baseSha: pr.base.sha,
          headSha: fresh.head.sha,
          now,
        });
      }
      return;
    }
    const stillMissing = await github.isBaseIncluded(repo, fresh.base.sha, fresh.head.sha);
    if (stillMissing === null || stillMissing) {
      if (stillMissing) queue.completeBaseSyncEvent(BASE_SYNC_SOURCE, externalId);
      return;
    }

    const attempt = queue.beginBaseSyncAttempt(externalId);
    let runId: number | null = null;
    try {
      runId =
        runStore?.createRun({
          origin: "conflict_resolution",
          repo,
          prNumber,
          branch: fresh.head.ref,
          harness: this.options.harness ?? process.env.AGENT_HARNESS ?? "claude-code",
          attempt,
        }) ?? null;
    } catch (error) {
      console.warn(`⚠️  Run recording (base sync begin) failed: ${(error as Error).message}`);
    }

    console.log(`\n🔀 [${this.name}] syncing ${repo}#${prNumber} with its advanced base`);
    let result: AutomaticResolveResult;
    try {
      result = await resolveConflicts(repo, prNumber, {
        headSha: fresh.head.sha,
        baseSha: fresh.base.sha,
      });
    } catch (error) {
      result = { outcome: "failed", message: (error as Error).message };
    }
    const terminal = result.outcome !== "failed" && result.outcome !== "deferred";
    if (terminal) {
      queue.completeBaseSyncEvent(BASE_SYNC_SOURCE, externalId);
    } else if (result.outcome === "deferred") {
      queue.deferBaseSyncAttempt(externalId);
    } else {
      const exhausted = queue.failBaseSyncEvent(externalId, result.message);
      if (exhausted) queue.exhaustBaseSyncEvent(BASE_SYNC_SOURCE, externalId, result.message);
    }
    if (runId !== null) {
      try {
        runStore?.finishRun(
          runId,
          result.outcome === "failed"
            ? "failed"
            : result.outcome === "deferred"
              ? "deferred"
              : "succeeded",
          result.message,
        );
      } catch (error) {
        console.warn(`⚠️  Run recording (base sync end) failed: ${(error as Error).message}`);
      }
    }
  }
}
