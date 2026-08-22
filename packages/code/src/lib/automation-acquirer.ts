import { randomUUID } from "crypto";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

import { CronExpressionParser } from "cron-parser";

import type { Acquirer } from "../worker";
import type { AutomationConfig } from "./automation-config";
import { AutomationStateStore } from "./automation-state";

const LEASE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
const TERMINATION_GRACE_MS = 5_000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AutomationRunContext {
  cwd: string;
  env: Record<string, string | undefined>;
  repo?: string;
  release(): void | Promise<void>;
}

export interface SpawnedAutomationRun {
  completion: Promise<boolean>;
  terminate(): void;
}

export interface AutomationAcquirerOptions {
  automations: AutomationConfig[];
  dbPath: string;
  resolveContext: (automation: AutomationConfig) => Promise<AutomationRunContext | null>;
  now?: () => number;
  spawnRun?: (automation: AutomationConfig, context: AutomationRunContext) => SpawnedAutomationRun;
  leaseMs?: number;
  heartbeatMs?: number;
  terminationGraceMs?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface ActiveAutomationRun {
  run: SpawnedAutomationRun;
  lifecycle: Promise<void>;
}

/** Calculate the first future occurrence after `afterMs` (cron uses host timezone). */
export function nextAutomationDue(automation: AutomationConfig, afterMs: number): number {
  if (automation.intervalMs) return afterMs + automation.intervalMs;
  if (!automation.cron) throw new Error(`Automation "${automation.id}" has no schedule`);
  return CronExpressionParser.parse(automation.cron, { currentDate: new Date(afterMs) })
    .next()
    .getTime();
}

/** One-timer scheduler with durable UTC cursors and per-automation leases. */
export class AutomationAcquirer implements Acquirer {
  readonly name = "scheduled-automations";
  private options: AutomationAcquirerOptions;
  private store: AutomationStateStore;
  private owner = `${process.pid}:${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = new Map<string, ActiveAutomationRun>();
  private tickPromise: Promise<void> | null = null;
  private stopped = true;

  constructor(options: AutomationAcquirerOptions) {
    this.options = options;
    this.store = new AutomationStateStore(options.dbPath);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const now = this.now();
    for (const automation of this.options.automations.filter((item) => item.enabled)) {
      this.store.register(automation, nextAutomationDue(automation, now));
    }
    console.log(
      `⏰ Scheduling ${this.options.automations.filter((item) => item.enabled).length} enabled automation(s)`,
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

  private async runTick(): Promise<void> {
    const leaseMs = this.options.leaseMs ?? LEASE_MS;
    for (const automation of this.options.automations.filter((item) => item.enabled)) {
      let state = this.store.get(automation.id);
      if (!state) continue;

      if (this.active.has(automation.id)) {
        const active = this.active.get(automation.id) as ActiveAutomationRun;
        if (!this.store.heartbeat(automation.id, this.owner, this.now(), leaseMs)) {
          console.warn(`⏭️  [automation:${automation.id}] terminating: lease was lost`);
          active.run.terminate();
          await active.lifecycle;
        }
        state = this.store.get(automation.id);
        if (!state) continue;
      }
      if (state.nextDueAt > this.now()) continue;

      const overlapNow = this.now();
      if (state.leaseOwner && (state.leaseExpiresAt ?? 0) > overlapNow) {
        const skipNow = this.now();
        const nextDue = nextAutomationDue(automation, skipNow);
        if (this.store.skipOverlap(automation.id, skipNow, nextDue)) {
          console.warn(
            `⏭️  [automation:${automation.id}] occurrence skipped: previous run is active`,
          );
        }
        continue;
      }
      const claimNow = this.now();
      const nextDue = nextAutomationDue(automation, claimNow);
      if (!this.store.claim(automation.id, this.owner, claimNow, nextDue, leaseMs)) continue;

      let context: AutomationRunContext | null = null;
      try {
        let ownsClaim = true;
        const heartbeatMs = Math.min(this.options.heartbeatMs ?? HEARTBEAT_MS, leaseMs / 2);
        const preparationHeartbeat = setInterval(
          () => {
            if (!this.store.heartbeat(automation.id, this.owner, this.now(), leaseMs)) {
              ownsClaim = false;
            }
          },
          Math.max(1, heartbeatMs),
        );
        preparationHeartbeat.unref();
        try {
          context = await this.options.resolveContext(automation);
        } finally {
          clearInterval(preparationHeartbeat);
        }
        if (!context) {
          console.warn(`⏭️  [automation:${automation.id}] occurrence skipped: repository is busy`);
          this.store.release(automation.id, this.owner);
          continue;
        }
        if (this.stopped) {
          this.store.release(automation.id, this.owner);
          await context.release();
          continue;
        }
        ownsClaim &&= this.store.heartbeat(automation.id, this.owner, this.now(), leaseMs);
        if (!ownsClaim) {
          console.warn(`⏭️  [automation:${automation.id}] occurrence skipped: lease was lost`);
          await context.release();
          continue;
        }
        console.log(`\n⏰ [automation:${automation.id}] starting ${automation.action}`);
        const run = this.options.spawnRun
          ? this.options.spawnRun(automation, context)
          : defaultSpawnRun(automation, context, this.options.terminationGraceMs);
        const active: ActiveAutomationRun = {
          run,
          lifecycle: Promise.resolve(),
        };
        active.lifecycle = run.completion
          .then((ok) =>
            console.log(
              ok
                ? `✅ [automation:${automation.id}] completed`
                : `⚠️  [automation:${automation.id}] did not complete cleanly`,
            ),
          )
          .catch((error) =>
            console.error(`❌ [automation:${automation.id}] ${(error as Error).message}`),
          )
          .finally(async () => {
            try {
              this.store.release(automation.id, this.owner);
              await context?.release();
            } finally {
              if (this.active.get(automation.id) === active) this.active.delete(automation.id);
              this.scheduleNext();
            }
          });
        this.active.set(automation.id, active);
      } catch (error) {
        this.store.release(automation.id, this.owner);
        await context?.release();
        console.error(`❌ [automation:${automation.id}] ${(error as Error).message}`);
      }
    }
    this.scheduleNext();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    const now = this.now();
    const dueTimes = this.options.automations
      .filter((item) => item.enabled)
      .map((item) => this.store.get(item.id)?.nextDueAt)
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

export interface AutomationInvocationPayload {
  id: string;
  action: AutomationConfig["action"];
  prompt: string;
  trackerProject?: string;
  repo?: string;
}

/** Build the internal invocation without exposing automation contents in argv. */
export function automationInvocation(
  automation: AutomationConfig,
  context: AutomationRunContext,
): { args: string[]; payload: string } {
  return {
    args: [process.argv[1] as string, "__automation-run"],
    payload: JSON.stringify({
      id: automation.id,
      action: automation.action,
      prompt: automation.prompt,
      trackerProject: automation.trackerProject,
      repo: context.repo,
    } satisfies AutomationInvocationPayload),
  };
}

function defaultSpawnRun(
  automation: AutomationConfig,
  context: AutomationRunContext,
  terminationGraceMs?: number,
): SpawnedAutomationRun {
  const { args, payload } = automationInvocation(automation, context);
  return spawnAutomationProcess(process.execPath, args, payload, {
    cwd: context.cwd,
    env: context.env,
    terminationGraceMs,
  });
}

/** Spawn one isolated automation subprocess and terminate its process tree within a bound. */
export function spawnAutomationProcess(
  executable: string,
  args: string[],
  payload: string,
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
    stdio: ["pipe", "inherit", "inherit"],
    detached,
  });
  let inputFailed = false;
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
    exitResult = code === 0 && !inputFailed;
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
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    const postExitPipe =
      error.code === "EPIPE" && (child.exitCode !== null || child.signalCode !== null);
    if (!postExitPipe) {
      inputFailed = true;
      beginTermination();
    }
  });
  child.stdin?.end(payload);

  return {
    completion,
    terminate: beginTermination,
  };
}
