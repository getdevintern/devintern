/**
 * Reply for an @mention that lands on a closed or merged PR.
 *
 * Every mention intake path (relay, mention sweep, direct webhook server)
 * checks the PR state before starting a run. A mention that passes the usual
 * gates (not bot-authored, actor has push access) on a PR that is no longer
 * open gets one short reply instead of an `address-review` run, so the
 * requester knows the bot saw it. Each path's own dedupe (processed-event ids
 * or webhook delivery ids) keeps the reply to one per triggering comment.
 */

/** Why a PR can no longer take pushes. */
export type ClosedPrState = "merged" | "closed";

/** PR fields the state check reads (REST PR payloads and webhook payloads). */
export interface PrStateFields {
  state: string;
  merged?: boolean | null;
  merged_at?: string | null;
}

/**
 * `"merged"` or `"closed"` for a PR that is not open, otherwise `null`.
 *
 * @param pr - PR state fields
 */
export function closedPrState(pr: PrStateFields): ClosedPrState | null {
  if (pr.state === "open") return null;
  return pr.merged || pr.merged_at ? "merged" : "closed";
}

/**
 * Marker on the reply, so the mention gates treat it as the worker's own
 * comment (see `isBotAuthored`).
 */
export const CLOSED_PR_MENTION_MARKER = "<!-- devintern:closed-pr-mention -->";

/**
 * Reply body for a mention on a PR that is not open.
 *
 * @param state - Whether the PR was merged or closed
 */
export function closedPrMentionReply(state: ClosedPrState): string {
  return (
    `This PR is already ${state}, so I can't push changes to it. Open a new PR, ` +
    "or file a ticket or ad-hoc task with this request, and I'll pick it up.\n\n" +
    CLOSED_PR_MENTION_MARKER
  );
}

/**
 * Post the closed-PR reply and log the skip. Posting is best-effort: a failed
 * post is logged, not thrown, so the delivery is still acknowledged as handled
 * and no run starts.
 *
 * @param target - PR, its state, and the mentioning user (for the log line)
 * @param postComment - Posts a PR conversation comment
 * @param logPrefix - Log prefix of the calling path (e.g. `[fleet]`)
 */
export async function replyToClosedPrMention(
  target: { repo: string; prNumber: number; state: ClosedPrState; actor: string },
  postComment: (body: string) => Promise<void>,
  logPrefix: string,
): Promise<void> {
  const where = `${target.repo}#${target.prNumber}`;
  console.log(
    `⏭️  ${logPrefix} Skipping mention on ${where} by @${target.actor}: PR is ${target.state}; ` +
      "replying instead of starting a run",
  );
  try {
    await postComment(closedPrMentionReply(target.state));
  } catch (error) {
    console.warn(
      `⚠️  ${logPrefix} Could not reply to the mention on ${target.state} PR ${where}: ` +
        (error as Error).message,
    );
  }
}
