/**
 * Shared harness failover for every long-running worker surface.
 *
 * Webhook serve, fleet polling, PR mentions, review addressing, conflict
 * resolution, scheduled automations, and estimations all share one
 * {@link HarnessFailover} instance so a usage limit on Codex fails over to
 * Grok (etc.) instead of only working inside `devintern webhook serve`.
 *
 * CLI subprocesses are pinned to the active harness via `AGENT_HARNESS` and
 * signal a limit with {@link USAGE_LIMIT_EXIT_CODE}; this module retries the
 * same spawn on the next chain entry, or reports `deferred` when the chain
 * is exhausted.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resetHintToMs, resolveHarnessChain } from "@devintern/agent-harness";
import type {
  HarnessChainEntry,
  ResolvedHarness,
  ResolvedHarnessChain,
} from "@devintern/agent-harness";

import { HarnessFailover } from "./harness-failover";
import type { FailoverOutcome } from "./harness-failover";
import type { WebhookQueue } from "./webhook-queue";
import {
  RATE_LIMIT_FALLBACK_MS,
  readUsageLimitHint,
  USAGE_LIMIT_EXIT_CODE,
  USAGE_LIMIT_FILE_ENV,
  WORKER_CHILD_ENV,
} from "./usage-limit-protocol";
import type { UsageLimitHint } from "./usage-limit-protocol";

export type CliFailoverResult = "ok" | "failed" | "deferred";

export interface WorkerFailoverOptions {
  /** Queue used to persist windows and the active harness across restarts. */
  queue?: WebhookQueue | null;
  /**
   * Probe installability at startup (default true). Tests that do not want
   * PATH checks pass false, matching webhook-server's lazy fallback.
   */
  checkInstalled?: boolean;
  /** Override `AGENT_HARNESS` (tests). */
  raw?: string;
  /** Called when every chain entry is limited (pause new agent work). */
  onPause?: (info: { untilMs: number; harness: string; resetHint?: string }) => void;
  /** Called when a window elapses and at least one harness is available. */
  onResume?: () => void;
  log?: (message: string) => void;
}

/**
 * In-process failover controller: chain resolution, persistence, failback
 * timers, and child-env pinning.
 */
export class WorkerFailover {
  readonly chain: ResolvedHarnessChain;
  readonly manager: HarnessFailover;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private readonly onPause?: WorkerFailoverOptions["onPause"];
  private readonly onResume?: WorkerFailoverOptions["onResume"];
  private readonly log: (message: string) => void;

  constructor(options: WorkerFailoverOptions = {}) {
    this.chain = resolveHarnessChain({
      checkInstalled: options.checkInstalled ?? true,
      raw: options.raw,
    });
    this.onPause = options.onPause;
    this.onResume = options.onResume;
    this.log = options.log ?? ((message) => console.log(message));

    const queue = options.queue;
    this.manager = new HarnessFailover({
      entries: this.chain.entries,
      persistLimit: queue ? (harness, untilMs) => queue.setRateLimit(harness, untilMs) : undefined,
      clearPersistedLimit: queue ? (harness) => queue.clearRateLimit(harness) : undefined,
      persistActive: queue ? (harness) => queue.setActiveHarness(harness) : undefined,
      log: this.log,
    });

    if (queue) {
      for (const warning of this.manager.restore(
        queue.getAllRateLimits(),
        queue.getActiveHarness(),
      )) {
        console.warn(`⚠️  ${warning}`);
      }
    }
  }

  /** Canonical name of the active harness. */
  get activeName(): string {
    return this.manager.activeName;
  }

  /** Active chain entry. */
  get active(): HarnessChainEntry {
    return this.manager.active;
  }

  /** Resolved harness + path for in-process spawns (webhook serve). */
  resolvedHarness(): ResolvedHarness {
    return { harness: this.active.harness, path: this.active.path };
  }

  describeChain(): string {
    return this.manager.describeChain();
  }

  windows(): Record<string, number> {
    return this.manager.windows();
  }

  allLimited(): boolean {
    return this.manager.allLimited();
  }

  /** Startup banner line (`Agent harness: a → b (failover enabled)`). */
  describeStartup(): string {
    return `Agent harness: ${this.manager.describeChain()}${
      this.chain.multiHarness ? " (failover enabled)" : ""
    }`;
  }

  /**
   * Environment overlay for a CLI child: pin `AGENT_HARNESS` to the active
   * entry so one-shot resolution uses that harness, and point at a hint file.
   */
  childEnv(
    base: Record<string, string | undefined>,
    hintPath: string,
  ): Record<string, string | undefined> {
    return {
      ...base,
      AGENT_HARNESS: this.manager.activeName,
      [WORKER_CHILD_ENV]: "1",
      [USAGE_LIMIT_FILE_ENV]: hintPath,
    };
  }

  /**
   * Record a usage limit and fail over. Pauses via {@link onPause} when the
   * chain is exhausted; always rearms the failback timer.
   */
  reportFromHint(hint?: Partial<UsageLimitHint> & { resetsAt?: string }): FailoverOutcome {
    const until =
      hint?.untilMs && hint.untilMs > Date.now()
        ? hint.untilMs
        : (resetHintToMs(hint?.resetsAt, Date.now()) ?? Date.now() + RATE_LIMIT_FALLBACK_MS);
    const harness = this.manager.activeName;
    const outcome = this.manager.reportUsageLimit(until);
    if (outcome.kind === "exhausted") {
      this.paused = true;
      this.onPause?.({ untilMs: outcome.untilMs, harness, resetHint: hint?.resetsAt });
    }
    this.armTimers();
    return outcome;
  }

  /** Start (or restart) the failback/resume timer at the earliest window. */
  armTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const nextMs = this.manager.earliestResetMs();
    if (nextMs === null) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const nowMs = Date.now();
        for (const [harness, until] of Object.entries(this.manager.windows())) {
          if (until <= nowMs) {
            this.manager.windowElapsed(harness);
          }
        }
        if (this.paused && !this.manager.allLimited()) {
          this.paused = false;
          this.onResume?.();
        }
        this.armTimers();
      },
      Math.max(0, nextMs - Date.now()),
    );
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * After restoring persisted windows, pause immediately when every entry is
   * still limited instead of recording a fresh limit on the active harness.
   */
  pauseIfExhaustedOnRestore(): void {
    if (this.manager.allLimited()) {
      this.paused = true;
      const untilMs = this.manager.earliestResetMs() ?? Date.now();
      this.onPause?.({ untilMs, harness: this.manager.activeName });
    }
    this.armTimers();
  }

  /** Warn about dropped chain entries and log the effective chain. */
  announceStartup(): void {
    for (const issue of this.chain.issues) {
      console.warn(`⚠️  ${issue.message}`);
    }
    this.log(`   ${this.describeStartup()}`);
  }
}

let instance: WorkerFailover | null = null;

/**
 * Initialize process-wide failover. Replaces any previous instance (tests).
 *
 * @param options - Persistence, pause/resume hooks, and installability
 */
export function startWorkerFailover(options: WorkerFailoverOptions = {}): WorkerFailover {
  instance?.stop();
  instance = new WorkerFailover(options);
  instance.announceStartup();
  instance.pauseIfExhaustedOnRestore();
  return instance;
}

/** The process-wide controller, or null when failover has not been started. */
export function getWorkerFailover(): WorkerFailover | null {
  return instance;
}

/**
 * Lazy fallback for in-process callers (webhook-server tests) that spawn
 * before {@link startWorkerFailover}. Does not persist or probe PATH.
 */
export function ensureWorkerFailover(): WorkerFailover {
  if (instance) {
    return instance;
  }
  instance = new WorkerFailover({ checkInstalled: false });
  return instance;
}

/** Drop the process-wide controller (tests). */
export function resetWorkerFailover(): void {
  instance?.stop();
  instance = null;
}

/**
 * Run a CLI child, retrying on usage-limit exit 75 until the chain is
 * exhausted. When failover has not been started, the spawn runs once with
 * the caller's env (one-shot / tests).
 *
 * @param spawnOnce - Spawn the child with the given env; return its exit code
 * @param baseEnv - Environment to pin the active harness onto
 */
export async function runWithFailover(
  spawnOnce: (env: Record<string, string | undefined>) => Promise<number>,
  baseEnv: Record<string, string | undefined> = { ...process.env },
): Promise<CliFailoverResult> {
  const failover = getWorkerFailover();
  if (!failover) {
    const code = await spawnOnce(baseEnv);
    return code === 0 ? "ok" : "failed";
  }

  const attempts = Math.max(1, failover.chain.entries.length);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (failover.allLimited()) {
      return "deferred";
    }
    const hintDir = mkdtempSync(join(tmpdir(), "devintern-usage-limit-"));
    const hintPath = join(hintDir, "hint.json");
    try {
      const code = await spawnOnce(failover.childEnv(baseEnv, hintPath));
      if (code !== USAGE_LIMIT_EXIT_CODE) {
        return code === 0 ? "ok" : "failed";
      }
      const hint = readUsageLimitHint(hintPath);
      const outcome = failover.reportFromHint(hint);
      if (outcome.kind === "exhausted") {
        return "deferred";
      }
    } finally {
      rmSync(hintDir, { recursive: true, force: true });
    }
  }
  return "deferred";
}

/** Map {@link runWithFailover} onto the poller's `boolean | "deferred"` result. */
export function cliResultToTaskResult(result: CliFailoverResult): boolean | "deferred" {
  if (result === "ok") {
    return true;
  }
  if (result === "deferred") {
    return "deferred";
  }
  return false;
}
