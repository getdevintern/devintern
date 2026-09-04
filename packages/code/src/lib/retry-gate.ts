/**
 * Retry gate
 *
 * Decides whether a task whose previous attempt was reported as a failure
 * should be re-run. A retry is warranted when the user changed something:
 * edited the description, posted a new comment (clarification), or deleted
 * the bot's automation failure comment from the ticket. `--force` bypasses
 * the gate for local runs.
 *
 * The comments passed here already exclude the bot's own automation comments
 * (every tracker client filters them), so the harness posting its failure
 * comment never counts as "the ticket changed" and cannot re-trigger itself.
 *
 * Fails open on every uncertainty (missing state, storage errors,
 * unparseable timestamps): a redundant attempt is cheaper than a silently
 * stuck ticket.
 */

import type { TaskTrackerClient } from "./task-tracker-client";
import type { Comment } from "../types/task-tracker";
import { hashDescription } from "./retry-state";
import type { RetryState } from "./retry-state";

export interface RetryGateInput {
  taskKey: string;
  /** Persisted retry state for the task (null when none — caller fetches it). */
  state: RetryState | null;
  /** Current task description text (tracker-extracted plain text). */
  description: string;
  /** Ticket comments (already filtered of the bot's own comments). */
  comments: Comment[];
  tracker: TaskTrackerClient;
  /** Explicit bypass (`--force`). */
  force?: boolean;
}

export interface RetryGateDecision {
  skip: boolean;
  reason: string;
}

/**
 * Evaluate the retry gate for one task.
 *
 * @returns `skip: true` only when a previous incomplete attempt is on
 *          record and nothing about the ticket has changed since.
 */
export async function shouldSkipRetry(input: RetryGateInput): Promise<RetryGateDecision> {
  const { taskKey, state, description, comments, tracker, force } = input;

  if (force) {
    return { skip: false, reason: "forced (--force)" };
  }

  if (!state) {
    return { skip: false, reason: "no incomplete attempt on record" };
  }

  if (state.descriptionHash !== hashDescription(description)) {
    return { skip: false, reason: "task description changed since last attempt" };
  }

  const hasNewComment = comments.some((comment) => {
    const created = Date.parse(comment.created);
    // Unparseable timestamps count as new: fail open.
    return Number.isNaN(created) || created > state.reportedAt;
  });
  if (hasNewComment) {
    return { skip: false, reason: "new comment(s) since last attempt" };
  }

  // The marker check keeps the ticket authoritative: deleting the bot's
  // failure comment (incomplete-implementation or processing failure)
  // unlocks a retry, and per-machine DB drift cannot block a ticket whose
  // comment was never posted. Trackers fail open (return false) on API
  // errors.
  const markerPresent = await tracker.hasIncompleteImplementationMarker(taskKey);
  if (!markerPresent) {
    return { skip: false, reason: "automation failure comment no longer on ticket" };
  }

  return {
    skip: true,
    reason:
      `attempt ${state.attemptCount} was reported incomplete and the ticket is unchanged ` +
      "(edit the description or add a comment to retry, or pass --force)",
  };
}
