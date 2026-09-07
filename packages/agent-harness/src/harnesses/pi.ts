/**
 * Pi harness.
 *
 * CLI: pi -p <prompt> [--model <model>]
 *
 * Uses `pi -p` for non-interactive (print) mode so the agent runs without
 * launching the interactive TUI.
 *
 * Effort is not a separate flag: pi encodes the thinking level in the model
 * string (`<id>:<thinking>`). {@link composePiModelWithEffort} appends the
 * requested effort to a configured model that does not already carry an
 * explicit thinking level.
 *
 * @see https://pi.dev/docs/latest/quickstart
 */

import { assertModeSupported } from "../modes.js";
import type { AgentEffort, AgentHarness, AgentRunOptions } from "../types.js";

/**
 * Compose pi's model string with a reasoning-effort (thinking) suffix.
 *
 * Pi's `--model` accepts `<id>`, `provider/id`, or `<id>:<thinking>` — the
 * thinking level is part of the model string, not a flag. Composition rules:
 *
 * - No effort → the model string unchanged (default behavior untouched).
 * - Effort without a model → `undefined`: there is nothing to attach the
 *   thinking level to, so the option cannot be expressed (the caller's
 *   default model and its default thinking level apply).
 * - Model already containing `:` → unchanged: the user picked an explicit
 *   provider/model/thinking combination, which wins over the generic effort.
 * - Otherwise → `<model>:<effort>`.
 *
 * Exported for tests.
 *
 * @param model - Raw `options.model` (may be undefined).
 * @param effort - Validated effort level (may be undefined).
 * @returns The model string to pass to `--model`, if any.
 */
export function composePiModelWithEffort(
  model: string | undefined,
  effort: AgentEffort | undefined,
): string | undefined {
  if (!effort) {
    return model;
  }
  if (!model) {
    return undefined;
  }
  if (model.includes(":")) {
    return model;
  }
  return `${model}:${effort}`;
}

export class PiHarness implements AgentHarness {
  readonly name = "pi";
  readonly displayName = "Pi";
  readonly defaultPath = "pi";
  readonly promptFlag = "-p";
  /** No native plan/read-only enforcement documented for headless `pi`. */
  readonly supportedModes = [] as const;
  /** `--mode json` emits the session event stream as JSON lines. */
  readonly supportsStructuredOutput = true;
  /**
   * Effort applies by composing the thinking level into the model string
   * (see {@link composePiModelWithEffort}); requires `options.model`.
   */
  readonly supportsEffort = true;

  /**
   * Build `pi` CLI flags for non-interactive (`-p`) execution.
   *
   * Supports `model` (`--model <pattern>`; accepts a model ID, `provider/id`,
   * or `<id>:<thinking>`) and `structuredOutput` (`--mode json`, which pairs
   * with the `-p` prompt flag: print mode with JSON event output). `effort`
   * is composed into the model string when a model is set (see
   * {@link composePiModelWithEffort}); without a model it cannot be applied
   * because pi has no separate thinking flag, so a one-line warning is
   * emitted instead of silently dropping the option. Pi's CLI does not
   * currently expose turns or permission flags.
   *
   * @param options - Accepted for interface compatibility; only `model`,
   *   `effort`, and `structuredOutput` are used.
   * @returns Args excluding the prompt (runner supplies `-p` via {@link promptFlag}).
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = [];

    const model = composePiModelWithEffort(options.model, options.effort);
    if (model) {
      args.push("--model", model);
    } else if (options.effort && !options.model) {
      console.warn(
        `⚠️  Pi (${this.name}) composes reasoning effort into the model string, but no model is ` +
          `set; ignoring effort "${options.effort}". ` +
          `Set AGENT_MODEL (or pass --model) to apply it.`,
      );
    }

    if (options.structuredOutput) {
      args.push("--mode", "json");
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
