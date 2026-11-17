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
import type { ScheduledRetry, ScheduledRetryStore } from "../state/run-retry";
import type { TaskExecutionResult } from "../acquirers/task-polling";
import { randomUUID } from "crypto";
import { getWorkerFailover } from "../worker/failover";
import { toRoutableTask } from "./router";
import { queueFailureReason } from "./queue-failure-reason";
import type { RoutableTask } from "./router";

export interface RetryQueueAcquirerOptions {
  store: ScheduledRetryStore;
  /** Shared workspace queue DB, for best-effort failed-run diagnostics. */
  runDbPath?: string;
  /** Fleet executor slice (same shape `createFleetTaskExecutor` returns). */
  execute: (
    taskKey: string,
    routable: RoutableTask,
    retry: ScheduledRetry,
    queueClaim: string,
  ) => Promise<TaskExecutionResult>;
  intervalSeconds: number;
  /**
   * Whether the harness chain is exhausted (usage-limited or cooling down).
   * A paused drain leaves queued retries untouched instead of claiming,
   * re-running, and requeueing one on every interval tick, which otherwise
   * floods the log for the whole limit window. Defaults to the process-wide
   * worker failover state.
   */
  isPaused?: () => boolean;
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
    // Exhausted harness chain: claim nothing and log nothing until the pause
    // ends. The executor keeps its own pre-git guard for work that starts
    // between this check and the run.
    if (this.isPaused()) {
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

  /** Whether the harness chain is exhausted and the drain must stay idle. */
  private isPaused(): boolean {
    return this.options.isPaused?.() ?? getWorkerFailover()?.allExhausted() ?? false;
  }

  /** Run one claimed retry; false when it was requeued for the next tick. */
  private async runOne(retry: ScheduledRetry): Promise<boolean> {
    const { store, execute, verbose } = this.options;
    const queueClaim = randomUUID();
    console.log(`🔁 [${this.name}] re-running ${retry.taskKey} (scheduled by ${retry.actor})`);
    try {
      const result = await execute(
        retry.taskKey,
        toRoutableTask({ key: retry.taskKey, labels: [], components: [] }),
        retry,
        queueClaim,
      );
      if (result === true) {
        store.finish(retry.id, "done");
      } else if (result === "skipped") {
        // Defensive: the retry queue prepends `--force`, which bypasses the
        // gate. If a skip still happens, the row is settled, not failed.
        store.finish(retry.id, "done", "skipped: ticket unchanged since the incomplete attempt");
        console.log(`⏭️  [${this.name}] ${retry.taskKey} skipped; ticket unchanged`);
      } else if (result === "deferred") {
        // Repo busy (or otherwise not started): back to the queue; stop this
        // drain so the row is not re-claimed until the next tick.
        store.requeue(retry.id);
        console.log(`⏳ [${this.name}] ${retry.taskKey} deferred; will retry next tick`);
        return false;
      } else {
        store.finish(retry.id, "failed", queueFailureReason(this.options.runDbPath, queueClaim));
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
