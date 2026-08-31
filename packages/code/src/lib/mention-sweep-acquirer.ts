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
 * 3. The permission gate (write/maintain/admin, fails closed) and the
 *    mention gate both apply inside the shared review pipeline this feeds.
 * 4. Pushes go through regular fast-forward `git push` — if a human moved
 *    the branch meanwhile, the push is rejected rather than clobbering.
 *
 * Comment ids dedupe via `processed_events`; cursors start at worker start
 * (old mentions are not dug up) and persist across restarts.
 */

import type { WebhookQueue } from "./webhook-queue";
import type { WorkerState } from "./worker-state";
import type { Acquirer } from "../worker";

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
  workerState: WorkerState;
  queue: WebhookQueue;
  github: MentionSweepGitHub;
  /** Feed one mention into the review pipeline (injected for tests). */
  handleMention: (comment: SweptComment, prNumber: number) => Promise<void>;
  verbose?: boolean;
}

/** Dedupe source for swept comment ids. */
const SOURCE = "github:mentions";

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

  constructor(options: MentionSweepAcquirerOptions) {
    this.options = options;
  }

  /** Start sweeping: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    console.log(
      `🔎 Sweeping ${this.options.repo} for @mentions every ${this.options.intervalSeconds}s`,
    );
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
  }

  /** Stop sweeping (an in-flight tick finishes its current mention). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One repo-wide sweep over both comment feeds. Skipped while busy. */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;

    try {
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
      console.warn(`⚠️  [${this.name}] sweep failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Resolve and cache the bot login; warn once when no identity is usable. */
  private async resolveBotName(): Promise<string | null> {
    if (this.botName === undefined) {
      this.botName = await this.options.github.getBotUsername();
      if (!this.botName && botMentionAliases().length === 0 && !this.warnedNoBot) {
        this.warnedNoBot = true;
        console.warn(
          `⚠️  [${this.name}] could not resolve a bot username (GitHub App auth required, ` +
            `or set GITHUB_BOT_ALIASES); mention sweeping is disabled`,
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

    const cursor = workerState.getCursor(cursorSource);
    // Mentions predating the first worker start are not dug up.
    const sinceIso = cursor?.cursorValue ?? new Date().toISOString();
    if (!cursor) {
      workerState.setCursor(cursorSource, sinceIso);
    }

    const comments = await fetchSince(sinceIso);
    let maxCreatedAt = sinceIso;

    for (const comment of comments) {
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
        await handleMention(comment, prNumber);
      } catch (error) {
        console.warn(
          `⚠️  [${this.name}] handling mention on #${prNumber} failed: ${(error as Error).message}`,
        );
      }
    }

    if (maxCreatedAt !== sinceIso) {
      workerState.setCursor(cursorSource, maxCreatedAt);
    }
  }
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
