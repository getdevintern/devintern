/**
 * Antigravity CLI harness (Google).
 *
 * CLI: agy -p <prompt> [--dangerously-skip-permissions]
 *
 * Uses `agy -p` for non-interactive / headless scripting. The prompt is passed
 * explicitly via the `-p` flag so runners never rely on stdin alone (agy is
 * TUI-first when no prompt flag is present).
 *
 * Google retired consumer Gemini CLI (2026-06-18) in favor of Antigravity CLI.
 * DevIntern routes the legacy harness name `gemini` to this implementation.
 *
 * Modes: none. Antigravity has no plan/read-only enforcement for headless
 * (`-p`) runs — print mode auto-approves all tool calls including file
 * writes, and `--sandbox` only restricts shell commands. The interactive
 * `--mode plan` startup flag (v1.1.0) is not documented to hold under `-p`,
 * so mapping readonly to it would risk a silent no-op instead of real
 * enforcement. Constrained mode requests therefore fail closed; analysis
 * spawns fall back to the default unattended path. Unlike the retired Gemini
 * CLI's `--approval-mode=plan`, this is an upstream gap — revisit when
 * https://github.com/google-antigravity/antigravity-cli/issues/45 lands.
 *
 * @see https://antigravity.google/docs/cli/overview
 * @see https://antigravity.google/docs/cli/install
 * @see https://antigravity.google/docs/cli/gcli-migration
 */

import { effectiveSkipPermissions, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class AntigravityHarness implements AgentHarness {
  readonly name = "antigravity";
  readonly displayName = "Antigravity CLI";
  /** Executable on PATH after install (`curl -fsSL https://antigravity.google/cli/install.sh | bash`). */
  readonly defaultPath = "agy";
  readonly promptFlag = "-p";

  /**
   * Build `agy` CLI flags for headless (`-p`) execution.
   *
   * @param options - Supports `skipPermissions` (`--dangerously-skip-permissions`).
   *   Model and max-turns are not exposed as stable CLI flags (model is chosen
   *   via `/model` or settings; no `--max-turns` equivalent documented).
   * @returns Args excluding the prompt (runner supplies `-p` via {@link promptFlag}).
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = [];

    if (effectiveSkipPermissions(options)) {
      // Official CLI override; confirmed for headless file edits / unattended runs.
      // Do not emit this when skipPermissions is false (fail closed for constrained use).
      args.push("--dangerously-skip-permissions");
    }

    // Antigravity does not currently document a stable `--model` flag for headless
    // runs (models are selected via `/model` or settings). Ignore options.model.
    //
    // Antigravity does not currently support --max-turns.
    // If it adds support in the future, uncomment:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
