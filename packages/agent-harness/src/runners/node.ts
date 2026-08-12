/**
 * Node-specific runner helper.
 *
 * Uses `child_process.spawn` for execution.  The prompt is passed as the
 * final positional argument when `inputMethod === "arg"` (the default) or
 * written to the process stdin when `inputMethod === "stdin"`.
 */

import type { ChildProcess } from "child_process";
import { preparePromptWithAttachments } from "../attachments.js";
import { detectMaxTurnsReached } from "../detect-max-turns.js";
import { assertModeSupported } from "../modes.js";
import { buildPromptArgs } from "../prompt-args.js";
import { spawnReapable, reapTree } from "../process-reaper.js";
import { resolveExecutablePathWithRetry } from "../resolver.js";
import type { AgentHarness, AgentRunOptions, AgentRunResult } from "../types.js";

export interface NodeRunnerOptions extends AgentRunOptions {
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Timeout in minutes (defaults to `AGENT_HARNESS_TIMEOUT_MINUTES` env var or 60). */
  timeoutMinutes?: number;
  /** Write stdout/stderr to the parent process in real time. */
  displayRealtime?: boolean;
}

function isVerbose(options: NodeRunnerOptions): boolean {
  return options.verbose === true || process.env.DEVINTERN_VERBOSE === "1";
}

function logAgent(message: string, options: NodeRunnerOptions): void {
  if (isVerbose(options)) {
    process.stderr.write(`[agent] ${message}\n`);
  }
}

/**
 * Spawn an agent CLI subprocess using Node `child_process` and collect output.
 *
 * Supports optional cwd, timeout, and real-time stdout/stderr streaming.
 * Default `inputMethod` is `"arg"`, matching the Bun runner.
 *
 * @param harness - Harness defining CLI flags via {@link AgentHarness.buildArgs}.
 * @param executablePath - Resolved path to the agent executable.
 * @param prompt - Task prompt passed to the agent.
 * @param options - Node-specific run options (cwd, timeout, displayRealtime, etc.).
 * @returns Captured stdout, stderr, and process exit code.
 * @throws {Error} When the executable is not found (`ENOENT`) or the process times out.
 * @throws {UnsupportedAgentModeError} when `options.mode` is not supported.
 */
export async function runAgentNode(
  harness: AgentHarness,
  executablePath: string,
  prompt: string,
  options: NodeRunnerOptions = {},
): Promise<AgentRunResult> {
  assertModeSupported(harness, options.mode);

  // Wait out any in-progress CLI auto-update swap before spawning (see
  // resolveExecutablePathWithRetry), so a transient `spawn ENOENT` doesn't
  // abort the run.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    cwd: options.cwd,
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    const inputMethod = options.inputMethod ?? "arg";
    const { prompt: effectivePrompt, imageArgs } = preparePromptWithAttachments(
      harness,
      prompt,
      options,
    );
    const args = [...harness.buildArgs(options)];

    if (inputMethod === "arg") {
      args.push(...buildPromptArgs(harness, effectivePrompt));
    }
    args.push(...imageArgs);

    const timeoutMinutes =
      options.timeoutMinutes ?? parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

    if (!options.silent) {
      console.log(`\n🤖 Running ${harness.displayName}...\n`);
    }

    logAgent(
      `Spawning ${harness.displayName}: ${resolvedPath} ${args
        .map((arg) => (arg === effectivePrompt ? `<prompt:${effectivePrompt.length} chars>` : arg))
        .join(" ")} (input: ${inputMethod})`,
      options,
    );

    const startedAt = Date.now();
    let gotOutput = false;

    const proc: ChildProcess = spawnReapable(resolvedPath, args, {
      cwd: options.cwd,
      // Only pipe stdin when feeding the prompt that way. An open stdin pipe (even
      // unused) makes opencode block until EOF.
      stdio: [inputMethod === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
    });

    logAgent(`${harness.displayName} pid ${proc.pid ?? "unknown"} started`, options);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const markOutput = (stream: "stdout" | "stderr", chunk: string): void => {
      if (!gotOutput && chunk.length > 0) {
        gotOutput = true;
        logAgent(
          `First ${stream} from ${harness.displayName} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${chunk.length} bytes)`,
          options,
        );
      }
    };

    const timeout = setTimeout(
      () => {
        timedOut = true;
        console.error(
          `\n⏰ ${harness.displayName} process timed out after ${timeoutMinutes} minutes, killing...`,
        );
        reapTree(proc, "SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            reapTree(proc, "SIGKILL");
          }
        }, 10_000);
      },
      timeoutMinutes * 60 * 1000,
    );

    if (proc.stdout) {
      proc.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        markOutput("stdout", chunk);
        if (options.displayRealtime) {
          process.stdout.write(chunk);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        markOutput("stderr", chunk);
        if (options.displayRealtime) {
          process.stderr.write(chunk);
        }
      });
    }

    proc.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `${harness.displayName} CLI not found at: ${resolvedPath}\n` +
              `Please install ${harness.displayName} or specify the correct path.`,
          ),
        );
      } else {
        reject(new Error(`Failed to run ${harness.displayName}: ${error.message}`));
      }
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${harness.displayName} timed out after ${timeoutMinutes} minutes`));
      } else {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
          maxTurnsReached: detectMaxTurnsReached(stdout, stderr),
        });
      }
    });

    if (proc.stdin && inputMethod === "stdin") {
      proc.stdin.write(effectivePrompt);
      proc.stdin.end();
    }
  });
}
