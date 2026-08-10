/**
 * Codex CLI harness.
 *
 * CLI: codex exec [--sandbox workspace-write --ask-for-approval never] [--model <model>] [prompt]
 *
 * Uses `codex exec` (non-interactive mode) so the agent runs without
 * launching the TUI.
 *
 * Modes:
 * - plan / readonly → `--sandbox read-only` (OS-enforced; no file writes)
 * - Default + skipPermissions → `--sandbox workspace-write --ask-for-approval never`
 *
 * Constrained-mode caveats (per OpenAI approvals/security docs, 2026-07):
 * shell still works in the read-only sandbox (filesystem is read-only at the
 * OS level), but network is disabled inside it. MCP servers are spawned
 * outside the sandbox and are NOT restricted by it — read-only mode is not a
 * guarantee against MCP-side effects.
 *
 * @see https://platform.openai.com/docs/codex
 */

import { effectiveSkipPermissions, isConstrainedMode, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class CodexHarness implements AgentHarness {
  readonly name = "codex";
  readonly displayName = "Codex";
  readonly defaultPath = "codex";
  readonly supportedModes = ["plan", "readonly"] as const;
  /** Codex `exec` accepts images via `-i` after the prompt. */
  readonly imageInput = "native" as const;

  /**
   * Build trailing `-i` flags for native image attachment.
   *
   * Must be appended **after** the prompt in `codex exec` mode.
   *
   * @param paths - Absolute image file paths.
   */
  buildImageArgs(paths: readonly string[]): string[] {
    const args: string[] = [];
    for (const path of paths) {
      if (path.trim()) {
        args.push("-i", path);
      }
    }
    return args;
  }

  /**
   * Build `codex exec` flags for non-interactive execution.
   *
   * @param options - Supports `mode`, `skipPermissions` (sandbox + approval), and `model`.
   * @returns Args starting with `exec`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = ["exec"];

    if (isConstrainedMode(options.mode)) {
      // Hard read-only sandbox for both plan and readonly (Codex has no separate plan flag).
      args.push("--sandbox", "read-only", "--ask-for-approval", "never");
    } else if (effectiveSkipPermissions(options)) {
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
