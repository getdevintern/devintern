/**
 * Pi harness.
 *
 * CLI: pi -p <prompt> [--model <model>]
 *
 * Uses `pi -p` for non-interactive (print) mode so the agent runs without
 * launching the interactive TUI.
 *
 * @see https://pi.dev/docs/latest/quickstart
 */

import { assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class PiHarness implements AgentHarness {
  readonly name = "pi";
  readonly displayName = "Pi";
  readonly defaultPath = "pi";
  readonly promptFlag = "-p";
  /** No native plan/read-only enforcement documented for headless `pi`. */
  readonly supportedModes = [] as const;

  /**
   * Build `pi` CLI flags for non-interactive (`-p`) execution.
   *
   * Supports `model` (`--model <pattern>`; accepts a model ID, `provider/id`,
   * or `<id>:<thinking>`). Pi's CLI does not currently expose turns or
   * permission flags.
   *
   * @param options - Accepted for interface compatibility; only `model` is used.
   * @returns Args excluding the prompt (runner supplies `-p` via {@link promptFlag}).
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = [];

    if (options.model) {
      args.push("--model", options.model);
    }

    // Pi does not currently expose --max-turns or
    // --skip-permissions flags on its CLI in documented form.
    // If support is added in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
