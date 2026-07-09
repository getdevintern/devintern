/**
 * Codex CLI harness.
 *
 * CLI: codex exec [--sandbox workspace-write --ask-for-approval never] [--model <model>] [prompt]
 *
 * Uses `codex exec` (non-interactive mode) so the agent runs without
 * launching the TUI.
 *
 * @see https://platform.openai.com/docs/codex
 */

import type { AgentHarness, AgentRunOptions } from "../types.js";

export class CodexHarness implements AgentHarness {
  readonly name = "codex";
  readonly displayName = "Codex";
  readonly defaultPath = "codex";

  /**
   * Build `codex exec` flags for non-interactive execution.
   *
   * @param options - Supports `skipPermissions` (sandbox + approval) and `model`.
   * @returns Args starting with `exec`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions): string[] {
    const args: string[] = ["exec"];

    if (options.skipPermissions) {
      args.push("--sandbox", "workspace-write", "--ask-for-approval", "never");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Codex does not currently support --max-turns in exec mode.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
