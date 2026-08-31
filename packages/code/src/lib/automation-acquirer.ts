import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { join } from "path";

import { resolveConfigDir } from "@devintern/utils";

import type { Acquirer } from "../worker";
import type { AutomationConfig } from "./automation-config";
import { nextScheduleOccurrence } from "./automation-config";
import { AutomationStateStore } from "./automation-state";
import { workerTaskArgs } from "./task-polling-acquirer";
import { RUN_ORIGIN_ENV } from "./analytics";

/** Environment markers the task pipeline reads to attribute scheduled runs. */
export const AUTOMATION_ORIGIN_ENV = RUN_ORIGIN_ENV;
export const AUTOMATION_ID_ENV = "DEVINTERN_AUTOMATION_ID";

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
          : defaultSpawnRun(automation, context, args, this.options.terminationGraceMs);
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
          .catch((error) =>
            console.error(`❌ [${kind}:${automation.id}] ${(error as Error).message}`),
          )
          .finally(async () => {
            try {
              this.store.release(stateId, this.owner);
              await context?.release();
            } finally {
              if (this.active.get(automation.id) === active) this.active.delete(automation.id);
              this.scheduleNext();
            }
          });
        this.active.set(automation.id, active);
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

function defaultSpawnRun(
  automation: AutomationConfig,
  context: AutomationRunContext,
  extraArgs: string[],
  terminationGraceMs?: number,
): SpawnedAutomationRun {
  const taskFile = writeAutomationTaskFile(automation, context);
  const env: Record<string, string | undefined> = {
    ...context.env,
    [AUTOMATION_ORIGIN_ENV]: "scheduled",
    [AUTOMATION_ID_ENV]: automation.id,
  };
  return spawnAutomationProcess(
    process.execPath,
    [process.argv[1] as string, taskFile, ...extraArgs],
    {
      cwd: context.cwd,
      env,
      terminationGraceMs,
    },
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
  const child: ChildProcess = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    detached,
  });
  let terminating = false;
  let exitResult: boolean | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let settle!: (ok: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid && detached) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall through to the direct child.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
  };
  const processGroupAlive = () => {
    if (!child.pid || !detached) return false;
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
      settle(false);
    }, options.terminationGraceMs ?? TERMINATION_GRACE_MS);
  };

  child.once("close", (code) => {
    exitResult = code === 0;
    if (!terminating) settle(exitResult);
    else if (!processGroupAlive()) {
      if (terminationTimer) clearTimeout(terminationTimer);
      settle(false);
    }
  });
  child.once("error", () => {
    exitResult = false;
    if (terminationTimer) clearTimeout(terminationTimer);
    settle(false);
  });

  return {
    completion,
    terminate: beginTermination,
  };
}
