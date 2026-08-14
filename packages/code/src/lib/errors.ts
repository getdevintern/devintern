/**
 * Shared error types for @devintern/code.
 */

/**
 * Thrown when the agent hits an account-wide usage/rate limit. Since every
 * remaining task in a batch would fail identically, callers abort the batch
 * rather than retrying immediately.
 */
export class UsageLimitError extends Error {
  constructor(public readonly resetHint?: string) {
    super(`Agent usage limit reached${resetHint ? ` (resets ${resetHint})` : ""}`);
    this.name = "UsageLimitError";
  }
}
