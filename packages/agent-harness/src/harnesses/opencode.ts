/**
 * Opencode harness.
 *
 * CLI: opencode run <prompt> [-m <model>] [--dangerously-skip-permissions]
 *
 * Uses `opencode run` for non-interactive mode. The prompt is passed as a
 * positional argument. Permissions are auto-approved with
 * `--dangerously-skip-permissions`.
 *
 * Unlike most harnesses, `opencode run` does NOT inherit the spawned process's
 * working directory for its own tool calls — it defaults to `$HOME` unless the
 * directory is passed explicitly via `--dir`. We therefore forward
 * `options.workingDir` as `--dir` so the agent operates inside the intended
 * repo/worktree rather than wandering the home directory.
 *
 * Modes:
 * - plan / readonly → `--agent plan` (built-in plan agent; edits denied)
 * - Never pass `--dangerously-skip-permissions` in constrained modes.
 *
 * Constrained-mode toolset caveat (verified on opencode 1.17.7, 2026-07): the
 * plan agent refuses bash as well as write/edit/patch — the agent explores via
 * native read/grep/glob only (refusals are graceful: exit 0, no hang). Fine
 * for read-and-emit-JSON analysis; do not use for tasks that need shell.
 *
 * @see https://opencode.ai/docs/cli/
 * @see https://opencode.ai/docs/agents/
 */

import { effectiveSkipPermissions, isConstrainedMode, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class OpencodeHarness implements AgentHarness {
  readonly name = "opencode";
  readonly displayName = "Opencode";
  readonly defaultPath = "opencode";
  readonly supportedModes = ["plan", "readonly"] as const;

  /**
   * Build `opencode run` flags for non-interactive execution.
   *
   * @param options - Supports `mode`, `skipPermissions`, `model`, and `workingDir`.
   * @returns Args starting with `run`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = ["run"];

    if (isConstrainedMode(options.mode)) {
      args.push("--agent", "plan");
    } else if (effectiveSkipPermissions(options)) {
      args.push("--dangerously-skip-permissions");
    }

    // opencode ignores the spawn cwd, so anchor it to the intended directory.
    if (options.workingDir) {
      args.push("--dir", options.workingDir);
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Opencode does not currently support --max-turns.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
