/**
 * Relay handlers for GitHub @mentions: a PR conversation comment
 * (`pr.comment_created`) and a review submitted on a PR the agent did not
 * open (`pr.review_submitted`).
 *
 * Envelopes carry references only, so each handler re-reads the comment or
 * the PR's reviews with local credentials, keeps only items that @mention the
 * bot and were not written by the bot or the worker, and hands each to the
 * fleet mention handler (push-access gate, then an address-review run with
 * the mention as feedback). Handled mentions are recorded under the same
 * `processed_events` ids the fallback mention sweep uses, so the sweep never
 * runs them a second time.
 */

import {
  MENTION_DEDUPE_SOURCE,
  botMentionCandidates,
  mentionDedupeId,
  mentionsAnyBot,
} from "../acquirers/mention-sweep";
import type { TaskExecutionResult } from "../acquirers/task-polling";
import { isBotAuthored } from "../review/mention-trigger";
import type { MentionKind } from "../review/mention-trigger";
import type { WebhookQueue } from "../state/webhook-queue";

/** One comment or review as the relay handlers read it. */
export interface RelayMentionItem {
  id: number;
  body: string | null;
  user: { login: string; type?: string } | null;
}

/** GitHub reads for one repository (`owner/repo`). */
export interface RelayMentionGitHub {
  /** The PR conversation comment, or `null` when it no longer exists. */
  getIssueComment(commentId: number): Promise<RelayMentionItem | null>;
  /** Submitted reviews of the PR. */
  listReviews(
    prNumber: number,
  ): Promise<Array<RelayMentionItem & { submitted_at?: string | null }>>;
  /** Inline comments of one review. */
  listReviewComments(prNumber: number, reviewId: number): Promise<RelayMentionItem[]>;
  getBotUsername(): Promise<string | null>;
}

export type RelayMentionOutcome = boolean | "deferred" | "skipped" | "interrupted";

export interface RelayMentionHandlerOptions {
  github: (repo: string) => RelayMentionGitHub;
  queue: Pick<WebhookQueue, "hasProcessed" | "markProcessed">;
  handleMention: (
    repo: string,
    comment: { id: number; body: string | null; user: { login: string; type?: string } },
    prNumber: number,
    kind: MentionKind,
  ) => Promise<TaskExecutionResult>;
  verbose?: boolean;
  /** Clock (tests). */
  now?: () => number;
}

/**
 * How far before the envelope's `submitted_at` a review still counts as the
 * one delivered (clock skew between GitHub and the relay timestamp).
 */
const REVIEW_MATCH_SLACK_MS = 60_000;
/** Window used when the envelope timestamp does not parse. */
const REVIEW_FALLBACK_WINDOW_MS = 15 * 60_000;

/** Whether a run outcome settled the mention (so it must not run again). */
function settled(outcome: TaskExecutionResult): boolean {
  return outcome !== "deferred" && outcome !== "interrupted";
}

/** Build the relay `handlePrComment` / `handlePrReview` handlers. */
export function createRelayMentionHandlers(options: RelayMentionHandlerOptions): {
  handlePrComment(repo: string, prNumber: number, commentId: number): Promise<RelayMentionOutcome>;
  handlePrReview(repo: string, prNumber: number, submittedAt: string): Promise<RelayMentionOutcome>;
} {
  const { queue, handleMention, verbose } = options;
  const now = options.now ?? Date.now;

  /** Run one mention unless already handled; record it once settled. */
  const runOnce = async (
    repo: string,
    prNumber: number,
    item: RelayMentionItem & { user: { login: string; type?: string } },
    kind: MentionKind,
  ): Promise<RelayMentionOutcome> => {
    const dedupeId = mentionDedupeId(kind, item.id);
    if (queue.hasProcessed(MENTION_DEDUPE_SOURCE, dedupeId)) {
      if (verbose) console.log(`   [relay] mention ${dedupeId} already handled; skipping`);
      return "skipped";
    }
    const outcome = await handleMention(repo, item, prNumber, kind);
    if (settled(outcome)) queue.markProcessed(MENTION_DEDUPE_SOURCE, dedupeId);
    return outcome;
  };

  return {
    async handlePrComment(repo, prNumber, commentId) {
      const github = options.github(repo);
      const comment = await github.getIssueComment(commentId);
      if (!comment?.user) return "skipped";
      const botNames = botMentionCandidates(await github.getBotUsername());
      if (botNames.length === 0 || !mentionsAnyBot(comment.body, botNames)) {
        return "skipped";
      }
      if (isBotAuthored(comment, botNames)) {
        if (verbose) console.log(`   [relay] ignoring bot-authored comment on ${repo}#${prNumber}`);
        return "skipped";
      }
      return runOnce(repo, prNumber, { ...comment, user: comment.user }, "issue_comment");
    },

    async handlePrReview(repo, prNumber, submittedAt) {
      const github = options.github(repo);
      const botNames = botMentionCandidates(await github.getBotUsername());
      if (botNames.length === 0) return "skipped";
      const delivered = Date.parse(submittedAt);
      const earliest = Number.isNaN(delivered)
        ? now() - REVIEW_FALLBACK_WINDOW_MS
        : delivered - REVIEW_MATCH_SLACK_MS;
      const candidates = (await github.listReviews(prNumber))
        .filter((review) => review.submitted_at && Date.parse(review.submitted_at) >= earliest)
        .sort((a, b) => Date.parse(a.submitted_at ?? "") - Date.parse(b.submitted_at ?? ""));

      let result: RelayMentionOutcome = "skipped";
      for (const review of candidates) {
        if (!review.user || isBotAuthored(review, botNames)) continue;
        let mentioned = mentionsAnyBot(review.body, botNames);
        let mentioningComments: RelayMentionItem[] = [];
        if (!mentioned) {
          // A review whose line comments @mention the bot counts too; its
          // threads are in scope of a review-triggered run.
          mentioningComments = (await github.listReviewComments(prNumber, review.id)).filter(
            (comment) => mentionsAnyBot(comment.body, botNames),
          );
          mentioned = mentioningComments.length > 0;
        }
        if (!mentioned) continue;
        const outcome = await runOnce(repo, prNumber, { ...review, user: review.user }, "review");
        if (outcome === "deferred" || outcome === "interrupted") return outcome;
        // The review run covered its line comments; keep the sweep from
        // starting another run for each of them.
        for (const comment of mentioningComments) {
          queue.markProcessed(MENTION_DEDUPE_SOURCE, mentionDedupeId("review_comment", comment.id));
        }
        if (outcome === false || result === false) result = false;
        else if (outcome !== "skipped" || result === "skipped") result = outcome;
      }
      if (result === "skipped" && verbose) {
        console.log(
          `   [relay] review on non-agent PR ${repo}#${prNumber} has no @mention; ignored`,
        );
      }
      return result;
    },
  };
}
