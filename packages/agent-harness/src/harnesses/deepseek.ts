/**
 * DeepSeek (Reasonix) harness.
 *
 * CLI: reasonix run [--model <model>] <prompt>
 *
 * Uses `reasonix run` for one-shot, non-interactive execution. Product-facing
 * harness id is `deepseek`; the executable on PATH is `reasonix` (DeepSeek's
 * listed community coding agent / DeepSeek-Reasonix). There is no official
 * DeepSeek-branded coding CLI yet.
 *
 * `reasonix run` is already autonomous for writer tools (honours configured
 * `deny` rules). `--yolo` applies to interactive chat, not headless `run`, so
 * `skipPermissions` is a no-op here. Turn limits are config-only (`max_steps`).
 *
 * @see https://github.com/esengine/DeepSeek-Reasonix
 * @see https://api-docs.deepseek.com/quick_start/agent_integrations/reasonix
 */

import { assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class DeepSeekHarness implements AgentHarness {
  readonly name = "deepseek";
  readonly displayName = "Reasonix";
  readonly defaultPath = "reasonix";
  /** No native plan/read-only enforcement documented for headless `reasonix run`. */
  readonly supportedModes = [] as const;

  /**
   * Build `reasonix run` flags for non-interactive execution.
   *
   * @param options - Supports `model`. `skipPermissions` and `maxTurns` are not
   *   exposed as CLI flags for `reasonix run`.
   * @returns Args starting with `run`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = ["run"];

    // reasonix run is already non-interactive / autonomous for writers.
    // Interactive --yolo applies to chat mode only.

    if (options.model) {
      args.push("--model", options.model);
    }

    // Reasonix turn limits are configured via max_steps in reasonix.toml /
    // ~/.reasonix/config.toml, not a CLI --max-turns flag.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
