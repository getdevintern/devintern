/**
 * Cline CLI harness.
 *
 * CLI: cline task <prompt> [-y] [-m <model>] [--json]
 *
 * Uses `cline task` for non-interactive scripting. The prompt is passed as a
 * positional argument after the `task` subcommand.
 *
 * @see https://docs.cline.bot/
 */

import { effectiveSkipPermissions, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class ClineHarness implements AgentHarness {
  readonly name = "cline";
  readonly displayName = "Cline";
  readonly defaultPath = "cline";
  /** No native plan/read-only enforcement documented for headless `cline task`. */
  readonly supportedModes = [] as const;

  /**
   * Build `cline task` subcommand flags for non-interactive execution.
   *
   * @param options - Supports `skipPermissions` (`--yolo`) and `model`.
   * @returns Args starting with `task`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = ["task"];

    if (effectiveSkipPermissions(options)) {
      args.push("--yolo");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Cline does not currently support --max-turns.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
