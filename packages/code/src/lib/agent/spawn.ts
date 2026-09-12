/**
 * Shared argv + stdio for headless agent spawns in this package.
 *
 * Implementation, hook-fix, review, and webhook paths must all put the prompt
 * on the command line. Piping it via stdin makes TUI-first CLIs (Grok Build,
 * Kimi, Goose, Qwen, Antigravity, Pi) open an interactive session and then
 * fail with ENXIO / "Device not configured" when there is no TTY. Positional
 * CLIs (Codex, Cursor, Opencode, Cline) never see a stdin prompt either.
 */

import { buildPromptArgs } from "@devintern/agent-harness";
import type { AgentHarness, AgentRunOptions } from "@devintern/agent-harness";

/** stdio used for every headless spawn: ignore stdin, pipe stdout/stderr. */
export const HEADLESS_AGENT_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/**
 * Build argv for a non-interactive agent run.
 *
 * @param harness - Resolved harness (supplies flags and optional `promptFlag`).
 * @param prompt - Full prompt text.
 * @param options - Per-run flags forwarded to {@link AgentHarness.buildArgs}.
 * @returns Args ready to pass to {@link spawnAgent}.
 */
export function buildHeadlessAgentArgs(
  harness: AgentHarness,
  prompt: string,
  options: AgentRunOptions,
): string[] {
  return [...harness.buildArgs(options), ...buildPromptArgs(harness, prompt)];
}
