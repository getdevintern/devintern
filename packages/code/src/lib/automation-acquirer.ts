import { randomUUID } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import { resolveConfigDir } from "@devintern/utils";

import type { Acquirer } from "../worker";
import type { AutomationConfig } from "./automation-config";
import { nextScheduleOccurrence } from "./automation-config";
import { AutomationStateStore } from "./automation-state";
import { workerTaskArgs } from "./task-polling-acquirer";
import { RUN_ORIGIN_ENV } from "./analytics";
import { getWorkerFailover } from "./worker-failover";
import {
  readUsageLimitHint,
  USAGE_LIMIT_EXIT_CODE,
  USAGE_LIMIT_FILE_ENV,
} from "./usage-limit-protocol";

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
   * Explicit directory for occurrence task files. When omitted, files go
   * under the nearest `.devintern-code` found above {@linkcode cwd}.
   */
  taskFileDir?: string;
  release(): void | Promise<void>;
}

export interface SpawnedAutomationRun {
  completion: Promise<boolean>;
  terminate(): void;
}

/** Result of a dashboard "Run now" trigger for one automation. */
export type ManualTriggerOutcome = { ok: true } | { ok: false; reason: string };

/** One configured schedule as exposed to the dashboard. */
export interface AutomationScheduleStatus {
  id: string;
  enabled: boolean;
  cron?: string;
  interval?: string;
  repo?: string;
  prompt: string;
  /** Durable next occurrence (epoch ms); absent before first registration. */
  nextDueAt?: number;
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
}

interface ActiveAutomationRun {
  run: SpawnedAutomationRun;
  lifecycle: Promise<void>;
}

/** Calculate the first future occurrence after `afterMs` (cron uses host timezone). */
export function nextAutomationDue(automation: AutomationConfig, afterMs: number): number {
  if (!automation.intervalMs && !automation.cron) {
    throw new Error(`Automation "${automation.id}" has no schedule`);
  }
  return nextScheduleOccurrence(automation, afterMs);
}

/** One-timer scheduler with durable UTC cursors and per-automation leases. */
export class AutomationAcquirer implements Acquirer {
  readonly name: string;
  private options: AutomationAcquirerOptions;
  private store: AutomationStateStore;
  private owner = `${process.pid}:${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = new Map<string, ActiveAutomationRun>();
  private tickPromise: Promise<void> | null = null;
  private stopped = true;

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
      if (state.nextDueAt > this.now()) continue;

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
        try {
          context = await this.options.resolveContext(automation);
        } finally {
          clearHeartbeatInterval(preparationHeartbeat);
        }
        if (!context) {
          console.warn(
            `⏭️  [${kind}:${automation.id}] occurrence skipped: ${this.busySkipReason()}`,
          );
          this.store.release(stateId, this.owner);
          continue;
        }
        if (this.stopped) {
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
        const extraArgs = this.options.extraArgs;
        const args =
          typeof extraArgs === "function" ? extraArgs() : (extraArgs ?? workerTaskArgs());
        const run = this.options.spawnRun
          ? this.options.spawnRun(automation, context)
          : defaultSpawnRun(
              automation,
              context,
              args,
              "scheduled",
              this.options.terminationGraceMs,
            );
        this.trackActiveRun(automation, stateId, context, run);
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
  ): void {
    const kind = this.jobKind();
    const active: ActiveAutomationRun = {
      run,
      lifecycle: Promise.resolve(),
    };
    active.lifecycle = run.completion
      .then((ok) =>
        console.log(
          ok
            ? `✅ [${kind}:${automation.id}] completed`
            : `⚠️  [${kind}:${automation.id}] did not complete cleanly`,
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
    if (this.active.has(automationId)) {
      return { ok: false, reason: `automation "${automationId}" is already running` };
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
    try {
      context = await this.options.resolveContext(automation);
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    } finally {
      clearHeartbeatInterval(preparationHeartbeat);
      if (context === null) {
        // Declined (busy repo) or rejected — give the lease back so the
        // scheduler can proceed with the next occurrence.
        this.store.release(stateId, this.owner);
      }
    }
    if (!context) {
      return {
        ok: false,
        reason: `the repository for "${automationId}" is busy with another run; try again shortly`,
      };
    }
    if (this.stopped) {
      this.store.release(stateId, this.owner);
      await context.release();
      return { ok: false, reason: "the worker is shutting down; try again after it restarts" };
    }
    if (!this.store.heartbeat(stateId, this.owner, this.now(), leaseMs)) {
      await context.release();
      return { ok: false, reason: `the run slot for "${automationId}" was lost; try again` };
    }

    console.log(`\n⏰ [${this.jobKind()}:${automationId}] starting manual run (dashboard)`);
    const extraArgs = this.options.extraArgs;
    const args = typeof extraArgs === "function" ? extraArgs() : (extraArgs ?? workerTaskArgs());
    let run: SpawnedAutomationRun;
    try {
      run = this.options.spawnManualRun
        ? this.options.spawnManualRun(automation, context)
        : spawnManualAutomationRun(automation, context, args, this.options.terminationGraceMs);
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
    this.trackActiveRun(automation, stateId, context, run);
    return { ok: true };
  }

  /** Dashboard catalog: every configured schedule with its durable next-due state. */
  listSchedules(): AutomationScheduleStatus[] {
    return this.options.automations.map((automation) => {
      const state = this.store.get(this.stateId(automation));
      return {
        id: automation.id,
        enabled: automation.enabled,
        cron: automation.cron,
        interval: automation.interval,
        repo: automation.repo,
        prompt: automation.prompt,
        nextDueAt: state?.nextDueAt,
      };
    });
  }

  private jobKind(): string {
    return this.options.jobKind ?? "automation";
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
      .filter((item) => item.enabled)
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
 * Directory that receives one markdown task file per occurrence.
 *
 * When the context does not pin an explicit directory, resolved like every
 * other durable-state location: the nearest existing `.devintern-code` found
 * by walking up from the run cwd, so a worker launched from a subfolder
 * reuses the project's config directory instead of creating a stray one
 * beside the cwd. Falls back to `<cwd>/.devintern-code` (e.g. inside
 * disposable worktrees where no parent config exists).
 */
export function automationTaskDir(context: AutomationRunContext): string {
  return (
    context.taskFileDir ??
    join(
      resolveConfigDir({ configDirName: ".devintern-code", startDir: context.cwd }),
      "automations",
    )
  );
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
    ...base,
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
    terminationGraceMs?: number;
  },
): SpawnedAutomationRun {
  const detached = process.platform !== "win32";
  let child: ChildProcess | null = null;
  let terminating = false;
  let exitResult: boolean | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let hintDir: string | undefined;
  let settle!: (ok: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    settle = resolve;
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
    const spawned = spawn(executable, args, {
      cwd: options.cwd,
      env,
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
      if (code === USAGE_LIMIT_EXIT_CODE) {
        const failover = getWorkerFailover();
        if (failover && !failover.allLimited()) {
          const outcome = failover.reportFromHint(readUsageLimitHint(env[USAGE_LIMIT_FILE_ENV]));
          if (outcome.kind !== "exhausted") {
            cleanupHint();
            const nextEnv = pinAutomationEnv(options.env);
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

  const initial = pinAutomationEnv(options.env);
  hintDir = initial.hintDir;
  start(initial.env);

  return {
    completion,
    terminate: beginTermination,
  };
}

function pinAutomationEnv(base: Record<string, string | undefined>): {
  env: Record<string, string | undefined>;
  hintDir?: string;
} {
  const failover = getWorkerFailover();
  if (!failover) {
    return { env: base };
  }
  const hintDir = mkdtempSync(join(tmpdir(), "devintern-usage-limit-"));
  return { env: failover.childEnv(base, join(hintDir, "hint.json")), hintDir };
}
