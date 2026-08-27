import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { join } from "path";

import { CronExpressionParser } from "cron-parser";
import { resolveConfigDir } from "@devintern/utils";

import type { Acquirer } from "../worker";
import type { AutomationConfig } from "./automation-config";
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
  /** Per-task CLI flags; defaults to `--create-pr`. */
  extraArgs?: string[];
  resolveContext: (automation: AutomationConfig) => Promise<AutomationRunContext | null>;
  now?: () => number;
  spawnRun?: (automation: AutomationConfig, context: AutomationRunContext) => SpawnedAutomationRun;
  /**
   * Override the default preset execution (in-process preset `run`). Tests
   * inject fakes; production uses the registry-defined runner.
   */
  presetRunner?: (
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
        const setHeartbeatInterval = this.options.setInterval ?? setInterval;
        const clearHeartbeatInterval = this.options.clearInterval ?? clearInterval;
        const preparationHeartbeat = setHeartbeatInterval(
          () => {
            if (!this.store.heartbeat(automation.id, this.owner, this.now(), leaseMs)) {
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
        console.log(`\n⏰ [automation:${automation.id}] starting scheduled run`);
        const run = this.options.spawnRun
          ? this.options.spawnRun(automation, context)
          : automation.preset
            ? (this.options.presetRunner ?? makeDefaultPresetSpawnRun(this.options.dbPath))(
                automation,
                context,
              )
            : defaultSpawnRun(
                automation,
                context,
                this.options.extraArgs ?? workerTaskArgs(),
                this.options.terminationGraceMs,
              );
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
    (automation.prompt ?? "").trim(),
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
 * Execute a preset automation in-process through its registry definition.
 *
 * Preset runs bypass the markdown-task pipeline: the definition owns prompt
 * construction, validation, side effects, and checkpointing, while this
 * acquirer still owns scheduling, leasing, overlap protection, and run
 * attribution. `terminate()` cooperatively aborts via signal — the runner
 * checks it between phases instead of killing a possibly mid-publication
 * process tree.
 */
export function makeDefaultPresetSpawnRun(
  dbPath: string,
): (automation: AutomationConfig, context: AutomationRunContext) => SpawnedAutomationRun {
  return (automation, context) => {
    const controller = new AbortController();
    const completion = (async (): Promise<boolean> => {
      const { getPreset } = await import("./automations/presets");
      const definition = getPreset(automation.preset ?? "");
      if (!definition) {
        console.error(
          `❌ [automation:${automation.id}] unknown preset "${automation.preset}"; skipping run`,
        );
        return false;
      }
      const resolved = {
        name: definition.name,
        version: definition.version,
        outputMode: automation.outputMode ?? definition.defaultOutputMode,
        options: {
          ...(automation.docPaths ? { docPaths: automation.docPaths } : {}),
          ...(automation.baselineSha ? { baselineSha: automation.baselineSha } : {}),
        },
      };
      const errors: string[] = [];
      definition.checkPrerequisites?.({
        cwd: context.cwd,
        trackerType: (process.env.TASK_TRACKER || "jira").toLowerCase(),
        resolved,
        error: (message) => errors.push(message),
      });
      if (errors.length > 0) {
        console.error(
          `❌ [automation:${automation.id}] preset prerequisites not met:\n- ${errors.join("\n- ")}`,
        );
        return false;
      }
      if (!definition.run) {
        console.error(`❌ [automation:${automation.id}] preset "${definition.name}" has no runner`);
        return false;
      }
      return definition.run({
        automationId: automation.id,
        resolved,
        cwd: context.cwd,
        repoName: context.repo,
        dbPath,
        signal: controller.signal,
      });
    })();
    return {
      completion,
      terminate: () => controller.abort(),
    };
  };
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
