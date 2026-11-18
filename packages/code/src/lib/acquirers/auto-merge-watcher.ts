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
 * Decisions are per head SHA and policy: a merge or a rejection is recorded
 * in `processed_events`, so the agent review runs at most once per head and
 * a rejected PR is only re-evaluated after new commits or a policy change
 * (for example widening the safe paths or enabling the review). `waiting`
 * outcomes back off without consuming attempts; failures retry up to a cap.
 *
 * Each evaluation is recorded as a run while it executes, so the dashboard
 * shows it live. Evaluations that end in "not ready yet" (waiting, skipped)
 * are discarded afterwards; decisions stay in the run list.
 *
 * Agent usage limits never drop a PR: the evaluation is `deferred` with the
 * quota's reset time, kept in the run list as **Deferred**, and the PR is
 * not touched again until then, so no check is relaunched into the limit.
 * The PR is reviewed on the first pass after the quota returns.
 */

import { startFirstTickInBackground } from "./background-tick";
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
  /**
   * Run the full gates and merge (the `devintern auto-merge` subprocess).
   * `lastAttempt` marks the head's final allowed attempt, so a failure is
   * stated on the PR instead of ending silently.
   */
  mergePr(
    repo: string,
    prNumber: number,
    expectedHeadSha: string,
    options: {
      lastAttempt: boolean;
      /** Called once the check is admitted and starts (after any wait for a slot). */
      onStart?: () => void;
      /** The run row opened for this check; its review transcript is attributed to it. */
      runId?: number;
    },
  ): Promise<AutoMergeResult>;
  runStore?: Pick<RunStore, "createRun" | "finishRun" | "discardRun"> &
    Partial<Pick<RunStore, "startStep">>;
  /** Harness recorded on runs; undefined when no agent review can run. */
  harness?: () => string | undefined;
  /**
   * Fingerprint of the effective policy for a repo. Part of the decision
   * key, so a policy change re-evaluates PRs decided under the old one.
   */
  policyFingerprint?: (repo: string) => string;
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

/** Run step while the check waits for the repository's slot. */
export const AUTO_MERGE_WAITING_STEP = "waiting-for-slot";
/** Run step once the check is admitted and evaluating the PR. */
export const AUTO_MERGE_CHECK_STEP = "auto-merge";

/** Re-check delay after a `waiting` outcome (changes requested, head moved). */
const WAITING_BACKOFF_MS = 10 * 60_000;
/** Minimum re-check delay after a `deferred` outcome (agent usage limit). */
const DEFERRED_BACKOFF_MS = 5 * 60_000;
/** Failure retry delay: 5 min, then 10, so a misread quota error does not exhaust attempts in minutes. */
const FAILURE_BACKOFF_BASE_MS = 5 * 60_000;
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
export function autoMergeDecisionKey(
  repo: string,
  prNumber: number,
  headSha: string,
  policyFingerprint?: string,
): string {
  const base = `${repo.toLowerCase()}#${prNumber}@${headSha}`;
  return policyFingerprint ? `${base}:${policyFingerprint}` : base;
}

/** Dashboard view of the watcher. */
export interface AutoMergeWatcherStatus {
  intervalSeconds: number;
  /** Next scheduled pass (ms epoch); absent before the timer started. */
  nextTickAt?: number;
  /** A pass is running right now. */
  running: boolean;
}

/** Result of a dashboard "Run now". */
export type AutoMergeRunNowOutcome = { ok: true } | { ok: false; reason: string };

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
  private nextTickAt: number | undefined;
  /** "Run now" arrived during a pass: run another one right after it. */
  private rerunRequested = false;
  /** The current/next pass ignores the quiet period and retry backoff. */
  private forceNextPass = false;

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
    // Arm the interval first, then run the first pass in the background: the
    // busy guard turns an interval fire during it into a no-op, and a long
    // first pass must not hold later acquirers (see background-tick.ts).
    this.startTimer();
    startFirstTickInBackground(this.name, () => this.tick());
  }

  private startTimer(): void {
    const ms = this.options.intervalSeconds * 1000;
    this.nextTickAt = this.now() + ms;
    this.timer = setInterval(() => {
      this.nextTickAt = this.now() + ms;
      void this.tick();
    }, ms);
  }

  /** Dashboard status; null while auto-merge is disabled. */
  status(): AutoMergeWatcherStatus | null {
    if (!this.options.enabled()) return null;
    return {
      intervalSeconds: this.options.intervalSeconds,
      ...(this.nextTickAt !== undefined ? { nextTickAt: this.nextTickAt } : {}),
      running: this.busy,
    };
  }

  /**
   * Dashboard "Run now": check every watched PR immediately, skipping the
   * quiet period and retry backoff. GitHub's readiness checks and per-head
   * decisions still apply, so a decided PR is not re-evaluated.
   */
  runNow(): AutoMergeRunNowOutcome {
    if (!this.options.enabled()) {
      return { ok: false, reason: "auto-merge is disabled ([workspace].auto_merge = false)" };
    }
    this.forceNextPass = true;
    if (this.busy) {
      this.rerunRequested = true;
    } else {
      void this.tick();
    }
    return { ok: true };
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
    this.startTimer();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** One pass over all watched PRs; skipped while a pass is running. */
  async tick(): Promise<void> {
    if (this.busy || !this.options.enabled()) return;
    this.busy = true;
    const force = this.forceNextPass;
    this.forceNextPass = false;
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
          await this.pollPr(pr.repo, pr.prNumber, force);
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
    if (this.rerunRequested) {
      this.rerunRequested = false;
      await this.tick();
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

  private async pollPr(repo: string, prNumber: number, force = false): Promise<void> {
    const key = `${repo.toLowerCase()}#${prNumber}`;
    const now = this.now();
    const previous = this.tracking.get(key);
    if (!force && previous && previous.nextAttemptAt > now) return;

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
    if (!force && now - state.headSeenAt < quietMs) return;
    const decisionKey = autoMergeDecisionKey(
      repo,
      prNumber,
      headSha,
      this.options.policyFingerprint?.(repo),
    );
    if (this.options.queue.hasProcessed(AUTO_MERGE_SOURCE, decisionKey)) return;

    await this.evaluate(repo, prNumber, state, decisionKey);
  }

  private async evaluate(
    repo: string,
    prNumber: number,
    state: PrTracking,
    decisionKey: string,
  ): Promise<void> {
    const runId = this.beginRun(repo, prNumber);
    // The run row exists before the check is admitted: until the supervisor
    // grants the repo's slot it is waiting, not evaluating.
    this.recordStep(runId, AUTO_MERGE_WAITING_STEP);
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_AUTO_MERGE_MAX_ATTEMPTS;
    let result: AutoMergeResult;
    try {
      result = await this.options.mergePr(repo, prNumber, state.headSha, {
        lastAttempt: state.failures + 1 >= maxAttempts,
        onStart: () => this.recordStep(runId, AUTO_MERGE_CHECK_STEP),
        ...(runId !== null ? { runId } : {}),
      });
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
        // Not an attempt: wait for the quota's reset (never less than the
        // floor), then evaluate this head again.
        state.nextAttemptAt = Math.max(finishedAt + DEFERRED_BACKOFF_MS, result.retryAt ?? 0);
        break;
      case "failed": {
        state.failures += 1;
        if (state.failures >= maxAttempts) {
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
    this.endRun(runId, result);
  }

  /** Open an in-progress run so the dashboard shows the evaluation live. */
  private beginRun(repo: string, prNumber: number): number | null {
    const { runStore } = this.options;
    if (!runStore) return null;
    try {
      const harness = this.options.harness?.();
      return runStore.createRun({
        origin: "auto_merge",
        repo,
        prNumber,
        prUrl: `https://github.com/${repo}/pull/${prNumber}`,
        ...(harness ? { harness } : {}),
      });
    } catch (error) {
      console.warn(`⚠️  Run recording (auto-merge begin) failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** Best-effort step marker on the open run. */
  private recordStep(runId: number | null, step: string): void {
    const { runStore } = this.options;
    if (!runStore?.startStep || runId === null) return;
    try {
      runStore.startStep(runId, step);
    } catch (error) {
      console.warn(`⚠️  Run recording (auto-merge step) failed: ${(error as Error).message}`);
    }
  }

  /** Keep decisions in the run list; drop "not ready yet" checks. */
  private endRun(runId: number | null, result: AutoMergeResult): void {
    const { runStore } = this.options;
    if (!runStore || runId === null) return;
    try {
      if (result.outcome === "merged") {
        runStore.finishRun(runId, "succeeded", result.message);
      } else if (result.outcome === "rejected") {
        runStore.finishRun(runId, "escalated", result.message);
      } else if (result.outcome === "failed") {
        runStore.finishRun(runId, "failed", result.message);
      } else if (result.outcome === "deferred" && result.retryAt !== undefined) {
        // Visible as waiting on quota until the review resumes.
        runStore.finishRun(runId, "deferred", result.message);
      } else {
        runStore.discardRun(runId);
      }
    } catch (error) {
      console.warn(`⚠️  Run recording (auto-merge end) failed: ${(error as Error).message}`);
    }
  }
}
