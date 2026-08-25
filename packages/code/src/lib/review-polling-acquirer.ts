/**
 * Review polling acquirer (worker Mode 1, Tier 1): watch the agent's own PRs.
 *
 * Each tick, for every open PR in the `agent_prs` registry:
 * 1. Conditional GET on the PR itself — closed/merged PRs leave the watch
 *    list; 304s (rate-limit-free) reuse cached metadata for base-sync checks.
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
  /**
   * Repo slugs (`owner/repo`) this worker manages. Open registry rows for
   * any other repo (e.g. left behind after a rename/transfer) are
   * auto-unwatched at startup and skipped on every tick. Omit to watch the
   * whole registry (previous behavior).
   */
  allowedRepos?: string[];
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
    /** Override the CLI entrypoint and output handling (subprocess tests). */
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
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
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
  },
): Promise<AutomaticResolveResult> {
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  return new Promise((resolve) => {
    let result: AutomaticResolveResult | null = null;
    let resultOutput = "";
    let resultOverflow = false;
    const maxResultBytes = 64 * 1024;
    const child = spawn(
      process.execPath,
      [opts.entrypoint ?? process.argv[1], "resolve-conflicts", prUrl, ...extraArgs],
      {
        stdio: ["inherit", opts.outputStdio ?? "inherit", opts.outputStdio ?? "inherit", "pipe"],
        cwd: opts.cwd,
        env: { ...(opts.env ?? process.env), DEVINTERN_RESULT_FD: "3" },
      },
    );
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      if (resultOverflow) return;
      if (Buffer.byteLength(resultOutput) + chunk.byteLength > maxResultBytes) {
        resultOutput = "";
        resultOverflow = true;
        return;
      }
      resultOutput += chunk.toString();
    });
    child.on("close", (code) => {
      if (!resultOverflow) {
        for (const line of resultOutput.trimEnd().split("\n")) {
          try {
            const candidate = JSON.parse(line) as Partial<AutomaticResolveResult>;
            if (
              typeof candidate.message === "string" &&
              ["clean", "resolved", "skipped", "failed", "deferred"].includes(
                candidate.outcome ?? "",
              )
            ) {
              result = candidate as AutomaticResolveResult;
            }
          } catch {
            // Ignore malformed records and use the exit-status fallback.
          }
        }
      }
      resolve(
        result ?? {
          outcome: code === 0 ? "skipped" : code === 2 ? "deferred" : "failed",
          message:
            code === 0
              ? "resolver completed"
              : code === 2
                ? "resolver deferred"
                : `resolver exited with code ${code}`,
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
  private comparisonCache = new Map<
    string,
    { baseSha: string; headSha: string; included: boolean }
  >();
  private prCache = new Map<string, PolledPr>();

  constructor(options: ReviewPollingAcquirerOptions) {
    this.options = options;
  }

  /** Start polling: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    // Drop stale registry rows for repos this worker no longer manages
    // (e.g. after a rename/transfer) so they never hit the API again.
    const { allowedRepos, workerState } = this.options;
    if (allowedRepos && allowedRepos.length > 0) {
      for (const pr of workerState.closeForeignAgentPrs(allowedRepos)) {
        console.log(
          `🧹 [${this.name}] ${pr.repo}#${pr.prNumber} is not part of this project; unwatching`,
        );
      }
    }
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
      const allowedRepos = this.options.allowedRepos;
      const watchedPrs = this.options.workerState.listOpenAgentPrs();
      const watchedKeys = new Set(watchedPrs.map((pr) => this.prKey(pr.repo, pr.prNumber)));
      for (const key of this.prCache.keys()) {
        if (!watchedKeys.has(key)) this.clearPrCache(key);
      }
      for (const pr of watchedPrs) {
        // Defensive: rows registered mid-run for a foreign repo (or when
        // startup pruning could not run) are skipped, never acted on.
        if (allowedRepos && allowedRepos.length > 0 && !allowedRepos.includes(pr.repo)) {
          continue;
        }
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
    const prKey = this.prKey(repo, prNumber);
    // Hydrate once per process even when an ETag survived a restart, then use
    // conditional requests on normal polling ticks.
    const prResult = await github.fetchPr(
      repo,
      prNumber,
      this.prCache.has(prKey) ? prCursor?.etag : undefined,
    );
    if (!prResult.notModified) {
      if (prResult.etag) {
        workerState.setCursor(prSource, "state", prResult.etag);
      }
      if (prResult.data && prResult.data.state !== "open") {
        console.log(`👁️  [${this.name}] ${repo}#${prNumber} is ${prResult.data.state}; unwatching`);
        workerState.markAgentPrClosed(repo, prNumber);
        this.clearPrCache(prKey);
        return;
      }

      if (prResult.data) this.prCache.set(prKey, prResult.data);

      if (resolveConflicts && prResult.data) {
        await this.maybeSyncBase(repo, prNumber, prResult.data);
      }
    } else if (resolveConflicts) {
      const cachedPr = this.prCache.get(prKey);
      if (cachedPr) await this.maybeSyncBase(repo, prNumber, cachedPr);
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

    const included = await this.isBaseIncluded(repo, prNumber, pr.base.sha, pr.head.sha);
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

    // Re-fetch immediately before execution. Any movement leaves the current
    // event pending and consumes no retry; a new base supersedes it immediately.
    const freshResult = await github.fetchPr(repo, prNumber);
    const fresh = freshResult.data;
    if (
      !fresh ||
      fresh.state !== "open" ||
      fresh.head?.sha !== pr.head.sha ||
      fresh.base?.sha !== pr.base.sha
    ) {
      if (fresh?.state === "open" && fresh.head?.sha && fresh.base?.sha) {
        queue.observeBaseSyncEvent({
          externalId: `base-sync:${repo}#${prNumber}:${fresh.base.sha}`,
          repo,
          prNumber,
          baseSha: fresh.base.sha,
          headSha: fresh.head.sha,
          now,
        });
      }
      return;
    }
    const stillMissing = await this.isBaseIncluded(repo, prNumber, fresh.base.sha, fresh.head.sha);
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

  private async isBaseIncluded(
    repo: string,
    prNumber: number,
    baseSha: string,
    headSha: string,
  ): Promise<boolean | null> {
    const compare = this.options.github.isBaseIncluded;
    if (!compare) return null;
    const key = this.prKey(repo, prNumber);
    const cached = this.comparisonCache.get(key);
    if (cached?.baseSha === baseSha && cached.headSha === headSha) return cached.included;
    let included: boolean | null;
    try {
      included = await compare(repo, baseSha, headSha);
    } catch (error) {
      if (this.options.verbose) {
        console.warn(
          `   [${this.name}] ${repo}#${prNumber}: base comparison unavailable: ${(error as Error).message}`,
        );
      }
      return null;
    }
    if (included !== null) this.comparisonCache.set(key, { baseSha, headSha, included });
    return included;
  }

  private prKey(repo: string, prNumber: number): string {
    return `${repo.toLowerCase()}#${prNumber}`;
  }

  private clearPrCache(key: string): void {
    this.prCache.delete(key);
    this.comparisonCache.delete(key);
  }
}
