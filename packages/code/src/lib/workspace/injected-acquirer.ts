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
import type {
  DependencyFacts,
  DependencyGateDecision,
  DependencyPr,
  MergeStateAnswer,
  StackBase,
} from "../dependencies/gate";
import { evaluateDependencyGate } from "../dependencies/gate";
import { applyStackBase } from "../dependencies/stacked-base";
import { getWorkerFailover } from "../worker/failover";
import { rewriteInjectedTaskFile } from "./injected-enqueue";
import { queueFailureReason } from "./queue-failure-reason";

/**
 * Minimum time between code-host lookups for one dependency PR the gate is
 * waiting on (closed with unknown merge state, or still `open` locally).
 */
export const MERGE_STATE_LOOKUP_COOLDOWN_MS = 5 * 60_000;

/**
 * How long the acquirer waits on one merge-state lookup before giving up on
 * it for this cooldown window. Lookups never run inside the claim section, so
 * this bounds only how long a {@link InjectedTaskAcquirer.tick} promise stays
 * pending, not how long other tasks wait to start.
 */
export const MERGE_STATE_LOOKUP_TIMEOUT_MS = 30_000;

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
   * Ask the code host whether a dependency PR merged or closed, and record
   * the answer in the PR registry (`agent_prs`) where it has a row. Called for
   * PRs the gate is waiting on: closed with an unknown reason, or still `open`
   * locally (no poller may be watching it, or the registry may not know it),
   * at most once per {@link MERGE_STATE_LOOKUP_COOLDOWN_MS} per PR. The
   * acquirer also remembers a `merged`/`closed` answer itself, so a PR without
   * a registry row still unblocks. Return `null` while the PR is open or when
   * the host cannot tell; the dependent keeps waiting.
   */
  resolveMergeState?: (lookup: UnknownMergeStateLookup) => Promise<MergeStateAnswer | null>;
  /**
   * Resolve a branch's current head SHA on the repo's remote (freshly
   * fetched). A stacked task records its base's head when its run starts, so
   * the first restack after the base is rewritten (amended, rebased) strips
   * exactly the commits the task was built on. Unset or failing: nothing is
   * recorded and the restack falls back to the merge base.
   */
  resolveBranchHead?: (repo: string, branch: string) => Promise<string | null>;
  /** Per-lookup timeout (defaults to {@link MERGE_STATE_LOOKUP_TIMEOUT_MS}; tests). */
  mergeStateLookupTimeoutMs?: number;
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
    const lookups: Promise<boolean>[] = [];
    try {
      // Dependency gate: rows still waiting on (or blocked by) a dependency
      // stay pending and are never claimed, so they take no concurrency slot
      // and never touch the deferral budget. The gate is synchronous: code-host
      // lookups it needs start in the background (collected in `lookups`) so
      // a slow or hung host never holds the claim section.
      const ready = this.gatePendingDependencies(excluded, lookups);
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
        const stackBase = decision ? this.prepareDependencyBase(task, decision) : undefined;
        executions.push(
          this.recordStackBaseHead(task, stackBase)
            .then(() => this.runOne(task))
            .finally(() => this.releaseSlot(task.repo)),
        );
      }
    } finally {
      this.claiming = false;
    }
    // A code-host answer can unblock a waiting row: re-gate as soon as the
    // lookups settle instead of a full interval later. Those PRs are now on
    // cooldown, so the re-tick does not look them up again.
    const regate = Promise.all(lookups).then((answers) =>
      answers.some(Boolean) && !this.stopped ? this.tick() : undefined,
    );
    await Promise.allSettled([...executions, regate]);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Last code-host merge-state lookup per dependency PR (cooldown). */
  private readonly mergeLookups = new Map<string, number>();

  /**
   * Final PR states the code host reported, per `repo#number`. Overlaid on the
   * local facts so an answer counts even when no `agent_prs` row could record
   * it (e.g. a run reported a PR the registry never saw).
   */
  private readonly observedPrStates = new Map<string, MergeStateAnswer>();

  /** Evaluate one row's dependency gate from local facts. */
  private evaluateGate(task: InjectedTask): DependencyGateDecision {
    return evaluateDependencyGate(
      task.dependencyMode ?? "merged",
      this.options.store
        .dependencyFacts(task.dependsOn)
        .map((facts) => this.withObservedPrState(task.repo, facts)),
    );
  }

  /**
   * Apply a code-host answer to a dependency the registry still sees as
   * unsettled. `merged` is terminal and always applies; `closed` applies only
   * where the registry has no settled row for it (see the body).
   */
  private withObservedPrState(repo: string, facts: DependencyFacts): DependencyFacts {
    if (facts.stackBase) {
      facts = { ...facts, stackBase: this.withObservedPrState(repo, facts.stackBase) };
    }
    const number = facts.pr?.number ?? facts.latestRun?.prNumber;
    if (number === undefined) return facts;
    const lookupKey = `${repo}#${number}`;
    const observed = this.observedPrStates.get(lookupKey);
    if (!observed) return facts;
    // `closed` is not terminal: the PR can be reopened and the dependency
    // re-queued. Forget it once the dependency runs again, and never let it
    // override a registry row, which the resolver already wrote the answer to
    // (an `open` row there means something re-registered the PR since).
    if (observed.state === "closed") {
      if (facts.work === "queued" || facts.work === "running") {
        this.observedPrStates.delete(lookupKey);
        this.mergeLookups.delete(lookupKey);
        return facts;
      }
      if (facts.pr && facts.pr.state !== "closed-unknown") return facts;
    }
    if (facts.pr && facts.pr.state !== "open" && facts.pr.state !== "closed-unknown") return facts;
    return {
      ...facts,
      pr: {
        number,
        url: facts.pr?.url ?? facts.latestRun?.prUrl,
        branch: facts.pr?.branch ?? facts.latestRun?.branch,
        state: observed.state,
        ...(observed.state === "merged"
          ? {
              mergedAt: observed.mergedAt ?? facts.pr?.mergedAt,
              mergedInto: observed.mergedInto ?? facts.pr?.mergedInto,
              mergedIntoDefault: observed.mergedIntoDefault ?? facts.pr?.mergedIntoDefault,
            }
          : {}),
      },
    };
  }

  /**
   * Gate every pending row that has dependencies: unsatisfied rows are added to
   * `excluded` (and their reason recorded for the queue view); satisfied rows
   * are returned with their decision so the claim can apply a stacked base.
   */
  private gatePendingDependencies(
    excluded: number[],
    lookups: Promise<boolean>[],
  ): Map<number, DependencyGateDecision> {
    const ready = new Map<number, DependencyGateDecision>();
    const { store } = this.options;
    for (const task of store.listPendingWithDependencies()) {
      const decision = this.evaluateGate(task);
      if (decision.kind === "waiting" && decision.mergeStateLookups.length > 0) {
        lookups.push(...this.startMergeStateLookups(task, decision));
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
   * Start (without awaiting) code-host lookups for the dependency PRs the gate
   * is waiting on. Answers land in {@link observedPrStates}, which the next
   * gate pass overlays; the caller must not await these inside the claim
   * section.
   *
   * @returns One promise per lookup started, resolving to whether it produced
   *   a `merged`/`closed` answer. Never rejects.
   */
  private startMergeStateLookups(
    task: InjectedTask,
    decision: Extract<DependencyGateDecision, { kind: "waiting" }>,
  ): Promise<boolean>[] {
    const resolve = this.options.resolveMergeState;
    if (!resolve) return [];
    const started: Promise<boolean>[] = [];
    for (const { key, pr } of decision.mergeStateLookups) {
      const lookupKey = `${task.repo}#${pr.number}`;
      const last = this.mergeLookups.get(lookupKey);
      if (last !== undefined && this.now() - last < MERGE_STATE_LOOKUP_COOLDOWN_MS) continue;
      this.mergeLookups.set(lookupKey, this.now());
      started.push(
        this.withLookupTimeout(resolve({ repo: task.repo, taskKey: key, pr })).then(
          (answer) => {
            if (!answer) return false;
            this.observedPrStates.set(lookupKey, answer);
            return true;
          },
          (error: unknown) => {
            console.warn(
              `⚠️  [${this.name}] could not check whether ${key} PR #${pr.number} merged: ` +
                `${(error as Error).message}`,
            );
            return false;
          },
        ),
      );
    }
    return started;
  }

  /** Reject a lookup that has not settled within {@link MERGE_STATE_LOOKUP_TIMEOUT_MS}. */
  private withLookupTimeout<T>(lookup: Promise<T>): Promise<T> {
    const ms = this.options.mergeStateLookupTimeoutMs ?? MERGE_STATE_LOOKUP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      timer.unref?.();
    });
    return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
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
  private prepareDependencyBase(
    task: InjectedTask,
    decision: DependencyGateDecision,
  ): StackBase | undefined {
    if (task.dependsOn.length === 0 || decision.kind !== "ready") return undefined;
    const applied = applyStackBase(task.body, decision.stackedOn, (message) =>
      console.warn(`⚠️  [${this.name}] ${task.taskKey}: ${message}`),
    );
    // Recorded before the rewrite so dependents never read a stale base: a
    // merged PR of this task counts only once its stack base's work merged.
    this.options.store.setStackedOn(task.id, applied.stackedOn?.taskKey ?? null);
    // A re-claim (e.g. `--resume`) starts a new stacked build: forget the
    // previous claim's base head and closed-base block.
    this.options.store.setStackBaseSha(task.id, null);
    this.options.store.setStackNotice(task.id, null);
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
    return applied.stackedOn;
  }

  /**
   * Record the head of the branch a stacked task is about to branch from
   * (see {@link InjectedTaskAcquirerOptions.resolveBranchHead}). Best effort:
   * a failure only costs the restack its exact old-base hint.
   */
  private async recordStackBaseHead(
    task: InjectedTask,
    base: StackBase | undefined,
  ): Promise<void> {
    const resolve = this.options.resolveBranchHead;
    if (!base || !resolve) return;
    try {
      const sha = await this.withLookupTimeout(resolve(task.repo, base.branch));
      if (sha && !this.options.store.isClosed()) this.options.store.setStackBaseSha(task.id, sha);
    } catch (error) {
      console.warn(
        `⚠️  [${this.name}] ${task.taskKey}: could not read ${base.branch}'s head: ` +
          (error as Error).message,
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
