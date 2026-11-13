/**
 * Detect an incomplete agent implementation from its final answer.
 *
 * Used when the agent exits 0 but may not have produced meaningful work. The
 * full stdout is *not* a trustworthy signal: agents print source files, docs,
 * and test output, and earlier versions matched phrases like "a harness whose
 * CLI cannot emit JSON" (which contains "I cannot") or "I could not verify the
 * live account" inside a Verification section. Either one escalated a run that
 * had implemented and verified its work.
 *
 * So only the agent's final answer is inspected:
 *
 * - when the implementation-summary protocol is present, that block is the
 *   final answer (progress and tool output stay outside it);
 * - otherwise the tail of stdout is used, which is where the last message
 *   lands across harnesses.
 *
 * Failure patterns additionally demand completion vocabulary, so an advisory
 * "could not verify X" never counts as an unfinished implementation. Stderr is
 * intentionally excluded: agents like Cursor emit transient "Error:" lines for
 * recovered tool failures that must not mark success as incomplete.
 */

import {
  IMPLEMENTATION_SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START,
} from "./implementation-summary.js";

const FAILURE_PATTERNS = [
  // The pronoun needs a word boundary: "CLI cannot", "AI could not". The verb
  // and object keep advisory notes such as "I could not verify X" out.
  /\bI (?:was |am )?(?:unable|cannot|can't|could not|couldn't)(?: to)? (?:complete|finish|implement|deliver)\b(?=[^.\n]{0,40}\b(?:tasks?|tickets?|implementations?|work|features?|changes?)\b)/i,
  /\bimplementation (?:was|is) unsuccessful\b/i,
  /\bfailed to implement\b/i,
  /\bI apologize, but I (?:could not|cannot|was unable)\b/i,
] as const;

const MIN_OUTPUT_LENGTH = 100;

/** Characters of the final message inspected when the summary protocol is absent. */
const FINAL_ANSWER_TAIL_CHARS = 4000;

export interface IncompleteImplementationResult {
  incomplete: boolean;
  reasons: string[];
}

/**
 * Extract the region of stdout that carries the agent's final answer.
 *
 * @param stdout - Captured standard output.
 * @returns The summary block when present, else the tail of the output.
 */
function finalAnswerScope(stdout: string): string {
  const start = stdout.lastIndexOf(IMPLEMENTATION_SUMMARY_START);
  if (start >= 0) {
    const end = stdout.indexOf(IMPLEMENTATION_SUMMARY_END, start);
    return end > start
      ? stdout.slice(start + IMPLEMENTATION_SUMMARY_START.length, end)
      : stdout.slice(start);
  }
  const trimmed = stdout.trimEnd();
  return trimmed.length > FINAL_ANSWER_TAIL_CHARS
    ? trimmed.slice(-FINAL_ANSWER_TAIL_CHARS)
    : trimmed;
}

/**
 * Return whether agent stdout indicates an incomplete or failed implementation.
 *
 * @param stdout - Captured standard output
 */
export function detectIncompleteImplementation(stdout: string): IncompleteImplementationResult {
  const reasons: string[] = [];

  if (FAILURE_PATTERNS.some((pattern) => pattern.test(finalAnswerScope(stdout)))) {
    reasons.push("agent output contains failure language");
  }

  if (stdout.trim().length < MIN_OUTPUT_LENGTH) {
    reasons.push("agent output is too short");
  }

  return { incomplete: reasons.length > 0, reasons };
}
