/**
 * Claude Code harness.
 *
 * CLI: claude -p <prompt> [--dangerously-skip-permissions] [--model <model>] [--max-turns N]
 *
 * `-p` takes the prompt as its value (non-interactive / print mode).
 *
 * Modes:
 * - plan / readonly → `--permission-mode plan` (reads only; plan-focused)
 * - Never combine with `--dangerously-skip-permissions` (that would override plan).
 *
 * Constrained-mode caveats (verified live in `-p` mode, 2026-07): plan mode
 * auto-approves file reads, grep/glob, and read-only bash commands; writes
 * and non-annotated MCP tools need allow rules, and in print mode a denied
 * tool aborts the run rather than prompting. We therefore emit
 * `--allowedTools WebFetch,WebSearch` in constrained modes — web reads don't
 * mutate the workspace, and tasks often reference external docs (verified:
 * plan mode + this allowlist fetches successfully headless). MCP servers the
 * user enabled can be granted via `options.allowedTools`
 * (e.g. `mcp__notion`); see the caution on that option about write tools.
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/cli
 * @see https://code.claude.com/docs/en/permission-modes
 */

import { effectiveSkipPermissions, isConstrainedMode, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class ClaudeCodeHarness implements AgentHarness {
  readonly name = "claude-code";
  readonly displayName = "Claude Code";
  readonly defaultPath = "claude";
  readonly promptFlag = "-p";
  readonly supportedModes = ["plan", "readonly"] as const;

  /**
   * Build `claude` CLI flags for non-interactive (`-p`) execution.
   *
   * @param options - Supports `mode`, `skipPermissions`, `model`, and `maxTurns`.
   * @returns Args excluding the prompt (runner supplies `-p` via {@link promptFlag}).
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = [];

    if (isConstrainedMode(options.mode)) {
      // Claude's plan permission mode is read-only for source edits.
      args.push("--permission-mode", "plan");
      // Web reads don't mutate the workspace; keep them available so plan
      // mode doesn't lose access to docs linked from task descriptions.
      const allowed = ["WebFetch", "WebSearch", ...(options.allowedTools ?? [])];
      args.push("--allowedTools", allowed.join(","));
    } else if (effectiveSkipPermissions(options)) {
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
