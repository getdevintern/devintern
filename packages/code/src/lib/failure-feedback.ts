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

import type { TaskTrackerClient } from "./task-tracker-client";
import { recordIncompleteAttempt } from "./retry-state";
import { formatProcessingFailureMarkdown } from "./trackers/shared/markdown-comment-formatter";

/** How to record the attempt for the retry gate (lib/retry-state.ts). */
export interface FailureAttemptRecorder {
  (taskKey: string, trackerType: string, description: string): void;
}

export interface FailureFeedbackDeps {
  taskKey: string;
  reason: string;
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

/**
 * Post the processing-failure comment and hand the ticket back to its To Do
 * status. On successful comment delivery, also persist the attempt so the
 * harness itself posting the comment never counts as "the ticket changed".
 *
 * Never throws.
 */
export async function reportTaskFailure(deps: FailureFeedbackDeps): Promise<void> {
  const { taskKey, reason, tracker } = deps;

  try {
    await tracker.postComment(taskKey, {
      format: "markdown",
      body: formatProcessingFailureMarkdown(taskKey, reason),
    });
    deps.log?.(`💬 Posted a failure comment to ${taskKey}`);
    await recordAttemptForGate(deps);
  } catch (commentError) {
    deps.warn?.(`⚠️  Failed to post failure comment to task tracker: ${commentError}`);
  }

  if (!deps.movedToInProgress) return;
  try {
    const todoStatus = deps.getTodoStatus();
    if (todoStatus && todoStatus.trim()) {
      await tracker.transitionStatus(taskKey, todoStatus.trim());
      deps.log?.(`🔄 Moved ${taskKey} back to '${todoStatus}' so it can be retried`);
    }
  } catch (transitionError) {
    deps.warn?.(`⚠️  Failed to move ${taskKey} back to To Do: ${transitionError}`);
  }
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
