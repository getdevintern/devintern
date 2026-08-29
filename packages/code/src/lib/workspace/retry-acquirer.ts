/**
 * Dashboard retry queue acquirer (fleet mode).
 *
 * The dashboard's "retry this run" action inserts a `pending` row into the
 * shared `scheduled_retries` table (see `lib/run-retry.ts`); this acquirer
 * drains those rows through the normal fleet pipeline — routing, bare-clone
 * fetch, disposable per-task worktree, per-repo env, and the repo run lock —
 * with `--force` prepended so the incomplete-attempt retry gate is bypassed.
 *
 * Rows are claimed atomically, so a dashboard retry is never lost on worker
 * restart (a claimed-but-unfished row stays `running`; see the store) and a
 * busy repo re-queues the row for the next tick.
 */

import type { Acquirer } from "../../worker";
import type { ScheduledRetry, ScheduledRetryStore } from "../run-retry";
import type { TaskExecutionResult } from "../task-polling-acquirer";
import { toRoutableTask } from "./router";
import type { RoutableTask } from "./router";

export interface RetryQueueAcquirerOptions {
  store: ScheduledRetryStore;
  /** Fleet executor slice (same shape `createFleetTaskExecutor` returns). */
  execute: (taskKey: string, routable: RoutableTask) => Promise<TaskExecutionResult>;
  intervalSeconds: number;
  verbose?: boolean;
}

/**
 * Poll the scheduled-retry table on a short interval so a dashboard-triggered
 * retry is picked up quickly — ahead of the slower task/review pollers.
 */
export class RetryQueueAcquirer implements Acquirer {
  readonly name = "retry-queue";
  private options: RetryQueueAcquirerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(options: RetryQueueAcquirerOptions) {
    this.options = options;
  }

  /** Start draining: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    console.log(`🔁 Draining scheduled dashboard retries every ${this.options.intervalSeconds}s`);
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
   * Claim and run every pending retry, oldest first, sequentially. Stops at
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
        const retry = this.options.store.claimNext();
        if (!retry) {
          return;
        }
        if (!(await this.runOne(retry))) {
          return;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Run one claimed retry; false when it was requeued for the next tick. */
  private async runOne(retry: ScheduledRetry): Promise<boolean> {
    const { store, execute, verbose } = this.options;
    console.log(`🔁 [${this.name}] re-running ${retry.taskKey} (scheduled by ${retry.actor})`);
    try {
      const result = await execute(
        retry.taskKey,
        toRoutableTask({ key: retry.taskKey, labels: [], components: [] }),
      );
      if (result === true) {
        store.finish(retry.id, "done");
      } else if (result === "deferred") {
        // Repo busy (or otherwise not started): back to the queue; stop this
        // drain so the row is not re-claimed until the next tick.
        store.requeue(retry.id);
        console.log(`⏳ [${this.name}] ${retry.taskKey} deferred; will retry next tick`);
        return false;
      } else {
        store.finish(retry.id, "failed", "task pipeline did not complete cleanly");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.finish(retry.id, "failed", message);
      console.error(`❌ [${this.name}] ${retry.taskKey} failed: ${message}`);
    }
    if (verbose) {
      console.log(`   [${this.name}] ${retry.taskKey} settled`);
    }
    return true;
  }
}
