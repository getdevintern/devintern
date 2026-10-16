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
   * Claim and run every pending task, oldest first, sequentially. A deferred
   * row (busy repo) is requeued but skipped for the rest of this drain — its id
   * is excluded from `claimNext` so a blocked repo cannot starve independent
   * repos behind it. It is retried on the next tick.
   */
  async tick(): Promise<void> {
    if (this.busy || this.options.store.isClosed()) {
      return;
    }
    this.busy = true;
    try {
      const deferredIds: number[] = [];
      for (;;) {
        // `stop()` closes the store immediately after returning, but an
        // in-flight `execute` may resolve later; writing then would reopen the
        // connection the successor worker has taken over. Leave the row
        // `running` for that successor's orphan recovery instead.
        if (this.options.store.isClosed()) {
          return;
        }
        const task = this.options.store.claimNext(deferredIds);
        if (!task) {
          return;
        }
        if (!(await this.runOne(task))) {
          deferredIds.push(task.id);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Run one claimed task; false when it was requeued (skip rest of drain). */
  private async runOne(task: InjectedTask): Promise<boolean> {
    const { store, execute, verbose } = this.options;
    console.log(`📥 [${this.name}] running ${task.taskKey} → ${task.repo}`);
    try {
      const result = await execute(task);
      if (store.isClosed()) {
        return true;
      }
      if (result === true) {
        store.finish(task.id, "done");
      } else if (result === "deferred") {
        // Repo busy (or otherwise not started): back to the queue for the next
        // tick. The caller excludes this id for the rest of the drain so it is
        // not re-claimed ahead of tasks for free repos.
        store.requeue(task.id);
        console.log(`⏳ [${this.name}] ${task.taskKey} deferred; will retry next tick`);
        return false;
      } else {
        store.finish(task.id, "failed", "task pipeline did not complete cleanly");
      }
    } catch (error) {
      if (store.isClosed()) {
        return true;
      }
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
