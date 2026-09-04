/**
 * Cursor CLI harness.
 *
 * CLI: cursor-agent -p [--force] [--trust] [--approve-mcps] [--model <model>] [prompt...]
 *
 * Uses `-p` / `--print` for non-interactive (headless) mode. The prompt is a
 * positional argument; runners append it after flags from {@link buildArgs}.
 *
 * Modes:
 * - plan → `--mode plan` (read-only planning; no edits)
 * - readonly → `--mode ask` (Q&A / exploration; no edits)
 * - Never pass `--force` / `--yolo` in constrained modes.
 *
 * Constrained-mode toolset caveat (verified on cursor-agent, 2026-07): ask/plan
 * modes remove the shell tool entirely — the agent cannot run `git log`, tests,
 * or any command, only native read/grep/glob. Blocked attempts are refused
 * in-band (exit 0, no hang). We also drop `--approve-mcps`, so unapproved MCP
 * servers are unavailable. Fine for read-and-emit-JSON analysis; do not use
 * these modes for tasks that need shell or MCP.
 *
 * @see https://cursor.com/docs/cli/headless
 */

import { effectiveSkipPermissions, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export class CursorHarness implements AgentHarness {
  readonly name = "cursor";
  readonly displayName = "Cursor";
  // Cursor installs both `agent` and `cursor-agent` symlinks; use the
  // unambiguous name — other CLIs (e.g. Grok) also install as `agent`.
  readonly defaultPath = "cursor-agent";
  readonly supportedModes = ["plan", "readonly"] as const;
  /** `--output-format json` emits one result object on completion (requires `-p`). */
  readonly supportsStructuredOutput = true;
  /**
   * The prompt is a positional argument parsed by commander; without this
   * marker a prompt starting with `-` (e.g. markdown frontmatter) fails with a
   * usage error. Verified `cursor-agent -p -- "<prompt>"` parses correctly.
   */
  readonly endOfOptionsMarker = "--";

  /**
   * Build Cursor `agent` CLI flags for non-interactive (`-p`) execution.
   *
   * @param options - Supports `mode`, `skipPermissions` (`--force`, `--trust`,
   *   `--approve-mcps`), `model`, and `structuredOutput`.
   * @returns Args excluding the prompt (runner supplies it positionally).
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = ["-p"];

    if (options.mode === "plan") {
      args.push("--mode", "plan");
      // Headless runs need workspace trust without interactive prompts.
      args.push("--trust");
    } else if (options.mode === "readonly") {
      args.push("--mode", "ask");
      args.push("--trust");
    } else if (effectiveSkipPermissions(options)) {
      args.push("--force", "--trust", "--approve-mcps");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.structuredOutput) {
      args.push("--output-format", "json");
    }

    // Cursor does not currently support --max-turns.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
