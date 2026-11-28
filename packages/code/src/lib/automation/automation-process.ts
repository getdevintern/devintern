/**
 * One automation subprocess (the CLI pipeline for a materialized task file):
 * harness pinning, workspace failover re-spawns, usage-limit deferrals, and
 * bounded process-tree termination.
 */

import { mkdtempSync, rmSync } from "fs";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import type { AutomationDeferral } from "./state";
import { pinnedHarnessChildEnv } from "../agent/selection";
import { readRunOutcomeHint, RUN_OUTCOME_FILE_ENV } from "../worker/run-outcome-protocol";
import type { RunOutcomeHint } from "../worker/run-outcome-protocol";
import {
  getWorkerFailover,
  harnessChainBlockedUntil,
  pinnedChildEnvWithHint,
} from "../worker/failover";
import type { WorkerFailover } from "../worker/failover";
import {
  HARNESS_UNAVAILABLE_EXIT_CODE,
  readUsageLimitHint,
  USAGE_LIMIT_EXIT_CODE,
  USAGE_LIMIT_FILE_ENV,
  usageLimitRetryAt,
} from "../worker/usage-limit-protocol";

const TERMINATION_GRACE_MS = 5_000;

export interface SpawnedAutomationRun {
  completion: Promise<boolean>;
  terminate(): void;
  /**
   * Terminal status the child recorded, read after a clean exit. A clean exit
   * can still be an escalated run (the agent reported its goal as blocked).
   */
  outcome?(): RunOutcomeHint | undefined;
  /**
   * Usage-limit deferral, read after the run settles: set when the child
   * exited on a usage limit (exit 75) and no other harness took over.
   */
  deferral?(): AutomationDeferral | undefined;
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
  let deferral: AutomationDeferral | undefined;
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
        let pinnedUntil: number | undefined;
        if (options.harnessPin && failover && code === USAGE_LIMIT_EXIT_CODE) {
          // Record the pinned harness's window so the scheduler and "Run
          // now" stop launching runs into the same limit.
          pinnedUntil = failover.recordLimit(
            options.harnessPin,
            readUsageLimitHint(env[USAGE_LIMIT_FILE_ENV]),
          );
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
        if (code === USAGE_LIMIT_EXIT_CODE) {
          deferral = usageLimitDeferral(env, options.harnessPin, failover, pinnedUntil);
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
    deferral: () => deferral,
  };
}

/**
 * Reset time and harness for a child that exited on a usage limit with no
 * harness left to take over: the pinned harness's recorded window, else the
 * chain's earliest reset, else the child's own hint.
 */
function usageLimitDeferral(
  env: Record<string, string | undefined>,
  harnessPin: string | undefined,
  failover: WorkerFailover | null,
  pinnedUntil: number | undefined,
): AutomationDeferral {
  const now = Date.now();
  const harness = harnessPin ?? env.AGENT_HARNESS ?? failover?.activeName;
  const untilMs =
    pinnedUntil ??
    (harnessPin ? undefined : harnessChainBlockedUntil(failover, now)) ??
    usageLimitRetryAt(readUsageLimitHint(env[USAGE_LIMIT_FILE_ENV]), now);
  return { untilMs, ...(harness ? { harness } : {}) };
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
