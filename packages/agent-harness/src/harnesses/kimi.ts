/**
 * Kimi CLI harness.
 *
 * CLI: kimi --print --prompt <prompt> [--yolo] [--model <model>]
 *
 * Uses `kimi --print` for non-interactive scripting. The prompt is passed
 * explicitly via the `--prompt` flag.
 *
 * @see https://moonshotai.github.io/kimi-cli/
 */

import type { AgentHarness, AgentRunOptions } from "../types.js";

export class KimiHarness implements AgentHarness {
  readonly name = "kimi";
  readonly displayName = "Kimi CLI";
  readonly defaultPath = "kimi";
  readonly promptFlag = "--prompt";

  /**
   * Build `kimi --print` flags for non-interactive execution.
   *
   * @param options - Supports `skipPermissions` (`--yolo`) and `model`.
   * @returns Args including `--print`; prompt is supplied via {@link promptFlag}.
   */
  buildArgs(options: AgentRunOptions): string[] {
    const args: string[] = ["--print"];

    if (options.skipPermissions) {
      args.push("--yolo");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Kimi CLI does not currently support --max-turns.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
