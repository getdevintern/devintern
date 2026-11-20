/**
 * Cancel a pending ad-hoc ("injected") task, shared by `devintern worker
 * cancel` and the dashboard's `POST /api/tasks/:id/cancel`.
 *
 * The store does the atomic pending → cancelled transition; this module maps
 * its outcome to the one message both surfaces print, so the CLI and the
 * dashboard always agree on wording.
 */

import type {
  InjectedCancelActor,
  InjectedCancelOutcome,
  InjectedTask,
  InjectedTaskStore,
} from "../state/injected-tasks";
import { RunStore } from "../state/run-recorder";

/** What one cancel attempt reported (the `worker cancel --json` object). */
export interface InjectedCancelReport {
  taskKey: string;
  outcome: InjectedCancelOutcome;
  message: string;
  /** The row after the attempt; unset when it was not found. */
  task?: InjectedTask;
}

/** Whether the outcome leaves the row cancelled (exit 0 / HTTP 200). */
export function cancelSucceeded(outcome: InjectedCancelOutcome): boolean {
  return outcome === "cancelled" || outcome === "already_cancelled";
}

/**
 * Who cancelled a row and when, e.g. `by cli at 2026-11-18T10:00:00.000Z
 * (reason: duplicate)`. Empty when the row is not cancelled.
 */
export function describeCancellation(
  task: Pick<InjectedTask, "status" | "cancelledBy" | "finishedAt" | "cancelReason">,
): string {
  if (task.status !== "cancelled") return "";
  const parts = [
    task.cancelledBy ? `by ${task.cancelledBy}` : undefined,
    task.finishedAt !== undefined ? `at ${new Date(task.finishedAt).toISOString()}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const reason = task.cancelReason ? ` (reason: ${task.cancelReason})` : "";
  return `${parts.join(" ")}${reason}`;
}

function outcomeMessage(taskKey: string, outcome: InjectedCancelOutcome, task?: InjectedTask) {
  switch (outcome) {
    case "cancelled":
      return `Cancelled ${taskKey}`;
    case "already_cancelled": {
      const detail = task ? describeCancellation(task) : "";
      return `${taskKey} already cancelled${detail ? ` ${detail}` : ""}`;
    }
    case "already_started":
      return `${taskKey} already started; it was not cancelled (running tasks cannot be cancelled)`;
    case "already_finished":
      return `${taskKey} already finished (${task?.status ?? "settled"}); nothing to cancel`;
    case "not_found":
      return `${taskKey} not found: no ad-hoc task with that key in this workspace`;
  }
}

/**
 * Cancel the pending row named by `taskKey`.
 *
 * @param store - Writable injected-task store
 * @param taskKey - Ad-hoc key (`local-…`)
 * @param options - Audit actor and optional reason
 */
export function cancelInjectedTask(
  store: InjectedTaskStore,
  taskKey: string,
  options: { actor: InjectedCancelActor; reason?: string; now?: number },
): InjectedCancelReport {
  const { outcome, task } = store.cancel(taskKey, options);
  if (cancelSucceeded(outcome) && task) settleDeferredRun(store.path, task);
  return { taskKey, outcome, message: outcomeMessage(taskKey, outcome, task), task };
}

/**
 * Settle the cancelled task's run if it was left `deferred` (a usage-limit
 * pause backing off). Otherwise the dashboard keeps listing the task as
 * "waiting to retry" and its run claims an automatic retry that never comes.
 * Runs on `already_cancelled` too, so a cancel interrupted between the two
 * writes converges on the next attempt. Best-effort: run recording must never
 * fail the cancel itself.
 */
function settleDeferredRun(dbPath: string, task: InjectedTask): void {
  let runs: RunStore | undefined;
  try {
    runs = new RunStore(dbPath);
    const detail = describeCancellation(task);
    runs.abandonDeferredRun(task.taskKey, `cancelled${detail ? ` ${detail}` : ""}`);
  } catch {
    /* best-effort */
  } finally {
    runs?.close();
  }
}
