/**
 * Detect incomplete agent implementation from stdout content.
 *
 * Used when the agent exits 0 but may not have produced meaningful work.
 * Stderr is intentionally excluded: agents like Cursor emit transient
 * "Error:" lines for recovered tool failures that must not mark success as incomplete.
 */

const FAILURE_PATTERNS = [
  /I (?:was unable to|cannot|could not|failed to)/i,
  /implementation was unsuccessful/i,
  /failed to implement/i,
  /I apologize, but I/i,
] as const;

const MIN_OUTPUT_LENGTH = 100;

export interface IncompleteImplementationResult {
  incomplete: boolean;
  reasons: string[];
}

/**
 * Return whether agent stdout indicates an incomplete or failed implementation.
 *
 * @param stdout - Captured standard output
 */
export function detectIncompleteImplementation(stdout: string): IncompleteImplementationResult {
  const reasons: string[] = [];

  if (FAILURE_PATTERNS.some((pattern) => pattern.test(stdout))) {
    reasons.push("agent output contains failure language");
  }

  if (stdout.trim().length < MIN_OUTPUT_LENGTH) {
    reasons.push("agent output is too short");
  }

  return { incomplete: reasons.length > 0, reasons };
}
