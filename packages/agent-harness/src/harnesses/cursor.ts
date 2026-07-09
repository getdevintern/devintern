/**
 * Cursor CLI harness.
 *
 * CLI: agent -p [--force] [--trust] [--approve-mcps] [--model <model>] [prompt...]
 *
 * Uses `-p` / `--print` for non-interactive (headless) mode. The prompt is a
 * positional argument; runners append it after flags from {@link buildArgs}.
 *
 * @see https://cursor.com/docs/cli/headless
 */

import type { AgentHarness, AgentRunOptions } from "../types.js";

export class CursorHarness implements AgentHarness {
  readonly name = "cursor";
  readonly displayName = "Cursor";
  readonly defaultPath = "agent";

  /**
   * Build Cursor `agent` CLI flags for non-interactive (`-p`) execution.
   *
   * @param options - Supports `skipPermissions` (`--force`, `--trust`,
   *   `--approve-mcps`) and `model`.
   * @returns Args excluding the prompt (runner supplies it positionally).
   */
  buildArgs(options: AgentRunOptions): string[] {
    const args: string[] = ["-p"];

    if (options.skipPermissions) {
      args.push("--force", "--trust", "--approve-mcps");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Cursor does not currently support --max-turns.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
