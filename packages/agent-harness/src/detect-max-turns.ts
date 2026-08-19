/**
 * Detect max-turns exhaustion from agent CLI stdout/stderr.
 *
 * Claude Code (`-p` / stdin) emits `Error: Reached max turns (N)` on stdout
 * with exit code 1. Match that as a complete diagnostic line — a substring
 * scan of the whole transcript also sees this repository's own source, lint
 * dumps, and diffs (DEV-70 Codex cron false positive).
 *
 * Do not treat stderr as trusted: Codex writes its tool transcript there.
 * Callers should also skip detection when the harness cannot impose a CLI
 * turn limit (`supportsMaxTurns`).
 */

import { isSourceOrDiffLine, outputLines } from "./output-lines.js";

const MAX_TURNS_PATTERNS = [
  /^(?:error:\s*)?reached max turns(?:\s*\(\d+\))?[.!]?$/i,
  /^(?:error:\s*)?max(?:imum)? turns reached[.!]?$/i,
] as const;

/**
 * Return the diagnostic line that indicates a max-turns limit, if any.
 *
 * @param stdout - Captured standard output
 * @param stderr - Captured standard error
 */
export function findMaxTurnsReachedLine(stdout: string, stderr: string): string | undefined {
  const lines = [...outputLines(stderr), ...outputLines(stdout)];
  const matched = lines.find((line) => {
    const normalized = line.normalized.trim();
    if (!normalized || isSourceOrDiffLine(normalized)) {
      return false;
    }
    return MAX_TURNS_PATTERNS.some((pattern) => pattern.test(normalized));
  });
  return matched?.raw.trim();
}

/**
 * Return whether agent output indicates the conversation hit a max-turns limit.
 *
 * @param stdout - Captured standard output
 * @param stderr - Captured standard error
 * @param supportsMaxTurns - When false, skip scanning (harness cannot hit a CLI turn limit)
 */
export function detectMaxTurnsReached(
  stdout: string,
  stderr: string,
  supportsMaxTurns: boolean = true,
): boolean {
  if (!supportsMaxTurns) {
    return false;
  }
  return findMaxTurnsReachedLine(stdout, stderr) !== undefined;
}
