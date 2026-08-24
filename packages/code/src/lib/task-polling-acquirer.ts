/**
 * Task polling acquirer (worker Mode 1): the detect-then-evaluate loop.
 *
 * Each tick:
 * 1. Detect — the tracker's change detector answers "did anything change
 *    since the persisted cursor?" (cheap, cursor-based).
 * 2. Evaluate — re-run the user's configured `--query` via the tracker's
 *    `searchTasks` to get the tasks that are actually ready.
 * 3. Dedupe — skip tasks already picked up at the same `updated` stamp
 *    (`processed_events`), so a task re-enters only when it changes again.
 * 4. Execute — run each ready task sequentially through the CLI pipeline.
 *
 * The cursor advances only after a tick completes; a crash mid-tick re-detects
 * on restart and the dedupe prevents double execution.
 */

import { spawn } from "child_process";

import type { ChangeDetector } from "./change-detector";
import type { WebhookQueue } from "./webhook-queue";
import type { WorkerState } from "./worker-state";
import type { Acquirer } from "../worker";

export interface ReadyTask {
  key: string;
  updated?: string;
}

export interface TaskPollingAcquirerOptions {
  trackerType: string;
  /** The user's task-selection query (same language as `--query`). */
  query: string;
  intervalSeconds: number;
  detector: ChangeDetector;
  workerState: WorkerState;
  queue: WebhookQueue;
  /** Evaluate step: run the user's query (injected for tests). */
  searchTasks: (query: string) => Promise<{ tasks: ReadyTask[] }>;
  /** Execute step: process one ready task; returns success (injected for tests). */
  executeTask: (taskKey: string) => Promise<boolean>;
  verbose?: boolean;
}

/**
 * Extra CLI args the worker passes to each task run.
 * `WORKER_TASK_ARGS` overrides (whitespace-separated); default `--create-pr`.
 */
export function workerTaskArgs(): string[] {
  const raw = process.env.WORKER_TASK_ARGS;
  if (raw && raw.trim()) {
    return raw.trim().split(/\s+/);
  }
  return ["--create-pr"];
}

/**
 * Run one task through the CLI pipeline as a subprocess, inheriting stdio.
 * Reuses the whole single-task flow (locks, license, tracker transitions,
 * PR creation, run records) without refactoring the entry point.
 *
 * @param taskKey - Task key to process
 * @param extraArgs - CLI flags (default from {@link workerTaskArgs})
 * @param opts - Working directory and environment for the subprocess;
 *               workspace mode routes each task to its repo's worktree with
 *               per-repo env, single-repo mode inherits both
 * @returns true when the CLI exited 0
 */
export function runTaskViaCli(
  taskKey: string,
  extraArgs: string[] = workerTaskArgs(),
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], taskKey, ...extraArgs], {
      stdio: "inherit",
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", (error) => {
      console.error(`❌ Failed to spawn task run for ${taskKey}: ${error.message}`);
      resolve(false);
    });
  });
}

/**
 * Polling acquirer for one tracker source.
 */
export class TaskPollingAcquirer implements Acquirer {
  readonly name: string;
  private options: TaskPollingAcquirerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(options: TaskPollingAcquirerOptions) {
    this.options = options;
    this.name = `poll:${options.trackerType}`;
  }

  /** Start polling: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    console.log(
      `🔎 Polling ${this.options.trackerType} every ${this.options.intervalSeconds}s ` +
        `(query: ${this.options.query})`,
    );
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
  }

  /** Stop polling (an in-flight tick finishes its current task). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One detect → evaluate → dedupe → execute cycle. Skipped while busy. */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;

    const { detector, workerState, queue, query, searchTasks, executeTask, verbose } = this.options;
    try {
      const cursor = workerState.getCursor(detector.source)?.cursorValue ?? null;
      const detection = await detector.changesSince(cursor);

      if (detection.changed) {
        const { tasks } = await searchTasks(query);
        if (verbose) {
          console.log(`   [${this.name}] change detected; ${tasks.length} task(s) match query`);
        }

        for (const task of tasks) {
          const externalId = `task:${task.key}:${task.updated ?? ""}`;
          if (queue.hasProcessed(detector.source, externalId)) {
            continue;
          }
          // Mark before executing: a persistently failing task must not loop
          // every tick. It re-enters when the ticket is updated again (new
          // stamp), and the pipeline's own incomplete-attempt check guards
          // the retry.
          queue.markProcessed(detector.source, externalId);

          console.log(`\n📌 [${this.name}] picking up ${task.key}`);
          const ok = await executeTask(task.key);
          console.log(
            ok
              ? `✅ [${this.name}] ${task.key} completed`
              : `⚠️  [${this.name}] ${task.key} did not complete cleanly`,
          );
        }
      }

      if (detection.nextCursor !== null && detection.nextCursor !== cursor) {
        workerState.setCursor(detector.source, detection.nextCursor);
      }
    } catch (error) {
      console.warn(`⚠️  [${this.name}] polling tick failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
