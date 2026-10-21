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
   * Claim every pending task, oldest first, then run them concurrently. The
   * workspace supervisor bounds actual execution (`max_concurrency` and
   * `max_concurrency_per_repo`); ad-hoc tasks share the same capacity as
   * polled, review, and automation work.
   *
   * A deferred row (busy repo) is requeued and retried on the next tick. Every
   * row is claimed exactly once per drain, so a blocked repo cannot starve
   * independent repos behind it.
   */
  async tick(): Promise<void> {
    if (this.busy || this.options.store.isClosed()) {
      return;
    }
    this.busy = true;
    try {
      const executions: Promise<void>[] = [];
      for (;;) {
        // `stop()` closes the store immediately after returning, but in-flight
        // `execute` calls may resolve later; writing then would reopen the
        // connection the successor worker has taken over. Leave those rows
        // `running` for that successor's orphan recovery instead.
        if (this.options.store.isClosed()) {
          break;
        }
        const task = this.options.store.claimNext();
        if (!task) {
          break;
        }
        executions.push(
          (async () => {
            // runOne settles its own row and never rejects; allSettled keeps a
            // future regression from abandoning the remaining executions.
            await this.runOne(task);
          })(),
        );
      }
      await Promise.allSettled(executions);
    } finally {
      this.busy = false;
    }
  }

  /** Run one claimed task and settle its row; a deferred row is requeued. */
  private async runOne(task: InjectedTask): Promise<void> {
    const { store, execute, verbose } = this.options;
    console.log(`📥 [${this.name}] running ${task.taskKey} → ${task.repo}`);
    try {
      const result = await execute(task);
      if (store.isClosed()) {
        return;
      }
      if (result === true) {
        store.finish(task.id, "done");
      } else if (result === "skipped") {
        // Defensive: a skip means the ticket was left untouched, which is a
        // settled row rather than a failure.
        store.finish(task.id, "done", "skipped: ticket unchanged since the incomplete attempt");
        console.log(`⏭️  [${this.name}] ${task.taskKey} skipped; ticket unchanged`);
      } else if (result === "deferred") {
        // Repo busy (or otherwise not started): back to the queue for the next
        // tick. Every row is claimed once per drain, so this cannot starve
        // tasks for other repos.
        store.requeue(task.id);
        console.log(`⏳ [${this.name}] ${task.taskKey} deferred; will retry next tick`);
        return;
      } else {
        store.finish(task.id, "failed", "task pipeline did not complete cleanly");
      }
    } catch (error) {
      if (store.isClosed()) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      store.finish(task.id, "failed", message);
      console.error(`❌ [${this.name}] ${task.taskKey} failed: ${message}`);
    }
    if (verbose) {
      console.log(`   [${this.name}] ${task.taskKey} settled`);
    }
  }
}
