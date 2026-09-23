/**
 * Actioned-ticket bookkeeping.
 *
 * A ticket that already produced a PR must not be re-implemented on the next
 * sweep just because the worker's own post-PR comment or status transition
 * bumped its tracker `updated` stamp. The worker records a local actioned
 * marker keyed by tracker source + task key, holding a digest of the ticket's
 * human-editable fields (summary, description, status, labels). The polling
 * acquirer consults it before executing: an actioned ticket whose digest is
 * unchanged is skipped even though it still matches the sweep query.
 *
 * A genuine human change — editing the description, re-opening, re-labelling,
 * or otherwise modifying a tracked field — produces a different digest, so the
 * marker is cleared and the ticket becomes eligible again. Because the digest
 * is captured *after* the worker's own writes, the worker's own comment or
 * transition never re-arms the ticket.
 */

import { createHash } from "crypto";

import type { Task } from "../../types/task-tracker";
import type { TaskTrackerClient } from "../trackers/client";
import type { WorkerState } from "../state/worker-state";
import { sleep } from "../utils/general";
import { ACTIONED_SOURCE_ENV } from "../workspace/env";

/** Re-read attempts before recording from an unverified snapshot. */
const REREAD_ATTEMPTS = 3;
/** Delay between re-read attempts, in milliseconds. */
const REREAD_DELAY_MS = 250;

/** Human-editable fields whose change re-arms an actioned ticket. */
export interface ActionedSignalInput {
  summary?: string;
  description?: string;
  status?: string;
  labels?: string[];
}

/**
 * Digest the fields a person can edit on a ticket.
 *
 * Labels are lower-cased and sorted so tracker label ordering is irrelevant;
 * whitespace is trimmed. The input fields are the exact signal documented for
 * re-triggering (see docs/code/*-integration.md).
 *
 * @param input - Ticket fields to digest
 * @returns A stable hex digest
 */
export function computeActionedSignal(input: ActionedSignalInput): string {
  const labels = [...(input.labels ?? [])]
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const canonical = JSON.stringify({
    summary: (input.summary ?? "").trim(),
    description: (input.description ?? "").trim(),
    status: (input.status ?? "").trim().toLowerCase(),
    labels,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Digest a normalized task using the tracker's own description extraction. */
export function trackerActionedSignal(tracker: TaskTrackerClient, task: Task): string {
  return computeActionedSignal({
    summary: task.summary,
    description: tracker.extractDescriptionText(task),
    status: task.status,
    labels: task.labels,
  });
}

/**
 * Canonical actioned/tracker source key.
 *
 * Multi-team workspaces namespace a source per team (`jira:platform`) so two
 * boards of the same tracker never share actioned state; single-source
 * workspaces use the bare tracker name.
 */
export function actionedSourceKey(trackerType: string | undefined, teamName?: string): string {
  const base = (trackerType ?? "").trim().toLowerCase() || "jira";
  return teamName ? `${base}:${teamName}` : base;
}

/** The actioned source key for a worker task subprocess, derived from its env. */
export function actionedSourceKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const pinned = env[ACTIONED_SOURCE_ENV]?.trim();
  if (pinned) return pinned;
  return actionedSourceKey(env.TASK_TRACKER, env.DEVINTERN_WORKSPACE_TEAM);
}

/**
 * Re-read a ticket for its actioned signal, retrying transient tracker blips.
 *
 * @throws The last error once every attempt fails.
 */
async function rereadTask(
  tracker: TaskTrackerClient,
  taskKey: string,
  attempts = REREAD_ATTEMPTS,
  delayMs = REREAD_DELAY_MS,
): Promise<Task> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await tracker.getTask(taskKey);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Record a ticket as actioned after its PR was created.
 *
 * Re-reads the ticket so the digest reflects the post-transition state. The
 * re-read is retried a few times; when it still fails the `fallbackTask` (the
 * run's original snapshot) is recorded but flagged `unverified`, because that
 * snapshot predates the worker's own status transition. The gate treats an
 * unverified record as fail-safe and keeps suppressing the ticket until a
 * successful read refreshes it — a transient read error must never re-arm the
 * ticket and produce a duplicate PR.
 *
 * @returns `true` when the marker was written
 */
export async function recordTaskActioned(input: {
  workerState: WorkerState;
  source: string;
  tracker: TaskTrackerClient;
  taskKey: string;
  fallbackTask?: Task;
}): Promise<boolean> {
  const { workerState, source, tracker, taskKey } = input;
  let task: Task | undefined;
  let verified = false;
  try {
    task = await rereadTask(tracker, taskKey);
    verified = true;
  } catch (error) {
    task = input.fallbackTask;
    if (!task) {
      console.warn(
        `⚠️  [actioned] could not read ${taskKey} to record its actioned state: ${
          (error as Error).message
        }`,
      );
      return false;
    }
    console.warn(
      `⚠️  [actioned] could not read ${taskKey}; recording an unverified marker from the run snapshot: ${
        (error as Error).message
      }`,
    );
  }
  if (!task) return false;

  try {
    const signal = trackerActionedSignal(tracker, task);
    workerState.markTaskActioned(source, taskKey, signal, verified, task.updated);
    return true;
  } catch (error) {
    console.warn(
      `⚠️  [actioned] failed to record actioned state for ${taskKey}: ${(error as Error).message}`,
    );
    return false;
  }
}

/**
 * Build the gate the polling acquirer uses to keep an actioned ticket out of
 * the sweep until it changes.
 *
 * The tracker is resolved lazily so an automations-only workspace does not
 * need tracker credentials at startup. A read failure fails safe (skip the
 * ticket) to avoid a duplicate PR.
 *
 * A record written from a fallback snapshot is `unverified`: its digest
 * predates the worker's own transition, so comparing it against the live
 * ticket would look like a human change and re-arm it. The first successful
 * read after such a record refreshes it as verified and keeps suppressing.
 *
 * Once verified, the ticket's `updated` stamp is persisted alongside the
 * marker; while the caller reports the same stamp the gate skips the tracker
 * read entirely. Because it is persisted, the cache survives a worker restart,
 * so a cold start does not burst one API call per still-actioned ticket.
 *
 * @returns `true` when the ticket was actioned and has not changed since
 */
export function createTaskActionedGate(deps: {
  getTracker: () => TaskTrackerClient | Promise<TaskTrackerClient>;
  workerState: WorkerState;
  source: string;
}): (taskKey: string, updated?: string) => Promise<boolean> {
  return async (taskKey, updated) => {
    const record = deps.workerState.getTaskActioned(deps.source, taskKey);
    if (!record) return false;

    const stamp = updated?.trim();
    // A verified marker whose persisted stamp matches the sweep result means
    // the ticket has not changed since the last read: skip the tracker call.
    if (stamp && record.verified && record.updatedStamp === stamp) {
      return true;
    }

    try {
      const tracker = await deps.getTracker();
      const task = await tracker.getTask(taskKey);
      const signal = trackerActionedSignal(tracker, task);

      if (record.verified && signal !== record.signal) {
        deps.workerState.clearTaskActioned(deps.source, taskKey);
        return false;
      }

      // Verified match, or the first successful read since an unverified
      // record: refresh so the marker reflects the live post-transition state,
      // and pin the stamp so an unchanged next tick skips the read.
      if (!record.verified || (stamp && record.updatedStamp !== stamp)) {
        deps.workerState.markTaskActioned(deps.source, taskKey, signal, true, stamp);
      }
      return true;
    } catch (error) {
      console.warn(
        `⚠️  [actioned] could not verify ${taskKey}; leaving it actioned to avoid a duplicate PR: ${
          (error as Error).message
        }`,
      );
      return true;
    }
  };
}
