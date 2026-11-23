/**
 * The auto-merge status comment: one comment per PR, created on the first
 * decision and edited in place on later ones (new commits, policy changes),
 * so the PR always states its current auto-merge outcome without a new
 * comment per push.
 */

import type { AutoMergeMethod } from "./merge-gate";

/** Hidden first line identifying the managed comment. */
export const AUTO_MERGE_COMMENT_MARKER = "<!-- devintern:auto-merge-status -->";

/** Changed files listed in a "left open" comment before summarizing the rest. */
const MAX_LISTED_PATHS = 10;

/** Why a PR was left open for a human. */
export type LeftOpenReason =
  /**
   * Agent review is off. `paths` are outside the safe paths; `reviewPathMatches`
   * match `auto_merge_review_paths` (listed separately, even if also outside).
   */
  | { kind: "outside-safe-paths"; paths: string[]; reviewPathMatches?: string[] }
  | { kind: "denied"; path: string; pattern: string }
  /** `policy` is the policy label (`strict`, ..., `custom: rules.md`). */
  | { kind: "agent-unsafe"; reason: string; policy: string; reviewPathMatches?: string[] }
  /** A `custom` policy's rules could not be loaded, so no review ran. */
  | { kind: "rules-unavailable"; policy: string; problem: string }
  | { kind: "not-evaluable"; detail: string };

export type AutoMergeCommentStatus =
  | { kind: "merged"; method: AutoMergeMethod; headSha: string; agentReason?: string }
  | {
      kind: "left-open";
      headSha: string;
      reason: LeftOpenReason;
      /** Checked once per PR (`auto_merge_once`): new commits are not re-checked. */
      once?: boolean;
    };

/** Neutralize mentions and flatten whitespace in text posted to the PR. */
export function sanitizeCommentText(text: string, maxLength = 600): string {
  const flattened = text.replace(/\s+/g, " ").trim().replace(/@/g, "@​");
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}…` : flattened;
}

/** Inline-code a repo path, keeping backticks from breaking the markup. */
function codePath(path: string): string {
  return `\`${sanitizeCommentText(path, 200).replace(/`/g, "'")}\``;
}

/** A bulleted path list, summarizing past {@link MAX_LISTED_PATHS}. */
function pathList(paths: readonly string[]): string[] {
  const listed = paths.slice(0, MAX_LISTED_PATHS).map((path) => `- ${codePath(path)}`);
  const more = paths.length - listed.length;
  return [...listed, ...(more > 0 ? [`- …and ${more} more`] : [])];
}

/** The "matches `auto_merge_review_paths`" paragraph; empty when none matched. */
function reviewPathLines(paths: readonly string[] | undefined, lead: string): string[] {
  if (!paths || paths.length === 0) return [];
  return [
    `${paths.length} changed file(s) match \`auto_merge_review_paths\`, ${lead}:`,
    "",
    ...pathList(paths),
  ];
}

function leftOpenBody(reason: LeftOpenReason): string[] {
  switch (reason.kind) {
    case "outside-safe-paths": {
      const review = reviewPathLines(
        reason.reviewPathMatches,
        "which always need the agent review, and agent review is off",
      );
      const outside =
        reason.paths.length > 0
          ? [
              `${reason.paths.length} changed file(s) are outside the workspace's safe paths, ` +
                "and agent review is off:",
              "",
              ...pathList(reason.paths),
            ]
          : [];
      return [
        ...outside,
        ...(outside.length > 0 && review.length > 0 ? [""] : []),
        ...review,
        "",
        review.length > 0 && outside.length === 0
          ? "To merge it: review and merge it yourself, or enable `auto_merge_review`."
          : "To merge it: review and merge it yourself, add these paths to " +
            "`auto_merge_safe_paths`, or enable `auto_merge_review`.",
      ];
    }
    case "denied":
      return [
        `${codePath(reason.path)} matches the deny path ${codePath(reason.pattern)}, so this ` +
          "pull request is never auto-merged. Review and merge it yourself.",
      ];
    case "agent-unsafe":
      return [
        `The merge-safety review (${codePath(reason.policy)} policy) found: ` +
          sanitizeCommentText(reason.reason),
        "",
        ...reviewPathLines(reason.reviewPathMatches, "so the review ran even if they are safe"),
        ...(reason.reviewPathMatches?.length ? [""] : []),
        "Review and merge it yourself if you disagree.",
      ];
    case "rules-unavailable":
      return [
        `The merge-safety review (${codePath(reason.policy)} policy) could not run: ` +
          `${sanitizeCommentText(reason.problem)}.`,
        "",
        "Fix the workspace's `auto_merge_rules_file` (or `auto_merge_rules`), or review and " +
          "merge it yourself.",
      ];
    case "not-evaluable":
      return [
        `It could not be evaluated automatically: ${sanitizeCommentText(reason.detail)}.`,
        "Review and merge it yourself.",
      ];
  }
}

/**
 * Render the status comment body (marker included).
 *
 * @param status - The decision for the evaluated head commit
 */
export function buildAutoMergeStatusComment(status: AutoMergeCommentStatus): string {
  const sha = `\`${status.headSha.slice(0, 7)}\``;
  if (status.kind === "merged") {
    const why = status.agentReason
      ? `The merge-safety review judged it safe: ${sanitizeCommentText(status.agentReason)}`
      : "Every changed file is inside the workspace's safe paths.";
    return [
      AUTO_MERGE_COMMENT_MARKER,
      `🤖 **Auto-merge: merged** (${status.method}) at ${sha}.`,
      "",
      why,
    ].join("\n");
  }
  return [
    AUTO_MERGE_COMMENT_MARKER,
    `🛑 **Auto-merge: left open for human review** (checked ${sha}).`,
    "",
    ...leftOpenBody(status.reason),
    "",
    status.once
      ? "<sub>devintern checks each pull request once and does not check again after new commits; a change to the auto-merge policy re-checks it.</sub>"
      : "<sub>devintern checks again after new commits or a change to the auto-merge policy.</sub>",
  ].join("\n");
}
