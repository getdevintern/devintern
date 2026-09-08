/**
 * Unified auto-review iteration cap.
 *
 * One CLI arg (`--auto-review-iterations`) and one matching env var
 * (`AUTO_REVIEW_ITERATIONS`) are the only primary controls for the
 * auto-review loop, shared by every path that runs it: direct CLI runs,
 * workspace/worker runs (via `worker_task_args` on the spawned CLI), and the
 * webhook server.
 */

/** Env var paired with the `--auto-review-iterations` CLI arg. */
export const AUTO_REVIEW_ITERATIONS_ENV = "AUTO_REVIEW_ITERATIONS";

/**
 * Deprecated webhook-only alias, folded into {@link AUTO_REVIEW_ITERATIONS}.
 * Only consulted when the unified env var is unset; setting it logs a
 * deprecation warning.
 */
export const AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV = "WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS";

/** Canonical CLI arg name for the cap. */
export const AUTO_REVIEW_ITERATIONS_ARG = "--auto-review-iterations";

/**
 * Ceiling on review-fix cycles when neither the CLI arg nor the env var is
 * set. The cap is a ceiling, not a quota: the loop still stops as soon as the
 * review is approved or no important issues remain.
 */
export const DEFAULT_AUTO_REVIEW_ITERATIONS = 2;

/** Error thrown for a malformed iteration cap so the loop never starts. */
export class InvalidAutoReviewIterationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAutoReviewIterationsError";
  }
}

function invalidValueMessage(source: string, raw: string): string {
  return (
    `${source} must be a whole number of iterations >= 1 (got "${raw}"). ` +
    "A value of 1 means a single review pass; 0 is not treated as unlimited."
  );
}

/**
 * Parse one explicit iteration-cap value.
 *
 * @param raw - The raw string value (CLI arg or env var)
 * @param source - Human-readable source label used in error messages
 * @returns The validated iteration count
 * @throws {@link InvalidAutoReviewIterationsError} when the value is
 *   non-numeric, fractional, or less than 1
 */
export function parseAutoReviewIterations(raw: string, source: string): number {
  const value = Number.parseInt(raw.trim(), 10);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidAutoReviewIterationsError(invalidValueMessage(source, raw));
  }
  return value;
}

/**
 * Resolve the auto-review iteration cap for one run.
 *
 * Precedence: explicit CLI arg → {@link AUTO_REVIEW_ITERATIONS} env var →
 * deprecated `WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS` env var → shared default.
 *
 * @param explicitValue - The raw `--auto-review-iterations` value when the
 *   flag was passed, `undefined` otherwise
 * @param env - Environment to read the env vars from; defaults to
 *   `process.env` (pass an explicit object to keep callers pure-testable)
 * @returns The validated iteration count for this run
 * @throws {@link InvalidAutoReviewIterationsError} when an explicitly
 *   provided value (CLI arg or env var) is invalid
 */
export function resolveAutoReviewIterations(
  explicitValue?: string,
  env: Record<string, string | undefined> = process.env,
): number {
  if (explicitValue !== undefined) {
    return parseAutoReviewIterations(explicitValue, AUTO_REVIEW_ITERATIONS_ARG);
  }

  const unified = env[AUTO_REVIEW_ITERATIONS_ENV];
  if (unified !== undefined && unified.trim() !== "") {
    return parseAutoReviewIterations(unified, AUTO_REVIEW_ITERATIONS_ENV);
  }

  const deprecated = env[AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV];
  if (deprecated !== undefined && deprecated.trim() !== "") {
    process.stderr.write(
      `⚠️  ${AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV} is deprecated, use ${AUTO_REVIEW_ITERATIONS_ENV} instead\n`,
    );
    return parseAutoReviewIterations(deprecated, AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV);
  }

  return DEFAULT_AUTO_REVIEW_ITERATIONS;
}

/**
 * Resolve the iteration cap for a host that only uses it when auto-review is
 * enabled (the CLI run loop and the webhook server).
 *
 * Mirrors the CLI's gating: when auto-review is off and no explicit value was
 * passed, the cap is unused and the env vars are not even read — a stray
 * invalid `AUTO_REVIEW_ITERATIONS` in the environment must not block startup
 * of a server that would never run the loop. An explicit value is always
 * validated, exactly like the CLI validates `--auto-review-iterations`.
 *
 * @param explicitValue - Explicit override (CLI arg string, or a numeric
 *   config value such as the webhook's `autoReviewMaxIterations`) when one
 *   was provided, `undefined` otherwise
 * @param autoReviewEnabled - Whether the host will actually run the
 *   auto-review loop
 * @param env - Environment to read the env vars from; defaults to
 *   `process.env`
 * @returns The validated iteration count
 * @throws {@link InvalidAutoReviewIterationsError} when a value that will be
 *   used (an explicit override, or an env var with auto-review enabled) is
 *   invalid
 */
export function resolveAutoReviewIterationsIfEnabled(
  explicitValue: string | number | undefined,
  autoReviewEnabled: boolean,
  env: Record<string, string | undefined> = process.env,
): number {
  if (explicitValue === undefined && !autoReviewEnabled) {
    return DEFAULT_AUTO_REVIEW_ITERATIONS;
  }
  return resolveAutoReviewIterations(
    explicitValue === undefined ? undefined : String(explicitValue),
    env,
  );
}
