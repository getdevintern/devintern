/**
 * Pi harness.
 *
 * CLI: pi -p <prompt>
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
   * Pi's CLI does not currently expose model, turns, or permission flags.
   *
   * @param _options - Accepted for interface compatibility; currently unused.
   * @returns Empty args; prompt is supplied via {@link promptFlag}.
   */
  buildArgs(_options: AgentRunOptions): string[] {
    assertModeSupported(this, _options.mode);
    const args: string[] = [];

    // Pi does not currently expose --model, --max-turns, or
    // --skip-permissions flags on its CLI in documented form.
    // If support is added in the future, uncomment the following:
    // if (_options.model) {
    //   args.push("--model", _options.model);
    // }
    // if (_options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(_options.maxTurns));
    // }

    return args;
  }
}
