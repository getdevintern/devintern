/**
 * Muse Code harness.
 *
 * CLI: muse exec [--prompt-file <path> | <prompt>] [flags…]
 *
 * Uses Meta's headless `muse exec` surface, which runs one prompt to
 * completion and exits. Plain text is the default so transcript-based
 * diagnostics and live output keep working; `--json` is emitted only when the
 * caller requests structured output.
 *
 * Unattended behavior:
 * - `--disable-approval` when {@link AgentRunOptions.skipPermissions} is set.
 *   It skips approval prompts but keeps Muse's OS sandbox on. `--yolo` (which
 *   also disables the sandbox and trusts the workspace) is deliberately not
 *   emitted: a review checkout must not auto-trust attacker-controlled
 *   skills/rules.
 * - `--disable-request-user-input` is always emitted for headless runs so the
 *   agent cannot block on an interactive question.
 * - `--max-model-steps` maps the shared `maxTurns` budget to Muse's model-step
 *   cap.
 *
 * Modes: `readonly` maps to Muse's built-in `:read-only` permission profile.
 * Muse has no headless plan mode; `plan` fails closed in `assertModeSupported`.
 *
 * Prompt size: the shared prompt builder uses {@link promptFileFlag} for
 * prompts too large for one argv entry, handing the full prompt to Muse via
 * `--prompt-file` instead of a no-op pointer.
 *
 * @see https://dev.meta.ai/docs/muse-code/extending#headless-and-ci
 * @see https://dev.meta.ai/docs/muse-code/configuration#launch-flags
 * @see https://dev.meta.ai/docs/muse-code/permissions
 */

import { assertModeSupported, effectiveSkipPermissions, isConstrainedMode } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

/** Muse's built-in read-only permission profile id. */
export const MUSE_READONLY_PROFILE = ":read-only";

export class MuseHarness implements AgentHarness {
  readonly name = "muse";
  readonly displayName = "Muse Code";
  readonly defaultPath = "muse";
  /**
   * `muse exec --prompt-file <path>` reads the prompt from a file. The shared
   * prompt builder only uses it when a prompt exceeds the argv budget.
   */
  readonly promptFileFlag = "--prompt-file";
  /** `muse exec` parses positionals with clap; `--` protects dash-leading prompts. */
  readonly endOfOptionsMarker = "--";
  /** `readonly` is enforced by the documented `:read-only` permission profile. */
  readonly supportedModes = ["readonly"] as const;
  /** `--max-model-steps` caps the run, and exhaustion prints "This turn reached its step limit." */
  readonly supportsMaxTurns = true;
  /** `--json` emits JSONL events on stdout. */
  readonly supportsStructuredOutput = true;
  /** `--reasoning-effort` accepts the shared low/medium/high levels. */
  readonly supportsEffort = true;

  /**
   * Build `muse exec` flags for a non-interactive run.
   *
   * The prompt is not included: it is appended by the shared prompt builder as
   * a positional argument, or as `--prompt-file <path>` for oversized prompts.
   *
   * @param options - Supports `mode`, `skipPermissions`, `model`, `effort`,
   *   `workingDir`, `structuredOutput`, and `maxTurns`.
   * @returns Args starting with `exec`; prompt is appended separately.
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);

    // Headless runs must never wait on the interactive question tool.
    const args: string[] = ["exec", "--disable-request-user-input"];

    if (isConstrainedMode(options.mode)) {
      // The profile itself is read-only; never combine it with a bypass flag.
      args.push("--permission-profile", MUSE_READONLY_PROFILE);
    } else if (effectiveSkipPermissions(options)) {
      // Keep Muse's sandbox in place; only skip the approval gate.
      args.push("--disable-approval");
    }

    // Muse roots policy-gated workspace tools at this path. Most runs already
    // inherit the spawn cwd, so this only matters when a caller passes an
    // explicit working directory (for example an analysis run).
    if (options.workingDir) {
      args.push("--workspace", options.workingDir);
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.effort) {
      args.push("--reasoning-effort", options.effort);
    }

    if (options.structuredOutput) {
      args.push("--json");
    }

    if (options.maxTurns !== undefined) {
      args.push("--max-model-steps", String(options.maxTurns));
    }

    return args;
  }
}
