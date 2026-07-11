/**
 * Grok Build (xAI) harness.
 *
 * CLI: grok -p <prompt> [--always-approve] [-m <model>] [--cwd <dir>] [--no-auto-update]
 *
 * Uses `grok -p` (headless / single-prompt mode) for non-interactive scripting.
 * Product name is "Grok Build"; the executable on PATH is `grok`.
 *
 * Modes:
 * - plan / readonly → `--permission-mode plan` (explore + plan; no source edits)
 * - Never combine with `--always-approve` in constrained modes.
 *
 * Constrained-mode caveat (verified on grok 0.2.93, 2026-07): plan mode blocks
 * file writes silently — the headless run still exits 0 and the model may even
 * claim the write succeeded, so never trust the transcript over the filesystem.
 * Shell availability under plan mode is undocumented; assume a reduced toolset
 * and use these modes only for read-and-emit-JSON analysis.
 *
 * Do NOT try to re-enable web tools in plan mode via `--allow`: verified on
 * 0.2.93 (2026-07) that a `web_fetch` attempt under `--permission-mode plan`
 * makes the headless run return empty stdout with exit 0 — even with
 * `--allow web_fetch` — while the same fetch works under `--always-approve`.
 * `options.allowedTools` is therefore intentionally ignored here.
 *
 * @see https://docs.x.ai/build/cli/headless-scripting
 * @see https://x.ai/cli
 */

import { effectiveSkipPermissions, isConstrainedMode, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class GrokHarness implements AgentHarness {
  readonly name = "grok";
  readonly displayName = "Grok Build";
  readonly defaultPath = "grok";
  readonly promptFlag = "-p";
  readonly supportedModes = ["plan", "readonly"] as const;

  /**
   * Build `grok` CLI flags for headless (`-p`) execution.
   *
   * @param options - Supports `mode`, `skipPermissions` (`--always-approve`), `model` (`-m`),
   *   and `workingDir` (`--cwd`).
   * @returns Args excluding the prompt (runner supplies `-p` via {@link promptFlag}).
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    // Skip background update checks in automated / CI runs.
    const args: string[] = ["--no-auto-update"];

    if (isConstrainedMode(options.mode)) {
      args.push("--permission-mode", "plan");
    } else if (effectiveSkipPermissions(options)) {
      args.push("--always-approve");
    }

    if (options.model) {
      args.push("-m", options.model);
    }

    if (options.workingDir) {
      args.push("--cwd", options.workingDir);
    }

    // Grok Build does not currently support --max-turns.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
