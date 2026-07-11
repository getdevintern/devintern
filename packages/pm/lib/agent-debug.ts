/**
 * Debug dumps of raw agent output for diagnosing parse failures.
 *
 * Interactive mode can't show long raw output in the UI, so failures write
 * the full stdout/stderr (plus the args devpm spawned the agent with) to a
 * file and surface its path in the error message.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunResult } from "@devintern/agent-harness";

/**
 * Write the raw agent result to a timestamped log file in the OS temp dir.
 *
 * @param label - Short slug for the failing step (e.g. `story-generation`).
 * @param result - The agent run result whose output failed to parse.
 * @param context - Extra lines to record (harness name, CLI args, etc.).
 * @returns Absolute path of the written file, or `null` if writing failed.
 */
export async function dumpAgentOutput(
  label: string,
  result: AgentRunResult,
  context: Record<string, string> = {},
): Promise<string | null> {
  const file = join(tmpdir(), `devpm-${label}-${Date.now()}.log`);
  const contextLines = Object.entries(context)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const content = [
    `devpm agent output dump — ${label}`,
    contextLines,
    `exitCode: ${result.exitCode}`,
    `maxTurnsReached: ${result.maxTurnsReached}`,
    "",
    `=== stdout (${result.stdout.length} chars) ===`,
    result.stdout,
    "",
    `=== stderr (${result.stderr.length} chars) ===`,
    result.stderr,
    "",
  ].join("\n");
  try {
    await Bun.write(file, content);
    return file;
  } catch {
    return null;
  }
}
