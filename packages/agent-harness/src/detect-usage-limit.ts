/**
 * Detect Claude/agent usage- or rate-limit exhaustion from CLI stdout/stderr.
 *
 * Unlike a generic failure, a usage limit must NOT be retried immediately —
 * the agent can't make progress until the limit window resets. Claude Code
 * prints messages like (verified against the CLI binary):
 *
 *   You've hit your session limit · resets 7:20pm (Asia/Ho_Chi_Minh)
 *   You've hit your fast limit · resets in 2h 15m
 *   You've hit your monthly spend limit.
 *   Claude usage limit reached
 *
 * so we also try to extract a human-readable reset hint for callers that want
 * to schedule a delayed retry. Note: a "monthly spend limit" / credit message
 * is reported as limited but generally carries no timer-based reset.
 *
 * Other harnesses surface the underlying model-provider error. opencode (via
 * the Vercel AI SDK) prints things like:
 *
 *   AI_RetryError: Failed after 4 attempts. Last error: Too Many Requests
 *   Too Many Requests: {"error":{"code":"1302","message":"Rate limit reached for req..."}}
 *   rate_limit_error / quota exceeded
 *
 * which the provider-rate-limit patterns below cover.
 * Ref (opencode API rate-limit reporting):
 *   https://github.com/sst/opencode/issues/2398  (AI_RetryError: ... Too Many Requests)
 *
 * KNOWN GAP — opencode + Claude subscription "plan" limit:
 * When opencode drives a Claude (OAuth) subscription and the *plan* usage limit
 * is hit, opencode emits NO message — it freezes with an empty response, so
 * there is nothing to match here. It surfaces to callers as an agent timeout
 * instead. Both issues are unresolved as of this writing:
 *   https://github.com/sst/opencode/issues/877  (no error message on Claude usage limit)
 *   https://github.com/sst/opencode/issues/777  (silent freeze / empty response)
 * For reliable subscription-limit handling prefer the `claude-code` harness,
 * which prints the limit message verified above. Revisit these issues before
 * attempting text-based detection of opencode plan limits.
 */

const USAGE_LIMIT_PATTERNS = [
  // "You've hit your <session|fast|weekly|monthly spend|5-hour|usage> limit"
  /hit your (?:session|usage|account|weekly|monthly|fast|5[- ]?hour) (?:spend )?limit/i,
  // "You have reached your usage limit"
  /reached your (?:usage|session|account|weekly|monthly|fast) (?:spend )?limit/i,
  // "usage limit reached", "fast limit reached", "session limit reached"
  /(?:usage|session|account|fast|usage credit) limit reached/i,
  // generic Claude/Anthropic phrasing
  /claude (?:ai )?usage limit/i,
  // API/provider rate limits (qualified to avoid matching benign prose).
  // Covers "rate limit error/exceeded/reached" and "rate_limit_error" (opencode/AI SDK).
  /rate[ _-]?limit(?: error| exceeded| reached)/i,
  /\brate_limit/i,
  /\btoo many requests\b/i,
  /\bquota exceeded\b/i,
  /\b429\b/,
] as const;

const RESET_PATTERNS = [
  // "resets 7:20pm (Asia/Ho_Chi_Minh)", "resets at 9am", "resets in 2 hours"
  /resets?\s+(?:at\s+|in\s+)?([0-9][^\n.]*?)(?:\.|\n|$)/i,
  // "try again at 9am", "try again after 2h", "try again in 30 minutes"
  /try again\s+(?:at|after|in)\s+([^\n.]+?)(?:\.|\n|$)/i,
  // "retry after 30s", "retry-after: 60"
  /retry[- ]after:?\s+([^\n.]+?)(?:\.|\n|$)/i,
  // "available again at ...", "available again in ..."
  /available again\s+(?:at|in)\s+([^\n.]+?)(?:\.|\n|$)/i,
] as const;

export interface UsageLimitResult {
  /** True when output indicates a usage/rate limit was hit. */
  limited: boolean;
  /** Human-readable reset hint when present, e.g. `7:20pm (Asia/Ho_Chi_Minh)`. */
  resetsAt?: string;
  /** The line that matched the limit pattern, for logging. */
  matchedLine?: string;
}

/**
 * Extract a human-readable reset hint from limit output, if present.
 *
 * @param text - Combined stdout/stderr
 */
function extractResetHint(text: string): string | undefined {
  for (const pattern of RESET_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

/**
 * Convert a human-readable reset hint into an absolute epoch (ms).
 *
 * Handles relative durations ("2h 15m", "in 30 minutes") and clock times
 * ("7:20pm", "9am", with an optional trailing timezone label which is ignored —
 * the clock reading is interpreted in the host's local time). Returns `null`
 * when the hint can't be parsed or resolves to a time already in the past, so
 * the caller can apply its own fallback cooldown.
 *
 * @param hint - Reset hint from {@link UsageLimitResult.resetsAt}
 * @param nowMs - Current time in epoch ms (injected for testability)
 */
export function resetHintToMs(hint: string | undefined, nowMs: number): number | null {
  if (!hint) {
    return null;
  }
  const text = hint.toLowerCase();

  // Relative duration: "2h 15m", "in 30 minutes", "45m", "2 hours", "30s", "1 day"
  const dayMatch = text.match(/(\d+)\s*(?:d|days?)\b/);
  const hourMatch = text.match(/(\d+)\s*(?:h|hrs?|hours?)\b/);
  const minMatch = text.match(/(\d+)\s*(?:m|mins?|minutes?)\b/);
  const secMatch = text.match(/(\d+)\s*(?:s|secs?|seconds?)\b/);
  if (dayMatch || hourMatch || minMatch || secMatch) {
    const ms =
      (dayMatch ? Number(dayMatch[1]) * 86_400_000 : 0) +
      (hourMatch ? Number(hourMatch[1]) * 3_600_000 : 0) +
      (minMatch ? Number(minMatch[1]) * 60_000 : 0) +
      (secMatch ? Number(secMatch[1]) * 1_000 : 0);
    if (ms > 0) {
      return nowMs + ms;
    }
  }

  // Clock time: "7:20pm", "9am" (timezone label, if any, is ignored).
  const clock = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3] === "pm") {
      hour += 12;
    }
    const minute = clock[2] ? Number(clock[2]) : 0;
    const target = new Date(nowMs);
    target.setHours(hour, minute, 0, 0);
    const resetAt = target.getTime();
    // A clock time already past today likely reflects timezone skew; let the
    // caller fall back rather than wait ~a day.
    return resetAt > nowMs ? resetAt : null;
  }

  return null;
}

/**
 * Return whether agent output indicates a usage/rate limit, plus a reset hint.
 *
 * @param stdout - Captured standard output
 * @param stderr - Captured standard error
 */
export function detectUsageLimit(stdout: string, stderr: string): UsageLimitResult {
  const combined = `${stdout}\n${stderr}`;

  const matchedPattern = USAGE_LIMIT_PATTERNS.find((pattern) => pattern.test(combined));
  if (!matchedPattern) {
    return { limited: false };
  }

  // Capture the specific line for logging context.
  const matchedLine = combined
    .split("\n")
    .find((line) => matchedPattern.test(line))
    ?.trim();

  return {
    limited: true,
    resetsAt: extractResetHint(combined),
    matchedLine,
  };
}
