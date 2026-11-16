/**
 * Auto-merge watcher acquirer (worker Mode 1, Tier 1): merge the agent's own
 * PRs once they are green and pass the workspace's auto-merge policy.
 *
 * Each tick, for every open PR in the `agent_prs` registry, a cheap in-process
 * precheck (one ETag-cached PR GET) looks for PRs that are open, not drafts,
 * not forks, reported mergeable with passing checks (`clean`/`has_hooks`),
 * and whose head has been stable for the quiet period. Only those spawn
 * `devintern auto-merge <pr-url> --expected-head <sha>`, which runs the real
 * gates (reviews, path policy, optional agent review) and merges.
 *
 * Decisions are per head SHA: a merge or a rejection is recorded in
 * `processed_events`, so the agent review runs at most once per head and a
 * rejected PR is only re-evaluated after new commits. `waiting` outcomes
 * back off without consuming attempts; failures retry up to a cap.
 */

import type { Acquirer } from "../../worker";
import type { AutoMergeResult } from "../review/auto-merge";
import type { ConditionalResult, PolledPr } from "../review/agent-pr-reconciler";
import { classifyAgentPrState } from "../review/agent-pr-reconciler";
import { describeGitHubAuthFailure, isGitHubAuthError } from "../code-host/github/reviews";
import type { RunStore } from "../state/run-recorder";
import type { WebhookQueue } from "../state/webhook-queue";
import type { WorkerState } from "../state/worker-state";

/** PR fields the precheck reads. */
export interface AutoMergePolledPr extends PolledPr {
  draft?: boolean;
}

export interface AutoMergeWatcherOptions {
  intervalSeconds: number;
  workerState: WorkerState;
  queue: WebhookQueue;
  /** Live `[workspace].auto_merge` switch. */
  enabled: () => boolean;
  fetchPr(
    repo: string,
    prNumber: number,
    etag?: string,
  ): Promise<ConditionalResult<AutoMergePolledPr>>;
  /** Run the full gates and merge (the `devintern auto-merge` subprocess). */
  mergePr(repo: string, prNumber: number, expectedHeadSha: string): Promise<AutoMergeResult>;
  runStore?: Pick<RunStore, "createRun" | "finishRun">;
  /** Harness recorded on runs that spent tokens. */
  harness?: () => string | undefined;
  /** Seconds a head SHA must stay unchanged before evaluation (default 300). */
  quietSeconds?: number;
  /** Failed evaluations per head SHA before giving up (default 3). */
  maxAttempts?: number;
  now?: () => number;
  verbose?: boolean;
}

/** Dedupe source for per-head auto-merge decisions. */
export const AUTO_MERGE_SOURCE = "github:auto-merge";

export const DEFAULT_AUTO_MERGE_QUIET_SECONDS = 300;
export const DEFAULT_AUTO_MERGE_MAX_ATTEMPTS = 3;

/** Re-check delay after a `waiting` outcome (changes requested, head moved). */
const WAITING_BACKOFF_MS = 10 * 60_000;
/** Re-check delay after a `deferred` outcome (agent usage limit). */
const DEFERRED_BACKOFF_MS = 5 * 60_000;
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 30 * 60_000;

/** `mergeable_state` values meaning "mergeable and checks passing". */
const READY_STATES = new Set(["clean", "has_hooks"]);

interface PrTracking {
  headSha: string;
  /** When this head SHA was first observed (quiet-period anchor). */
  headSeenAt: number;
  failures: number;
  nextAttemptAt: number;
  etag?: string;
  cached?: AutoMergePolledPr;
}

/** Durable key of one auto-merge decision. */
export function autoMergeDecisionKey(repo: string, prNumber: number, headSha: string): string {
  return `${repo.toLowerCase()}#${prNumber}@${headSha}`;
}

/**
 * Watches the agent's open PRs and merges the safe ones.
 */
export class AutoMergeWatcherAcquirer implements Acquirer {
  readonly name = "poll:auto-merge";
  private options: AutoMergeWatcherOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private tracking = new Map<string, PrTracking>();
  private authWarnedAt = new Map<string, number>();

  constructor(options: AutoMergeWatcherOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.options.enabled()) {
      console.log(
        `🔀 Auto-merge enabled; poll interval ${this.options.intervalSeconds}s ` +
          `(watching ${this.options.workerState.listOpenAgentPrs().length} open PR(s))`,
      );
    }
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Apply a live workspace poll-interval change. */
  updateInterval(seconds: number): void {
    this.options.intervalSeconds = seconds;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** One pass over all watched PRs; skipped while a pass is running. */
  async tick(): Promise<void> {
    if (this.busy || !this.options.enabled()) return;
    this.busy = true;
    try {
      const watched = this.options.workerState.listOpenAgentPrs();
      const keys = new Set(watched.map((pr) => `${pr.repo.toLowerCase()}#${pr.prNumber}`));
      for (const key of this.tracking.keys()) {
        if (!keys.has(key)) this.tracking.delete(key);
      }
      for (const pr of watched) {
        // A live disable takes effect between PRs, not only between ticks.
        if (!this.options.enabled()) break;
        try {
          await this.pollPr(pr.repo, pr.prNumber);
        } catch (error) {
          if (isGitHubAuthError(error)) {
            this.warnAuthFailure(pr.repo, error as Error);
            continue;
          }
          console.warn(
            `⚠️  [${this.name}] ${pr.repo}#${pr.prNumber} failed: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private warnAuthFailure(repo: string, error: Error): void {
    const key = repo.toLowerCase();
    const now = this.now();
    const last = this.authWarnedAt.get(key);
    if (last !== undefined && now - last < 60 * 60_000) return;
    this.authWarnedAt.set(key, now);
    console.warn(
      `⚠️  [${this.name}] GitHub rejected the credential for ${repo}: ${error.message} ` +
        describeGitHubAuthFailure(error, "reviews"),
    );
  }

  private async pollPr(repo: string, prNumber: number): Promise<void> {
    const key = `${repo.toLowerCase()}#${prNumber}`;
    const now = this.now();
    const previous = this.tracking.get(key);
    if (previous && previous.nextAttemptAt > now) return;

    const fetched = await this.options.fetchPr(repo, prNumber, previous?.etag);
    if (fetched.gone) return;
    const pr = fetched.notModified ? previous?.cached : fetched.data;
    if (!pr?.head?.sha) return;
    if (classifyAgentPrState(pr.state) !== "open") return;

    const headSha = pr.head.sha;
    const state: PrTracking =
      previous && previous.headSha === headSha
        ? previous
        : { headSha, headSeenAt: now, failures: 0, nextAttemptAt: 0 };
    if (!fetched.notModified) {
      state.etag = fetched.etag;
      state.cached = pr;
    }
    this.tracking.set(key, state);

    if (pr.draft) return;
    if (pr.head.repo?.full_name && pr.head.repo.full_name.toLowerCase() !== repo.toLowerCase()) {
      return;
    }
    if (!READY_STATES.has(pr.mergeable_state ?? "")) return;
    const quietMs = (this.options.quietSeconds ?? DEFAULT_AUTO_MERGE_QUIET_SECONDS) * 1000;
    if (now - state.headSeenAt < quietMs) return;
    const decisionKey = autoMergeDecisionKey(repo, prNumber, headSha);
    if (this.options.queue.hasProcessed(AUTO_MERGE_SOURCE, decisionKey)) return;

    await this.evaluate(repo, prNumber, state, decisionKey);
  }

  private async evaluate(
    repo: string,
    prNumber: number,
    state: PrTracking,
    decisionKey: string,
  ): Promise<void> {
    const startedAt = this.now();
    let result: AutoMergeResult;
    try {
      result = await this.options.mergePr(repo, prNumber, state.headSha);
    } catch (error) {
      result = { outcome: "failed", message: (error as Error).message, reviewed: false };
    }
    const label = `${repo}#${prNumber}`;
    const finishedAt = this.now();

    switch (result.outcome) {
      case "merged":
      case "would-merge":
      case "rejected":
      case "skipped":
        this.options.queue.markProcessed(AUTO_MERGE_SOURCE, decisionKey);
        break;
      case "waiting":
        state.nextAttemptAt = finishedAt + WAITING_BACKOFF_MS;
        break;
      case "deferred":
        state.nextAttemptAt = finishedAt + DEFERRED_BACKOFF_MS;
        break;
      case "failed": {
        state.failures += 1;
        const max = this.options.maxAttempts ?? DEFAULT_AUTO_MERGE_MAX_ATTEMPTS;
        if (state.failures >= max) {
          console.warn(
            `⛔ [${this.name}] ${label} auto-merge failed ${state.failures} time(s); ` +
              "giving up until new commits land",
          );
          this.options.queue.markProcessed(AUTO_MERGE_SOURCE, decisionKey);
        } else {
          state.nextAttemptAt =
            finishedAt +
            Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (state.failures - 1), FAILURE_BACKOFF_MAX_MS);
        }
        break;
      }
    }

    const icon =
      result.outcome === "merged"
        ? "🔀"
        : result.outcome === "rejected"
          ? "🛑"
          : result.outcome === "failed"
            ? "⚠️ "
            : "ℹ️ ";
    if (result.outcome !== "waiting" || this.options.verbose) {
      console.log(`${icon} [${this.name}] ${label} ${result.outcome}: ${result.message}`);
    }
    this.recordRun(repo, prNumber, startedAt, result);
  }

  /** Record decisions (not "not ready yet" checks) on the dashboard. */
  private recordRun(
    repo: string,
    prNumber: number,
    startedAt: number,
    result: AutoMergeResult,
  ): void {
    const { runStore } = this.options;
    if (!runStore) return;
    if (!["merged", "rejected", "failed"].includes(result.outcome)) return;
    try {
      const runId = runStore.createRun({
        origin: "auto_merge",
        repo,
        prNumber,
        prUrl: `https://github.com/${repo}/pull/${prNumber}`,
        ...(result.reviewed ? { harness: this.options.harness?.() } : {}),
        startedAt,
      });
      runStore.finishRun(
        runId,
        result.outcome === "merged"
          ? "succeeded"
          : result.outcome === "rejected"
            ? "escalated"
            : "failed",
        result.message,
      );
    } catch (error) {
      console.warn(`⚠️  Run recording (auto-merge) failed: ${(error as Error).message}`);
    }
  }
}
