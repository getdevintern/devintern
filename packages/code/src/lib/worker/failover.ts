/**
 * Shared harness failover for every long-running worker surface.
 *
 * Webhook serve, fleet polling, PR mentions, review addressing, conflict
 * resolution, scheduled automations, and estimations all share one
 * {@link HarnessFailover} instance so a usage limit on Codex fails over to
 * Grok (etc.) instead of only working inside `devintern webhook serve`.
 *
 * CLI subprocesses are pinned to the active harness via `AGENT_HARNESS` and
 * signal a limit with {@link USAGE_LIMIT_EXIT_CODE} or a startup failure with
 * {@link HARNESS_UNAVAILABLE_EXIT_CODE}; this module retries the same spawn on
 * the next chain entry, or reports `deferred` when the chain is exhausted.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  resetHarnessSandboxProbeCache,
  resetHintToMs,
  resolveHarnessChain,
  resolveHarnessChainSync,
} from "@devintern/agent-harness";
import type {
  HarnessChainEntry,
  HarnessSandboxProbeResult,
  ResolvedHarness,
  ResolvedHarnessChain,
} from "@devintern/agent-harness";

import { HarnessFailover } from "../agent/harness-failover";
import type { FailoverOutcome } from "../agent/harness-failover";
import { HARNESS_CHAIN_ENV, resolveAgentModel } from "../agent/model";
import type { WebhookQueue } from "../state/webhook-queue";
import {
  AUTOMATION_ACCESS_EXIT_CODE,
  HARNESS_UNAVAILABLE_EXIT_CODE,
  RATE_LIMIT_FALLBACK_MS,
  readUsageLimitHint,
  TASK_SKIP_EXIT_CODE,
  USAGE_LIMIT_EXIT_CODE,
  USAGE_LIMIT_FILE_ENV,
  WORKER_CHILD_ENV,
} from "./usage-limit-protocol";
import type { UsageLimitHint } from "./usage-limit-protocol";

export type CliFailoverResult = "ok" | "failed" | "deferred" | "skipped";

/**
 * How long a harness that could not start is skipped for this process. Short
 * enough that a fixed path is retried without restarting the worker.
 */
export const HARNESS_UNAVAILABLE_COOLDOWN_MS = 60_000;

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
  /** Pre-resolved chain (tests/async startup); otherwise resolved internally. */
  chain?: ResolvedHarnessChain;
  /** Sandbox readiness probe override (tests). */
  probeSandbox?: (entry: {
    name: string;
    path: string;
  }) => HarnessSandboxProbeResult | Promise<HarnessSandboxProbeResult>;
  /** Effective sandbox name override (tests). Defaults to `AGENT_SANDBOX`. */
  sandboxName?: string;
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
    this.chain =
      options.chain ??
      resolveHarnessChainSync({
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
      try {
        // Read the two pieces of persisted state separately so a corrupt
        // active-harness row does not discard the already-parsed healthy
        // rate-limit windows (that read is deliberately per-row tolerant).
        const limits = queue.getAllRateLimits();
        let active: string | null = null;
        try {
          active = queue.getActiveHarness();
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(
            `⚠️  Could not restore persisted active harness, using priority default: ${detail}`,
          );
        }
        for (const warning of this.manager.restore(limits, active)) {
          console.warn(`⚠️  ${warning}`);
        }
      } catch (error) {
        // Corrupt persisted state must never block worker startup; fall back to
        // the primary harness with no restored windows.
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️  Could not restore persisted failover state, starting fresh: ${detail}`);
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
   * entry so one-shot resolution uses that harness, keep the configured chain
   * so model resolution can tell a fallback from the primary, and point at a
   * hint file.
   */
  childEnv(
    base: Record<string, string | undefined>,
    hintPath: string,
  ): Record<string, string | undefined> {
    return {
      ...base,
      AGENT_HARNESS: this.manager.activeName,
      [HARNESS_CHAIN_ENV]: this.chain.parsed.join(","),
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
        // Falling back may select a harness whose sandbox readiness changed
        // (binary updated/reconfigured); re-probe it on the next readiness
        // resolution instead of trusting the cached failure.
        resetHarnessSandboxProbeCache();
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
    if (this.chain.multiHarness) {
      // Model ids are harness-specific; show what each entry will actually run
      // so a fallback configured with no model is obvious at startup.
      const models = this.chain.entries
        .map(
          (entry) =>
            `${entry.name}: ${resolveAgentModel(entry.name, this.chain.parsed) ?? "default"}`,
        )
        .join(" | ");
      this.log(`   Models: ${models}`);
    }
  }
}

let instance: WorkerFailover | null = null;

/**
 * Initialize process-wide failover. Replaces any previous instance (tests).
 *
 * @param options - Persistence, pause/resume hooks, and installability
 */
export async function startWorkerFailover(
  options: WorkerFailoverOptions = {},
): Promise<WorkerFailover> {
  instance?.stop();
  // A fresh start is a configuration reload: drop cached sandbox readiness so
  // a fixed <HARNESS>_CLI_PATH is probed again.
  resetHarnessSandboxProbeCache();
  const chain =
    options.chain ??
    (await resolveHarnessChain({
      checkInstalled: options.checkInstalled ?? true,
      raw: options.raw,
      ...(options.sandboxName !== undefined ? { sandboxName: options.sandboxName } : {}),
      ...(options.probeSandbox ? { probeSandbox: options.probeSandbox } : {}),
    }));
  instance = new WorkerFailover({ ...options, chain });
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
 * Run a CLI child, retrying on usage-limit exit 75 or harness-startup exit 78
 * until the chain is exhausted. A retry-gate skip
 * ({@link TASK_SKIP_EXIT_CODE}) is reported as `"skipped"` immediately:
 * another harness would make the same decision. When failover has not been
 * started, the spawn runs once with the caller's env (one-shot / tests).
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
    if (code === AUTOMATION_ACCESS_EXIT_CODE) return "deferred";
    if (code === HARNESS_UNAVAILABLE_EXIT_CODE) return "deferred";
    if (code === TASK_SKIP_EXIT_CODE) return "skipped";
    return code === 0 ? "ok" : "failed";
  }

  const attempts = Math.max(1, failover.chain.entries.length);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (failover.allLimited() || failover.manager.allUnavailable()) {
      return "deferred";
    }
    // A cooldown may have expired on a higher-priority entry while we were
    // parked on a fallback; make sure this attempt uses a usable entry.
    failover.manager.ensureAvailableActive();
    const hintDir = mkdtempSync(join(tmpdir(), "devintern-usage-limit-"));
    const hintPath = join(hintDir, "hint.json");
    try {
      const code = await spawnOnce(failover.childEnv(baseEnv, hintPath));
      if (code === AUTOMATION_ACCESS_EXIT_CODE) return "deferred";
      if (code === TASK_SKIP_EXIT_CODE) return "skipped";
      if (code === HARNESS_UNAVAILABLE_EXIT_CODE) {
        // The child never started: skip this entry for the process and try
        // the next one without recording a usage-limit window.
        const outcome = failover.manager.reportHarnessUnavailable(
          Date.now() + HARNESS_UNAVAILABLE_COOLDOWN_MS,
        );
        if (outcome.kind === "exhausted") {
          return "deferred";
        }
        continue;
      }
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

/**
 * Map {@link runWithFailover} onto the poller's `TaskExecutionResult`
 * (`boolean | "deferred" | "skipped"`). The union is spelled out here rather
 * than imported so this module stays free of an import cycle with the acquirer.
 */
export function cliResultToTaskResult(result: CliFailoverResult): boolean | "deferred" | "skipped" {
  if (result === "ok") {
    return true;
  }
  if (result === "deferred") {
    return "deferred";
  }
  if (result === "skipped") {
    return "skipped";
  }
  return false;
}
