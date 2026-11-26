/**
 * The PR comment or review that @mentioned the bot and triggered a feedback
 * run. The worker hands it to the `address-review` subprocess
 * (`--mention <kind>:<id>`) so the mention itself is addressed as feedback,
 * also on PRs that have no reviews at all.
 *
 * Only the kind and id cross the process boundary: the subprocess re-fetches
 * the body with its own credentials, so comment text never lands in argv.
 */

/** Where the mention was written. */
export type MentionKind = "issue_comment" | "review_comment" | "review";

export const MENTION_KINDS: readonly MentionKind[] = ["issue_comment", "review_comment", "review"];

export interface MentionTrigger {
  kind: MentionKind;
  /** Issue comment, review comment, or review id (per `kind`). */
  id: number;
}

/** `--mention` argument value for a trigger (`<kind>:<id>`). */
export function formatMentionArg(trigger: MentionTrigger): string {
  return `${trigger.kind}:${trigger.id}`;
}

/** Parse a `--mention` argument value; `undefined` when malformed. */
export function parseMentionArg(value: string): MentionTrigger | undefined {
  const match = /^(issue_comment|review_comment|review):(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  return { kind: match[1] as MentionKind, id };
}

/** Stable key for deduping triggers (`<kind>:<id>`). */
export function mentionTriggerKey(trigger: MentionTrigger): string {
  return formatMentionArg(trigger);
}

/**
 * Marker that every comment the worker itself posts carries
 * (`<!-- devintern:… -->`). In relay mode the worker writes with the user's
 * own token, so the author login alone cannot tell a worker comment apart.
 */
const WORKER_COMMENT_MARKER = "<!-- devintern";

/**
 * Whether a comment or review was written by the bot or the worker itself.
 * Acting on one would let the agent trigger itself in a loop.
 *
 * @param item - Author and body of the comment or review
 * @param botNames - Bot logins the mention gate matches (with or without `[bot]`)
 */
export function isBotAuthored(
  item: { user?: { login?: string; type?: string } | null; body?: string | null },
  botNames: readonly string[] = [],
): boolean {
  const login = item.user?.login?.toLowerCase();
  if (item.user?.type === "Bot" || login?.endsWith("[bot]")) return true;
  if (login) {
    const bare = login.replace(/\[bot\]$/, "");
    if (botNames.some((name) => name.toLowerCase().replace(/\[bot\]$/, "") === bare)) return true;
  }
  return item.body?.includes(WORKER_COMMENT_MARKER) ?? false;
}
