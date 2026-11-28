/**
 * Subprocess runners for the automatic review loops: address-review and
 * resolve-conflicts run as `devintern` CLI children (with harness failover)
 * so each agent run gets its own process, timeout, and result channel.
 */
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { captureError } from "@devintern/utils";

import { pinnedHarnessChildEnv } from "../agent/selection";
import { parseEnvInteger } from "../config/env-integer";
import { childOutputMode, forwardChildOutput } from "../observability/child-output";
import { formatMentionArg } from "../review/mention-trigger";
import type { MentionTrigger } from "../review/mention-trigger";
import { jobMemoryLimitReason, jobMemorySpawn } from "../worker/job-cgroup";
import type { TaskExecutionResult } from "./task-polling";
import {
  cliResultToTaskResult,
  harnessChainBlockedUntil,
  runWithFailover,
} from "../worker/failover";
import {
  AUTOMATION_ACCESS_EXIT_CODE,
  HARNESS_UNAVAILABLE_EXIT_CODE,
  readUsageLimitHint,
  usageLimitRetryAt,
  USAGE_LIMIT_EXIT_CODE,
  USAGE_LIMIT_FILE_ENV,
  WORKTREE_BUSY_EXIT_CODE,
} from "../worker/usage-limit-protocol";

export interface AutomaticResolveResult {
  outcome: "clean" | "resolved" | "skipped" | "failed" | "deferred";
  message: string;
  /**
   * Set on a `deferred` outcome when the resolver never ran because the worker
   * had no capacity (every harness usage-limited, or the worker draining).
   * Capacity defers are transient and never count toward the defer cap.
   */
  capacity?: true;
  /** Earliest time a capacity defer should be retried, when known. */
  retryAt?: number;
  /**
   * On a `failed` outcome, how far the resolver got (`setup`, `aborted`,
   * `push-failed`, `landed-but-unconfirmed`; see `FailureKind` in
   * `review/conflict-resolver.ts`). Carried through the result record; absent
   * when the subprocess died without writing one.
   */
  failureKind?: string;
}

const prRunTails = new Map<string, Promise<void>>();

/** Default wall-clock budget for one resolve-conflicts subprocess. */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 30 * 60 * 1000;

/** Resolver subprocess budget; `WORKER_RESOLVE_TIMEOUT_SECONDS` overrides (0 disables). */
function resolveTimeoutMs(overrideMs?: number): number {
  if (overrideMs !== undefined) return overrideMs;
  return (
    parseEnvInteger("WORKER_RESOLVE_TIMEOUT_SECONDS", DEFAULT_RESOLVE_TIMEOUT_MS / 1000, {
      min: 0,
    }) * 1000
  );
}

/** Kill a spawned process and (best-effort) its whole process group. */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  // The child is spawned detached, so it leads its own process group;
  // the negative pid signals every descendant (e.g. agent harnesses).
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  // If the SIGTERM already finished the child, cancel the deferred SIGKILL:
  // by then the pid/pgid may have been recycled for an unrelated process, and
  // signalling that would kill a bystander (e.g. under heavy test-suite churn).
  const sigkillTimer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 5_000).unref();
  child.once("close", () => clearTimeout(sigkillTimer));
}

/** Serialize automatic pipelines that target the same PR worktree. */
export async function serializePrRun<T>(
  repo: string,
  prNumber: number,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${repo.toLowerCase()}#${prNumber}`;
  const previous = prRunTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => tail);
  prRunTails.set(key, chained);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (prRunTails.get(key) === chained) prRunTails.delete(key);
  }
}

/**
 * Run `devintern address-review` for a PR as a CLI subprocess, reusing the
 * whole manual flow (worktree, agent, push, replies, reactions).
 *
 * @param repo - `owner/repo` slug
 * @param prNumber - Pull request number
 * @param opts - Working directory and environment for the subprocess;
 *               the workspace worker runs from the repo's base worktree with
 *               per-repo env; direct callers inherit both. `mention` is the
 *               @mention that triggered the run, addressed as feedback itself.
 */
export function runAddressReviewViaCli(
  repo: string,
  prNumber: number,
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    mention?: MentionTrigger;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
  } = {},
): Promise<TaskExecutionResult> {
  const { mention, ...rest } = opts;
  return serializePrRun(repo, prNumber, () =>
    runSubcommandViaCli("address-review", repo, prNumber, {
      ...rest,
      extraArgs: mention ? ["--mention", formatMentionArg(mention)] : [],
    }),
  );
}

/** Run manual feedback addressing for an already canonical change-request URL. */
export function runAddressReviewUrlViaCli(
  webUrl: string,
  serializationKey: string,
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
  } = {},
): Promise<TaskExecutionResult> {
  return serializePrRun(serializationKey, 0, () =>
    runSubcommandViaCli("address-review", serializationKey, 0, { ...opts, webUrl }),
  );
}

/**
 * Run `devintern resolve-conflicts` for a PR as a CLI subprocess.
 *
 * @param repo - `owner/repo` slug
 * @param prNumber - Pull request number
 * @param opts - Optional per-repo working directory and environment
 */
export function runResolveConflictsViaCli(
  repo: string,
  prNumber: number,
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    expectedHeadSha?: string;
    expectedBaseSha?: string;
    /** Hard wall-clock budget; defaults to `WORKER_RESOLVE_TIMEOUT_SECONDS` (30min). */
    timeoutMs?: number;
    /** Override the CLI entrypoint and output handling (subprocess tests). */
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
    webUrl?: string;
    signal?: AbortSignal;
    /** Harness pinned by `[workspace].conflict_resolution_harness` (skips failover). */
    harnessPin?: string;
  } = {},
): Promise<AutomaticResolveResult> {
  const args = [
    ...(opts.expectedHeadSha ? ["--expected-head", opts.expectedHeadSha] : []),
    ...(opts.expectedBaseSha ? ["--expected-base", opts.expectedBaseSha] : []),
  ];
  return serializePrRun(repo, prNumber, () => runResolveSubcommand(repo, prNumber, args, opts));
}

/** Run conflict resolution for a canonical provider change-request URL. */
export function runResolveConflictsUrlViaCli(
  webUrl: string,
  serializationKey: string,
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    expectedHeadSha?: string;
    expectedBaseSha?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Harness pinned by `[workspace].conflict_resolution_harness` (skips failover). */
    harnessPin?: string;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
  } = {},
): Promise<AutomaticResolveResult> {
  return runResolveConflictsViaCli(serializationKey, 0, { ...opts, webUrl });
}

function runResolveSubcommand(
  repo: string,
  prNumber: number,
  extraArgs: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
    webUrl?: string;
    signal?: AbortSignal;
    /** Harness pinned by `[workspace].conflict_resolution_harness` (skips failover). */
    harnessPin?: string;
  },
): Promise<AutomaticResolveResult> {
  return runResolveWithFailover(repo, prNumber, extraArgs, opts);
}

async function runResolveWithFailover(
  repo: string,
  prNumber: number,
  extraArgs: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
    webUrl?: string;
    signal?: AbortSignal;
    /** Harness pinned by `[workspace].conflict_resolution_harness` (skips failover). */
    harnessPin?: string;
  },
): Promise<AutomaticResolveResult> {
  if (opts.harnessPin) {
    return runPinnedResolve(repo, prNumber, extraArgs, opts, opts.harnessPin);
  }
  let last: AutomaticResolveResult | null = null;
  const status = await runWithFailover(async (env) => {
    const spawned = await spawnResolveOnce(repo, prNumber, extraArgs, { ...opts, env });
    last = spawned.result;
    return spawned.code;
  }, opts.env ?? process.env);
  if (status === "deferred") {
    const retryAt = harnessChainBlockedUntil();
    return {
      outcome: "deferred",
      message: "agent usage limit; waiting for a harness to become available",
      capacity: true,
      ...(retryAt !== undefined ? { retryAt } : {}),
    };
  }
  return (
    last ?? {
      outcome: status === "ok" ? "skipped" : "failed",
      message: status === "ok" ? "resolver completed" : "resolver exited with a non-zero code",
    }
  );
}

/**
 * Run the resolver on a job-pinned harness, outside failover, while still
 * honoring the reset window the child reports.
 *
 * A pin deliberately opts out of the failover chain, so the worker cannot
 * move the job to another harness. It must not relaunch the pinned harness
 * every few minutes either: unlike a chain run, no failover window records
 * the limit, so the child's hint file is the only source for its real reset
 * time.
 *
 * @param repo - `owner/repo` slug
 * @param prNumber - Pull request number
 * @param extraArgs - Additional `resolve-conflicts` CLI arguments
 * @param opts - Working directory, environment, timeout, and signal
 * @param harnessPin - Harness the job pinned
 */
async function runPinnedResolve(
  repo: string,
  prNumber: number,
  extraArgs: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
    webUrl?: string;
    signal?: AbortSignal;
  },
  harnessPin: string,
): Promise<AutomaticResolveResult> {
  const hintDir = mkdtempSync(join(tmpdir(), "devintern-resolve-limit-"));
  const hintPath = join(hintDir, "hint.json");
  try {
    const env = {
      ...pinnedHarnessChildEnv(opts.env ?? process.env, harnessPin),
      [USAGE_LIMIT_FILE_ENV]: hintPath,
    };
    const spawned = await spawnResolveOnce(repo, prNumber, extraArgs, { ...opts, env });
    if (spawned.code === USAGE_LIMIT_EXIT_CODE) {
      return {
        outcome: "deferred",
        message: `agent usage limit on pinned harness ${harnessPin}; waiting for it to reset`,
        capacity: true,
        retryAt: usageLimitRetryAt(readUsageLimitHint(hintPath), Date.now()),
      };
    }
    if (
      spawned.code === AUTOMATION_ACCESS_EXIT_CODE ||
      spawned.code === HARNESS_UNAVAILABLE_EXIT_CODE ||
      spawned.code === WORKTREE_BUSY_EXIT_CODE
    ) {
      return {
        outcome: "deferred",
        message: "agent unavailable; retrying later",
        capacity: true,
      };
    }
    return (
      spawned.result ?? {
        outcome: spawned.code === 0 ? "skipped" : "failed",
        message:
          spawned.code === 0 ? "resolver completed" : `resolver exited with code ${spawned.code}`,
      }
    );
  } finally {
    rmSync(hintDir, { recursive: true, force: true });
  }
}

function spawnResolveOnce(
  repo: string,
  prNumber: number,
  extraArgs: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
    webUrl?: string;
    signal?: AbortSignal;
  },
): Promise<{ code: number; result: AutomaticResolveResult }> {
  const prUrl = opts.webUrl ?? `https://github.com/${repo}/pull/${prNumber}`;
  return new Promise((resolve) => {
    let settled = false;
    let abort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: { code: number; result: AutomaticResolveResult }): void => {
      if (settled) return;
      settled = true;
      if (abort) opts.signal?.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- settled guards a single resolution.
      resolve(value);
    };
    if (opts.signal?.aborted) {
      finish({ code: 1, result: { outcome: "failed", message: "resolver cancelled" } });
      return;
    }
    let result: AutomaticResolveResult | null = null;
    let resultOutput = "";
    let resultOverflow = false;
    let timedOut = false;
    const maxResultBytes = 64 * 1024;
    // Detached so the whole process group (agent harnesses included) can be
    // signalled on timeout.
    const output = childOutputMode(opts.outputStdio);
    const job = jobMemorySpawn(
      process.execPath,
      [opts.entrypoint ?? process.argv[1], "resolve-conflicts", prUrl, ...extraArgs],
      { ...(opts.env ?? process.env), DEVINTERN_RESULT_FD: "3" },
    );
    const child = spawn(job.command, job.args, {
      detached: true,
      stdio: ["inherit", output, output, "pipe"],
      cwd: opts.cwd,
      env: job.env,
    });
    forwardChildOutput(child, `resolve-conflicts ${prUrl}`);
    let aborted = false;
    abort = () => {
      aborted = true;
      killProcessTree(child);
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
    timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            console.warn(
              `⏱️  resolve-conflicts for ${prUrl} exceeded ${Math.round(timeoutMs / 1000)}s; killing`,
            );
            killProcessTree(child);
          }, timeoutMs)
        : null;
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      if (resultOverflow) return;
      if (Buffer.byteLength(resultOutput) + chunk.byteLength > maxResultBytes) {
        resultOutput = "";
        resultOverflow = true;
        return;
      }
      resultOutput += chunk.toString();
    });
    child.on("close", (code) => {
      const memory = job.onClose();
      if (aborted) {
        finish({ code: 1, result: { outcome: "failed", message: "resolver cancelled" } });
        return;
      }
      if (timedOut) {
        finish({
          code: 1,
          result: { outcome: "failed", message: `resolver timed out after ${timeoutMs}ms` },
        });
        return;
      }
      if (!resultOverflow) {
        for (const line of resultOutput.trimEnd().split("\n")) {
          try {
            const candidate = JSON.parse(line) as Partial<AutomaticResolveResult>;
            if (
              typeof candidate.message === "string" &&
              ["clean", "resolved", "skipped", "failed", "deferred"].includes(
                candidate.outcome ?? "",
              )
            ) {
              result = candidate as AutomaticResolveResult;
            }
          } catch {
            // Ignore malformed records and use the exit-status fallback.
          }
        }
      }
      finish({
        code: code ?? 1,
        result: result ?? {
          outcome: code === 0 ? "skipped" : code === 2 ? "deferred" : "failed",
          message:
            code === 0
              ? "resolver completed"
              : code === 2
                ? "resolver deferred"
                : memory.exceeded
                  ? jobMemoryLimitReason(memory.label)
                  : `resolver exited with code ${code}`,
        },
      });
    });
    child.on("error", (error) => {
      job.onClose();
      finish({
        code: 1,
        result: { outcome: "failed", message: `failed to spawn resolver: ${error.message}` },
      });
    });
  });
}

async function runSubcommandViaCli(
  subcommand: string,
  repo: string,
  prNumber: number,
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    webUrl?: string;
    entrypoint?: string;
    outputStdio?: "inherit" | "ignore";
    extraArgs?: string[];
  } = {},
): Promise<TaskExecutionResult> {
  const prUrl = opts.webUrl ?? `https://github.com/${repo}/pull/${prNumber}`;
  // Distinguishes "the drain killed this run" from "the run failed and the
  // drain happened to start around the same time". Only the abort handler (or
  // an already-aborted signal) sets it, so the SIGTERM exit code of a drained
  // child is never mistaken for a genuine pipeline failure.
  let interrupted = false;
  const status = await runWithFailover(
    (env) =>
      new Promise<number>((resolve) => {
        if (opts.signal?.aborted) {
          interrupted = true;
          resolve(1);
          return;
        }
        const output = childOutputMode(opts.outputStdio);
        const job = jobMemorySpawn(
          process.execPath,
          [opts.entrypoint ?? process.argv[1], subcommand, prUrl, ...(opts.extraArgs ?? [])],
          env,
        );
        const child = spawn(job.command, job.args, {
          stdio: ["inherit", output, output],
          cwd: opts.cwd,
          env: job.env,
          detached: process.platform !== "win32",
        });
        forwardChildOutput(child, `${subcommand} ${prUrl}`);
        const abort = () => {
          interrupted = true;
          killProcessTree(child);
        };
        let settled = false;
        const finish = (code: number) => {
          if (settled) return;
          settled = true;
          opts.signal?.removeEventListener("abort", abort);
          resolve(code);
        };
        opts.signal?.addEventListener("abort", abort, { once: true });
        child.on("close", (code) => {
          const memory = job.onClose();
          if (memory.exceeded && !interrupted) {
            console.warn(`⚠️  ${subcommand} for ${prUrl}: ${jobMemoryLimitReason(memory.label)}`);
          }
          finish(code ?? 1);
        });
        child.on("error", (error) => {
          job.onClose();
          captureError(error, { command: subcommand, repo, prNumber, stage: "spawn" });
          console.error(`❌ Failed to spawn ${subcommand} for ${prUrl}: ${error.message}`);
          finish(1);
        });
      }),
    opts.env ?? process.env,
  );
  if (interrupted) return "interrupted";
  return cliResultToTaskResult(status);
}
