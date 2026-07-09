/**
 * Claude Code harness.
 *
 * CLI: claude -p <prompt> [--dangerously-skip-permissions] [--model <model>] [--max-turns N]
 *
 * `-p` takes the prompt as its value (non-interactive / print mode).
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/cli
 */

import type { AgentHarness, AgentRunOptions } from "../types.js";

export class ClaudeCodeHarness implements AgentHarness {
  readonly name = "claude-code";
  readonly displayName = "Claude Code";
  readonly defaultPath = "claude";
  readonly promptFlag = "-p";

  /**
   * Build `claude` CLI flags for non-interactive (`-p`) execution.
   *
   * @param options - Supports `skipPermissions`, `model`, and `maxTurns`.
   * @returns Args excluding the prompt (runner supplies `-p` via {@link promptFlag}).
   */
  buildArgs(options: AgentRunOptions): string[] {
    const args: string[] = [];

    if (options.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.maxTurns !== undefined) {
      args.push("--max-turns", String(options.maxTurns));
    }

    return args;
  }
}
