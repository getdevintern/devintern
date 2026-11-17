/**
 * Run `devintern auto-merge` for one PR as a CLI subprocess with harness
 * failover, reading its structured result from a dedicated fd (the same
 * protocol `resolve-conflicts` uses).
 */

import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resetHintToMs } from "@devintern/agent-harness";

import { pinnedHarnessChildEnv } from "../agent/selection";
import { harnessLogRunEnv } from "../observability/harness-logs";
import { AUTO_MERGE_OUTCOMES } from "../review/auto-merge";
import type { AutoMergeOutcome, AutoMergePolicy, AutoMergeResult } from "../review/auto-merge";
import { getWorkerFailover, runWithFailover } from "../worker/failover";
import {
  AUTOMATION_ACCESS_EXIT_CODE,
  HARNESS_UNAVAILABLE_EXIT_CODE,
  RATE_LIMIT_FALLBACK_MS,
  RATE_LIMIT_PERIOD_FLOOR_MS,
  readUsageLimitHint,
  USAGE_LIMIT_EXIT_CODE,
  USAGE_LIMIT_FILE_ENV,
} from "../worker/usage-limit-protocol";
import type { UsageLimitHint } from "../worker/usage-limit-protocol";
import { serializePrRun } from "./review-polling";

/** Default wall-clock budget for one auto-merge subprocess (review included). */
export const DEFAULT_AUTO_MERGE_TIMEOUT_MS = 30 * 60 * 1000;

export interface AutoMergeCliOptions {
  policy: AutoMergePolicy;
  expectedHeadSha: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Harness pinned by `[workspace].auto_merge_harness` (skips failover). */
  harnessPin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override the CLI entrypoint (subprocess tests). */
  entrypoint?: string;
  /** This head's final allowed attempt: a failure is stated on the PR. */
  lastAttempt?: boolean;
  /** Worker run for this check; the child's agent transcript is filed under it. */
  runId?: number;
}

/** CLI flags carrying the policy to the subprocess. */
export function autoMergeCliArgs(
  policy: AutoMergePolicy,
  expectedHeadSha: string,
  options: { lastAttempt?: boolean } = {},
): string[] {
  return [
    "--expected-head",
    expectedHeadSha,
    ...(options.lastAttempt ? ["--last-attempt"] : []),
    "--method",
    policy.method,
    ...(policy.review ? [] : ["--no-review"]),
    ...policy.safePaths.flatMap((glob) => ["--safe-path", glob]),
    ...policy.denyPaths.flatMap((glob) => ["--deny-path", glob]),
    // Unset keeps the CLI default label; empty disables labeling.
    ...(policy.reviewLabel === undefined
      ? []
      : policy.reviewLabel
        ? ["--review-label", policy.reviewLabel]
        : ["--no-review-label"]),
  ];
}

/** Parse the subprocess result record; `null` when absent or malformed. */
export function parseAutoMergeResultLine(output: string): AutoMergeResult | null {
  let result: AutoMergeResult | null = null;
  for (const line of output.trimEnd().split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.message === "string" &&
      (AUTO_MERGE_OUTCOMES as readonly unknown[]).includes(record.outcome)
    ) {
      result = {
        outcome: record.outcome as AutoMergeOutcome,
        message: record.message,
        reviewed: record.reviewed === true,
      };
    }
  }
  return result;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, 5_000).unref();
}

function spawnOnce(
  prUrl: string,
  args: string[],
  opts: AutoMergeCliOptions & { env: Record<string, string | undefined> },
): Promise<{ code: number; result: AutoMergeResult | null }> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ code: 1, result: null });
      return;
    }
    let output = "";
    let settled = false;
    const child = spawn(
      process.execPath,
      [opts.entrypoint ?? (process.argv[1] as string), "auto-merge", prUrl, ...args],
      {
        detached: true,
        stdio: ["inherit", "inherit", "inherit", "pipe"],
        cwd: opts.cwd,
        env: {
          ...opts.env,
          DEVINTERN_RESULT_FD: "3",
          ...(opts.runId !== undefined ? harnessLogRunEnv(opts.runId) : {}),
        },
      },
    );
    const abort = () => killTree(child.pid);
    opts.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTO_MERGE_TIMEOUT_MS;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            console.warn(`⏱️  auto-merge for ${prUrl} exceeded ${timeoutMs / 1000}s; killing`);
            killTree(child.pid);
          }, timeoutMs)
        : null;
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      if (output.length < 64 * 1024) output += chunk.toString();
    });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      // oxlint-disable-next-line promise/no-multiple-resolved -- settled guards a single resolution.
      resolve({ code, result: parseAutoMergeResultLine(output) });
    };
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", (error) => {
      console.error(`❌ Failed to spawn auto-merge for ${prUrl}: ${error.message}`);
      finish(1);
    });
  });
}

/** When a limited harness's quota returns, from the child's hint file. */
export function usageLimitRetryAt(hint: UsageLimitHint, now: number): number {
  if (hint.untilMs && hint.untilMs > now) return hint.untilMs;
  const parsed = resetHintToMs(hint.resetsAt, now);
  if (parsed !== null && parsed > now) return parsed;
  return now + (hint.period ? RATE_LIMIT_PERIOD_FLOOR_MS[hint.period] : RATE_LIMIT_FALLBACK_MS);
}

/** Earliest instant a usage-limited harness in the failover chain returns. */
function failoverRetryAt(now: number): number | undefined {
  const windows = Object.values(getWorkerFailover()?.windows() ?? {}).filter((at) => at > now);
  return windows.length > 0 ? Math.min(...windows) : undefined;
}

function quotaDeferral(retryAt: number | undefined): AutoMergeResult {
  return {
    outcome: "deferred",
    message: retryAt
      ? `agent usage limit; review resumes after ${new Date(retryAt).toISOString()}`
      : "no agent harness is available right now",
    reviewed: false,
    ...(retryAt ? { retryAt } : {}),
  };
}

/**
 * A harness pinned by `auto_merge_harness` runs outside the failover chain,
 * which would discard the child's reset hint; read it here instead so the
 * watcher waits for the real reset rather than relaunching into the limit.
 */
async function runPinned(
  prUrl: string,
  args: string[],
  opts: AutoMergeCliOptions & { harnessPin: string },
): Promise<AutoMergeResult> {
  const hintDir = mkdtempSync(join(tmpdir(), "devintern-auto-merge-limit-"));
  const hintPath = join(hintDir, "hint.json");
  try {
    const env = {
      ...pinnedHarnessChildEnv(opts.env ?? process.env, opts.harnessPin),
      [USAGE_LIMIT_FILE_ENV]: hintPath,
    };
    const spawned = await spawnOnce(prUrl, args, { ...opts, env });
    if (spawned.code === USAGE_LIMIT_EXIT_CODE) {
      return quotaDeferral(usageLimitRetryAt(readUsageLimitHint(hintPath), Date.now()));
    }
    if (
      spawned.code === AUTOMATION_ACCESS_EXIT_CODE ||
      spawned.code === HARNESS_UNAVAILABLE_EXIT_CODE
    ) {
      return quotaDeferral(undefined);
    }
    return (
      spawned.result ?? {
        outcome: "failed",
        message: `auto-merge exited with code ${spawned.code} without a result`,
        reviewed: false,
      }
    );
  } finally {
    rmSync(hintDir, { recursive: true, force: true });
  }
}

/**
 * Evaluate (and possibly merge) one PR via the CLI. Serialized with the
 * other automatic pipelines on the same PR (reviews, conflicts, CI fixes).
 */
export function runAutoMergeViaCli(
  repo: string,
  prNumber: number,
  opts: AutoMergeCliOptions,
): Promise<AutoMergeResult> {
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  const args = autoMergeCliArgs(opts.policy, opts.expectedHeadSha, {
    lastAttempt: opts.lastAttempt,
  });
  const { harnessPin } = opts;
  return serializePrRun(repo, prNumber, async () => {
    if (harnessPin) return runPinned(prUrl, args, { ...opts, harnessPin });
    let last: AutoMergeResult | null = null;
    const status = await runWithFailover(async (env) => {
      const spawned = await spawnOnce(prUrl, args, { ...opts, env });
      last = spawned.result;
      return spawned.code;
    }, opts.env ?? process.env);
    // Every harness is limited (or none could start): the chain's windows say
    // when the earliest one returns.
    if (status === "deferred") return quotaDeferral(failoverRetryAt(Date.now()));
    return (
      last ?? {
        outcome: "failed",
        message: `auto-merge exited without a result (${status})`,
        reviewed: false,
      }
    );
  });
}
