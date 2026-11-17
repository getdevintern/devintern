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
import { randomUUID } from "crypto";
import type { DependencyGateDecision, DependencyPr } from "../dependencies/gate";
import { evaluateDependencyGate } from "../dependencies/gate";
import { applyStackBase } from "../dependencies/stacked-base";
import { getWorkerFailover } from "../worker/failover";
import { rewriteInjectedTaskFile } from "./injected-enqueue";
import { queueFailureReason } from "./queue-failure-reason";

/**
 * Minimum time between code-host lookups for one closed dependency PR whose
 * merge state the registry does not know.
 */
export const MERGE_STATE_LOOKUP_COOLDOWN_MS = 5 * 60_000;

/** A dependency PR whose merge state must be asked of the code host. */
export interface UnknownMergeStateLookup {
  /** Repo of the dependent (and dependency) task. */
  repo: string;
  taskKey: string;
  pr: DependencyPr;
}

/** Source label surfaced in worker logs, run records, and the dashboard. */
export const INJECTED_TASK_SOURCE = "local:add";

/**
 * Consecutive deferrals after which an injected task is settled `failed`.
 * A real usage limit pauses the drain for its whole window, so a healthy task
 * defers about once per window; dozens of deferrals mean the harness keeps
 * failing in a way the worker does not recognize.
 */
export const MAX_INJECTED_DEFERRALS = 24;

/** Backoff cap between deferred attempts of one injected task. */
export const MAX_INJECTED_DEFER_BACKOFF_MS = 60 * 60_000;

/**
 * Exponential backoff after the Nth consecutive deferral: 1m, 2m, 4m, ...,
 * capped at {@link MAX_INJECTED_DEFER_BACKOFF_MS}.
 *
 * @param deferCount - Consecutive deferrals including this one (1-based).
 */
export function injectedDeferBackoffMs(deferCount: number): number {
  const exponent = Math.min(Math.max(0, deferCount - 1), 20);
  return Math.min(60_000 * 2 ** exponent, MAX_INJECTED_DEFER_BACKOFF_MS);
}

export interface InjectedTaskAcquirerOptions {
  store: InjectedTaskStore;
  /** Shared workspace queue DB, for best-effort failed-run diagnostics. */
  runDbPath?: string;
  /** Run one claimed task through the fleet executor. */
  execute: (task: InjectedTask, queueClaim: string) => Promise<TaskExecutionResult>;
  intervalSeconds: number;
  /**
   * Global agent concurrency cap. Claim at most this many injected tasks at
   * once so this queue cannot start more work than the worker allows.
   * Defaults to unbounded (tests and single-source callers).
   */
  maxConcurrency?: number;
  /**
   * Per-repository agent concurrency cap. A task for a saturated repo stays
   * pending while other repos can still start. Defaults to unbounded.
   */
  maxConcurrencyPerRepo?: number;
  /**
   * Whether a graceful shutdown drain has begun. The pipeline reports a drain
   * abort as `"interrupted"`; this is the fallback for an executor that throws
   * instead, whose rows must then be left `running` for startup recovery rather
   * than settled `failed`.
   */
  isDraining?: () => boolean;
  /**
   * Whether the harness chain is exhausted (usage-limited or cooling down).
   * A paused drain leaves every row pending instead of claiming, running, and
   * requeueing it on each interval tick, which otherwise floods the log with
   * identical `running`/`deferred` lines for the whole limit window.
   * Defaults to the process-wide worker failover state.
   */
  isPaused?: () => boolean;
  /** Consecutive-deferral budget (defaults to {@link MAX_INJECTED_DEFERRALS}). */
  maxDeferrals?: number;
  /** Backoff after a deferral (defaults to {@link injectedDeferBackoffMs}). */
  deferBackoffMs?: (deferCount: number) => number;
  /**
   * Ask the code host whether a closed dependency PR merged, and record the
   * answer in the PR registry (`agent_prs`). Called only when the registry
   * says the PR closed without knowing why, at most once per
   * {@link MERGE_STATE_LOOKUP_COOLDOWN_MS} per PR. Return `null` when the
   * host cannot tell; the dependent keeps waiting.
   */
  resolveMergeState?: (lookup: UnknownMergeStateLookup) => Promise<"merged" | "closed" | null>;
  /** Clock for claims and backoff (tests). */
  now?: () => number;
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
  private claiming = false;
  private stopped = false;
  private inFlight = 0;
  private readonly inFlightByRepo = new Map<string, number>();

  constructor(options: InjectedTaskAcquirerOptions) {
    this.options = options;
  }

  /**
   * Install the interval and kick off the first drain without waiting for it.
   *
   * Startup must never block on an injected task: `startWorker` starts its
   * acquirers sequentially, so awaiting the first drain would keep scheduled
   * automations, estimations, and event acquirers from starting until the
   * task settled. The supervisor and the caps below still bound execution.
   */
  async start(): Promise<void> {
    this.stopped = false;
    console.log(`📥 Draining injected tasks every ${this.options.intervalSeconds}s`);
    this.timer = setInterval(() => this.kick(), this.options.intervalSeconds * 1000);
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Start a drain, ignoring overlaps (the next interval will retry). */
  private kick(): void {
    if (this.stopped) return;
    void this.tick().catch((error) => {
      if (!this.options.store.isClosed()) {
        console.error(`❌ [${this.name}] drain failed: ${(error as Error).message}`);
      }
    });
  }

  /**
   * Claim pending tasks up to the available global/per-repo capacity and run
   * them concurrently. A deferred row (busy repo or exhausted harness) is
   * requeued for the next interval tick; it cannot spin here because this
   * drain never re-claims a row it already handled. The interval refills
   * freed slots without holding worker startup or another acquirer.
   *
   * The returned promise covers the executions started by this call, which
   * keeps tests deterministic; production callers use {@link start} or the
   * interval and never await it.
   */
  async tick(): Promise<void> {
    if (this.stopped || this.claiming || this.options.store.isClosed()) {
      return;
    }
    // Exhausted harness chain: claim nothing and log nothing until the pause
    // ends. The executor keeps its own pre-git guard for work that starts
    // between this check and the run.
    if (this.isPaused()) {
      return;
    }
    this.claiming = true;
    const executions: Promise<void>[] = [];
    const excluded: number[] = [];
    try {
      // Dependency gate: rows still waiting on (or blocked by) a dependency
      // stay pending and are never claimed, so they take no concurrency slot
      // and never touch the deferral budget.
      const ready = await this.gatePendingDependencies(excluded);
      while (this.hasCapacity()) {
        // `stop()` closes the store immediately after returning, but in-flight
        // `execute` calls may resolve later; writing then would reopen the
        // connection the successor worker has taken over. Leave those rows
        // `running` for that successor's orphan recovery instead.
        if (this.options.store.isClosed()) {
          break;
        }
        const task = this.options.store.claimNext(excluded, this.now());
        if (!task) {
          break;
        }
        // Avoid re-claiming a row we requeue in this same drain.
        excluded.push(task.id);
        let decision = ready.get(task.id);
        if (task.dependsOn.length > 0 && !decision) {
          // Enqueued after the gate pass above: gate it now.
          decision = this.evaluateGate(task);
          if (decision.kind !== "ready") {
            this.options.store.requeue(task.id);
            this.recordGate(task, decision);
            continue;
          }
        }
        if (!this.hasRepoCapacity(task.repo)) {
          this.options.store.requeue(task.id);
          continue;
        }
        this.reserveSlot(task.repo);
        if (decision) this.prepareDependencyBase(task, decision);
        executions.push(this.runOne(task).finally(() => this.releaseSlot(task.repo)));
      }
    } finally {
      this.claiming = false;
    }
    await Promise.allSettled(executions);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Last code-host merge-state lookup per dependency PR (cooldown). */
  private readonly mergeLookups = new Map<string, number>();

  /** Evaluate one row's dependency gate from local facts. */
  private evaluateGate(task: InjectedTask): DependencyGateDecision {
    return evaluateDependencyGate(
      task.dependencyMode ?? "merged",
      this.options.store.dependencyFacts(task.dependsOn),
    );
  }

  /**
   * Gate every pending row that has dependencies: unsatisfied rows are added to
   * `excluded` (and their reason recorded for the queue view); satisfied rows
   * are returned with their decision so the claim can apply a stacked base.
   */
  private async gatePendingDependencies(
    excluded: number[],
  ): Promise<Map<number, DependencyGateDecision>> {
    const ready = new Map<number, DependencyGateDecision>();
    const { store } = this.options;
    for (const task of store.listPendingWithDependencies()) {
      let decision = this.evaluateGate(task);
      if (decision.kind === "waiting" && decision.unknownMergeState.length > 0) {
        if (await this.resolveUnknownMergeStates(task, decision)) {
          if (store.isClosed()) break;
          decision = this.evaluateGate(task);
        }
      }
      if (decision.kind === "ready") {
        ready.set(task.id, decision);
      } else {
        excluded.push(task.id);
      }
      this.recordGate(task, decision);
    }
    return ready;
  }

  /**
   * Ask the code host about closed dependency PRs of unknown merge state.
   *
   * @returns Whether any lookup ran (the caller re-evaluates the gate)
   */
  private async resolveUnknownMergeStates(
    task: InjectedTask,
    decision: Extract<DependencyGateDecision, { kind: "waiting" }>,
  ): Promise<boolean> {
    const resolve = this.options.resolveMergeState;
    if (!resolve) return false;
    let looked = false;
    for (const { key, pr } of decision.unknownMergeState) {
      const lookupKey = `${task.repo}#${pr.number}`;
      const last = this.mergeLookups.get(lookupKey);
      if (last !== undefined && this.now() - last < MERGE_STATE_LOOKUP_COOLDOWN_MS) continue;
      this.mergeLookups.set(lookupKey, this.now());
      looked = true;
      try {
        await resolve({ repo: task.repo, taskKey: key, pr });
      } catch (error) {
        console.warn(
          `⚠️  [${this.name}] could not check whether ${key} PR #${pr.number} merged: ` +
            `${(error as Error).message}`,
        );
      }
    }
    return looked;
  }

  /** Persist the gate verdict on the row; log only when it changes. */
  private recordGate(task: InjectedTask, decision: DependencyGateDecision): void {
    const { store } = this.options;
    if (store.isClosed()) return;
    const state = decision.kind === "ready" ? null : decision.kind;
    const reason = decision.kind === "ready" ? null : decision.reason;
    if (!store.setDependencyState(task.id, state, reason)) return;
    if (decision.kind === "blocked") {
      console.warn(`⛔ [${this.name}] ${task.taskKey} blocked: ${decision.reason}`);
    } else if (decision.kind === "waiting") {
      console.log(`⏳ [${this.name}] ${task.taskKey} waiting: ${decision.reason}`);
    } else if (this.options.verbose) {
      console.log(`   [${this.name}] ${task.taskKey} dependencies satisfied`);
    }
  }

  /**
   * Materialize the description the run should see: a stacked task gains the
   * generated `Target branch:` section for its one unmerged dependency; any
   * other dependent task is rewritten from its original body so a stale base
   * from an earlier claim cannot linger.
   */
  private prepareDependencyBase(task: InjectedTask, decision: DependencyGateDecision): void {
    if (task.dependsOn.length === 0 || decision.kind !== "ready") return;
    const applied = applyStackBase(task.body, decision.stackedOn, (message) =>
      console.warn(`⚠️  [${this.name}] ${task.taskKey}: ${message}`),
    );
    try {
      rewriteInjectedTaskFile(task, applied.body);
    } catch (error) {
      console.warn(
        `⚠️  [${this.name}] could not rewrite ${task.taskKey}'s prompt: ${(error as Error).message}`,
      );
      return;
    }
    if (applied.stackedOn) {
      console.log(
        `🧱 [${this.name}] ${task.taskKey} stacked on ${applied.stackedOn.taskKey} ` +
          `PR #${applied.stackedOn.prNumber} (${applied.stackedOn.branch})`,
      );
    }
  }

  /** Whether the harness chain is exhausted and the drain must stay idle. */
  private isPaused(): boolean {
    return this.options.isPaused?.() ?? getWorkerFailover()?.allExhausted() ?? false;
  }

  /** Whether another injected task may start globally right now. */
  private hasCapacity(): boolean {
    return this.inFlight < (this.options.maxConcurrency ?? Number.POSITIVE_INFINITY);
  }

  /** Whether another injected task may start for this repository right now. */
  private hasRepoCapacity(repo: string): boolean {
    return (
      (this.inFlightByRepo.get(repo) ?? 0) <
      (this.options.maxConcurrencyPerRepo ?? Number.POSITIVE_INFINITY)
    );
  }

  private reserveSlot(repo: string): void {
    this.inFlight += 1;
    this.inFlightByRepo.set(repo, (this.inFlightByRepo.get(repo) ?? 0) + 1);
  }

  private releaseSlot(repo: string): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const remaining = (this.inFlightByRepo.get(repo) ?? 0) - 1;
    if (remaining > 0) {
      this.inFlightByRepo.set(repo, remaining);
    } else {
      this.inFlightByRepo.delete(repo);
    }
  }

  /** Requeue a deferred row with backoff, or fail it once its budget is spent. */
  private settleDeferred(task: InjectedTask): void {
    const maxDeferrals = this.options.maxDeferrals ?? MAX_INJECTED_DEFERRALS;
    const outcome = this.options.store.defer(task.id, {
      maxDeferrals,
      backoffMs: this.options.deferBackoffMs ?? injectedDeferBackoffMs,
      exhaustedMessage:
        `deferred ${maxDeferrals} times in a row without the agent harness doing the work; ` +
        `check the harness logs, then re-queue with \`devintern worker add --resume ${task.taskKey}\``,
      now: this.now(),
    });
    if (!outcome) return;
    if (outcome.requeued) {
      const retryAt = outcome.task.notBefore ?? this.now();
      console.log(
        `⏳ [${this.name}] ${task.taskKey} deferred (${outcome.task.deferCount}/${maxDeferrals}); ` +
          `next attempt after ${new Date(retryAt).toISOString()}`,
      );
    } else {
      console.error(
        `❌ [${this.name}] ${task.taskKey} failed: deferred ${outcome.task.deferCount} times in a row; ` +
          "giving up until it is re-queued",
      );
    }
  }

  /** Run one claimed task and settle its row. */
  private async runOne(task: InjectedTask): Promise<void> {
    const { store, execute, verbose } = this.options;
    const queueClaim = randomUUID();
    console.log(`📥 [${this.name}] running ${task.taskKey} → ${task.repo}`);
    try {
      const result = await execute(task, queueClaim);
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
        // Harness exhausted or unable to start: back to the queue with backoff,
        // under a durable consecutive-deferral budget so an unrecognized
        // harness failure cannot re-run the task every tick forever.
        this.settleDeferred(task);
      } else if (result === "interrupted") {
        // A graceful shutdown aborted this run's child, so its failure is an
        // artifact of the drain, not the pipeline. Leave the row claimed: the
        // successor worker's startup recovery settles it from the run record,
        // and a settle here would race the store close that follows the drain.
        // A genuine failure that merely happens during the shutdown window
        // arrives as `false` and is settled below, keeping its real outcome.
        console.log(
          `⏸️  [${this.name}] ${task.taskKey} interrupted by worker shutdown; ` +
            "left running for the next worker to resume",
        );
      } else {
        store.finish(task.id, "failed", queueFailureReason(this.options.runDbPath, queueClaim));
      }
    } catch (error) {
      if (store.isClosed()) {
        return;
      }
      // Fallback for an executor that throws on a drain (rather than reporting
      // `"interrupted"`): its row must stay claimed for startup recovery.
      if (this.options.isDraining?.()) {
        console.log(
          `⏸️  [${this.name}] ${task.taskKey} interrupted by worker shutdown; ` +
            "left running for the next worker to resume",
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      store.finish(task.id, "failed", message);
      console.error(`❌ [${this.name}] ${task.taskKey} failed: ${message}`);
    } finally {
      if (verbose && !store.isClosed()) {
        console.log(`   [${this.name}] ${task.taskKey} settled`);
      }
    }
  }
}
