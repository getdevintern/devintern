import { randomUUID } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import type { Acquirer } from "../../worker";
import type { AutomationConfig } from "./config";
import type { AgentSelection } from "../agent/selection";
import { automationTaskArgs, nextScheduleOccurrence } from "./config";
import { AutomationStateStore } from "./state";
import { workerTaskArgs } from "../acquirers/task-polling";
import {
  applyAgentSelectionEnv,
  pickAgentSelection,
  pinnedHarnessChildEnv,
} from "../agent/selection";
import { automationsDir } from "../workspace/paths";
import { RUN_ORIGIN_ENV } from "../observability/analytics";
import type { RunOrigin } from "../state/run-recorder";
import { readRunOutcomeHint, RUN_OUTCOME_FILE_ENV } from "../worker/run-outcome-protocol";
import type { RunOutcomeHint } from "../worker/run-outcome-protocol";
import {
  getWorkerFailover,
  harnessBlockedReason,
  pinnedChildEnvWithHint,
} from "../worker/failover";
import {
  HARNESS_UNAVAILABLE_EXIT_CODE,
  readUsageLimitHint,
  USAGE_LIMIT_EXIT_CODE,
  USAGE_LIMIT_FILE_ENV,
} from "../worker/usage-limit-protocol";

/** Environment markers the task pipeline reads to attribute scheduled runs. */
export const AUTOMATION_ORIGIN_ENV = RUN_ORIGIN_ENV;
export const AUTOMATION_ID_ENV = "DEVINTERN_AUTOMATION_ID";
/** Origin recorded for dashboard-triggered ("Run now") automation runs. */
export const MANUAL_ORIGIN_ENV_VALUE = "manual";

const LEASE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
const TERMINATION_GRACE_MS = 5_000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AutomationRunContext {
  cwd: string;
  env: Record<string, string | undefined>;
  repo?: string;
  /**
   * Explicit directory for occurrence task files. When omitted, files go to
   * the workspace `automations/` directory.
   */
  taskFileDir?: string;
  release(): void | Promise<void>;
}

export interface SpawnedAutomationRun {
  completion: Promise<boolean>;
  terminate(): void;
  /**
   * Terminal status the child recorded, read after a clean exit. A clean exit
   * can still be an escalated run (the agent reported its goal as blocked).
   */
  outcome?(): RunOutcomeHint | undefined;
}

/**
 * Worker log line for a settled automation run. A clean exit whose recorded
 * run escalated uses the worker's escalation wording (🛑, as auto-merge
 * rejections do), and one recorded as failed (for example, pushed but the PR
 * could not be created) says so, instead of claiming completion.
 *
 * @param label - Log prefix such as `automation:release`
 * @param ok - Whether the child exited cleanly
 * @param outcome - Terminal status the child recorded, when known
 * @param subject - Noun for the run (`""` or `"manual run "`)
 */
export function automationCompletionMessage(
  label: string,
  ok: boolean,
  outcome: RunOutcomeHint | undefined,
  subject = "",
): string {
  if (!ok) return `⚠️  [${label}] ${subject}did not complete cleanly`;
  if (outcome?.status === "escalated") {
    return `🛑 [${label}] ${subject}escalated: ${outcome.reason ?? "handed back to a human"}`;
  }
  if (outcome?.status === "failed") {
    return `❌ [${label}] ${subject}failed: ${outcome.reason ?? "run did not deliver"}`;
  }
  return `✅ [${label}] ${subject}completed`;
}

/** Result of a dashboard "Run now" trigger for one automation. */
export type ManualTriggerOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Scheduled job types the dashboard lists side by side: prompt automations,
 * story-point estimation sweeps, and the scheduled conflict-resolution window.
 */
export type ScheduledJobKind = "automation" | "estimation" | "conflict_resolution" | "auto_merge";

/** Which recorded runs belong to one scheduled job (see `RunFilter`). */
export interface ScheduledJobRunFilter {
  automationId?: string;
  origin?: RunOrigin;
}

/**
 * What an occurrence is doing before its run record exists. The task
 * subprocess creates the run row, so without this a run that is waiting for a
 * free slot (the repo's base checkout or a worker slot) or still starting up
 * is invisible on the dashboard.
 */
export interface AutomationActivity {
  /** `waiting`: holding the lease, not yet admitted. `running`: subprocess spawned. */
  state: "waiting" | "running";
  /** When the occurrence entered this state (epoch ms). */
  since: number;
  /** What started the occurrence. */
  trigger: "scheduled" | "manual";
  /** Why a waiting occurrence has not started yet. */
  reason?: string;
}

/** One configured schedule as exposed to the dashboard, with its agent override. */
export interface AutomationScheduleStatus extends AgentSelection {
  id: string;
  /** In-flight occurrence held by this worker; absent when idle. */
  activity?: AutomationActivity;
  /** Job type; absent means a prompt automation. */
  kind?: ScheduledJobKind;
  /** Display name when it differs from `id` (namespaced estimation / conflict ids). */
  title?: string;
  enabled: boolean;
  cron?: string;
  interval?: string;
  repo?: string;
  prompt: string;
  /** Whether occurrences open a pull request (opt-in; default off). */
  openPr?: boolean;
  /** Durable next occurrence (epoch ms); absent before first registration. */
  nextDueAt?: number;
  /** Estimation sweeps: tracker query selecting the tickets to estimate. */
  query?: string;
  /** Estimation sweeps: `[[teams]]` name whose tracker the sweep uses. */
  team?: string;
  /** Recorded runs attributed to this job; defaults to `{ automationId: id }`. */
  runFilter?: ScheduledJobRunFilter;
}

/**
 * What the dashboard needs to list and trigger automations. The workspace
 * worker supplies it from its in-process {@linkcode AutomationAcquirer}; a
 * standalone dashboard falls back to the project-config spawn path
 * (`lib/automation-manual.ts`).
 */
export interface DashboardAutomationActions {
  list(): AutomationScheduleStatus[];
  trigger(automationId: string): Promise<ManualTriggerOutcome>;
}

export interface AutomationAcquirerOptions {
  automations: AutomationConfig[];
  dbPath: string;
  /**
   * Per-task CLI flags; defaults to `--create-pr`. May be a factory so live
   * config reloads (e.g. `[defaults].worker_task_args`) apply to later runs.
   */
  extraArgs?: string[] | (() => string[]);
  /**
   * Per-automation CLI flags; when set this wins over `extraArgs`, so each
   * occurrence's flags can honor its own `open_pr` policy (e.g. workspace
   * flags for PR-opening automations, `--no-git` for the rest).
   */
  automationArgs?: (automation: AutomationConfig) => string[];
  resolveContext: (automation: AutomationConfig) => Promise<AutomationRunContext | null>;
  now?: () => number;
  spawnRun?: (automation: AutomationConfig, context: AutomationRunContext) => SpawnedAutomationRun;
  /** Test-only runner override for manual ("Run now") runs. */
  spawnManualRun?: (
    automation: AutomationConfig,
    context: AutomationRunContext,
  ) => SpawnedAutomationRun;
  leaseMs?: number;
  heartbeatMs?: number;
  terminationGraceMs?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  /** Namespace durable schedule state when another job type reuses this scheduler. */
  stateId?: (automation: AutomationConfig) => string;
  /** User-facing job kind used in log lines; defaults to "automation". */
  jobKind?: string;
  /** Acquirer name override (worker banner / analytics worker mode). */
  name?: string;
  /**
   * Epoch ms until which no agent harness can run this entry, or `null` when
   * one is available. Defaults to the worker failover state: the whole chain
   * for unpinned entries, the pinned harness's own window otherwise.
   */
  harnessBlockedUntil?: (automation: AutomationConfig) => number | null;
}

interface ActiveAutomationRun {
  run: SpawnedAutomationRun;
  lifecycle: Promise<void>;
  startedAt: number;
  trigger: AutomationActivity["trigger"];
}

/**
 * Default harness gate: while every chain entry is usage-limited or cooling
 * down, a spawned run would only fail within seconds and re-report the limit.
 */
export function defaultHarnessBlockedUntil(automation: AutomationConfig): number | null {
  const failover = getWorkerFailover();
  if (!failover) return null;
  if (automation.harness) {
    // Includes windows recorded by earlier runs pinned to this harness.
    return failover.limitedUntil(automation.harness);
  }
  if (!failover.allExhausted()) return null;
  const now = Date.now();
  return failover.earliestChainResetMs(now) ?? now;
}

/** Calculate the first future occurrence after `afterMs` (cron uses host timezone). */
export function nextAutomationDue(automation: AutomationConfig, afterMs: number): number {
  if (!automation.intervalMs && !automation.cron) {
    throw new Error(`Automation "${automation.id}" has no schedule`);
  }
  return nextScheduleOccurrence(automation, afterMs);
}

/**
 * Per-run CLI args for one automation occurrence: the per-automation policy
 * resolver wins when present; otherwise the shared per-task flags (a factory
 * for live-reload freshness) and finally `workerTaskArgs()`, always with the
 * automation's `open_pr` policy applied so the default per-task flags cannot
 * turn PR creation on for an automation that has it off.
 */
export function resolveAutomationRunArgs(
  automation: AutomationConfig,
  options: Pick<AutomationAcquirerOptions, "automationArgs" | "extraArgs">,
): string[] {
  if (options.automationArgs) return options.automationArgs(automation);
  const extraArgs = options.extraArgs;
  const base = typeof extraArgs === "function" ? extraArgs() : (extraArgs ?? workerTaskArgs());
  return automationTaskArgs(automation, base);
}

/** One-timer scheduler with durable UTC cursors and per-automation leases. */
export class AutomationAcquirer implements Acquirer {
  readonly name: string;
  private options: AutomationAcquirerOptions;
  private store: AutomationStateStore;
  private owner = `${process.pid}:${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = new Map<string, ActiveAutomationRun>();
  /** Occurrences holding the lease while `resolveContext` waits for a slot. */
  private waiting = new Map<string, { since: number; trigger: AutomationActivity["trigger"] }>();
  private tickPromise: Promise<void> | null = null;
  private stopped = true;
  private paused = false;

  constructor(options: AutomationAcquirerOptions) {
    this.options = options;
    this.name = options.name ?? "scheduled-automations";
    this.store = new AutomationStateStore(options.dbPath);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const now = this.now();
    for (const automation of this.options.automations.filter((item) => item.enabled)) {
      this.store.register(automation, nextAutomationDue(automation, now), this.stateId(automation));
    }
    console.log(
      `⏰ Scheduling ${this.options.automations.filter((item) => item.enabled).length} enabled ${this.jobKind()}(s)`,
    );
    await this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
    await this.tickPromise;
    for (const active of this.active.values()) active.run.terminate();
    await Promise.allSettled([...this.active.values()].map((active) => active.lifecycle));
    this.store.close();
  }

  /** Suspend new scheduled and manual runs while active runs keep their leases. */
  pause(): void {
    this.paused = true;
  }

  /** Resume acquisition after automation access has been restored. */
  async resume(): Promise<void> {
    this.paused = false;
    await this.tick();
  }

  /** Public for deterministic tests; production calls it through one setTimeout. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.tickPromise) return this.tickPromise;
    const tickPromise = this.runTick();
    this.tickPromise = tickPromise;
    try {
      await tickPromise;
    } finally {
      if (this.tickPromise === tickPromise) this.tickPromise = null;
    }
  }

  /**
   * Replace the automation set at runtime (live workspace.toml reload).
   *
   * Reconciles durable schedule state without interrupting active work:
   *
   * - Newly added or rescheduled entries register (a changed schedule resets
   *   the cursor; an unchanged one retains the prior interval anchor).
   * - Entries removed from the config retire: removed-but-active runs finish
   *   their current occurrence naturally, then their schedule state is
   *   dropped. Fully removed inactive entries are unregistered immediately.
   * - Entries merely disabled keep their schedule rows so re-enabling later
   *   keeps the anchor, matching restart semantics.
   */
  applyAutomations(next: AutomationConfig[]): void {
    const previous = this.options.automations;
    this.options.automations = next;

    const now = this.now();
    for (const automation of next.filter((item) => item.enabled)) {
      try {
        this.store.register(
          automation,
          nextAutomationDue(automation, now),
          this.stateId(automation),
        );
      } catch (error) {
        console.error(
          `❌ [${this.jobKind()}:${automation.id}] invalid schedule after reload: ` +
            `${(error as Error).message}`,
        );
      }
    }

    for (const retired of previous.filter((item) => !next.some((n) => n.id === item.id))) {
      const active = this.active.get(retired.id);
      if (active) {
        // Let the in-flight occurrence run to completion; drop its state only
        // after it ends and only if the id was not re-added in the meantime.
        void active.lifecycle
          .catch(() => undefined)
          .then(() => {
            if (!this.options.automations.some((item) => item.id === retired.id)) {
              this.store.unregister(this.stateId(retired));
            }
          });
      } else {
        this.store.unregister(this.stateId(retired));
      }
    }

    this.scheduleNext();
  }

  private async runTick(): Promise<void> {
    const leaseMs = this.options.leaseMs ?? LEASE_MS;
    const kind = this.jobKind();
    for (const automation of this.options.automations.filter((item) => item.enabled)) {
      const stateId = this.stateId(automation);
      let state = this.store.get(stateId);
      if (!state) continue;

      if (this.active.has(automation.id)) {
        const active = this.active.get(automation.id) as ActiveAutomationRun;
        if (!this.store.heartbeat(stateId, this.owner, this.now(), leaseMs)) {
          console.warn(`⏭️  [${kind}:${automation.id}] terminating: lease was lost`);
          active.run.terminate();
          await active.lifecycle;
        }
        state = this.store.get(stateId);
        if (!state) continue;
      }
      if (this.paused || state.nextDueAt > this.now()) continue;

      const blockedUntil = this.harnessBlockedUntil(automation);
      if (blockedUntil !== null) {
        const skipNow = this.now();
        if (this.store.skipDue(stateId, skipNow, nextAutomationDue(automation, skipNow))) {
          console.warn(
            `⏭️  [${kind}:${automation.id}] occurrence skipped: ${harnessBlockedReason(blockedUntil)}`,
          );
        }
        continue;
      }

      const overlapNow = this.now();
      if (state.leaseOwner && (state.leaseExpiresAt ?? 0) > overlapNow) {
        const skipNow = this.now();
        const nextDue = nextAutomationDue(automation, skipNow);
        if (this.store.skipOverlap(stateId, skipNow, nextDue)) {
          console.warn(`⏭️  [${kind}:${automation.id}] occurrence skipped: previous run is active`);
        }
        continue;
      }
      const claimNow = this.now();
      const nextDue = nextAutomationDue(automation, claimNow);
      if (!this.store.claim(stateId, this.owner, claimNow, nextDue, leaseMs)) continue;

      let context: AutomationRunContext | null = null;
      try {
        let ownsClaim = true;
        const heartbeatMs = Math.min(this.options.heartbeatMs ?? HEARTBEAT_MS, leaseMs / 2);
        const setHeartbeatInterval = this.options.setInterval ?? setInterval;
        const clearHeartbeatInterval = this.options.clearInterval ?? clearInterval;
        const preparationHeartbeat = setHeartbeatInterval(
          () => {
            if (!this.store.heartbeat(stateId, this.owner, this.now(), leaseMs)) {
              ownsClaim = false;
            }
          },
          Math.max(1, heartbeatMs),
        );
        (preparationHeartbeat as { unref?: () => void }).unref?.();
        this.waiting.set(automation.id, { since: this.now(), trigger: "scheduled" });
        try {
          context = await this.options.resolveContext(automation);
        } finally {
          clearHeartbeatInterval(preparationHeartbeat);
          this.waiting.delete(automation.id);
        }
        if (!context) {
          console.warn(
            `⏭️  [${kind}:${automation.id}] occurrence skipped: ${this.busySkipReason()}`,
          );
          this.store.release(stateId, this.owner);
          continue;
        }
        if (this.stopped || this.paused) {
          this.store.release(stateId, this.owner);
          await context.release();
          continue;
        }
        ownsClaim &&= this.store.heartbeat(stateId, this.owner, this.now(), leaseMs);
        if (!ownsClaim) {
          console.warn(`⏭️  [${kind}:${automation.id}] occurrence skipped: lease was lost`);
          await context.release();
          continue;
        }
        console.log(`\n⏰ [${kind}:${automation.id}] starting scheduled run`);
        const run = this.options.spawnRun
          ? this.options.spawnRun(automation, context)
          : defaultSpawnRun(
              automation,
              context,
              this.resolveAutomationArgs(automation),
              "scheduled",
              this.options.terminationGraceMs,
            );
        this.trackActiveRun(automation, stateId, context, run, "scheduled");
      } catch (error) {
        this.store.release(stateId, this.owner);
        await context?.release();
        console.error(`❌ [${kind}:${automation.id}] ${(error as Error).message}`);
      }
    }
    this.scheduleNext();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Track a spawned run until it settles: heartbeat-driven ticks observe it,
   * `stop()` terminates it, and its cleanup releases the schedule lease plus
   * the run context (repo lock, coordinator slot) exactly once.
   */
  private trackActiveRun(
    automation: AutomationConfig,
    stateId: string,
    context: AutomationRunContext,
    run: SpawnedAutomationRun,
    trigger: AutomationActivity["trigger"],
  ): void {
    const kind = this.jobKind();
    const active: ActiveAutomationRun = {
      run,
      lifecycle: Promise.resolve(),
      startedAt: this.now(),
      trigger,
    };
    active.lifecycle = run.completion
      .then((ok) =>
        console.log(
          automationCompletionMessage(
            `${kind}:${automation.id}`,
            ok,
            ok ? run.outcome?.() : undefined,
          ),
        ),
      )
      .catch((error) => console.error(`❌ [${kind}:${automation.id}] ${(error as Error).message}`))
      .finally(async () => {
        try {
          this.store.release(stateId, this.owner);
          await context.release();
        } finally {
          if (this.active.get(automation.id) === active) this.active.delete(automation.id);
          this.scheduleNext();
        }
      });
    this.active.set(automation.id, active);
  }

  /**
   * Dashboard "Run now": execute one automation occurrence immediately through
   * the same pipeline a scheduled run uses (context resolution, task-file
   * materialization, CLI subprocess), attributed with the `manual` origin so
   * run history distinguishes it from scheduled runs.
   *
   * The manual run holds the automation's overlap lease while active, so a
   * scheduled occurrence coming due mid-run is coalesced (skipped) instead of
   * running concurrently, and a second manual trigger is rejected while one
   * is in flight.
   */
  async triggerManual(automationId: string): Promise<ManualTriggerOutcome> {
    const automation = this.options.automations.find((item) => item.id === automationId);
    if (!automation) {
      return { ok: false, reason: `automation "${automationId}" is not configured` };
    }
    if (!automation.enabled) {
      return {
        ok: false,
        reason: `automation "${automationId}" is disabled; enable it in the config first`,
      };
    }
    if (this.stopped) {
      return { ok: false, reason: "the worker is shutting down; try again after it restarts" };
    }
    if (this.paused) {
      return { ok: false, reason: "automation access is paused; try again after it is restored" };
    }
    if (this.active.has(automationId)) {
      return { ok: false, reason: `automation "${automationId}" is already running` };
    }
    const blockedUntil = this.harnessBlockedUntil(automation);
    if (blockedUntil !== null) {
      return { ok: false, reason: harnessBlockedReason(blockedUntil) };
    }

    const stateId = this.stateId(automation);
    const state = this.store.get(stateId);
    if (!state) {
      return {
        ok: false,
        reason: `automation "${automationId}" is not registered yet; wait for the config reload and try again`,
      };
    }
    const leaseMs = this.options.leaseMs ?? LEASE_MS;
    const now = this.now();
    if (state.leaseOwner && (state.leaseExpiresAt ?? 0) > now) {
      return { ok: false, reason: `automation "${automationId}" is already running` };
    }
    if (!this.store.acquireManual(stateId, this.owner, this.now(), leaseMs)) {
      return {
        ok: false,
        reason: `could not acquire the run slot for "${automationId}"; try again`,
      };
    }

    let context: AutomationRunContext | null = null;
    const heartbeatMs = Math.min(this.options.heartbeatMs ?? HEARTBEAT_MS, leaseMs / 2);
    const setHeartbeatInterval = this.options.setInterval ?? setInterval;
    const clearHeartbeatInterval = this.options.clearInterval ?? clearInterval;
    const preparationHeartbeat = setHeartbeatInterval(
      () => {
        this.store.heartbeat(stateId, this.owner, this.now(), leaseMs);
      },
      Math.max(1, heartbeatMs),
    );
    (preparationHeartbeat as { unref?: () => void }).unref?.();
    this.waiting.set(automation.id, { since: this.now(), trigger: "manual" });
    try {
      context = await this.options.resolveContext(automation);
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    } finally {
      clearHeartbeatInterval(preparationHeartbeat);
      this.waiting.delete(automation.id);
      if (context === null) {
        // Declined (busy repo) or rejected — give the lease back so the
        // scheduler can proceed with the next occurrence.
        this.store.release(stateId, this.owner);
      }
    }
    if (!context) {
      return {
        ok: false,
        reason:
          this.options.jobKind === undefined
            ? `the repository for "${automationId}" is busy with another run; try again shortly`
            : `the worker is busy with another run; try again shortly`,
      };
    }
    if (this.stopped || this.paused) {
      this.store.release(stateId, this.owner);
      await context.release();
      return {
        ok: false,
        reason: this.stopped
          ? "the worker is shutting down; try again after it restarts"
          : "automation access is paused; try again after it is restored",
      };
    }
    if (!this.store.heartbeat(stateId, this.owner, this.now(), leaseMs)) {
      await context.release();
      return { ok: false, reason: `the run slot for "${automationId}" was lost; try again` };
    }

    console.log(`\n⏰ [${this.jobKind()}:${automationId}] starting manual run (dashboard)`);
    let run: SpawnedAutomationRun;
    try {
      run = this.options.spawnManualRun
        ? this.options.spawnManualRun(automation, context)
        : spawnManualAutomationRun(
            automation,
            context,
            this.resolveAutomationArgs(automation),
            this.options.terminationGraceMs,
          );
    } catch (error) {
      this.store.release(stateId, this.owner);
      try {
        await context.release();
      } catch (releaseError) {
        console.error(
          `❌ [${this.jobKind()}:${automationId}] cleanup failed: ${(releaseError as Error).message}`,
        );
      }
      throw error;
    }
    this.trackActiveRun(automation, stateId, context, run, "manual");
    return { ok: true };
  }

  /** Dashboard catalog: every configured schedule with its durable next-due state. */
  listSchedules(): AutomationScheduleStatus[] {
    return this.options.automations.map((automation) => {
      const state = this.store.get(this.stateId(automation));
      const activity = this.activityOf(automation);
      return {
        id: automation.id,
        ...(activity ? { activity } : {}),
        enabled: automation.enabled,
        cron: automation.cron,
        interval: automation.interval,
        repo: automation.repo,
        prompt: automation.prompt,
        openPr: automation.openPr === true,
        ...pickAgentSelection(automation),
        nextDueAt: state?.nextDueAt,
      };
    });
  }

  /** Per-run CLI args: per-automation policy first, then the shared defaults. */
  private resolveAutomationArgs(automation: AutomationConfig): string[] {
    return resolveAutomationRunArgs(automation, this.options);
  }

  private harnessBlockedUntil(automation: AutomationConfig): number | null {
    return (this.options.harnessBlockedUntil ?? defaultHarnessBlockedUntil)(automation);
  }

  private jobKind(): string {
    return this.options.jobKind ?? "automation";
  }

  /** In-flight occurrence of one automation, for the dashboard. */
  private activityOf(automation: AutomationConfig): AutomationActivity | undefined {
    const active = this.active.get(automation.id);
    if (active) return { state: "running", since: active.startedAt, trigger: active.trigger };
    const waiting = this.waiting.get(automation.id);
    if (!waiting) return undefined;
    return { state: "waiting", ...waiting, reason: this.waitingReason(automation) };
  }

  /** Why an admitted-but-not-started occurrence is still waiting. */
  private waitingReason(automation: AutomationConfig): string {
    if (this.options.jobKind !== undefined || !automation.repo) {
      return "waiting for a free worker slot";
    }
    return `waiting for the ${automation.repo} checkout, which another run is using`;
  }

  /** Reason logged when `resolveContext` declines a due occurrence. */
  private busySkipReason(): string {
    return this.options.jobKind === undefined ? "repository is busy" : "worker is busy";
  }

  private stateId(automation: AutomationConfig): string {
    return this.options.stateId?.(automation) ?? automation.id;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    const now = this.now();
    const dueTimes = this.options.automations
      .filter((item) => item.enabled && !this.paused)
      .map((item) => this.store.get(this.stateId(item))?.nextDueAt)
      .filter((value): value is number => value !== undefined);
    const heartbeatAt =
      this.active.size > 0 ? now + (this.options.heartbeatMs ?? HEARTBEAT_MS) : Infinity;
    const wakeAt = Math.min(heartbeatAt, ...dueTimes);
    if (!Number.isFinite(wakeAt)) return;
    this.timer = (this.options.setTimer ?? setTimeout)(
      () => void this.tick(),
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, wakeAt - now)),
    );
  }
}

/**
 * Directory that receives one markdown task file per occurrence: the
 * context's explicit directory, else the workspace `automations/` directory.
 */
export function automationTaskDir(context: AutomationRunContext): string {
  return context.taskFileDir ?? automationsDir();
}

/**
 * Materialize the automation prompt as a local markdown task file so the
 * regular task pipeline can process it like any other tracker-less task.
 */
export function writeAutomationTaskFile(
  automation: AutomationConfig,
  context: AutomationRunContext,
): string {
  const dir = join(automationTaskDir(context), automation.id);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(dir, `${stamp}.md`);
  const body = [
    "---",
    "type: Task",
    "---",
    "",
    `# ${automation.id}`,
    "",
    automation.prompt.trim(),
    "",
  ].join("\n");
  writeFileSync(filePath, body);
  return filePath;
}

/**
 * Attribution env for an automation subprocess: the run origin (`scheduled`
 * for occurrences, `manual` for dashboard "Run now") plus the owning
 * schedule id.
 */
export function automationRunEnv(
  automation: AutomationConfig,
  base?: Record<string, string | undefined>,
  originValue: string = "scheduled",
): Record<string, string | undefined> {
  return {
    ...applyAgentSelectionEnv({ ...base }, pickAgentSelection(automation)),
    [AUTOMATION_ORIGIN_ENV]: originValue,
    [AUTOMATION_ID_ENV]: automation.id,
  };
}

function defaultSpawnRun(
  automation: AutomationConfig,
  context: AutomationRunContext,
  extraArgs: string[],
  originValue: string,
  terminationGraceMs?: number,
): SpawnedAutomationRun {
  const taskFile = writeAutomationTaskFile(automation, context);
  return spawnAutomationProcess(
    process.execPath,
    [process.argv[1] as string, taskFile, ...extraArgs],
    {
      cwd: context.cwd,
      env: automationRunEnv(automation, context.env, originValue),
      // A pinned harness must survive the failover child-env pin (see
      // `pinAutomationEnv`); entries without one keep workspace failover.
      harnessPin: automation.harness,
      terminationGraceMs,
    },
  );
}

/**
 * Manual ("Run now") spawn: the identical pipeline as a scheduled run — same
 * materialized task file, same CLI arguments, same working directory and env —
 * with only the run-origin marker set to `manual` so run records stay
 * distinguishable in the dashboard.
 */
export function spawnManualAutomationRun(
  automation: AutomationConfig,
  context: AutomationRunContext,
  extraArgs: string[],
  terminationGraceMs?: number,
): SpawnedAutomationRun {
  return defaultSpawnRun(
    automation,
    context,
    extraArgs,
    MANUAL_ORIGIN_ENV_VALUE,
    terminationGraceMs,
  );
}

/**
 * Spawn one isolated automation subprocess (the normal CLI pipeline for the
 * materialized task file) and terminate its process tree within a bound.
 */
export function spawnAutomationProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    /**
     * Explicit harness pinned by the scheduled entry (`harness` field). When
     * set, the child is pinned to it and the workspace failover overlay is
     * skipped so the entry always uses the agent it named. Entries without a
     * `harness` keep normal workspace failover.
     */
    harnessPin?: string;
    terminationGraceMs?: number;
  },
): SpawnedAutomationRun {
  const detached = process.platform !== "win32";
  let child: ChildProcess | null = null;
  let terminating = false;
  let exitResult: boolean | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let hintDir: string | undefined;
  let outcomeHint: RunOutcomeHint | undefined;
  const outcomeDir = mkdtempSync(join(tmpdir(), "devintern-run-outcome-"));
  const outcomePath = join(outcomeDir, "outcome.json");
  let settle!: (ok: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    settle = (ok) => {
      if (ok) outcomeHint = readRunOutcomeHint(outcomePath);
      rmSync(outcomeDir, { recursive: true, force: true });
      resolve(ok);
    };
  });
  const cleanupHint = () => {
    if (!hintDir) return;
    rmSync(hintDir, { recursive: true, force: true });
    hintDir = undefined;
  };
  const kill = (signal: NodeJS.Signals) => {
    if (child?.pid && detached) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall through to the direct child.
      }
    }
    try {
      child?.kill(signal);
    } catch {
      // The child may already have exited.
    }
  };
  const processGroupAlive = () => {
    if (!child?.pid || !detached) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const beginTermination = () => {
    if (terminating || exitResult !== undefined) return;
    terminating = true;
    kill("SIGTERM");
    terminationTimer = setTimeout(() => {
      kill("SIGKILL");
      cleanupHint();
      settle(false);
    }, options.terminationGraceMs ?? TERMINATION_GRACE_MS);
  };

  const start = (env: Record<string, string | undefined>): void => {
    // A failover re-spawn must not inherit the previous attempt's status.
    rmSync(outcomePath, { force: true });
    const spawned = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...env, [RUN_OUTCOME_FILE_ENV]: outcomePath },
      stdio: "inherit",
      detached,
    });
    child = spawned;
    spawned.once("close", (code) => {
      if (terminating) {
        if (!processGroupAlive()) {
          if (terminationTimer) clearTimeout(terminationTimer);
          cleanupHint();
          settle(false);
        }
        return;
      }
      if (code === USAGE_LIMIT_EXIT_CODE || code === HARNESS_UNAVAILABLE_EXIT_CODE) {
        const failover = getWorkerFailover();
        if (options.harnessPin && failover && code === USAGE_LIMIT_EXIT_CODE) {
          // Record the pinned harness's window so the scheduler and "Run
          // now" stop launching runs into the same limit.
          failover.recordLimit(options.harnessPin, readUsageLimitHint(env[USAGE_LIMIT_FILE_ENV]));
        }
        // A harness pinned by the entry opts out of workspace failover, so an
        // explicit selection never silently runs a different agent.
        if (!options.harnessPin && failover) {
          const outcome =
            code === USAGE_LIMIT_EXIT_CODE
              ? failover.reportFromHint(
                  readUsageLimitHint(env[USAGE_LIMIT_FILE_ENV]),
                  env.AGENT_HARNESS ?? failover.activeName,
                )
              : failover.reportStartFailure(env.AGENT_HARNESS ?? failover.activeName);
          if (outcome.kind !== "exhausted") {
            cleanupHint();
            const nextEnv = pinAutomationEnv(options.env, options.harnessPin);
            hintDir = nextEnv.hintDir;
            start(nextEnv.env);
            return;
          }
        }
        exitResult = false;
        cleanupHint();
        settle(false);
        return;
      }
      exitResult = code === 0;
      if (exitResult) getWorkerFailover()?.recordSuccess(env.AGENT_HARNESS);
      cleanupHint();
      settle(exitResult);
    });
    spawned.once("error", () => {
      exitResult = false;
      if (terminationTimer) clearTimeout(terminationTimer);
      cleanupHint();
      settle(false);
    });
  };

  const initial = pinAutomationEnv(options.env, options.harnessPin);
  hintDir = initial.hintDir;
  start(initial.env);

  return {
    completion,
    terminate: beginTermination,
    outcome: () => outcomeHint,
  };
}

function pinAutomationEnv(
  base: Record<string, string | undefined>,
  harnessPin?: string,
): {
  env: Record<string, string | undefined>;
  hintDir?: string;
} {
  const failover = getWorkerFailover();
  if (!failover) {
    return { env: harnessPin ? pinnedHarnessChildEnv(base, harnessPin) : base };
  }
  const hintDir = mkdtempSync(join(tmpdir(), "devintern-usage-limit-"));
  const hintPath = join(hintDir, "hint.json");
  // A pinned entry keeps the agent it named (no failover overlay); its
  // usage-limit exit is recorded but never re-spawned on another harness.
  const env = harnessPin
    ? pinnedChildEnvWithHint(base, harnessPin, hintPath)
    : failover.childEnv(base, hintPath);
  return { env, hintDir };
}
