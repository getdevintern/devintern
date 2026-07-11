/**
 * Bun-specific runner helper.
 *
 * Spawns the agent in its own process group via {@link spawnReapable} so any
 * long-lived grandchildren it starts (dev servers, watchers) are torn down with
 * it rather than orphaned. (`Bun.spawn` offers no process-group control, so this
 * routes through `node:child_process`, which Bun implements.) The prompt is
 * passed as the final positional argument when `inputMethod === "arg"` (the
 * default) or written to the process stdin when `inputMethod === "stdin"`.
 */

import { detectMaxTurnsReached } from "../detect-max-turns.js";
import { assertModeSupported } from "../modes.js";
import { buildPromptArgs } from "../prompt-args.js";
import { spawnReapable } from "../process-reaper.js";
import { resolveExecutablePathWithRetry } from "../resolver.js";
import type { AgentHarness, AgentRunOptions, AgentRunResult } from "../types.js";

/**
 * Spawn an agent CLI subprocess using Bun and collect its output.
 *
 * The prompt is appended as a positional argument or `promptFlag` value when
 * `inputMethod` is `"arg"` (default), or written to stdin when `"stdin"`.
 *
 * @param harness - Harness defining CLI flags via {@link AgentHarness.buildArgs}.
 * @param executablePath - Resolved path to the agent executable.
 * @param prompt - Task prompt passed to the agent.
 * @param options - Run options (turn limits, model, input method, etc.).
 * @returns Captured stdout, stderr, and process exit code.
 * @throws {UnsupportedAgentModeError} when `options.mode` is not supported.
 */
export async function runAgentBun(
  harness: AgentHarness,
  executablePath: string,
  prompt: string,
  options: AgentRunOptions = {},
): Promise<AgentRunResult> {
  assertModeSupported(harness, options.mode);

  const inputMethod = options.inputMethod ?? "arg";
  const args = harness.buildArgs(options);

  if (inputMethod === "arg") {
    args.push(...buildPromptArgs(harness, prompt));
  }

  if (!options.silent) {
    console.log(`\n🤖 Running ${harness.displayName}...\n`);
  }

  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the run.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    displayName: harness.displayName,
  });

  const proc = spawnReapable(resolvedPath, args, {
    // Only pipe stdin when feeding the prompt that way. An open stdin pipe (even
    // unused) makes opencode block until EOF.
    stdio: [inputMethod === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
  });

  if (inputMethod === "stdin" && proc.stdin) {
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    options.onStderr?.(text);
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", reject);
  });

  return {
    stdout,
    stderr,
    exitCode,
    maxTurnsReached: detectMaxTurnsReached(stdout, stderr),
  };
}
