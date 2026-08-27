/**
 * Task polling acquirer (worker Mode 1): the detect-then-evaluate loop.
 *
 * Each tick:
 * 1. Detect — the tracker's change detector answers "did anything change
 *    since the persisted cursor?" (cheap, cursor-based).
 * 2. Evaluate — re-run the user's configured query via the tracker's
 *    `searchTasks` to get the tasks that are actually ready.
 * 3. Dedupe — skip tasks already picked up at the same `updated` stamp
 *    (`processed_events`), so a task re-enters only when it changes again.
 *    Skips are logged when nothing new is claimed. An empty stamp is sticky
 *    (tracker search must return `updated`) and is warned on.
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

/** A deferred task was not attempted and must be evaluated again next tick. */
export type TaskExecutionResult = boolean | "deferred";

/** Dedupe key for a ready task: one execution per `(key, update stamp)`. */
export function processedTaskId(task: ReadyTask): string {
  return `task:${task.key}:${task.updated?.trim() ?? ""}`;
}

function hasUpdateStamp(task: ReadyTask): boolean {
  return Boolean(task.updated?.trim());
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
  /** Execute step: process, fail, or defer one ready task (injected for tests). */
  executeTask: (taskKey: string) => Promise<TaskExecutionResult>;
  /**
   * Batch execution strategy over one tick's ready tasks (dedupe already
   * filtered). The default runs tasks strictly sequentially, marking each
   * before executing. Workspace (fleet) mode injects a scheduler-backed
   * strategy that marks the whole batch first and lets independent repos
   * run concurrently within the configured global limit.
   */
  executeBatch?: (
    tasks: ReadyTask[],
    helpers: {
      markProcessed: (externalId: string) => void;
      unmarkProcessed: (externalId: string) => void;
    },
  ) => Promise<boolean>;
  verbose?: boolean;
}

/** Default CLI flags the worker passes to each task run. */
export function workerTaskArgs(): string[] {
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
 *               the workspace worker routes each task to its repo's worktree
 *               with per-repo env; direct callers inherit both
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
      let tickDeferred = false;

      if (detection.changed) {
        const { tasks } = await searchTasks(query);
        const skipped: string[] = [];
        const missingStamp: string[] = [];
        let pickedUp = 0;

        // Dedupe-classify the matched tasks before executing: already
        // processed versions are reported (not silently dropped), and an
        // empty stamp is sticky — tracker search must return `updated` or a
        // later edit cannot retrigger the task.
        const ready: ReadyTask[] = [];
        for (const task of tasks) {
          if (!hasUpdateStamp(task)) {
            missingStamp.push(task.key);
          }
          const externalId = processedTaskId(task);
          if (queue.hasProcessed(detector.source, externalId)) {
            skipped.push(task.key);
            continue;
          }
          ready.push(task);
        }

        if (this.options.executeBatch) {
          // Fleet strategy: hand the whole ready batch to the injected runner
          // (which marks + executes via the scheduler).
          pickedUp += ready.length;
          tickDeferred = await this.options.executeBatch(ready, {
            markProcessed: (externalId) => queue.markProcessed(detector.source, externalId),
            unmarkProcessed: (externalId) => queue.unmarkProcessed(detector.source, externalId),
          });
        } else {
          for (const task of ready) {
            // Mark before executing: a persistently failing task must not loop
            // every tick. It re-enters when the ticket is updated again (new
            // stamp), and the pipeline's own incomplete-attempt check guards
            // the retry.
            queue.markProcessed(detector.source, processedTaskId(task));

            pickedUp++;
            console.log(`\n📌 [${this.name}] picking up ${task.key}`);
            const result = await executeTask(task.key);
            if (result === "deferred") {
              queue.unmarkProcessed(detector.source, processedTaskId(task));
              tickDeferred = true;
              console.log(`⏳ [${this.name}] ${task.key} deferred; will retry next poll`);
            } else {
              console.log(
                result
                  ? `✅ [${this.name}] ${task.key} completed`
                  : `⚠️  [${this.name}] ${task.key} did not complete cleanly`,
              );
            }
          }
        }

        this.logEvaluate(tasks.length, skipped, missingStamp, pickedUp, verbose);
      }

      if (!tickDeferred && detection.nextCursor !== null && detection.nextCursor !== cursor) {
        workerState.setCursor(detector.source, detection.nextCursor);
      }
    } catch (error) {
      console.warn(`⚠️  [${this.name}] polling tick failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Always-on skip/stamp diagnosis. Silent skips made "ticket matches query
   * but was never picked up" undebuggable from the worker log.
   */
  private logEvaluate(
    matched: number,
    skipped: string[],
    missingStamp: string[],
    pickedUp: number,
    verbose?: boolean,
  ): void {
    if (verbose) {
      const skipNote = skipped.length > 0 ? ` (${skipped.length} already processed)` : "";
      console.log(`   [${this.name}] change detected; ${matched} task(s) match query${skipNote}`);
    }

    // Always log when every match was skipped — that is the "why didn't it
    // pick up KEY?" case. Mixed pickup/skip stays verbose-only to avoid noise.
    if (skipped.length > 0 && (pickedUp === 0 || verbose)) {
      console.log(
        `⏭️  [${this.name}] skipping ${skipped.join(", ")} (already processed at this update)`,
      );
    }

    if (missingStamp.length > 0) {
      const names = missingStamp.join(", ");
      const singular = missingStamp.length === 1;
      console.warn(
        `⚠️  [${this.name}] ${names} ${singular ? "has" : "have"} no update stamp from the tracker. ` +
          `Editing ${singular ? "that ticket" : "those tickets"} will not retrigger polling until search returns \`updated\`.`,
      );
    }
  }
}
