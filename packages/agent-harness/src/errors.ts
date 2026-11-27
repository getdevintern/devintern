/**
 * Shared harness errors.
 *
 * These live in the harness package rather than in a consumer so a harness can
 * reject a configuration at invocation-build time with the same error type a
 * caller uses to distinguish "the harness never started" from "the agent ran
 * and failed". Runtime workers use that distinction to fail over to the next
 * harness instead of burning a task attempt.
 */

/**
 * Error raised when a harness CLI cannot start.
 *
 * Covers a missing binary, a sandbox denial before the agent runs, and a
 * configuration that cannot produce a valid invocation (for example
 * `AGENT_HARNESS=deepseek` pointing at the community Reasonix binary).
 */
export class HarnessUnavailableError extends Error {
  /** Registered harness name whose startup failed, when known. */
  readonly harnessName?: string;

  /**
   * @param message - Human-readable failure reason.
   * @param options - Optional harness name for attribution.
   */
  constructor(message: string, options: { harnessName?: string } = {}) {
    super(message);
    this.name = "HarnessUnavailableError";
    this.harnessName = options.harnessName;
  }
}
