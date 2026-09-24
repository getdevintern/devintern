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
 * 4. Execute — hand each ready task to the executor. The detect/evaluate/claim
 *    phase is gated against overlap, but the executions are not: polling keeps
 *    running on its interval so newly available tasks fill free concurrency
 *    slots without waiting for the current batch to finish.
 *
 * The cursor advances once a tick's executions settle; a crash mid-tick
 * re-detects on restart and the dedupe prevents double execution. An edit to a
 * task whose run is still in flight advances the cursor too, but its unclaimed
 * stamp is persisted durably and re-admitted once that run settles — or on the
 * next start after a crash — so the cursor is not held (and the tracker
 * re-queried) for the whole run. A deferred task is tracked the same way, so it
 * is re-evaluated even when an overlapping tick already advanced the cursor.
 */

import { spawn } from "child_process";

import type { ChangeDetector } from "./change-detector";
import type { PickupGate } from "../worker/schedule";
import { TASK_POLL_LAST_DRAIN_KEY } from "../state/worker-state";
import type { WebhookQueue } from "../state/webhook-queue";
import type { WorkerState } from "../state/worker-state";
import type { Acquirer } from "../../worker";
import { cliResultToTaskResult, runWithFailover } from "../worker/failover";

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

/** Parse a persisted `[key, externalId]` list, ignoring anything malformed. */
function parsePendingRescans(raw: string | null): Array<[string, string]> {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: Array<[string, string]> = [];
  for (const entry of parsed as unknown[]) {
    if (!Array.isArray(entry)) continue;
    const [key, externalId] = entry as unknown[];
    if (typeof key === "string" && typeof externalId === "string") {
      result.push([key, externalId]);
    }
  }
  return result;
}

export interface TaskPollingAcquirerOptions {
  trackerType: string;
  /** The user's task-selection query (same language as `--query`). */
  query: string | (() => string | undefined);
  intervalSeconds: number;
  detector: ChangeDetector;
  workerState: WorkerState;
  queue: WebhookQueue;
  /** Evaluate step: run the user's query (injected for tests). */
  searchTasks: (query: string) => Promise<{ tasks: ReadyTask[] }>;
  /** Execute step: process, fail, or defer one ready task (injected for tests). */
  executeTask: (taskKey: string) => Promise<TaskExecutionResult>;
  /**
   * Actioned gate: `true` when the task already produced a PR and has not
   * changed since, so it must not be re-implemented even though it still
   * matches the sweep query. Injected by the workspace wiring, which has
   * tracker access to compare the ticket's current signal (see
   * lib/task/actioned-state.ts). Omitted in focused tests.
   */
  isTaskActionedUnchanged?: (task: ReadyTask) => Promise<boolean>;
  /**
   * Working-window gate (quiet hours). When closed, ticks start no new
   * detection/evaluation/execution; already-running executions finish
   * naturally. Manual overrides and startup catch-up are the gate's decisions
   * surfaced as one-shot bypasses.
   */
  gate?: PickupGate;
  /**
   * Optional live capacity snapshot used for verbose diagnostics, so a stalled
   * worker is observable as "N in flight, M slots free".
   */
  capacity?: () => { available: number; inFlight: number };
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
 * @returns true when the CLI exited 0, `"deferred"` when every harness in
 *   the failover chain is usage-limited, false on any other failure
 */
export async function runTaskViaCli(
  taskKey: string,
  extraArgs: string[] = workerTaskArgs(),
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
  } = {},
): Promise<TaskExecutionResult> {
  const result = await runWithFailover(
    (env) =>
      new Promise<number>((resolve) => {
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        const finish = (code: number) => {
          if (settled) return;
          settled = true;
          if (abort) opts.signal?.removeEventListener("abort", abort);
          if (killTimer) clearTimeout(killTimer);
          // oxlint-disable-next-line promise/no-multiple-resolved -- settled guards a single resolution.
          resolve(code);
        };
        if (opts.signal?.aborted) {
          finish(1);
          return;
        }
        const detached = process.platform !== "win32";
        const child = spawn(process.execPath, [process.argv[1], taskKey, ...extraArgs], {
          stdio: "inherit",
          cwd: opts.cwd,
          env,
          detached,
        });
        abort = () => {
          if (child.pid === undefined) return;
          try {
            if (detached) process.kill(-child.pid, "SIGTERM");
            else child.kill("SIGTERM");
          } catch {
            // The child may already have exited.
          }
          killTimer = setTimeout(() => {
            try {
              if (detached) process.kill(-child.pid!, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              // The child may already have exited.
            }
          }, 5_000);
          killTimer.unref?.();
        };
        opts.signal?.addEventListener("abort", abort, { once: true });
        child.on("close", (code) => {
          finish(code ?? 1);
        });
        child.on("error", (error) => {
          console.error(`❌ Failed to spawn task run for ${taskKey}: ${error.message}`);
          finish(1);
        });
      }),
    opts.env ?? process.env,
  );
  return cliResultToTaskResult(result);
}

/**
 * Polling acquirer for one tracker source.
 */
export class TaskPollingAcquirer implements Acquirer {
  readonly name: string;
  private options: TaskPollingAcquirerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** Task keys with an execution in flight, to avoid running one key twice at once. */
  private readonly inFlightKeys = new Set<string>();
  /**
   * Tasks that must be re-admitted once their run settles, keyed to the newest
   * unclaimed `(key, stamp)` id. Covers both a task edited mid-run and a
   * deferred task whose claim was released. The cursor advances past the change
   * so ticks do not re-query the tracker while the in-flight run is still
   * going; the map is persisted to `worker_meta` so a crash before the run
   * settles still replays the re-admission on restart.
   */
  private readonly pendingRescans = new Map<string, string>();
  private readonly gateErrors = new Set<string>();

  constructor(options: TaskPollingAcquirerOptions) {
    this.options = options;
    this.name = `poll:${options.trackerType}`;
  }

  /** Start polling: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    if (this.timer) return;
    const query = this.resolveQuery();
    console.log(
      `🔎 Polling ${this.options.trackerType} every ${this.options.intervalSeconds}s ` +
        `(query: ${query ?? "disabled until task_query is configured"})`,
    );
    const lastDrainAt = this.readLastDrainAt();
    // Arm the interval before the first batch settles: the startup/catch-up
    // drain must also keep polling while its executions run, and a slow first
    // batch must not delay the cadence.
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
    if (this.options.gate?.shouldCatchUpOnStart(lastDrainAt)) {
      // The laptop slept through the entire previous window; drain once now
      // instead of waiting for the next one.
      console.log(`🌙 [${this.name}] working window(s) elapsed while idle; running catch-up drain`);
      await this.tick({ ignoreGate: true });
    } else {
      await this.tick();
    }
  }

  private readLastDrainAt(): number | null {
    try {
      const raw = this.options.workerState.getMeta(TASK_POLL_LAST_DRAIN_KEY);
      if (!raw) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Stop polling (in-flight executions continue until the supervisor drains). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Apply a new poll cadence without restarting (live workspace config
   * reload). Re-arms the repeating timer with the new interval.
   */
  updateInterval(intervalSeconds: number): void {
    this.options.intervalSeconds = intervalSeconds;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), intervalSeconds * 1000);
  }

  /**
   * One detect → evaluate → dedupe → execute cycle. The detect/evaluate/claim
   * phase is skipped while busy and while the working-window gate is closed
   * (unless overridden for a manual run or startup catch-up). The scheduled
   * executions are awaited only after the busy gate is released, so the next
   * interval tick keeps polling and fills free concurrency slots while the
   * current batch runs.
   */
  async tick(bypass: { ignoreGate?: boolean } = {}): Promise<void> {
    if (this.busy) {
      return;
    }
    const query = this.resolveQuery();
    if (!query) return;

    const gate = this.options.gate;
    if (!bypass.ignoreGate && gate) {
      const manual = this.scheduleGuard(() => gate.consumeManualPickup(), false);
      if (manual) {
        console.log(`▶️  [${this.name}] manual run requested; draining now`);
      } else if (!this.scheduleGuard(() => gate.pickupAllowed(), true)) {
        // Outside the working window: no detection, no evaluation, no new
        // tasks. Whatever is already running finishes before this check even
        // happens, and no cursor moves while gated out.
        return;
      }
    }

    this.busy = true;

    const { detector, workerState, queue, searchTasks, executeTask, verbose } = this.options;
    const executions: Promise<void>[] = [];
    let tickDeferred = false;
    let evaluateFailed = false;
    let cursorBefore: string | null = null;
    let nextCursor: string | null = null;

    try {
      // Replay any pending re-admissions persisted before a restart before
      // deciding whether this tick has work to evaluate.
      this.loadPendingRescans(detector.source);
      cursorBefore = workerState.getCursor(detector.source)?.cursorValue ?? null;
      const detection = await detector.changesSince(cursorBefore);
      nextCursor = detection.nextCursor;
      // A task edited mid-run or deferred keeps a pending stamp. Re-evaluate
      // once its run has settled — not on every tick — so the cursor can
      // advance while the potentially many-minute agent run is still in flight.
      const hasReadyPending = [...this.pendingRescans.keys()].some(
        (key) => !this.inFlightKeys.has(key),
      );

      if (detection.changed || hasReadyPending) {
        const { tasks } = await searchTasks(query);
        const skipped: string[] = [];
        const actionedSkips: string[] = [];
        const missingStamp: string[] = [];
        let pickedUp = 0;

        // Resolve the actioned gate for every candidate before claiming any:
        // batching keeps the async tracker reads out of the per-task claim loop
        // so releasing the busy gate is not delayed by an in-flight execution
        // starting mid-loop (see the pending-rescan timing the tests pin).
        const actionedKeys = await this.resolveActionedKeys(tasks);

        for (const task of tasks) {
          if (!hasUpdateStamp(task)) {
            missingStamp.push(task.key);
          }
          // Already actioned (a PR exists) and unchanged: keep it out of the
          // sweep even though the query still matches, until a human changes it.
          if (actionedKeys.has(task.key)) {
            actionedSkips.push(task.key);
            continue;
          }
          const externalId = processedTaskId(task);
          if (queue.hasProcessed(detector.source, externalId)) {
            skipped.push(task.key);
            continue;
          }
          if (this.inFlightKeys.has(task.key)) {
            // The same task is still running (it was edited mid-run). Advance
            // the cursor past the edit instead of holding it, and persist the
            // unclaimed stamp so the settled run (or a restart) re-admits it
            // exactly once, rather than running one task twice concurrently.
            this.rememberPendingRescan(detector.source, task.key, externalId);
            continue;
          }
          // This stamp is being admitted now: drop any pending marker for it.
          this.forgetPendingRescan(detector.source, task.key);
          // Mark before executing: a persistently failing task must not loop
          // every tick. It re-enters when the ticket is updated again (new
          // stamp), and the pipeline's own incomplete-attempt check guards
          // the retry. An empty stamp is also sticky — tracker search must
          // return `updated` or a later edit cannot retrigger this task.
          queue.markProcessed(detector.source, externalId);

          pickedUp++;
          console.log(`\n📌 [${this.name}] picking up ${task.key}`);
          this.inFlightKeys.add(task.key);
          executions.push(
            (async () => {
              try {
                const result = await executeTask(task.key);
                if (result === "deferred") {
                  // The task never started. Release the provisional claim and
                  // track the key explicitly so the same tracker change is
                  // re-evaluated on the next tick even when an overlapping tick
                  // already advanced the cursor past it (the best-effort
                  // rollback below is not always possible). Other tasks
                  // completed in this tick stay deduped.
                  queue.unmarkProcessed(detector.source, externalId);
                  this.rememberPendingRescan(detector.source, task.key, externalId);
                  tickDeferred = true;
                  console.log(`⏳ [${this.name}] ${task.key} deferred; will retry next poll`);
                } else {
                  console.log(
                    result
                      ? `✅ [${this.name}] ${task.key} completed`
                      : `⚠️  [${this.name}] ${task.key} did not complete cleanly`,
                  );
                }
              } finally {
                this.inFlightKeys.delete(task.key);
              }
            })(),
          );
        }

        this.logEvaluate(tasks.length, skipped, actionedSkips, missingStamp, pickedUp, verbose);
        // Remember that a drain ran so working-window catch-up can tell an
        // elapsed-but-idle window apart from one that was already served.
        this.scheduleGuard(
          () => workerState.setMeta(TASK_POLL_LAST_DRAIN_KEY, String(Date.now())),
          undefined,
        );
        this.logCapacity(pickedUp, verbose);
        // A pending stamp that is neither still in flight nor returned by
        // search is no longer eligible; drop it so it cannot force future
        // re-evaluations forever.
        let droppedPending = false;
        for (const key of Array.from(this.pendingRescans.keys())) {
          if (!this.inFlightKeys.has(key)) {
            this.pendingRescans.delete(key);
            droppedPending = true;
          }
        }
        if (droppedPending) {
          this.persistPendingRescans(detector.source);
        }
      }
    } catch (error) {
      // Detection, evaluation, or claim failed partway: do not advance the
      // cursor, or the detected change would be silently consumed and its
      // tasks skipped until the ticket is edited again.
      evaluateFailed = true;
      console.warn(`⚠️  [${this.name}] polling tick failed: ${(error as Error).message}`);
    } finally {
      // Release the polling gate before awaiting the batch: polling must keep
      // picking up newly available tasks while these executions run.
      this.busy = false;
    }

    const outcomes = await Promise.allSettled(executions);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (rejected) {
      console.warn(`⚠️  [${this.name}] polling tick failed: ${(rejected.reason as Error).message}`);
    }

    if (evaluateFailed) {
      // Leave the cursor untouched so the next tick re-detects the same change
      // instead of skipping its tasks.
      return;
    }

    if (tickDeferred) {
      // A deferred task never started. Roll the cursor back to where this tick
      // began so the change is re-detected next tick; dedupe keeps completed
      // siblings from re-running. Deleting the row is only correct when there
      // was no prior cursor — otherwise a sync-token tracker would be forced
      // into a full resync, and an overlapping tick's progress would be lost.
      if (cursorBefore === null) {
        this.scheduleGuard(() => workerState.clearCursor(detector.source), undefined);
      } else {
        const current = this.scheduleGuard(
          () => workerState.getCursor(detector.source)?.cursorValue ?? null,
          null,
        );
        if (current === nextCursor) {
          this.scheduleGuard(() => workerState.setCursor(detector.source, cursorBefore), undefined);
        }
      }
      return;
    }

    if (rejected) {
      return;
    }

    const finalCursor = nextCursor;
    if (finalCursor !== null && finalCursor !== cursorBefore) {
      // Compare-and-set: overlapping ticks must not regress a newer cursor.
      // Both the read and the write go through the guard: a bookkeeping failure
      // must degrade to a warning, never crash the fire-and-forget tick.
      const current = this.scheduleGuard(
        () => workerState.getCursor(detector.source)?.cursorValue ?? null,
        null,
      );
      if (current === cursorBefore) {
        this.scheduleGuard(() => workerState.setCursor(detector.source, finalCursor), undefined);
      }
    }
  }

  /**
   * Actioned gate: `true` when the task already produced a PR and has not
   * changed since, so it must be skipped even though the query still matches.
   */
  private async isActionedUnchanged(task: ReadyTask): Promise<boolean> {
    if (!this.options.isTaskActionedUnchanged) return false;
    return this.options.isTaskActionedUnchanged(task);
  }

  /**
   * Resolve the actioned gate for a whole batch before any task is claimed, so
   * the async tracker reads never interleave with the claim loop (which must
   * reach the busy-gate release without yielding mid-batch).
   */
  private async resolveActionedKeys(tasks: ReadyTask[]): Promise<Set<string>> {
    const actioned = new Set<string>();
    if (!this.options.isTaskActionedUnchanged) return actioned;
    const decisions = await Promise.all(
      tasks.map(async (task) => ((await this.isActionedUnchanged(task)) ? task.key : null)),
    );
    for (const key of decisions) {
      if (key !== null) actioned.add(key);
    }
    return actioned;
  }

  private resolveQuery(): string | undefined {
    const raw = this.options.query;
    return typeof raw === "function" ? raw() : raw;
  }

  /** `worker_meta` key holding one source's durable pending re-admissions. */
  private pendingRescansKey(source: string): string {
    return `task-poll:pending-rescans:${source}`;
  }

  /**
   * Merge persisted pending re-admissions into the in-memory map. Runs at the
   * start of every tick: a restart loses the map but not the advanced cursor,
   * so without this an edit that landed while a run was in flight would be
   * silently dropped.
   */
  private loadPendingRescans(source: string): void {
    const raw = this.scheduleGuard(
      () => this.options.workerState.getMeta(this.pendingRescansKey(source)),
      null,
    );
    for (const [key, externalId] of parsePendingRescans(raw)) {
      if (!this.pendingRescans.has(key)) {
        this.pendingRescans.set(key, externalId);
      }
    }
  }

  /** Remember one unclaimed stamp and persist it for replay after a restart. */
  private rememberPendingRescan(source: string, key: string, externalId: string): void {
    this.pendingRescans.set(key, externalId);
    this.persistPendingRescans(source);
  }

  /** Drop a pending re-admission and persist the removal. */
  private forgetPendingRescan(source: string, key: string): void {
    if (!this.pendingRescans.delete(key)) return;
    this.persistPendingRescans(source);
  }

  /** Write the whole map through to `worker_meta`; failures degrade to a warning. */
  private persistPendingRescans(source: string): void {
    const serialized = JSON.stringify([...this.pendingRescans.entries()]);
    this.scheduleGuard(
      () => this.options.workerState.setMeta(this.pendingRescansKey(source), serialized),
      undefined,
    );
  }

  /**
   * Scheduling must never break polling: gate or bookkeeping failures are
   * downgraded to a single warning per error identity.
   */
  private scheduleGuard<T>(operation: () => T, fallback: T): T {
    try {
      return operation();
    } catch (error) {
      const message = (error as Error).message;
      if (!this.gateErrors.has(message)) {
        this.gateErrors.add(message);
        console.warn(`⚠️  [${this.name}] schedule check failed: ${message}`);
      }
      return fallback;
    }
  }

  /**
   * Verbose capacity line so a worker that stops filling free slots is
   * observable from the log.
   */
  private logCapacity(pickedUp: number, verbose?: boolean): void {
    if (!verbose || pickedUp === 0) return;
    const snapshot = this.options.capacity?.();
    if (!snapshot) return;
    console.log(
      `   [${this.name}] ${snapshot.inFlight} in flight, ${snapshot.available} slot(s) available`,
    );
  }

  /**
   * Always-on skip/stamp diagnosis. Silent skips made "ticket matches query
   * but was never picked up" undebuggable from the worker log.
   */
  private logEvaluate(
    matched: number,
    skipped: string[],
    actionedSkips: string[],
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

    // An actioned-but-unchanged ticket still matching the query is the exact
    // duplicate-PR hazard this gate prevents; always say why it was skipped.
    if (actionedSkips.length > 0) {
      console.log(
        `⏭️  [${this.name}] skipping ${actionedSkips.join(", ")} (already actioned; no change since the PR)`,
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
