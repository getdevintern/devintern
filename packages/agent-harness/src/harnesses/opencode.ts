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
 * @see https://opencode.ai/docs/cli/
 */

import type { AgentHarness, AgentRunOptions } from "../types.js";

export class OpencodeHarness implements AgentHarness {
  readonly name = "opencode";
  readonly displayName = "Opencode";
  readonly defaultPath = "opencode";

  /**
   * Build `opencode run` flags for non-interactive execution.
   *
   * @param options - Supports `skipPermissions`, `model`, and `workingDir`.
   * @returns Args starting with `run`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions): string[] {
    const args: string[] = ["run"];

    if (options.skipPermissions) {
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
