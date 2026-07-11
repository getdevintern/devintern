/**
 * Qwen Code harness.
 *
 * CLI: qwen --prompt <prompt> [--yolo]
 *
 * Uses `qwen --prompt` (headless mode) for non-interactive scripting.
 *
 * @see https://qwenlm.github.io/qwen-code-docs/
 */

import { effectiveSkipPermissions, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class QwenCodeHarness implements AgentHarness {
  readonly name = "qwen";
  readonly displayName = "Qwen Code";
  readonly defaultPath = "qwen";
  readonly promptFlag = "-p";
  /** No native plan/read-only enforcement documented for headless `qwen`. */
  readonly supportedModes = [] as const;

  /**
   * Build `qwen` CLI flags for headless (`-p`) execution.
   *
   * @param options - Supports `skipPermissions` (`--yolo`); model is config-file only.
   * @returns Args excluding the prompt (runner supplies `-p` via {@link promptFlag}).
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = [];

    if (effectiveSkipPermissions(options)) {
      args.push("--yolo");
    }

    // Qwen Code does not currently support --model via CLI flag.
    // Model selection is configured via ~/.qwen/settings.json.
    // If it adds support in the future, uncomment the following:
    // if (options.model) {
    //   args.push("--model", options.model);
    // }

    // Qwen Code does not currently support --max-turns.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
