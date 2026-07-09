/**
 * Detect max-turns exhaustion from agent CLI stdout/stderr.
 *
 * Claude Code (`-p` / stdin) emits `Error: Reached max turns (N)` on stdout with exit code 1.
 * Match known phrases across both streams since agents differ.
 */

const MAX_TURNS_PATTERNS = [
  /Reached max turns/i,
  /max turns reached/i,
  /maximum turns reached/i,
] as const;

/**
 * Return whether agent output indicates the conversation hit a max-turns limit.
 *
 * @param stdout - Captured standard output
 * @param stderr - Captured standard error
 */
export function detectMaxTurnsReached(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return MAX_TURNS_PATTERNS.some((pattern) => pattern.test(combined));
}
