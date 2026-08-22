/**
 * Shared launch lifecycle for the CLI's agent spawn sites (feasibility
 * clarity check, estimation, implementation).
 *
 * Extracted verbatim from `src/index.ts` so the wiring that actually drives
 * harness fallback — ENOENT → executable-missing, other spawn errors →
 * spawn-failed, timeout → plain Error, and non-zero exits → classified
 * {@link AgentLaunchError} vs plain Error — can be exercised end-to-end by
 * integration tests against stub executables.
 */

import { reapTree, resolveExecutablePathWithRetry, spawnAgent } from "@devintern/agent-harness";
import type { ResolvedSandbox } from "@devintern/agent-harness";

import {
  exitClassificationError,
  executableMissingError,
  spawnFailedError,
} from "./harness-launch";

/** Output captured from a completed agent child process. */
export interface CapturedAgentRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Outcome decided by {@link RunCapturedAgentOptions.inspectClose}.
 *
 * - `Error`: reject the run with this error (e.g. usage limits).
 * - `"handled"`: the caller already settled the outer promise (the
 *   max-turns path resolves instead of rejecting); skip default handling.
 * - `null` / `undefined`: continue default handling (classify non-zero
 *   exits, resolve zero exits).
 */
export type CloseInspection = Error | "handled" | null | undefined;

/** Options for {@link runCapturedAgentProcess}. */
export interface RunCapturedAgentOptions {
  /** Human-readable harness name used in log/error messages. */
  displayName: string;
  /**
   * User-facing executable path or alias; kept for error messages while the
   * spawn itself uses the retry-resolved path.
   */
  executablePath: string;
  /** Full argv after the executable (harness flags + prompt args). */
  args: readonly string[];
  /** Sandbox resolution for this harness (`getSandbox(harness.name)` result). */
  sandbox?: ResolvedSandbox | null;
  /**
   * Stage suffix inserted into spawn-failure messages, e.g. `"clarity check"`
   * produces ``Failed to run Claude Code clarity check: …``. Omit for the
   * implementation stage.
   */
  stageLabel?: string;
  /** Subject used in non-zero-exit messages, e.g. `"Agent clarity check"`. */
  exitSubject: string;
  /** Timeout budget in minutes before the child is reaped. */
  timeoutMinutes: number;
  /** Complete message used when the run times out. */
  timeoutMessage: string;
  /** Mirror captured chunks to this process's console (implementation site). */
  mirrorToConsole?: boolean;
  /** Invoked first thing in the close handler (e.g. separator logging). */
  onCloseStart?: () => void;
  /** Invoked right before rejecting due to a timeout (extra site logging). */
  onTimeout?: () => void;
  /**
   * Invoked synchronously when the child closes non-zero, right before the
   * classified rejection (implementation site logs its ❌ banner here).
   */
  onNonZeroExit?: (exitCode: number | null) => void;
  /**
   * Inspect the captured output before default handling. Runs after the
   * timeout check and before exit classification so site-specific outcomes
   * (usage limits, max-turns resolution) keep their original precedence.
   */
  inspectClose?: (run: CapturedAgentRun) => Promise<CloseInspection> | CloseInspection;
}

/**
 * Spawn an agent CLI, capture its output, and classify launch failures.
 *
 * Rejects with:
 * - {@link executableMissingError} (`executable-missing`) when the binary is
 *   gone at spawn time (ENOENT),
 * - {@link spawnFailedError} (`spawn-failed`) for any other spawn error,
 * - a plain `Error` when the child is reaped after the timeout budget,
 * - an {@link AgentLaunchError} for a non-zero exit whose classification is
 *   fallback-eligible ({@link exitClassificationError}),
 * - a plain `Error` for a non-zero exit that happened after meaningful work
 *   (never fall back then).
 *
 * Resolves with the captured output only when the child exits zero.
 *
 * @param options - Harness invocation and message-shaping details.
 */
export async function runCapturedAgentProcess(
  options: RunCapturedAgentOptions,
): Promise<CapturedAgentRun> {
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the run.
  const resolvedPath = await resolveExecutablePathWithRetry(options.executablePath, {
    displayName: options.displayName,
  });

  return new Promise<CapturedAgentRun>((resolve, reject) => {
    (async () => {
      let stdoutOutput = "";
      let stderrOutput = "";
      let timedOut = false;

      const { child, cleanup: sandboxCleanup } = await spawnAgent({
        resolvedPath,
        args: options.args,
        spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
        sandbox: options.sandbox ?? null,
      });

      const timeout = setTimeout(
        () => {
          timedOut = true;
          console.error(
            `\n⏰ ${options.displayName} process timed out after ${options.timeoutMinutes} minutes, killing...`,
          );
          reapTree(child, "SIGTERM");
          setTimeout(() => {
            if (!child.killed) {
              reapTree(child, "SIGKILL");
            }
            sandboxCleanup().catch(() => {});
          }, 10_000);
        },
        options.timeoutMinutes * 60 * 1000,
      );

      if (child.stdout) {
        child.stdout.on("data", (data: Buffer) => {
          const output = data.toString();
          stdoutOutput += output;
          if (options.mirrorToConsole) {
            process.stdout.write(output);
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          stderrOutput += output;
          if (options.mirrorToConsole) {
            process.stderr.write(output);
          }
        });
      }

      // Handle errors
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (error.code === "ENOENT") {
          reject(
            executableMissingError(
              `${options.displayName} CLI not found at: ${options.executablePath}\n` +
                `Please install ${options.displayName} or specify the correct path with --agent-path`,
            ),
          );
        } else {
          const stageSuffix = options.stageLabel ? ` ${options.stageLabel}` : "";
          reject(
            spawnFailedError(
              `Failed to run ${options.displayName}${stageSuffix}: ${error.message}`,
              error.message,
            ),
          );
        }
      });

      // Handle process exit
      child.on("close", async (code: number | null) => {
        clearTimeout(timeout);
        sandboxCleanup().catch(() => {});
        options.onCloseStart?.();

        if (timedOut) {
          options.onTimeout?.();
          reject(new Error(options.timeoutMessage));
          return;
        }

        const inspection = await options.inspectClose?.({
          exitCode: code,
          stdout: stdoutOutput,
          stderr: stderrOutput,
        });
        if (inspection === "handled") {
          return;
        }
        if (inspection instanceof Error) {
          reject(inspection);
          return;
        }

        if (code !== 0) {
          options.onNonZeroExit?.(code);
          // Classify pre-work exits so the fallback coordinator can advance
          // to the next configured harness when the failure is safe.
          reject(
            exitClassificationError(
              `${options.exitSubject} exited with code ${code}`,
              stdoutOutput,
              stderrOutput,
              code,
            ),
          );
          return;
        }

        resolve({ exitCode: code, stdout: stdoutOutput, stderr: stderrOutput });
      });
    })().catch(reject);
  });
}
