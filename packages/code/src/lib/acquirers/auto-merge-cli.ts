/**
 * Run `devintern auto-merge` for one PR as a CLI subprocess with harness
 * failover, reading its structured result from a dedicated fd (the same
 * protocol `resolve-conflicts` uses).
 */

import { spawn } from "child_process";

import { AUTO_MERGE_OUTCOMES } from "../review/auto-merge";
import type { AutoMergeOutcome, AutoMergePolicy, AutoMergeResult } from "../review/auto-merge";
import { runWithFailover } from "../worker/failover";
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
}

/** CLI flags carrying the policy to the subprocess. */
export function autoMergeCliArgs(policy: AutoMergePolicy, expectedHeadSha: string): string[] {
  return [
    "--expected-head",
    expectedHeadSha,
    "--method",
    policy.method,
    ...(policy.review ? [] : ["--no-review"]),
    ...policy.safePaths.flatMap((glob) => ["--safe-path", glob]),
    ...policy.denyPaths.flatMap((glob) => ["--deny-path", glob]),
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
        env: { ...opts.env, DEVINTERN_RESULT_FD: "3" },
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
  const args = autoMergeCliArgs(opts.policy, opts.expectedHeadSha);
  return serializePrRun(repo, prNumber, async () => {
    let last: AutoMergeResult | null = null;
    const status = await runWithFailover(
      async (env) => {
        const spawned = await spawnOnce(prUrl, args, { ...opts, env });
        last = spawned.result;
        return spawned.code;
      },
      opts.env ?? process.env,
      { harnessPin: opts.harnessPin },
    );
    if (status === "deferred") {
      return {
        outcome: "deferred",
        message: "agent usage limit; waiting for a harness to become available",
        reviewed: false,
      };
    }
    return (
      last ?? {
        outcome: "failed",
        message: `auto-merge exited without a result (${status})`,
        reviewed: false,
      }
    );
  });
}
