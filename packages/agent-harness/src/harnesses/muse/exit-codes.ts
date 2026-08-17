/**
 * Muse Code process exit code mapping.
 */

import type { MuseExitState } from "./types.js";

/** Patterns indicating OS sandbox / bubblewrap unavailable on Linux CI. */
const SANDBOX_UNAVAILABLE_PATTERNS = [
  /bubblewrap/i,
  /bwrap/i,
  /sandbox.*(unavailable|not available|failed|failure)/i,
  /environment failure/i,
  /musl.*sandbox/i,
] as const;

/**
 * Detect sandbox environment failures from stderr.
 *
 * @param stderr - Captured stderr.
 */
export function detectMuseSandboxFailure(stderr: string): boolean {
  return SANDBOX_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Map Muse process exit code and stream hints to a normalized exit state.
 *
 * Exit codes (per Muse docs):
 * - 0: turn completed (not work success)
 * - 1: failed / cancelled / step limit
 * - 2: usage error
 * - 130 / 143: interrupted (SIGINT / SIGTERM)
 *
 * @param exitCode - Process exit code.
 * @param options - Stream hints from the run.
 */
export function mapMuseExitState(
  exitCode: number,
  options: {
    timedOut?: boolean;
    stepLimitReached?: boolean;
    stderr?: string;
    cancelled?: boolean;
  } = {},
): MuseExitState {
  if (options.stderr && detectMuseSandboxFailure(options.stderr)) {
    return "sandbox_unavailable";
  }

  if (options.timedOut || options.cancelled) {
    return "interrupted";
  }

  if (exitCode === 0) {
    return "completed";
  }

  if (exitCode === 2) {
    return "usage_error";
  }

  if (exitCode === 130 || exitCode === 143) {
    return "interrupted";
  }

  if (exitCode === 1) {
    if (options.stepLimitReached) {
      return "step_limit";
    }
    return "failed";
  }

  return "failed";
}

/**
 * Human-readable label for a Muse exit state (for logs/diagnostics).
 *
 * @param state - Normalized exit state.
 */
export function describeMuseExitState(state: MuseExitState): string {
  switch (state) {
    case "completed":
      return "Muse turn completed (exit 0)";
    case "failed":
      return "Muse run failed or was cancelled (exit 1)";
    case "step_limit":
      return "Muse hit --max-model-steps limit (exit 1)";
    case "usage_error":
      return "Muse usage error (exit 2)";
    case "interrupted":
      return "Muse run interrupted (signal/timeout)";
    case "sandbox_unavailable":
      return "Muse sandbox unavailable on this runner";
    case "invalid_config":
      return "Invalid Muse harness configuration";
    case "binary_missing":
      return "Muse CLI not found or not executable";
    default:
      return state;
  }
}
