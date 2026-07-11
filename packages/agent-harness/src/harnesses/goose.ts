/**
 * Goose CLI harness.
 *
 * CLI: goose run -t <prompt> [--model <model>] [--provider <provider>]
 *
 * Uses `goose run -t` for non-interactive scripting. The prompt is passed
 * explicitly via the `-t` flag.
 *
 * Goose defaults to "Auto Mode" (fully autonomous), so no extra
 * skip-permissions flag is needed.
 *
 * @see https://goose-docs.ai/docs/guides/goose-cli-commands
 */

import { effectiveSkipPermissions, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class GooseHarness implements AgentHarness {
  readonly name = "goose";
  readonly displayName = "Goose";
  readonly defaultPath = "goose";
  readonly promptFlag = "-t";
  /** No native plan/read-only enforcement documented for headless `goose run`. */
  readonly supportedModes = [] as const;

  /**
   * Build `goose run` flags for non-interactive (`-t`) execution.
   *
   * @param options - Supports `skipPermissions` (`--no-session`) and `model`.
   * @returns Args starting with `run`; prompt is supplied via {@link promptFlag}.
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = ["run"];

    if (effectiveSkipPermissions(options)) {
      // Goose defaults to Auto Mode (fully autonomous).
      // No explicit flag is required, but we add --no-session
      // to avoid creating a session file in unattended mode.
      args.push("--no-session");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Goose does not currently support --max-turns via CLI flag.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
