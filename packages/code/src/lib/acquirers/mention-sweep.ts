/**
 * Mention sweep acquirer (worker Mode 1, Tier 2): react to @mentions on ANY
 * PR in the repo, not only the agent's own.
 *
 * Detection is a repo-wide sweep — two `since`-cursor requests per tick
 * regardless of how many PRs are open:
 * - `GET /repos/{r}/issues/comments?since=` (PR conversation comments)
 * - `GET /repos/{r}/pulls/comments?since=`  (inline review comments)
 * filtered for the bot's @mention.
 *
 * Guardrails, in order:
 * 1. Bot identity required — without a resolvable bot username there is
 *    nothing to match, and the sweep stays dormant.
 * 2. Fork PRs are skipped (with an explanatory comment) unless
 *    `maintainer_can_modify` allows pushing to the contributor's branch.
 * 3. The permission gate (write/maintain/admin; API errors are retried, never
 *    treated as a grant) and the mention gate both apply inside the shared
 *    review pipeline this feeds.
 * 4. Pushes go through regular fast-forward `git push` — if a human moved
 *    the branch meanwhile, the push is rejected rather than clobbering.
 *
 * Comment ids dedupe via `processed_events`; cursors start at worker start
 * (old mentions are not dug up) and persist across restarts.
 *
 * Retry semantics: a run interrupted by a shutdown drain or deferred because
 * every harness is usage-limited releases its dedupe claim, holds the cursor
 * before the comment, and is retried on the next sweep without spending an
 * attempt. A handler that throws (for example a transient permission-API
 * error) is retried the same way up to `feedbackMaxAttempts` times (durable
 * ledger in `WebhookQueue`), then marked handled. A throw that
 * `classifyWebhookError` deems permanent (e.g. a 404 for a plain issue) is
 * marked handled immediately.
 */

import { startFirstTickInBackground } from "./background-tick";
import { classifyWebhookError } from "../webhook/webhook-errors";
import type { WebhookQueue } from "../state/webhook-queue";
import type { WorkerState } from "../state/worker-state";
import type { TaskExecutionResult } from "./task-polling";
import type { Acquirer } from "../../worker";

export interface SweptComment {
  id: number;
  body: string | null;
  user: { login: string; type: string };
  created_at: string;
  html_url: string;
  /** Present on issue-comment feed items; used to resolve the PR number. */
  issue_url?: string;
  /** Present on review-comment feed items. */
  pull_request_url?: string;
}

export interface SweptPrInfo {
  number: number;
  state: string;
  /** Head repo slug; differs from the base repo for fork PRs. */
  headRepoFullName?: string;
  maintainerCanModify?: boolean;
}

export interface MentionSweepGitHub {
  /** Repo-wide conversation comments since `sinceIso`. */
  fetchIssueCommentsSince(sinceIso: string): Promise<SweptComment[]>;
  /** Repo-wide inline review comments since `sinceIso`. */
  fetchReviewCommentsSince(sinceIso: string): Promise<SweptComment[]>;
  /** Bot login (e.g. `devintern[bot]`), or null when not resolvable. */
  getBotUsername(): Promise<string | null>;
  /** PR lookup; must reject/throw for plain (non-PR) issues. */
  getPr(prNumber: number): Promise<SweptPrInfo>;
  /** Best-effort explanatory comment (fork skip). */
  postComment(prNumber: number, body: string): Promise<void>;
}

export interface MentionSweepAcquirerOptions {
  /** Base repo slug (`owner/repo`) the worker operates on. */
  repo: string;
  intervalSeconds: number;
  /** Whether mention acquisition should run. */
  shouldPollFeedback?: () => boolean;
  /** Safety sweep cadence while relay is healthy. Defaults to 30 minutes. */
  feedbackFallbackIntervalSeconds?: number;
  workerState: WorkerState;
  queue: WebhookQueue;
  github: MentionSweepGitHub;
  /**
   * Feed one mention into the review pipeline (injected for tests).
   *
   * Returns the run outcome so an `"interrupted"`/`"deferred"` run can release
   * the comment's dedupe claim and be retried instead of being lost.
   */
  handleMention: (comment: SweptComment, prNumber: number) => Promise<TaskExecutionResult>;
  /**
   * Failed (throwing) handler attempts tolerated per comment before the
   * mention is marked handled anyway. Defaults to
   * `WORKER_FEEDBACK_MAX_ATTEMPTS`, or 3.
   */
  feedbackMaxAttempts?: number;
  verbose?: boolean;
}

/** Dedupe source for swept comment ids. */
const SOURCE = "github:mentions";

/** Default per-comment attempt budget for throwing mention handlers. */
export const DEFAULT_FEEDBACK_MAX_ATTEMPTS = 3;

/**
 * Resolve the per-comment attempt budget: explicit option, then
 * `WORKER_FEEDBACK_MAX_ATTEMPTS`, then {@link DEFAULT_FEEDBACK_MAX_ATTEMPTS}.
 *
 * @param explicit - Option override (tests/embedders)
 */
export function feedbackMaxAttempts(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const parsed = parseInt(process.env.WORKER_FEEDBACK_MAX_ATTEMPTS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FEEDBACK_MAX_ATTEMPTS;
}

/**
 * Whether a comment body mentions the bot (`@name`, with or without the
 * `[bot]` suffix), case-insensitively.
 *
 * @param body - Comment body
 * @param botName - Bot login (possibly ending in `[bot]`)
 */
export function mentionsBot(body: string | null, botName: string): boolean {
  if (!body) {
    return false;
  }
  const bare = botName.replace(/\[bot\]$/i, "");
  const haystack = body.toLowerCase();
  return (
    haystack.includes(`@${botName.toLowerCase()}`) || haystack.includes(`@${bare.toLowerCase()}`)
  );
}

/**
 * Extra bot logins that should count as @mentions beyond the resolved GitHub
 * identity, from `GITHUB_BOT_ALIASES` (comma-separated, with or without the
 * `[bot]` suffix). The main use case is the relay: relay-managed PRs are
 * associated with the DevIntern AI App identity, whose private key never
 * leaves DevIntern infrastructure — so the local worker cannot resolve it via
 * App auth and must be told the login instead.
 */
export function botMentionAliases(): string[] {
  return (process.env.GITHUB_BOT_ALIASES ?? "")
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
}

/**
 * All bot logins a mention gate should match: the resolved identity (App auth
 * or a Bot-type token) plus configured aliases, deduped order-stable.
 */
export function botMentionCandidates(resolvedBotName: string | null): string[] {
  return [
    ...new Set([resolvedBotName, ...botMentionAliases()].filter((n): n is string => Boolean(n))),
  ];
}

/**
 * Whether a comment body mentions any of the candidate bot logins.
 */
export function mentionsAnyBot(body: string | null, botNames: string[]): boolean {
  return botNames.some((name) => mentionsBot(body, name));
}

/**
 * Sweeps the repo for bot mentions on any PR.
 */
export class MentionSweepAcquirer implements Acquirer {
  readonly name = "poll:mentions";
  private options: MentionSweepAcquirerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private botName: string | null | undefined; // undefined = not resolved yet
  private warnedNoBot = false;
  private sweepAnnounced = false;
  private lastFeedbackPollAt: number;

  constructor(options: MentionSweepAcquirerOptions) {
    this.options = options;
    this.lastFeedbackPollAt = Date.now();
  }

  /** Start sweeping: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    if (this.timer) return;
    // The "Sweeping ..." line is logged by the first tick, once the bot
    // identity resolves: a worker with no usable identity never sweeps.
    // Arm the interval first, then run the first tick in the background: the
    // busy guard turns an interval fire during it into a no-op, and a long
    // first tick must not hold later acquirers (see background-tick.ts).
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
    startFirstTickInBackground(this.name, () => this.tick());
  }

  /** Stop sweeping (an in-flight tick finishes its current mention). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Apply a new sweep cadence without restarting (live workspace config
   * reload). Re-arms the repeating timer with the new interval.
   */
  updateInterval(intervalSeconds: number): void {
    this.options.intervalSeconds = intervalSeconds;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), intervalSeconds * 1000);
  }

  /** One repo-wide sweep over both comment feeds. Skipped while busy. */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;

    try {
      const fallbackMs = (this.options.feedbackFallbackIntervalSeconds ?? 30 * 60) * 1000;
      const now = Date.now();
      if (
        !(this.options.shouldPollFeedback?.() ?? true) &&
        now - this.lastFeedbackPollAt < fallbackMs
      ) {
        return;
      }
      this.lastFeedbackPollAt = now;
      const botNames = botMentionCandidates(await this.resolveBotName());
      if (botNames.length === 0) {
        return;
      }

      await this.sweepFeed(
        `github:mention:issuecomments:${this.options.repo}`,
        (since) => this.options.github.fetchIssueCommentsSince(since),
        botNames,
      );
      await this.sweepFeed(
        `github:mention:prcomments:${this.options.repo}`,
        (since) => this.options.github.fetchReviewCommentsSince(since),
        botNames,
      );
    } catch (error) {
      console.warn(
        `⚠️  [${this.name}] ${this.options.repo} sweep failed: ${(error as Error).message}`,
      );
    } finally {
      this.busy = false;
    }
  }

  /** Resolve and cache the bot login; warn once when no identity is usable. */
  private async resolveBotName(): Promise<string | null> {
    if (this.botName === undefined) {
      this.botName = await this.options.github.getBotUsername();
      if (!this.botName && botMentionAliases().length === 0) {
        // Expected with token-mode auth, so info rather than a warning, once.
        if (!this.warnedNoBot) {
          this.warnedNoBot = true;
          console.log(
            `ℹ️  [${this.name}] mention sweeping is off for ${this.options.repo}: no bot ` +
              `username (GitHub App auth required, or set GITHUB_BOT_ALIASES)`,
          );
        }
      } else if (!this.sweepAnnounced) {
        this.sweepAnnounced = true;
        console.log(
          `🔎 Sweeping ${this.options.repo} for @mentions every ${this.options.intervalSeconds}s`,
        );
      }
    }
    return this.botName;
  }

  /** Sweep one comment feed since its cursor and handle new mentions. */
  private async sweepFeed(
    cursorSource: string,
    fetchSince: (sinceIso: string) => Promise<SweptComment[]>,
    botNames: string[],
  ): Promise<void> {
    const { workerState, queue, github, handleMention, verbose } = this.options;
    const maxAttempts = feedbackMaxAttempts(this.options.feedbackMaxAttempts);

    const cursor = workerState.getCursor(cursorSource);
    // Mentions predating the first worker start are not dug up.
    const sinceIso = cursor?.cursorValue ?? new Date().toISOString();
    if (!cursor) {
      workerState.setCursor(cursorSource, sinceIso);
    }

    const comments = await fetchSince(sinceIso);
    let maxCreatedAt = sinceIso;
    // Earliest cursor a comment that must be retried needs held. A throw holds
    // it but lets the sweep continue, so one failing mention does not delay
    // the rest of the feed; comments handled past the hold are deduped by
    // `processed_events` when the next sweep re-reads them.
    let holdCursor: string | null = null;

    for (const comment of comments) {
      // Cursor to hold when this comment must be retried: its value before
      // the comment, but never past the comment itself (feeds are not
      // guaranteed to be created_at-ordered) nor behind this sweep's start.
      const beforeComment = comment.created_at < maxCreatedAt ? comment.created_at : maxCreatedAt;
      const retryCursor = beforeComment > sinceIso ? beforeComment : sinceIso;
      if (comment.created_at > maxCreatedAt) {
        maxCreatedAt = comment.created_at;
      }
      if (comment.user.type === "Bot") {
        continue;
      }
      const matchedBot = botNames.find((name) => mentionsBot(comment.body, name));
      if (!matchedBot) {
        continue;
      }

      const externalId = `comment:${comment.id}`;
      if (queue.hasProcessed(SOURCE, externalId)) {
        continue;
      }
      queue.markProcessed(SOURCE, externalId);

      const prNumber = extractPrNumber(comment);
      if (prNumber === null) {
        if (verbose) {
          console.log(`   [${this.name}] mention ${comment.id} is not on a PR; skipping`);
        }
        continue;
      }

      try {
        // Confirm it's an open PR (plain issues reject here) and apply the
        // fork guard before feeding the pipeline.
        const pr = await github.getPr(prNumber);
        if (pr.state !== "open") {
          continue;
        }

        const isFork =
          pr.headRepoFullName !== undefined && pr.headRepoFullName !== this.options.repo;
        if (isFork && !pr.maintainerCanModify) {
          console.log(
            `⛔ [${this.name}] skipping mention on fork PR #${prNumber} ` +
              `(maintainer edits not allowed)`,
          );
          await github
            .postComment(
              prNumber,
              "This PR's branch lives on a fork that does not allow maintainer edits, " +
                'so the agent cannot push fixes here. Enable "Allow edits by maintainers" ' +
                "on the PR and mention the bot again.",
            )
            .catch(() => {});
          continue;
        }

        console.log(
          `\n📌 [${this.name}] @${matchedBot} mentioned on PR #${prNumber} by @${comment.user.login}`,
        );
        const outcome = await handleMention(comment, prNumber);
        if (outcome === "interrupted" || outcome === "deferred") {
          // The run did not settle (shutdown drain) or never started (every
          // harness usage-limited). Neither is an attempt: release the claim
          // and stop before the cursor passes this comment so the next sweep
          // retries it, matching the relay path. Stopping (rather than
          // continuing) is deliberate: a shutdown must not start new runs, and
          // with no harness available later mentions would defer too.
          queue.unmarkProcessed(SOURCE, externalId);
          holdCursor = earlierIso(holdCursor, retryCursor);
          console.log(
            outcome === "interrupted"
              ? `⏸️  [${this.name}] mention on PR #${prNumber} interrupted by worker shutdown; will retry`
              : `⏳ [${this.name}] mention on PR #${prNumber} deferred; will retry when a harness is available`,
          );
          break;
        }
        // Settled: forget any retry history left by earlier throws.
        queue.clearFeedbackAttempts(ledgerId(externalId));
      } catch (error) {
        const message = (error as Error).message;
        if (classifyWebhookError(error) === "permanent") {
          // A terminal failure (e.g. a 404 because the mention is on a plain
          // issue, not a PR) never succeeds on retry: keep the claim and do
          // not spend attempts or hold the cursor.
          queue.clearFeedbackAttempts(ledgerId(externalId));
          console.warn(
            `⚠️  [${this.name}] handling mention on #${prNumber} failed permanently; ` +
              `marking it handled: ${message}`,
          );
          continue;
        }
        // The claim is provisional until the handler settles. A throw (for
        // example a transient permission-API error) releases it and holds the
        // cursor; the durable ledger bounds the retries so a deterministic
        // failure still becomes terminal.
        const attempts = queue.beginFeedbackAttempt(
          ledgerId(externalId),
          `mention on ${this.options.repo}#${prNumber} threw: ${message}`,
        );
        if (attempts < maxAttempts) {
          queue.unmarkProcessed(SOURCE, externalId);
          holdCursor = earlierIso(holdCursor, retryCursor);
          console.warn(
            `⚠️  [${this.name}] handling mention on #${prNumber} failed ` +
              `(attempt ${attempts}/${maxAttempts}); will retry: ${message}`,
          );
          continue;
        }
        queue.clearFeedbackAttempts(ledgerId(externalId));
        console.warn(
          `⚠️  [${this.name}] handling mention on #${prNumber} failed ` +
            `${attempts} times; marking it handled: ${message}`,
        );
      }
    }

    const nextCursor = earlierIso(holdCursor, maxCreatedAt);
    if (nextCursor !== sinceIso) {
      workerState.setCursor(cursorSource, nextCursor);
    }
  }
}

/** The earlier of two ISO timestamps, treating `null` as unset. */
function earlierIso(held: string | null, candidate: string): string {
  return held !== null && held < candidate ? held : candidate;
}

/** Attempt-ledger key for a swept comment's dedupe id. */
function ledgerId(externalId: string): string {
  return `${SOURCE}:${externalId}`;
}

/** Resolve the PR number from either comment feed's URL fields. */
export function extractPrNumber(comment: SweptComment): number | null {
  const url = comment.pull_request_url ?? comment.issue_url;
  if (!url) {
    return null;
  }
  const match = url.match(/\/(?:pulls|issues)\/(\d+)$/);
  if (!match || !match[1]) {
    return null;
  }
  return parseInt(match[1], 10);
}
