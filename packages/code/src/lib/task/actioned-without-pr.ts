import { isWorkerTaskProcess } from "../cli/context";
import { WorkerState } from "../state/worker-state";
import type { TaskTrackerClient } from "../trackers/client";
import type { Task } from "../../types/task-tracker";
import { actionedSourceKeyFromEnv, recordTaskActioned } from "./actioned-state";

/** What happened when a worker run finished without a PR. */
export type ActionedWithoutPrOutcome =
  | "not-worker"
  | "pr-failed"
  | "pr-failed-exhausted"
  | "already-marked"
  | "marked"
  | "not-marked"
  | "error";

/**
 * Worker runs in a row whose PR failed retryably before the ticket is marked
 * actioned anyway. Each retry is a full re-run (new agent session, new
 * tracker comments), so the count must stay small.
 */
export const MAX_PR_DELIVERY_ATTEMPTS = 3;

/** `worker_meta` key holding the consecutive PR-failure count for a ticket. */
export function prDeliveryFailuresKey(source: string, taskKey: string): string {
  return `pr-delivery-failures:${source}:${taskKey}`;
}

/**
 * Whether a retryable PR failure in this run is the one that reaches
 * {@link MAX_PR_DELIVERY_ATTEMPTS}, so {@link recordActionedWithoutPr} will
 * mark the ticket actioned instead of letting the next poll re-run it. Reads
 * the same counter before it is incremented. False outside worker runs and
 * when the state DB cannot be read. Never throws.
 */
export function isFinalPrDeliveryAttempt(
  taskKey: string,
  openWorkerState: () => WorkerState = () => new WorkerState(),
): boolean {
  if (!isWorkerTaskProcess()) return false;
  let workerState: WorkerState | undefined;
  try {
    workerState = openWorkerState();
    const key = prDeliveryFailuresKey(actionedSourceKeyFromEnv(), taskKey);
    const failures = (Number(workerState.getMeta(key)) || 0) + 1;
    return failures >= MAX_PR_DELIVERY_ATTEMPTS;
  } catch {
    return false;
  } finally {
    workerState?.close();
  }
}

/**
 * Record a successful worker run that produced no PR as actioned.
 *
 * `applyActionedTransition` only runs after a PR is created. When the code host
 * is unsupported, or `--create-pr` is not in `worker_task_args`, the run still
 * succeeds, but the worker's own comment and status transition bump the
 * ticket's `updated` stamp. Without a marker the polling dedupe sees a new
 * stamp and re-implements the unchanged ticket on every tick. The marker is
 * captured after those writes, so only a human edit (summary, description,
 * status, labels) re-arms the ticket.
 *
 * A PR that was attempted on a supported host and failed retryably (5xx,
 * rate limit, expired token) is not recorded, so the next poll re-runs the
 * whole ticket: a new agent session, new tracker comments, and a new push of
 * the same branch. Nothing resumes PR delivery alone. Those failures are
 * counted per ticket in `worker_meta`, and the run that reaches
 * {@link MAX_PR_DELIVERY_ATTEMPTS} records the marker anyway, so a ticket
 * whose PR never succeeds stops after a bounded number of runs. Any run that
 * does not fail this way resets the count. Permanent failures (missing
 * config, 4xx validation) never set `prCreationFailure` and are marked at
 * once. A marker already written by the PR path is left untouched.
 * Interactive runs are skipped. Never throws.
 */
export async function recordActionedWithoutPr(input: {
  tracker: TaskTrackerClient;
  task: Task | undefined;
  taskKey: string;
  /** Message of a retryable PR-creation failure in this run, when one happened. */
  prCreationFailure?: string;
  /** Opens the worker state DB; injectable for tests. */
  openWorkerState?: () => WorkerState;
  /** Pause between tracker re-read attempts; injectable for tests. */
  rereadDelayMs?: number;
}): Promise<ActionedWithoutPrOutcome> {
  const { tracker, task, taskKey } = input;
  if (!isWorkerTaskProcess()) return "not-worker";
  let workerState: WorkerState | undefined;
  try {
    workerState = (input.openWorkerState ?? (() => new WorkerState()))();
    const source = actionedSourceKeyFromEnv();
    const failuresKey = prDeliveryFailuresKey(source, taskKey);
    let exhausted = false;
    if (input.prCreationFailure !== undefined) {
      const failures = (Number(workerState.getMeta(failuresKey)) || 0) + 1;
      if (failures < MAX_PR_DELIVERY_ATTEMPTS) {
        workerState.setMeta(failuresKey, String(failures));
        console.log(
          `↩️  Not recording ${taskKey} as actioned: PR creation failed (attempt ${failures}/${MAX_PR_DELIVERY_ATTEMPTS}), so the next poll re-runs it`,
        );
        return "pr-failed";
      }
      console.warn(
        `⚠️  PR creation for ${taskKey} failed ${failures} times in a row; recording it as actioned so it is not re-run until it changes`,
      );
      exhausted = true;
    }
    workerState.deleteMeta(failuresKey);
    if (workerState.getTaskActioned(source, taskKey)) return "already-marked";
    const marked = await recordTaskActioned({
      workerState,
      source,
      tracker,
      taskKey,
      fallbackTask: task,
      ...(input.rereadDelayMs === undefined ? {} : { rereadDelayMs: input.rereadDelayMs }),
    });
    if (!marked) return "not-marked";
    console.log(`✅ Recorded ${taskKey} as actioned (no PR) so it is not re-implemented`);
    return exhausted ? "pr-failed-exhausted" : "marked";
  } catch (error) {
    console.warn(`⚠️  Failed to record ${taskKey} as actioned: ${(error as Error).message}`);
    return "error";
  } finally {
    workerState?.close();
  }
}
