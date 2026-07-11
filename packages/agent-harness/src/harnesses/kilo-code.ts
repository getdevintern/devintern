/**
 * Kilo Code CLI harness.
 *
 * CLI: kilo run <prompt> [--auto] [-m <model>]
 *
 * Uses `kilo run` for non-interactive scripting. The prompt is passed as a
 * positional argument after the `run` subcommand.
 *
 * @see https://kilo.ai/docs
 */

import { effectiveSkipPermissions, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class KiloCodeHarness implements AgentHarness {
  readonly name = "kilo-code";
  readonly displayName = "Kilo Code";
  readonly defaultPath = "kilo";
  /** No native plan/read-only enforcement documented for headless `kilo run`. */
  readonly supportedModes = [] as const;

  /**
   * Build `kilo run` subcommand flags for non-interactive execution.
   *
   * @param options - Supports `skipPermissions` (`--auto`) and `model`.
   * @returns Args starting with `run`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = ["run"];

    if (effectiveSkipPermissions(options)) {
      args.push("--auto");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Kilo Code does not currently support --max-turns.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
