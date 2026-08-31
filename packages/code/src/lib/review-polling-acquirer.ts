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
 * Base sync eligibility comes from GitHub's own `mergeable_state` ("dirty"
 * or "behind"), not from ancestry checks against the API-reported base
 * SHA — that field can lag the real branch tip for days and would both
 * skip eligible PRs forever and loop ineligible ones.
 *
 * Review/comment ids dedupe via `processed_events`, so webhook redeliveries
 * or window overlap never double-run. ETags and comment cursors persist per
 * PR in `cursors`.
 */

import { spawn } from "child_process";

import { parseHarnessList } from "@devintern/agent-harness";
import { nextScheduleOccurrence } from "./automation-config";
import type { CronOrIntervalSchedule } from "./automation-config";
import { parseEnvInteger } from "./env-integer";
import type { RunStore } from "./run-recorder";
import type { WebhookQueue } from "./webhook-queue";
import type { WorkerState } from "./worker-state";
import type { ConflictResolutionMode } from "./workspace/config";
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
}

/** Dedupe source for review/comment ids. */
const SOURCE = "github:reviews";
const BASE_SYNC_SOURCE = "github:base-sync";
/** Durable cursor source for the scheduled conflict-resolution window. */
const CONFLICT_WINDOW_SOURCE = "worker:conflict-window";
const prRunTails = new Map<string, Promise<void>>();

/** Default minutes a scheduled conflict-resolution window stays open. */
export const DEFAULT_CONFLICT_WINDOW_GRACE_MINUTES = 60;

/** Durable state for scheduled conflict resolution (persisted per worker). */
interface ConflictWindowState {
  /** Next scheduled occurrence (ms epoch). */
  nextWindowAt: number;
  /** Resolution attempts are allowed until this instant (0 = none opened yet). */
  windowOpenUntil: number;
}

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

/** Default wall-clock budget for one resolve-conflicts subprocess. */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 30 * 60 * 1000;

/** Resolver subprocess budget; `WORKER_RESOLVE_TIMEOUT_SECONDS` overrides (0 disables). */
function resolveTimeoutMs(overrideMs?: number): number {
  if (overrideMs !== undefined) return overrideMs;
  return (
    parseEnvInteger("WORKER_RESOLVE_TIMEOUT_SECONDS", DEFAULT_RESOLVE_TIMEOUT_MS / 1000, {
      min: 0,
    }) * 1000
  );
}

/** Kill a spawned process and (best-effort) its whole process group. */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  // The child is spawned detached, so it leads its own process group;
  // the negative pid signals every descendant (e.g. agent harnesses).
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  // If the SIGTERM already finished the child, cancel the deferred SIGKILL:
  // by then the pid/pgid may have been recycled for an unrelated process, and
  // signalling that would kill a bystander (e.g. under heavy test-suite churn).
  const sigkillTimer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 5_000).unref();
  child.once("close", () => clearTimeout(sigkillTimer));
}

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
 *               the workspace worker runs from the repo's base worktree with
 *               per-repo env; direct callers inherit both.
 */
export function runAddressReviewViaCli(
  repo: string,
  prNumber: number,
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
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
    /** Hard wall-clock budget; defaults to `WORKER_RESOLVE_TIMEOUT_SECONDS` (30min). */
    timeoutMs?: number;
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
    timeoutMs?: number;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
  },
): Promise<AutomaticResolveResult> {
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  return new Promise((resolve) => {
    let result: AutomaticResolveResult | null = null;
    let resultOutput = "";
    let resultOverflow = false;
    let timedOut = false;
    const maxResultBytes = 64 * 1024;
    // Detached so the whole process group (agent harnesses included) can be
    // signalled on timeout.
    const child = spawn(
      process.execPath,
      [opts.entrypoint ?? process.argv[1], "resolve-conflicts", prUrl, ...extraArgs],
      {
        detached: true,
        stdio: ["inherit", opts.outputStdio ?? "inherit", opts.outputStdio ?? "inherit", "pipe"],
        cwd: opts.cwd,
        env: { ...(opts.env ?? process.env), DEVINTERN_RESULT_FD: "3" },
      },
    );
    const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            console.warn(
              `⏱️  resolve-conflicts for ${prUrl} exceeded ${Math.round(timeoutMs / 1000)}s; killing`,
            );
            killProcessTree(child);
          }, timeoutMs)
        : null;
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
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ outcome: "failed", message: `resolver timed out after ${timeoutMs}ms` });
        return;
      }
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
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ outcome: "failed", message: `failed to spawn resolver: ${error.message}` });
    });
  });
}

function runSubcommandViaCli(
  subcommand: string,
  repo: string,
  prNumber: number,
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<boolean> {
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], subcommand, prUrl], {
      stdio: ["inherit", "inherit", "inherit"],
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
  private prCache = new Map<string, PolledPr>();
  /** Consecutive `deferred` resolver outcomes per base-sync event. */
  private deferCounts = new Map<string, number>();
  /** Cached scheduled-window state; `undefined` = not loaded from the cursor yet. */
  private conflictWindowState: ConflictWindowState | null | undefined;

  constructor(options: ReviewPollingAcquirerOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
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
    this.syncConflictWindow();
    this.logConflictMode();
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
      this.syncConflictWindow();
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
    const { workerState, queue, github, addressPr, resolveConflicts } = this.options;

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
    if (!resolveConflicts) return;
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
    if (this.options.conflictSchedule && !this.conflictWindowOpen(now)) return;

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
          externalId: this.baseSyncExternalId(repo, prNumber, fresh.base.sha, fresh.head.sha),
          repo,
          prNumber,
          baseSha: fresh.base.sha,
          headSha: fresh.head.sha,
          now,
        });
      }
      return;
    }
    // Mergeability resolved itself while we waited (someone else synced the
    // branch): nothing left to do.
    if (fresh.mergeable_state === "unknown" || !fresh.mergeable_state) return;
    if (fresh.mergeable_state !== "dirty" && fresh.mergeable_state !== "behind") {
      this.deferCounts.delete(externalId);
      queue.completeBaseSyncEvent(BASE_SYNC_SOURCE, externalId);
      return;
    }

    const attempt = queue.beginBaseSyncAttempt(externalId, now);
    let runId: number | null = null;
    try {
      runId =
        runStore?.createRun({
          origin: "conflict_resolution",
          repo,
          prNumber,
          branch: fresh.head.ref,
          harness: this.options.harness ?? parseHarnessList(process.env.AGENT_HARNESS)[0],
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
      this.deferCounts.delete(externalId);
      queue.completeBaseSyncEvent(BASE_SYNC_SOURCE, externalId);
    } else if (result.outcome === "deferred") {
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
      } else {
        queue.deferBaseSyncAttempt(externalId);
      }
    } else {
      console.warn(`⚠️  [${this.name}] ${repo}#${prNumber} base sync failed: ${result.message}`);
      const exhausted = queue.failBaseSyncEvent(externalId, result.message, now);
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

  private prKey(repo: string, prNumber: number): string {
    return `${repo.toLowerCase()}#${prNumber}`;
  }

  /**
   * Advance the durable scheduled-window state for this tick. Auto mode
   * (no schedule) is a no-op. The first tick after enabling scheduled mode
   * only schedules the next occurrence — conflicts detected from now on
   * queue for it instead of running. When an occurrence arrives, a grace
   * window opens so pending conflicts resolve on the following ticks.
   */
  private syncConflictWindow(): void {
    const schedule = this.options.conflictSchedule;
    if (!schedule) return;
    const now = this.now();
    if (this.conflictWindowState === undefined) {
      this.conflictWindowState = null;
      const raw = this.options.workerState.getCursor(CONFLICT_WINDOW_SOURCE)?.cursorValue;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<ConflictWindowState>;
          if (
            typeof parsed.nextWindowAt === "number" &&
            typeof parsed.windowOpenUntil === "number"
          ) {
            this.conflictWindowState = {
              nextWindowAt: parsed.nextWindowAt,
              windowOpenUntil: parsed.windowOpenUntil,
            };
          }
        } catch {
          // Corrupt state re-initializes below.
        }
      }
    }

    let state = this.conflictWindowState;
    if (!state) {
      state = { nextWindowAt: nextScheduleOccurrence(schedule, now), windowOpenUntil: 0 };
      this.saveConflictWindowState(state);
      return;
    }
    if (now >= state.nextWindowAt) {
      // Fresh window: each window gets its own defer budget, and anything
      // still pending (including from a missed window while the worker was
      // down) resolves now.
      this.deferCounts.clear();
      state = {
        nextWindowAt: nextScheduleOccurrence(schedule, now),
        windowOpenUntil: now + this.conflictWindowGraceMs(),
      };
      this.saveConflictWindowState(state);
      console.log(
        `⏰ [${this.name}] conflict-resolution window open until ${new Date(
          state.windowOpenUntil,
        ).toISOString()}; queued conflicts will resolve now`,
      );
    }
  }

  /** Scheduled mode only: are resolution attempts currently allowed? */
  private conflictWindowOpen(now: number): boolean {
    const state = this.conflictWindowState;
    return state != null && now <= state.windowOpenUntil;
  }

  private saveConflictWindowState(state: ConflictWindowState): void {
    this.conflictWindowState = state;
    this.options.workerState.setCursor(CONFLICT_WINDOW_SOURCE, JSON.stringify(state));
  }

  private conflictWindowGraceMs(): number {
    return (
      this.options.conflictWindowGraceMs ??
      parseEnvInteger(
        "WORKER_RESOLVE_WINDOW_GRACE_MINUTES",
        DEFAULT_CONFLICT_WINDOW_GRACE_MINUTES,
        { min: 0 },
      ) * 60_000
    );
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
