/**
 * Injected-task queue acquirer (fleet mode).
 *
 * `devintern worker add` inserts a `pending` row into the shared
 * `injected_tasks` table (see `lib/state/injected-tasks.ts`); this acquirer
 * drains those rows through the normal fleet pipeline — bare-clone fetch,
 * disposable per-task worktree, per-repo env, and the shared concurrency
 * supervisor. The row names its repo explicitly, so no `[[routing.rules]]`
 * entry is required.
 *
 * Rows are claimed atomically, so an enqueued task is never lost on worker
 * restart (a claimed-but-unfinished row is failed by startup recovery; see
 * the store) and a busy repo re-queues the row for the next tick.
 */

import type { Acquirer } from "../../worker";
import type { InjectedTask, InjectedTaskStore } from "../state/injected-tasks";
import type { TaskExecutionResult } from "../acquirers/task-polling";

/** Source label surfaced in worker logs, run records, and the dashboard. */
export const INJECTED_TASK_SOURCE = "local:add";

export interface InjectedTaskAcquirerOptions {
  store: InjectedTaskStore;
  /** Run one claimed task through the fleet executor. */
  execute: (task: InjectedTask) => Promise<TaskExecutionResult>;
  intervalSeconds: number;
  verbose?: boolean;
}

/**
 * Poll the injected-task table on a short interval so `worker add` is picked
 * up quickly — ahead of the slower task/review pollers. Operator-initiated
 * work bypasses working windows, matching `worker run-now` and retries.
 */
export class InjectedTaskAcquirer implements Acquirer {
  readonly name = INJECTED_TASK_SOURCE;
  private options: InjectedTaskAcquirerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(options: InjectedTaskAcquirerOptions) {
    this.options = options;
  }

  /** Start draining: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    console.log(`📥 Draining injected tasks every ${this.options.intervalSeconds}s`);
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Claim and run every pending task, oldest first, sequentially. Stops at
   * the first deferred row (it is back in the queue for the next tick), so a
   * requeued row is never re-claimed by the same drain.
   */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      for (;;) {
        const task = this.options.store.claimNext();
        if (!task) {
          return;
        }
        if (!(await this.runOne(task))) {
          return;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Run one claimed task; false when it was requeued for the next tick. */
  private async runOne(task: InjectedTask): Promise<boolean> {
    const { store, execute, verbose } = this.options;
    console.log(`📥 [${this.name}] running ${task.taskKey} → ${task.repo}`);
    try {
      const result = await execute(task);
      if (result === true) {
        store.finish(task.id, "done");
      } else if (result === "deferred") {
        // Repo busy (or otherwise not started): back to the queue; stop this
        // drain so the row is not re-claimed until the next tick.
        store.requeue(task.id);
        console.log(`⏳ [${this.name}] ${task.taskKey} deferred; will retry next tick`);
        return false;
      } else {
        store.finish(task.id, "failed", "task pipeline did not complete cleanly");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.finish(task.id, "failed", message);
      console.error(`❌ [${this.name}] ${task.taskKey} failed: ${message}`);
    }
    if (verbose) {
      console.log(`   [${this.name}] ${task.taskKey} settled`);
    }
    return true;
  }
}
