/**
 * Prompt argument construction shared by runners and external callers.
 */

import type { AgentHarness } from "./types.js";

/**
 * Build the argv entries that feed the prompt to a harness CLI.
 *
 * Harnesses with a `promptFlag` (e.g. `grok -p`, `kimi --prompt`) receive the
 * prompt as that flag's value; all others take it as a positional argument
 * after the flags from `buildArgs()`. Prefer this over piping the prompt via
 * stdin: several CLIs (Grok Build, Antigravity CLI / agy, Kimi CLI) launch their
 * interactive TUI when no prompt argument is present and then fail without a
 * controlling terminal.
 *
 * @param harness - Harness definition supplying the optional `promptFlag`.
 * @param prompt - Full prompt text.
 * @returns Argv entries to append after `harness.buildArgs()` output.
 */
export function buildPromptArgs(harness: AgentHarness, prompt: string): string[] {
  return harness.promptFlag ? [harness.promptFlag, prompt] : [prompt];
}
