/**
 * Failure feedback: tell the tracker a run failed, and make the retry gate
 * aware of it.
 *
 * Posting the failure comment bumps the ticket's `updated` stamp — without
 * bookkeeping that bump alone would re-trigger polling pickup on the next
 * tick (the exact re-pickup loop this module exists to prevent). So right
 * after the comment is posted we record an incomplete attempt in the retry
 * state; combined with `hasIncompleteImplementationMarker` now matching
 * processing-failure comments too, the gate skips unchanged tickets exactly
 * like it does for incomplete-implementation runs.
 *
 * Best-effort throughout: feedback must never mask the original error.
 */

import { homedir } from "node:os";

import { redactAgentOutput } from "../agent/harness-startup";
import type { TaskTrackerClient } from "../trackers/client";
import { recordIncompleteAttempt } from "../state/retry-state";
import { formatProcessingFailureMarkdown } from "../trackers/shared/markdown-comment-formatter";

/** How to record the attempt for the retry gate (lib/retry-state.ts). */
export interface FailureAttemptRecorder {
  (taskKey: string, trackerType: string, description: string): void;
}

export interface FailureFeedbackDeps {
  taskKey: string;
  reason: string;
  /** Interruption feedback was already handled by this run; retry only the status transition. */
  skipComment?: boolean;
  tracker: TaskTrackerClient;
  /** Tracker identifier stored with the retry state (`TASK_TRACKER`). */
  trackerType: string;
  projectKey: string;
  /** Whether the run already moved the ticket to "In Progress". */
  movedToInProgress: boolean;
  /** Resolve the To Do status configured for `projectKey` (null/empty = skip). */
  getTodoStatus: () => string | null | undefined;
  /** Overrides default best-effort recording (tests). */
  recordAttempt?: FailureAttemptRecorder;
  log?: typeof console.log;
  warn?: typeof console.warn;
}

/** Longest reason posted to the tracker; a huge stderr dump is cut here. */
export const MAX_FAILURE_REASON_LENGTH = 1000;

/**
 * Scrub a failure reason before it is posted as a tracker comment.
 *
 * Reasons often quote subprocess output (git, hooks, HTTP bodies), and tracker
 * comments can be visible to far more people than the operator. This is the
 * single sink for every processing-failure comment, so redact here even when
 * the caller already did: credential shapes via {@link redactAgentOutput},
 * credentials in URLs of any scheme, the local home directory (which names the
 * OS user), then bound the length. Local logs and run records keep the raw text.
 */
export function redactFailureReason(reason: string, home: string = homedir()): string {
  let out = redactAgentOutput(reason)
    // URL credentials for any scheme (ssh://, git+https://, ...): scheme://***@host.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/?]+@/gi, "$1***@");
  if (home && home !== "/") {
    out = out.split(home).join("~");
  }
  if (out.length > MAX_FAILURE_REASON_LENGTH) {
    out = `${out.slice(0, MAX_FAILURE_REASON_LENGTH)}…`;
  }
  return out;
}

/**
 * Post the processing-failure comment and hand the ticket back to its To Do
 * status. On successful comment delivery, also persist the attempt so the
 * harness itself posting the comment never counts as "the ticket changed".
 *
 * Never throws. Returns `true` when the comment was delivered or skipped, so a
 * caller (the child's SIGTERM handler) can record a durable clean-stop marker
 * only when recovery genuinely has nothing left to post.
 */
export async function reportTaskFailure(deps: FailureFeedbackDeps): Promise<boolean> {
  const { taskKey, reason, tracker } = deps;

  let posted = Boolean(deps.skipComment);
  if (!deps.skipComment) {
    try {
      await tracker.postComment(taskKey, {
        format: "markdown",
        body: formatProcessingFailureMarkdown(taskKey, redactFailureReason(reason)),
      });
      deps.log?.(`💬 Posted a failure comment to ${taskKey}`);
      posted = true;
      await recordAttemptForGate(deps);
    } catch (commentError) {
      deps.warn?.(`⚠️  Failed to post failure comment to task tracker: ${commentError}`);
    }
  }

  if (!deps.movedToInProgress) return posted;
  try {
    const todoStatus = deps.getTodoStatus();
    if (todoStatus && todoStatus.trim()) {
      await tracker.transitionStatus(taskKey, todoStatus.trim());
      deps.log?.(`🔄 Moved ${taskKey} back to '${todoStatus}' so it can be retried`);
    }
  } catch (transitionError) {
    deps.warn?.(`⚠️  Failed to move ${taskKey} back to To Do: ${transitionError}`);
  }
  return posted;
}

/**
 * Record the failed attempt so the retry gate blocks re-runs until the user
 * changes the ticket. The description is fetched fresh from the tracker; if
 * either fetch or storage fails, nothing happens here (state stays unset and
 * the gate fails open as before).
 */
async function recordAttemptForGate(deps: FailureFeedbackDeps): Promise<void> {
  const doRecord = deps.recordAttempt ?? recordIncompleteAttempt;
  try {
    const task = await deps.tracker.getTask(deps.taskKey);
    doRecord(deps.taskKey, deps.trackerType, deps.tracker.extractDescriptionText(task));
  } catch (error) {
    deps.warn?.(
      `⚠️  Failed to record retry state after failure comment: ${(error as Error).message}`,
    );
  }
}
