/**
 * Gemini CLI harness.
 *
 * CLI: gemini -p <prompt> [--approval-mode=yolo] [--model <model>]
 *
 * Uses `gemini -p` for non-interactive scripting. The prompt is passed
 * explicitly via the `-p` flag.
 *
 * @see https://geminicli.com/docs/
 */

import type { AgentHarness, AgentRunOptions } from "../types.js";

export class GeminiHarness implements AgentHarness {
  readonly name = "gemini";
  readonly displayName = "Gemini CLI";
  readonly defaultPath = "gemini";
  readonly promptFlag = "-p";

  /**
   * Build `gemini` CLI flags for non-interactive (`-p`) execution.
   *
   * @param options - Supports `skipPermissions` (`--approval-mode=yolo`) and `model`.
   * @returns Args excluding the prompt (runner supplies `-p` via {@link promptFlag}).
   */
  buildArgs(options: AgentRunOptions): string[] {
    const args: string[] = [];

    if (options.skipPermissions) {
      args.push("--approval-mode=yolo");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Gemini CLI does not currently support --max-turns.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
