/**
 * Prompt argument construction shared by runners and external callers.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentHarness } from "./types.js";

/**
 * Largest prompt handed to a CLI as a single argv entry.
 *
 * Linux rejects one argument of `MAX_ARG_STRLEN` (32 pages, 131072 bytes) with
 * `E2BIG: argument list too long` when `posix_spawn` runs the child — and the
 * sandbox wrapper adds argv entries of its own around the prompt, so the real
 * budget can be lower still. Stay well behind the kernel's limit: a review of a
 * large PR exceeds it easily (a 44-file diff is ~137 KB before the template).
 */
export const MAX_PROMPT_ARG_BYTES = 120_000;

/**
 * Directory holding prompts too large for argv. Shared by every run in the
 * process and keyed by content, so retries reuse one file instead of piling up.
 */
const OVERSIZED_PROMPT_DIR = join(tmpdir(), "devintern-prompts");

/**
 * Write an oversized prompt to a private temp file and return a short prompt
 * that points the agent at it.
 *
 * Agents reach this path when their instructions (a diff, findings, and task
 * content) cannot fit one argv string. Every supported harness is a coding
 * agent with file tools, so an absolute path is a portable hand-off.
 *
 * @param prompt - Full prompt text.
 * @returns Bootstrap prompt naming the file that holds it.
 */
function externalizePrompt(prompt: string): string {
  const digest = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  const path = join(OVERSIZED_PROMPT_DIR, `${digest}.md`);
  try {
    mkdirSync(OVERSIZED_PROMPT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, prompt, { mode: 0o600 });
  } catch (error) {
    // Falling back to argv reproduces the original E2BIG failure, but it is
    // still better than throwing away the run when only temp storage is broken.
    console.warn(`⚠️  Could not externalize an oversized prompt to ${path}: ${error}`);
    return prompt;
  }
  return [
    "Your instructions for this run are too large to pass on the command line,",
    "so they were written to the file below.",
    "",
    `    ${path}`,
    "",
    "Read that file in full before taking any other action, treat its contents as",
    "your task prompt, and carry out its instructions exactly.",
  ].join("\n");
}

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
 * Prompts larger than {@link MAX_PROMPT_ARG_BYTES} (bytes, not characters) are
 * written to a temp file and replaced with a short pointer, because the kernel
 * rejects a single oversized argv entry with `E2BIG` before the CLI starts.
 *
 * Positional prompts that begin with `-` (markdown frontmatter, bullet lists)
 * would be parsed as CLI flags and rejected. Harnesses that declare an
 * `endOfOptionsMarker` get the marker emitted before such a prompt.
 *
 * @param harness - Harness definition supplying the optional `promptFlag`.
 * @param prompt - Full prompt text.
 * @returns Argv entries to append after `harness.buildArgs()` output.
 */
export function buildPromptArgs(harness: AgentHarness, prompt: string): string[] {
  const effective =
    Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_ARG_BYTES ? externalizePrompt(prompt) : prompt;

  if (harness.promptFlag) {
    return [harness.promptFlag, effective];
  }
  if (effective.startsWith("-") && harness.endOfOptionsMarker) {
    return [harness.endOfOptionsMarker, effective];
  }
  return [effective];
}
