/**
 * Review polling acquirer (worker Mode 1, Tier 1): watch the agent's own PRs.
 *
 * Each tick, for every open PR in the `agent_prs` registry:
 * 1. The reconciler conditionally GETs the PR itself — closed/merged
 *    PRs leave the watch list (and the dashboard's open count); 304s
 *    (rate-limit-free) reuse cached metadata for base-sync checks.
 * 2. Conditional GET on the review list — a new `changes_requested` review
 *    by a human is implicitly addressed to the agent (its own PR), no
 *    @mention required.
 * 3. `since`-windowed GET on inline review comments — new human comments
 *    count as feedback too.
 * 4. When anything actionable is new, run `devintern address-review` for
 *    the PR (once per tick per PR), which fetches unaddressed comments,
 *    runs the agent, pushes, and replies.
 *
 * Base sync eligibility comes from GitHub's own `mergeable_state` ("dirty"
 * or "behind"), not from ancestry checks against the API-reported base
 * SHA — that field can lag the real branch tip for days and would both
 * skip eligible PRs forever and loop ineligible ones.
 *
 * Review/comment ids dedupe via `processed_events`, so webhook redeliveries
 * or window overlap never double-run. ETags and comment cursors persist per
 * PR in `cursors`.
 *
 * Team-PR base sync (opt-in, `sync_team_prs = true` per workspace repo): for
 * each opted-in repo the tick also lists open PRs (ETag-conditional) and runs
 * base sync — never review-feedback addressing — on teammates' open,
 * non-draft, same-repo PRs whose `author_association` marks a team member
 * (see {@link isTeamAuthor}). Those PRs flow through the same
 * `maybeSyncBase` → `refetchForBaseSync` → `executeBaseSync` path as the
 * agent's own, so mode, schedule window, quiet period, retry backoff, and
 * defer caps apply unchanged. The agent's own PRs are skipped in the sweep.
 */

import { captureError } from "@devintern/utils";

import { parseHarnessList } from "@devintern/agent-harness";

import {
  agentPrKey,
  agentPrStateCursorSource,
  applyAgentPrFetch,
  classifyAgentPrState,
  reconcileOpenAgentPrs,
} from "../review/agent-pr-reconciler";
import type { ConditionalResult, PolledPr } from "../review/agent-pr-reconciler";
import {
  describeGitHubAuthFailure,
  isGitHubAuthError,
  isGitHubTransientError,
} from "../code-host/github/reviews";
import { nextScheduleOccurrence } from "../automation/config";
import type { CronOrIntervalSchedule } from "../automation/config";
import type { RunStore } from "../state/run-recorder";
import type { TaskExecutionResult } from "./task-polling";
import type { WebhookQueue } from "../state/webhook-queue";
import type { WorkerState } from "../state/worker-state";
import type { ConflictResolutionMode } from "../workspace/config";
import type { Acquirer } from "../../worker";
import type { AutomaticResolveResult } from "./review-cli-runners";
import { isTeamAuthor, TeamPrSweeper } from "./team-pr-sweep";
import type { PolledPrListItem, TeamPrSweepHost } from "./team-pr-sweep";
import {
  CONFLICT_WINDOW_SOURCE,
  extendConflictWindow,
  isConflictWindowOpen,
  openConflictWindow,
  parseConflictWindowState,
  resolveConflictWindowGraceMs,
} from "./conflict-window";
import type {
  ConflictWindowState,
  ConflictWindowStatus,
  ConflictWindowTriggerOutcome,
} from "./conflict-window";

// The PR-state protocol types live with the reconciler, which shares them;
// re-exported so poller consumers keep their existing import paths.
export type { ConditionalResult, PolledPr };
export {
  isTeamAuthor,
  OPEN_PR_LIST_PAGE_SIZE,
  TEAM_AUTHOR_ASSOCIATIONS,
  teamPrListCursorSource,
  teamPrStateCursorSource,
} from "./team-pr-sweep";
export type { PolledPrListItem } from "./team-pr-sweep";
export {
  DEFAULT_RESOLVE_TIMEOUT_MS,
  runAddressReviewUrlViaCli,
  runAddressReviewViaCli,
  runResolveConflictsUrlViaCli,
  runResolveConflictsViaCli,
  serializePrRun,
} from "./review-cli-runners";
export type { AutomaticResolveResult } from "./review-cli-runners";
export type { ConflictWindowStatus, ConflictWindowTriggerOutcome };

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
  /**
   * List a repo's open PRs (team-PR base sync discovery). Optional: without
   * it, `sync_team_prs` repos fall back to own-PR-only base sync.
   */
  listOpenPullRequests?(
    repo: string,
    etag?: string,
  ): Promise<ConditionalResult<PolledPrListItem[]>>;
}

/**
 * Endpoint group a polling pass can fail on. Recovery is tracked per stage so
 * a successful metadata-only PR fetch cannot clear a reviews/comments throttle
 * that was never re-tested.
 */
type PollStage = "pr-state" | "reviews" | "comments" | "write" | "open-prs";

/** Human label for a stage, used in credential warnings. */
const POLL_STAGE_LABELS: Record<PollStage, string> = {
  "pr-state": "reading PR state",
  reviews: "reading reviews",
  comments: "reading review comments",
  write: "posting a review comment",
  "open-prs": "listing open PRs",
};

interface AuthFailureEntry {
  repo: string;
  stage: PollStage;
  lastWarnAt: number | null;
  active: boolean;
}

/** Stage progress for one PR pass; mutated by {@link ReviewPollingAcquirer.pollPr}. */
interface PollProgress {
  /** Stages whose requests completed during this pass. */
  completed: Set<PollStage>;
  /** Stage whose request is currently in flight. */
  current?: PollStage;
}

export interface ReviewPollingAcquirerOptions {
  intervalSeconds: number;
  /** Whether feedback acquisition should run (state/base reconciliation always runs). */
  shouldPollFeedback?: () => boolean;
  /** Safety sweep cadence while relay is healthy. Defaults to 30 minutes. */
  feedbackFallbackIntervalSeconds?: number;
  workerState: WorkerState;
  queue: WebhookQueue;
  github: ReviewPollingGitHub;
  /** Handle feedback on one PR; returns success (injected for tests). */
  addressPr: (repo: string, prNumber: number) => Promise<TaskExecutionResult>;
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
   * whole registry (previous behavior). May be a factory so live config
   * reloads (repos added to `workspace.toml`) apply on later ticks.
   */
  allowedRepos?: string[] | (() => string[]);
  verbose?: boolean;
  /**
   * Schedule gating automatic conflict resolution (workspace scheduled
   * mode, `[workspace].conflict_resolution = "scheduled"`). When set,
   * conflicting PRs are still detected and queued on every tick, but the
   * agent is invoked only inside the scheduled window. Omit for `auto`
   * mode: resolve as soon as a conflict is detected (default).
   */
  conflictSchedule?: CronOrIntervalSchedule;
  /**
   * Workspace conflict-resolution mode (`[workspace].conflict_resolution`),
   * surfaced in the startup log. `"disabled"` means the caller omits
   * `resolveConflicts`, so base-sync detection never runs and conflicts
   * stay for manual resolution. Defaults to `"scheduled"` when
   * `conflictSchedule` is set, else `"auto"`.
   */
  conflictResolution?: ConflictResolutionMode;
  /**
   * How long a scheduled window stays open for resolution attempts once it
   * arrives (covers quiet-period waits, retry backoff, and a serial pass
   * over several PRs). Defaults to `WORKER_RESOLVE_WINDOW_GRACE_MINUTES`
   * or 60 minutes.
   */
  conflictWindowGraceMs?: number;
  /**
   * GitHub slugs opted into team-PR base sync (`sync_team_prs = true`).
   * Factory form so live config reloads apply on the next tick. Empty or
   * omitted keeps own-PR-only base sync with no extra API requests.
   * Requires `github.listOpenPullRequests` and `resolveConflicts`.
   */
  syncTeamPrsRepos?: string[] | (() => string[]);
}

/** Per-tick stage bookkeeping for credential-failure throttling. */
interface TickStages {
  /** Stages that completed in this tick, per repo (union over its requests). */
  succeeded: Map<string, Set<PollStage>>;
  /** Stages that failed with a credential error in this tick, per repo. */
  failed: Map<string, Set<PollStage>>;
}

/** Add `stages` to `repo`'s entry in a per-tick stage map. */
function recordStages(
  target: Map<string, Set<PollStage>>,
  repo: string,
  stages: Iterable<PollStage>,
): void {
  let entry = target.get(repo);
  if (!entry) {
    entry = new Set();
    target.set(repo, entry);
  }
  for (const stage of stages) entry.add(stage);
}

/** Dedupe source for review/comment ids. */
const SOURCE = "github:reviews";
const BASE_SYNC_SOURCE = "github:base-sync";

/**
 * Consecutive `deferred` resolver outcomes tolerated for one base-sync event
 * before it is exhausted. Defers do not consume attempts (they model benign
 * branch movement), so without a cap a deterministic defer would retry
 * silently on every poll tick forever.
 */
const MAX_CONSECUTIVE_DEFERS = 3;

/** Backoff before the first retry of a failed base-sync event. */
const RETRY_BACKOFF_BASE_MS = 30_000;

/** Upper bound on the wait between retries of a failed base-sync event. */
const RETRY_BACKOFF_MAX_MS = 10 * 60_000;

/**
 * Wait required before retrying a base-sync event that has failed `attempts`
 * times: 30s after the first failure, doubling to a 10-minute cap. Keeps
 * persistent failures (bad credentials, repo renamed, agent crash loop) from
 * hammering GitHub and the agent on every poll tick while still retrying.
 */
export function baseSyncRetryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (attempts - 1), RETRY_BACKOFF_MAX_MS);
}

/**
 * Polls the agent's own PRs for review feedback.
 */
export class ReviewPollingAcquirer implements Acquirer {
  readonly name = "poll:reviews";
  private options: ReviewPollingAcquirerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private prCache = new Map<string, PolledPr>();
  /** Consecutive `deferred` resolver outcomes per base-sync event. */
  private deferCounts = new Map<string, number>();
  /** Cached scheduled-window state; `undefined` = not loaded from the cursor yet. */
  private conflictWindowState: ConflictWindowState | null | undefined;
  private lastFeedbackPollAt: number;
  /**
   * Per-repo/per-stage throttle state for permanent credential failures. Fleet
   * mode resolves a distinct token per repo, so a 403 in one repo must not
   * hide an unrelated 401 in another, and a write failure must not be silenced
   * by a read warning (or cleared by a successful read).
   */
  private authFailures = new Map<string, AuthFailureEntry>();
  /** Per-repo throttle for "404 may mean access lost" warnings. */
  private inaccessibleWarnAt = new Map<string, number>();
  /** Team-PR base sync discovery state (`sync_team_prs`). */
  private teamPrs = new TeamPrSweeper(this.name);

  constructor(options: ReviewPollingAcquirerOptions) {
    this.options = options;
    this.lastFeedbackPollAt = (options.now ?? Date.now)();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Start polling: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    if (this.timer) return;
    // Drop stale registry rows for repos this worker no longer manages
    // (e.g. after a rename/transfer) so they never hit the API again.
    const allowedRepos = this.resolveAllowedRepos();
    if (allowedRepos && allowedRepos.length > 0) {
      for (const pr of this.options.workerState.closeForeignAgentPrs(allowedRepos)) {
        console.log(
          `🧹 [${this.name}] ${pr.repo}#${pr.prNumber} is not part of this project; unwatching`,
        );
      }
    }
    console.log(
      `🔎 Polling reviews on agent PRs every ${this.options.intervalSeconds}s ` +
        `(watching ${this.options.workerState.listOpenAgentPrs().length} open PR(s))`,
    );
    this.syncConflictWindow();
    this.logConflictMode();
    if (
      this.resolveTeamSyncRepos(allowedRepos).length > 0 &&
      !this.options.github.listOpenPullRequests
    ) {
      console.warn(
        `⚠️  [${this.name}] sync_team_prs is enabled but the GitHub client cannot list open ` +
          "PRs; only the agent's own PRs are base-synced",
      );
    }
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

  /**
   * Apply a new poll cadence without restarting (live workspace config
   * reload). Re-arms the repeating timer with the new interval.
   */
  updateInterval(intervalSeconds: number): void {
    this.options.intervalSeconds = intervalSeconds;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), intervalSeconds * 1000);
  }

  /** Apply conflict-resolution mode and schedule changes from workspace reloads. */
  updateConflictResolution(
    conflictResolution: ConflictResolutionMode,
    conflictSchedule?: CronOrIntervalSchedule,
  ): void {
    this.options.conflictResolution = conflictResolution;
    this.options.conflictSchedule = conflictSchedule;
    this.conflictWindowState = null;
    this.deferCounts.clear();
    this.syncConflictWindow();
    this.logConflictMode();
  }

  private resolveAllowedRepos(): string[] | undefined {
    const raw = this.options.allowedRepos;
    return typeof raw === "function" ? raw() : raw;
  }

  /** Opted-in team-PR sync slugs, restricted to the repos this worker manages. */
  private resolveTeamSyncRepos(allowedRepos: string[] | undefined): string[] {
    const raw = this.options.syncTeamPrsRepos;
    const repos = (typeof raw === "function" ? raw() : raw) ?? [];
    if (!allowedRepos || allowedRepos.length === 0) return repos;
    const allowed = new Set(allowedRepos.map((repo) => repo.toLowerCase()));
    return repos.filter((repo) => allowed.has(repo.toLowerCase()));
  }

  /**
   * Repos the team-PR sweep runs on this tick: empty unless discovery and
   * conflict resolution are both available and the mode is not `disabled`
   * (disabled mode spends no discovery requests).
   */
  private activeTeamSyncRepos(allowedRepos: string[] | undefined): string[] {
    if (
      !this.options.resolveConflicts ||
      !this.options.github.listOpenPullRequests ||
      this.options.conflictResolution === "disabled"
    ) {
      return [];
    }
    return this.resolveTeamSyncRepos(allowedRepos);
  }

  /** One polling cycle over all watched PRs. Skipped while busy. */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;

    try {
      this.syncConflictWindow();
      const { workerState } = this.options;
      const allowedRepos = this.resolveAllowedRepos();
      const fallbackMs = (this.options.feedbackFallbackIntervalSeconds ?? 30 * 60) * 1000;
      const now = this.now();
      const pollFeedback =
        (this.options.shouldPollFeedback?.() ?? true) ||
        now - this.lastFeedbackPollAt >= fallbackMs;
      if (pollFeedback) this.lastFeedbackPollAt = now;

      // Reconcile the registry with GitHub first: one conditional GET per
      // watched PR whose result is shared with the poll loop below, so PRs
      // closed or deleted outside the worker leave the watch list (and the
      // dashboard's open count) within this tick even if per-PR polling
      // later errors out.
      const fresh = new Map<string, ConditionalResult<PolledPr>>();
      const reconciliation = await reconcileOpenAgentPrs({
        workerState,
        github: this.options.github,
        watched: workerState.listOpenAgentPrs(),
        allowedRepos,
        etagFor: (repo, prNumber) =>
          this.prCache.has(agentPrKey(repo, prNumber))
            ? workerState.getCursor(agentPrStateCursorSource(repo, prNumber))?.etag
            : undefined,
        fresh,
      });
      for (const closure of reconciliation.closed) {
        console.log(
          `🧹 [${this.name}] ${closure.repo}#${closure.prNumber} is ${closure.reason}; unwatching`,
        );
      }

      const watchedPrs = workerState.listOpenAgentPrs();
      const watchedKeys = new Set(watchedPrs.map((pr) => agentPrKey(pr.repo, pr.prNumber)));
      for (const key of this.prCache.keys()) {
        if (!watchedKeys.has(key)) this.clearPrCache(key);
      }
      const teamSyncRepos = this.activeTeamSyncRepos(allowedRepos);
      this.teamPrs.prune(teamSyncRepos);
      const watchedRepos = new Set([...watchedPrs.map((pr) => pr.repo), ...teamSyncRepos]);
      for (const [key, entry] of this.authFailures) {
        if (!watchedRepos.has(entry.repo)) this.authFailures.delete(key);
      }
      for (const repo of this.inaccessibleWarnAt.keys()) {
        if (!watchedRepos.has(repo)) this.inaccessibleWarnAt.delete(repo);
      }
      const stages: TickStages = { succeeded: new Map(), failed: new Map() };
      for (const pr of watchedPrs) {
        // Defensive: rows registered mid-run for a foreign repo (or when
        // startup pruning could not run) are skipped, never acted on.
        if (allowedRepos && allowedRepos.length > 0 && !allowedRepos.includes(pr.repo)) {
          continue;
        }
        const progress: PollProgress = { completed: new Set() };
        try {
          await this.pollPr(
            pr.repo,
            pr.prNumber,
            pr.createdAt,
            pollFeedback,
            fresh.get(agentPrKey(pr.repo, pr.prNumber)),
            progress,
          );
        } catch (error) {
          recordStages(stages.succeeded, pr.repo, progress.completed);
          this.handlePollFailure(stages, pr.repo, pr.prNumber, error, progress.current ?? "write");
          continue;
        }
        recordStages(stages.succeeded, pr.repo, progress.completed);
      }

      // Team-PR base sync (opt-in per repo); no-op with no repo opted in.
      if (teamSyncRepos.length > 0) {
        const host = this.teamPrSweepHost(stages);
        for (const repo of teamSyncRepos) await this.teamPrs.sweep(repo, watchedKeys, host);
      }

      // Only a tick where the same stage succeeded proves that stage's
      // credential works again. A metadata-only PR fetch must not clear a
      // reviews/comments throttle it never exercised, and one PR's failure
      // must not mask another's success in the same repo.
      for (const [repo, succeeded] of stages.succeeded) {
        const failed = stages.failed.get(repo);
        for (const stage of succeeded) {
          if (failed?.has(stage)) continue;
          this.noteAuthRecovery(repo, stage);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Shared failure policy for one polling request: credential errors warn
   * (throttled per repo/stage) without captureError, transient GitHub errors
   * only warn, anything else is captured and warned.
   */
  private handlePollFailure(
    stages: TickStages,
    repo: string,
    prNumber: number | undefined,
    error: unknown,
    stage: PollStage,
  ): void {
    if (isGitHubAuthError(error)) {
      // Credential failures (401/rejected, 403/under-scoped) are
      // configuration problems that fail identically on every PR every
      // tick. Warn the operator at most once per repo per stage per hour
      // and intentionally skip captureError so a permanently rejected
      // credential does not flood error tracking with duplicates.
      recordStages(stages.failed, repo, [stage]);
      this.warnAuthFailure(repo, prNumber, error as Error, stage);
      return;
    }
    // A 408/429/5xx survived the client's retries: GitHub is momentarily
    // unavailable and the next tick retries it. Keep the warning visible,
    // but do not report expected upstream noise as a fresh issue.
    if (!isGitHubTransientError(error)) {
      captureError(error, {
        acquirer: this.name,
        repo,
        prNumber,
        stage: stage === "open-prs" ? "list-open-prs" : "poll-pr",
      });
    }
    const target = prNumber === undefined ? repo : `${repo}#${prNumber}`;
    console.warn(
      `⚠️  [${this.name}] ${stage === "open-prs" ? "listing open PRs on" : "polling"} ` +
        `${target} failed: ${(error as Error).message}`,
    );
  }

  /** One credential warning per repo per stage per rolling hour. */
  private static AUTH_WARN_INTERVAL_MS = 60 * 60 * 1000;

  private static authKey(repo: string, stage: PollStage): string {
    return `${repo.toLowerCase()}\u0000${stage}`;
  }

  private warnAuthFailure(
    repo: string,
    prNumber: number | undefined,
    error: Error,
    stage: PollStage,
  ): void {
    const key = ReviewPollingAcquirer.authKey(repo, stage);
    const entry = this.authFailures.get(key) ?? {
      repo,
      stage,
      lastWarnAt: null,
      active: false,
    };
    entry.active = true;
    const now = this.now();
    if (
      entry.lastWarnAt !== null &&
      now - entry.lastWarnAt < ReviewPollingAcquirer.AUTH_WARN_INTERVAL_MS
    ) {
      this.authFailures.set(key, entry);
      return;
    }
    entry.lastWarnAt = now;
    this.authFailures.set(key, entry);
    console.warn(
      `⚠️  [${this.name}] GitHub rejected the credential while ${POLL_STAGE_LABELS[stage]} ` +
        `on ${prNumber === undefined ? repo : `${repo}#${prNumber}`}: ` +
        `${error.message} ${describeGitHubAuthFailure(error, stage === "write" ? "comment" : "reviews")}`,
    );
  }

  /** Announce one stage's recovery and rearm that stage's throttle. */
  private noteAuthRecovery(repo: string, stage: PollStage): void {
    const key = ReviewPollingAcquirer.authKey(repo, stage);
    const entry = this.authFailures.get(key);
    if (!entry?.active) return;
    this.authFailures.delete(key);
    console.log(
      `✅ [${this.name}] GitHub credential accepted again for ${repo}; ` +
        `${POLL_STAGE_LABELS[stage]} recovered`,
    );
  }

  private warnPrInaccessible(repo: string, prNumber: number): void {
    const now = this.now();
    const lastWarnAt = this.inaccessibleWarnAt.get(repo);
    if (
      lastWarnAt !== undefined &&
      now - lastWarnAt < ReviewPollingAcquirer.AUTH_WARN_INTERVAL_MS
    ) {
      return;
    }
    this.inaccessibleWarnAt.set(repo, now);
    console.warn(
      `⚠️  [${this.name}] GitHub returned 404 for ${repo}#${prNumber}. ` +
        "The PR may still be open but inaccessible to this worker's GitHub credential; " +
        "keeping it watched. Check GITHUB_TOKEN access to this repository.",
    );
  }

  /** Poll a single PR; triggers at most one address-review run. */
  private async pollPr(
    repo: string,
    prNumber: number,
    watchedSinceMs: number,
    pollFeedback: boolean,
    prefetched: ConditionalResult<PolledPr> | undefined,
    progress: PollProgress,
  ): Promise<"ok" | "inaccessible"> {
    const { workerState, github, addressPr, resolveConflicts } = this.options;

    // 1. PR state (ETag-cached): unwatch confirmed closed/merged PRs. When the
    //    reconciliation pass already fetched this PR, its result is reused
    //    (and already applied), so no second request is spent here.
    progress.current = "pr-state";
    const prSource = agentPrStateCursorSource(repo, prNumber);
    const prKey = agentPrKey(repo, prNumber);
    const prResult =
      prefetched ??
      (await github.fetchPr(
        repo,
        prNumber,
        this.prCache.has(prKey) ? workerState.getCursor(prSource)?.etag : undefined,
      ));
    if (prResult.gone) {
      this.warnPrInaccessible(repo, prNumber);
      // A 404 can mean lost access, so it cannot prove the credential works.
      return "inaccessible";
    }
    if (!prefetched) {
      const closure = applyAgentPrFetch(workerState, { repo, prNumber }, prResult);
      if (closure) {
        console.log(`👁️  [${this.name}] ${repo}#${prNumber} is ${closure.reason}; unwatching`);
        this.clearPrCache(prKey);
        progress.completed.add("pr-state");
        return "ok";
      }
    }

    if (!prResult.notModified) {
      if (prResult.data) this.prCache.set(prKey, prResult.data);

      if (resolveConflicts && prResult.data) {
        await this.maybeSyncBase(repo, prNumber, prResult.data);
      }
    } else if (resolveConflicts) {
      const cachedPr = this.prCache.get(prKey);
      if (cachedPr) await this.maybeSyncBase(repo, prNumber, cachedPr);
    }

    // Reconciliation and base sync may spend additional PR-state requests; only
    // reaching this point proves the whole pr-state stage succeeded.
    progress.completed.add("pr-state");
    progress.current = undefined;
    if (!pollFeedback) return "ok";

    // GitHub can return an unusable PR state (missing/null/unknown) even though
    // the row stays watched (applyAgentPrFetch refuses to close on it). Do not
    // collect feedback in that case: collection marks reviews/comments as
    // processed *before* the address run re-fetches the PR, and that run rejects
    // an unconfirmed PR — so events would be deduped forever without ever being
    // addressed. Skipping leaves both cursors and processed markers untouched,
    // so the feedback is picked up once the state is usable again.
    const observedPr = prResult.notModified ? this.prCache.get(prKey) : prResult.data;
    const lifecycle = observedPr ? classifyAgentPrState(observedPr.state) : "open";
    if (lifecycle !== "open") return "ok";

    // 2. Reviews (ETag-cached): new human changes_requested reviews.
    // 3. Inline review comments since the last seen timestamp.
    // Both passes must run (each advances its own cursor), so no short-circuit.
    progress.current = "reviews";
    const reviewed = await this.collectActionableReviews(repo, prNumber);
    progress.completed.add("reviews");
    progress.current = "comments";
    const commented = await this.collectActionableComments(repo, prNumber, watchedSinceMs);
    progress.completed.add("comments");
    progress.current = undefined;
    if (!reviewed && !commented) {
      return "ok";
    }

    console.log(`\n📌 [${this.name}] new review feedback on ${repo}#${prNumber}`);
    progress.current = "write";
    let ok: TaskExecutionResult;
    try {
      ok = await addressPr(repo, prNumber);
      progress.completed.add("write");
    } catch (error) {
      // addressPr runs the feedback agent and its git/repo operations, not a
      // GitHub API fetch. Even when the message mentions the network (e.g.
      // "ssh: connect ... Network is unreachable"), a failed feedback run is
      // actionable, so always report it instead of letting the tick's
      // GitHub-transient filter hide it.
      captureError(error, {
        acquirer: this.name,
        repo,
        prNumber,
        stage: "address-pr",
      });
      console.warn(
        `⚠️  [${this.name}] addressing ${repo}#${prNumber} failed: ${(error as Error).message}`,
      );
      return "ok";
    } finally {
      progress.current = undefined;
    }
    if (ok === "deferred") {
      console.log(
        `⏳ [${this.name}] ${repo}#${prNumber} deferred; will retry when a harness is available`,
      );
    } else if (ok === "skipped") {
      console.log(`⏭️  [${this.name}] ${repo}#${prNumber} skipped; nothing to address`);
    } else if (ok === "interrupted") {
      console.log(`⏸️  [${this.name}] ${repo}#${prNumber} interrupted by worker shutdown`);
    } else {
      console.log(
        ok
          ? `✅ [${this.name}] ${repo}#${prNumber} feedback addressed`
          : `⚠️  [${this.name}] ${repo}#${prNumber} feedback run did not complete cleanly`,
      );
    }
    return "ok";
  }

  /** Mark unprocessed human `changes_requested` reviews as actionable. */
  private async collectActionableReviews(repo: string, prNumber: number): Promise<boolean> {
    const { workerState, queue, github } = this.options;
    const reviewsSource = `github:reviews:${repo}#${prNumber}`;
    const reviewsCursor = workerState.getCursor(reviewsSource);
    const reviewsResult = await github.fetchReviews(repo, prNumber, reviewsCursor?.etag);
    let actionable = false;
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
    return actionable;
  }

  /** Mark unprocessed non-bot inline comments as actionable and advance the cursor. */
  private async collectActionableComments(
    repo: string,
    prNumber: number,
    watchedSinceMs: number,
  ): Promise<boolean> {
    const { workerState, queue, github } = this.options;
    const commentsSource = `github:prcomments:${repo}#${prNumber}`;
    const commentsCursor = workerState.getCursor(commentsSource);
    const sinceIso = commentsCursor?.cursorValue ?? new Date(watchedSinceMs).toISOString();
    const comments = await github.fetchReviewCommentsSince(repo, prNumber, sinceIso);
    let maxCreatedAt = sinceIso;
    let actionable = false;
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
    return actionable;
  }

  /** Poller services for one team-PR sweep pass (shares this tick's stages). */
  private teamPrSweepHost(stages: TickStages): TeamPrSweepHost {
    const { github, workerState } = this.options;
    return {
      workerState,
      listOpenPullRequests: (repo, etag) =>
        github.listOpenPullRequests
          ? github.listOpenPullRequests(repo, etag)
          : Promise.resolve({ data: [], notModified: false }),
      fetchPr: (repo, prNumber, etag) => github.fetchPr(repo, prNumber, etag),
      syncBase: (repo, prNumber, pr) => this.maybeSyncBase(repo, prNumber, pr, { external: true }),
      onSuccess: (repo, stage) => recordStages(stages.succeeded, repo, [stage]),
      onFailure: (repo, prNumber, error, stage) =>
        this.handlePollFailure(stages, repo, prNumber, error, stage),
      warnPrInaccessible: (repo, prNumber) => this.warnPrInaccessible(repo, prNumber),
      warnListInaccessible: (repo) => this.warnRepoListInaccessible(repo),
    };
  }

  private warnRepoListInaccessible(repo: string): void {
    const now = this.now();
    const lastWarnAt = this.inaccessibleWarnAt.get(repo);
    if (
      lastWarnAt !== undefined &&
      now - lastWarnAt < ReviewPollingAcquirer.AUTH_WARN_INTERVAL_MS
    ) {
      return;
    }
    this.inaccessibleWarnAt.set(repo, now);
    console.warn(
      `⚠️  [${this.name}] GitHub returned 404 listing open PRs on ${repo}; team-PR base sync ` +
        "is paused for it. Check GITHUB_TOKEN access to this repository.",
    );
  }

  /**
   * Re-fetch the PR immediately before executing a base sync. Returns a "go"
   * with the fresh refs, or "stop" after recording/deferring or when the PR
   * changed, resolved itself, or GitHub is still recomputing mergeability.
   */
  private async refetchForBaseSync(
    repo: string,
    prNumber: number,
    expected: { headSha: string; baseSha: string },
    externalId: string,
    now: number,
    external = false,
  ): Promise<
    { kind: "go"; headSha: string; baseSha: string; branch: string | undefined } | { kind: "stop" }
  > {
    const { github, queue } = this.options;
    const freshResult = await github.fetchPr(repo, prNumber);
    const fresh = freshResult.data;
    // Teammate PRs: eligibility must still hold on the payload the run acts
    // on (the author's association or draft flag may have changed).
    if (external && fresh && (fresh.draft === true || !isTeamAuthor(fresh.author_association))) {
      return { kind: "stop" };
    }
    if (
      !fresh ||
      fresh.state !== "open" ||
      fresh.head?.sha !== expected.headSha ||
      fresh.base?.sha !== expected.baseSha
    ) {
      if (fresh?.state === "open" && fresh.head?.sha && fresh.base?.sha) {
        queue.observeBaseSyncEvent({
          externalId: this.baseSyncExternalId(repo, prNumber, fresh.base.sha, fresh.head.sha),
          repo,
          prNumber,
          baseSha: fresh.base.sha,
          headSha: fresh.head.sha,
          now,
        });
      }
      return { kind: "stop" };
    }
    // Mergeability resolved itself while we waited (someone else synced the
    // branch): nothing left to do.
    if (fresh.mergeable_state === "unknown" || !fresh.mergeable_state) {
      return { kind: "stop" };
    }
    if (fresh.mergeable_state !== "dirty" && fresh.mergeable_state !== "behind") {
      this.deferCounts.delete(externalId);
      queue.completeBaseSyncEvent(BASE_SYNC_SOURCE, externalId);
      return { kind: "stop" };
    }
    return { kind: "go", headSha: fresh.head.sha, baseSha: fresh.base.sha, branch: fresh.head.ref };
  }

  /** Run conflict resolution for a queued base-sync event and advance its state. */
  private async executeBaseSync(params: {
    repo: string;
    prNumber: number;
    externalId: string;
    now: number;
    headSha: string;
    baseSha: string;
    branch: string | undefined;
    /** Teammate PR (team-PR base sync); affects logging only. */
    external?: boolean;
  }): Promise<void> {
    const { queue, resolveConflicts, runStore } = this.options;
    if (!resolveConflicts) return;
    const { repo, prNumber, externalId, now, headSha, baseSha, branch } = params;

    const attempt = queue.beginBaseSyncAttempt(externalId, now);
    this.extendConflictWindowForDrain(now);
    let runId: number | null = null;
    try {
      runId =
        runStore?.createRun({
          origin: "conflict_resolution",
          repo,
          prNumber,
          prUrl: `https://github.com/${repo}/pull/${prNumber}`,
          branch,
          harness: this.options.harness ?? parseHarnessList(process.env.AGENT_HARNESS)[0],
          attempt,
        }) ?? null;
    } catch (error) {
      console.warn(`⚠️  Run recording (base sync begin) failed: ${(error as Error).message}`);
    }

    console.log(
      `\n🔀 [${this.name}] syncing ${repo}#${prNumber}` +
        `${params.external ? " (external PR)" : ""} with its advanced base`,
    );
    let result: AutomaticResolveResult;
    try {
      result = await resolveConflicts(repo, prNumber, { headSha, baseSha });
    } catch (error) {
      result = { outcome: "failed", message: (error as Error).message };
    }
    const exhausted = this.settleBaseSync(repo, prNumber, externalId, result, now);
    // Live (or just-landed) conflict work keeps a scheduled window draining.
    if (!exhausted) this.extendConflictWindowForDrain(this.now());
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

  /** Persist a resolver outcome on its base-sync event; returns true when exhausted. */
  private settleBaseSync(
    repo: string,
    prNumber: number,
    externalId: string,
    result: AutomaticResolveResult,
    now: number,
  ): boolean {
    const { queue } = this.options;
    if (result.outcome !== "failed" && result.outcome !== "deferred") {
      this.deferCounts.delete(externalId);
      queue.completeBaseSyncEvent(BASE_SYNC_SOURCE, externalId);
      return false;
    }
    if (result.outcome === "deferred") {
      const defers = (this.deferCounts.get(externalId) ?? 0) + 1;
      this.deferCounts.set(externalId, defers);
      console.warn(
        `⚠️  [${this.name}] ${repo}#${prNumber} base sync deferred: ${result.message} ` +
          `(${defers}/${MAX_CONSECUTIVE_DEFERS})`,
      );
      if (defers >= MAX_CONSECUTIVE_DEFERS) {
        console.warn(
          `⛔ [${this.name}] ${repo}#${prNumber} base sync keeps deferring; giving up until ` +
            `the head or base moves again`,
        );
        this.deferCounts.delete(externalId);
        queue.exhaustBaseSyncEvent(BASE_SYNC_SOURCE, externalId, result.message);
        return true;
      }
      queue.deferBaseSyncAttempt(externalId);
      return false;
    }
    console.warn(`⚠️  [${this.name}] ${repo}#${prNumber} base sync failed: ${result.message}`);
    const exhausted = queue.failBaseSyncEvent(externalId, result.message, now);
    if (exhausted) queue.exhaustBaseSyncEvent(BASE_SYNC_SOURCE, externalId, result.message);
    return exhausted;
  }

  private async maybeSyncBase(
    repo: string,
    prNumber: number,
    pr: PolledPr,
    opts: { external?: boolean } = {},
  ): Promise<void> {
    const { queue, resolveConflicts } = this.options;
    if (!resolveConflicts || this.options.conflictResolution === "disabled") return;
    if (!pr.head?.sha || !pr.base?.sha || !pr.head.ref) return;

    // The event key includes the head SHA so that new commits on the branch
    // (e.g. after a failed attempt was exhausted) open a fresh event without
    // waiting for the API-reported base SHA to move.
    const externalId = this.baseSyncExternalId(repo, prNumber, pr.base.sha, pr.head.sha);
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

    // GitHub's own mergeability verdict is the source of truth: "dirty"
    // means conflicting with the base, "behind" means mergeable but not up
    // to date. Ancestry checks against the API-reported base.sha are not
    // usable here — the field can lag the real branch tip for days, which
    // makes branches cut from newer main look "already included" and skips
    // them forever. "unknown" just means GitHub is recomputing after a push.
    if (pr.mergeable_state !== "dirty" && pr.mergeable_state !== "behind") return;

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
    // A conflict first seen (or whose head moved) while a scheduled window
    // is open keeps that window draining long enough to resolve it.
    const windowOpen = isConflictWindowOpen(this.conflictWindowState, now);
    if (event.updatedAt === now && windowOpen) this.extendConflictWindowForDrain(now);

    // Retry backoff: a previously failed event waits (doubled per further
    // failure) before another attempt. The anchor is the event's own
    // `updated_at`, stamped by the queue's clock at the last meaningful
    // change, so this works across worker restarts too.
    const backoffMs = baseSyncRetryBackoffMs(event.attempts);
    if (backoffMs > 0 && now - event.updatedAt < backoffMs) return;

    // Scheduled mode, outside the window: the conflict stays queued (the
    // event above is durable) and the agent is not invoked. A manual
    // `devintern resolve-conflicts <pr-url>` still runs on demand; once the
    // PR is no longer conflicting, the mergeability check above keeps the
    // queued event out of execution without spending tokens.
    if (this.options.conflictSchedule && !windowOpen) return;

    const quietMs = (this.options.quietPeriodSeconds ?? 30) * 1000;
    if (now - event.headObservedAt < quietMs) return;

    // Re-fetch immediately before execution. Any movement leaves the current
    // event pending and consumes no retry; a new base supersedes it immediately.
    const freshState = await this.refetchForBaseSync(
      repo,
      prNumber,
      { headSha: pr.head.sha, baseSha: pr.base.sha },
      externalId,
      now,
      opts.external,
    );
    if (freshState.kind === "stop") return;
    await this.executeBaseSync({
      repo,
      prNumber,
      externalId,
      now,
      headSha: freshState.headSha,
      baseSha: freshState.baseSha,
      branch: freshState.branch,
      external: opts.external,
    });
  }

  /**
   * Advance the durable scheduled-window state for this tick. Auto mode
   * (no schedule) is a no-op. The first tick after enabling scheduled mode
   * only schedules the next occurrence — conflicts detected from now on
   * queue for it instead of running. When an occurrence arrives, a grace
   * window opens so pending conflicts resolve on the following ticks.
   */
  private syncConflictWindow(): void {
    if (this.options.conflictResolution === "disabled") return;
    const schedule = this.options.conflictSchedule;
    if (!schedule) return;
    const now = this.now();
    if (this.conflictWindowState === undefined) {
      // Corrupt or missing state re-initializes below.
      this.conflictWindowState = parseConflictWindowState(
        this.options.workerState.getCursor(CONFLICT_WINDOW_SOURCE)?.cursorValue,
      );
    }

    let state = this.conflictWindowState;
    if (!state) {
      state = {
        nextWindowAt: nextScheduleOccurrence(schedule, now),
        windowOpenUntil: 0,
        windowCapAt: 0,
      };
      this.saveConflictWindowState(state);
      return;
    }
    if (now >= state.nextWindowAt) {
      // Fresh window: each window gets its own defer budget, and anything
      // still pending (including from a missed window while the worker was
      // down) resolves now.
      this.deferCounts.clear();
      state = openConflictWindow(
        nextScheduleOccurrence(schedule, now),
        now,
        this.conflictWindowGraceMs(),
      );
      this.saveConflictWindowState(state);
      console.log(
        `⏰ [${this.name}] conflict-resolution window open until ${new Date(
          state.windowOpenUntil,
        ).toISOString()}; queued conflicts will resolve now`,
      );
    }
  }

  /**
   * Scheduled mode only: the configured window and its durable state, or
   * `null` when conflicts resolve immediately (`auto`) or never (`disabled`).
   */
  conflictWindowStatus(): ConflictWindowStatus | null {
    const schedule = this.options.conflictSchedule;
    if (this.options.conflictResolution === "disabled" || !schedule) return null;
    if (!this.options.resolveConflicts) return null;
    const state = this.conflictWindowState ?? undefined;
    const now = this.now();
    return {
      schedule,
      nextWindowAt: state?.nextWindowAt,
      openUntil: state && now <= state.windowOpenUntil ? state.windowOpenUntil : undefined,
    };
  }

  /**
   * Dashboard "Run now" for scheduled conflict resolution: open the window
   * immediately (for the usual grace period) instead of waiting for the next
   * occurrence, then start a tick so queued conflicts resolve right away. The
   * next scheduled occurrence is unchanged. Per-PR safeguards still apply
   * (mergeability re-check, quiet period, retry backoff, repo locks).
   */
  openConflictWindowNow(): ConflictWindowTriggerOutcome {
    if (this.options.conflictResolution === "disabled") {
      return { ok: false, reason: "conflict resolution is disabled in workspace.toml" };
    }
    if (!this.options.conflictSchedule) {
      return {
        ok: false,
        reason: "conflict resolution runs automatically as soon as a conflict is detected",
      };
    }
    if (!this.options.resolveConflicts) {
      return { ok: false, reason: "conflict resolution is not available on this worker" };
    }
    // Load (or initialize) the durable cursor so the next occurrence is kept.
    this.syncConflictWindow();
    const now = this.now();
    const nextWindowAt =
      this.conflictWindowState?.nextWindowAt ??
      nextScheduleOccurrence(this.options.conflictSchedule, now);
    this.deferCounts.clear();
    this.saveConflictWindowState(
      openConflictWindow(nextWindowAt, now, this.conflictWindowGraceMs()),
    );
    console.log(
      `⏰ [${this.name}] conflict-resolution window opened on demand (dashboard) until ${new Date(
        now + this.conflictWindowGraceMs(),
      ).toISOString()}`,
    );
    // An in-flight tick finishes its pass; the open window covers the next one.
    if (this.timer) void this.tick();
    return { ok: true };
  }

  /**
   * Scheduled mode: keep the window open for the drain grace past `now`, up
   * to its hard cap. Only called for work begun inside an open window, so a
   * late event after an idle close never reopens it.
   */
  private extendConflictWindowForDrain(now: number): void {
    if (!this.options.conflictSchedule) return;
    const state = this.conflictWindowState;
    const extended = state ? extendConflictWindow(state, now) : null;
    if (!extended) return;
    this.saveConflictWindowState(extended);
    const until = new Date(extended.windowOpenUntil).toISOString();
    console.log(`⏰ [${this.name}] conflict window kept open until ${until} while work drains`);
  }

  private saveConflictWindowState(state: ConflictWindowState): void {
    this.conflictWindowState = state;
    this.options.workerState.setCursor(CONFLICT_WINDOW_SOURCE, JSON.stringify(state));
  }

  private conflictWindowGraceMs(): number {
    return resolveConflictWindowGraceMs(this.options.conflictWindowGraceMs);
  }

  private scheduleLabel(): string {
    const schedule = this.options.conflictSchedule;
    if (!schedule) return "auto";
    return schedule.cron ? `cron "${schedule.cron}"` : `interval ${schedule.interval}`;
  }

  /** Surface the active conflict-resolution mode on worker startup. */
  private logConflictMode(): void {
    const mode =
      this.options.conflictResolution ?? (this.options.conflictSchedule ? "scheduled" : "auto");
    if (mode === "disabled") {
      console.log(
        `⏸️  [${this.name}] conflict resolution: disabled (conflicts stay for manual resolution)`,
      );
      return;
    }
    if (!this.options.conflictSchedule) {
      console.log(
        `🔀 [${this.name}] conflict resolution: auto (immediately when a conflict is detected)`,
      );
      return;
    }
    const nextWindowAt = this.conflictWindowState?.nextWindowAt;
    console.log(
      `⏰ [${this.name}] conflict resolution: scheduled (${this.scheduleLabel()})` +
        (nextWindowAt ? `; next window ${new Date(nextWindowAt).toISOString()}` : ""),
    );
  }

  private baseSyncExternalId(repo: string, prNumber: number, baseSha: string, headSha: string) {
    return `base-sync:${repo}#${prNumber}:${baseSha}:${headSha}`;
  }

  private clearPrCache(key: string): void {
    this.prCache.delete(key);
  }
}
