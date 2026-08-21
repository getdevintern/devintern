import { randomUUID } from "crypto";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

import { CronExpressionParser } from "cron-parser";

import type { Acquirer } from "../worker";
import type { AutomationConfig } from "./automation-config";
import { AutomationStateStore } from "./automation-state";

const LEASE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;

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
  private active = new Map<string, SpawnedAutomationRun>();
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const run of this.active.values()) run.terminate();
    await Promise.allSettled([...this.active.values()].map((run) => run.completion));
    this.store.close();
  }

  /** Public for deterministic tests; production calls it through one setTimeout. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const leaseMs = this.options.leaseMs ?? LEASE_MS;
    for (const automation of this.options.automations.filter((item) => item.enabled)) {
      let state = this.store.get(automation.id);
      if (!state) continue;

      if (state.leaseOwner === this.owner && this.active.has(automation.id)) {
        this.store.heartbeat(automation.id, this.owner, now, leaseMs);
        state = this.store.get(automation.id);
        if (!state) continue;
      }
      if (state.nextDueAt > now) continue;

      const nextDue = nextAutomationDue(automation, now);
      if (state.leaseOwner && (state.leaseExpiresAt ?? 0) > now) {
        if (this.store.skipOverlap(automation.id, now, nextDue)) {
          console.warn(
            `⏭️  [automation:${automation.id}] occurrence skipped: previous run is active`,
          );
        }
        continue;
      }
      if (!this.store.claim(automation.id, this.owner, now, nextDue, leaseMs)) continue;

      let context: AutomationRunContext | null = null;
      try {
        context = await this.options.resolveContext(automation);
        if (!context) {
          console.warn(`⏭️  [automation:${automation.id}] occurrence skipped: repository is busy`);
          this.store.release(automation.id, this.owner);
          continue;
        }
        console.log(`\n⏰ [automation:${automation.id}] starting ${automation.action}`);
        const run = (this.options.spawnRun ?? defaultSpawnRun)(automation, context);
        this.active.set(automation.id, run);
        void run.completion
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
            this.active.delete(automation.id);
            this.store.release(automation.id, this.owner);
            await context?.release();
            this.scheduleNext();
          });
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
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    const dueTimes = this.options.automations
      .filter((item) => item.enabled)
      .map((item) => this.store.get(item.id)?.nextDueAt)
      .filter((value): value is number => value !== undefined);
    const heartbeatAt =
      this.active.size > 0 ? now + (this.options.heartbeatMs ?? HEARTBEAT_MS) : Infinity;
    const wakeAt = Math.min(heartbeatAt, ...dueTimes);
    if (!Number.isFinite(wakeAt)) return;
    this.timer = setTimeout(() => void this.tick(), Math.max(0, wakeAt - now));
  }
}

function defaultSpawnRun(
  automation: AutomationConfig,
  context: AutomationRunContext,
): SpawnedAutomationRun {
  const args = [
    process.argv[1] as string,
    "__automation-run",
    "--id",
    automation.id,
    "--action",
    automation.action,
    "--prompt",
    automation.prompt,
  ];
  if (automation.trackerProject) args.push("--tracker-project", automation.trackerProject);
  if (context.repo) args.push("--repo", context.repo);
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: context.cwd,
    env: context.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  return {
    completion: new Promise((resolve) => {
      child.once("close", (code) => resolve(code === 0));
      child.once("error", () => resolve(false));
    }),
    terminate() {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // Fall through to the direct child.
        }
      }
      child.kill("SIGTERM");
    },
  };
}
