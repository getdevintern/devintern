/**
 * Shared argv + stdio for headless agent spawns in this package.
 *
 * Implementation, hook-fix, review, and webhook paths must all put the prompt
 * on the command line. Piping it via stdin makes TUI-first CLIs (Grok Build,
 * Kimi, Goose, Qwen, Antigravity, Pi) open an interactive session and then
 * fail with ENXIO / "Device not configured" when there is no TTY. Positional
 * CLIs (Codex, Cursor, Opencode, Cline) never see a stdin prompt either.
 *
 * Args are built through {@link buildHarnessInvocation} so a version probe
 * (e.g. Opencode v1/v2) runs once per executable and the harness can emit the
 * right flags and spawn environment.
 */

import { buildHarnessInvocation, buildPromptArgs } from "@devintern/agent-harness";
import type { AgentHarness, AgentRunOptions, HarnessInvocation } from "@devintern/agent-harness";

/** stdio used for every headless spawn: ignore stdin, pipe stdout/stderr. */
export const HEADLESS_AGENT_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/**
 * Build the full invocation (flags + prompt + env) for a non-interactive run.
 *
 * @param harness - Resolved harness (supplies flags, optional `promptFlag`, probe).
 * @param executablePath - Resolved path/command of the harness CLI (for probing).
 * @param prompt - Full prompt text.
 * @param options - Per-run flags forwarded to {@link AgentHarness.buildArgs}.
 * @returns Args ready for {@link spawnAgent} plus any environment overlay.
 */
export async function buildHeadlessAgentInvocation(
  harness: AgentHarness,
  executablePath: string,
  prompt: string,
  options: AgentRunOptions,
): Promise<HarnessInvocation> {
  const invocation = await buildHarnessInvocation(harness, executablePath, options);
  return {
    ...invocation,
    args: [...invocation.args, ...buildPromptArgs(harness, prompt)],
  };
}

/**
 * Merge a harness environment overlay over the inherited environment.
 *
 * @param env - Overlay from {@link buildHeadlessAgentInvocation}, if any.
 * @returns Full env for `spawn`, or `undefined` to inherit unchanged.
 */
export function harnessSpawnEnv(
  env: Record<string, string> | undefined,
): NodeJS.ProcessEnv | undefined {
  return env ? { ...process.env, ...env } : undefined;
}
