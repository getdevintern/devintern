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
 *   Free usage exceeded, subscribe to Go
 *   5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue
 *     using this model now, enable usage from your available balance
 *
 * which the subscription and provider-rate-limit patterns below cover.
 * Ref (opencode API rate-limit reporting):
 *   https://github.com/sst/opencode/issues/2398  (AI_RetryError: ... Too Many Requests)
 *   https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/retry.ts
 *
 * OpenCode may keep `run` alive after a provider error and only expose the
 * diagnostic through `--print-logs`, as a timestamped line containing an
 * `error.error="AI_APICallError: ..."` field. Callers should scan output while
 * it streams and terminate the child as soon as this detector reports a limit.
 */

import type { OutputLine } from "./output-lines.js";
import { isSourceOrDiffLine, outputLines } from "./output-lines.js";

const USAGE_LIMIT_PATTERNS = [
  // Keep subscription messages anchored to the whole line. Codex writes its
  // tool transcript to stderr, so a substring match also sees source such as
  // `super("Agent usage limit reached")` as though it were a CLI diagnostic.
  /^(?:error:\s*)?you(?:'|’)ve hit your (?:session|usage|account|weekly|monthly|fast|opus|sonnet|fable 5|usage credit|5[- ]?hour) (?:spend )?limit(?:\s*(?:[.·—-]\s*)?(?:resets?|try again|available again|retry[- ]after)\b[^\n]*)?[.!]?$/i,
  /^(?:error:\s*)?you(?: have|(?:'|’)ve) reached your (?:usage|session|account|weekly|monthly|fast|opus|sonnet|fable 5|usage credit) (?:spend )?limit(?:\s*(?:[.·—-]\s*)?(?:resets?|try again|available again|retry[- ]after)\b[^\n]*)?[.!]?$/i,
  /^(?:(?:AI_(?:APICall|Retry)Error|error):\s*)?(?:(?:\d+[- ]hour\s+)?(?:usage|session|account|fast|opus|sonnet|fable 5|usage credit) limit reached|claude (?:ai )?usage limit(?: reached)?)(?:\s*(?:[.·—-]\s*)?(?:resets?|try again|available again|retry[- ]after)\b[^\n]*)?[.!]?$/i,
  // Claude Code 2.1.218 exports these as USAGE_LIMIT_ERROR_PREFIXES.
  /^(?:error:\s*)?(?:you(?:'|’)re out of (?:usage credits|extra usage)|your org is out of usage\s*·\s*(?:add funds to continue|contact your admin)|your seat type doesn(?:'|’)t include usage credits|your usage allocation has been disabled by your admin|your group(?:'|’)s usage limit is set to \$0)(?:\s*(?:[.·—-]\s*)?(?:resets?|try again|available again|retry[- ]after)\b[^\n]*)?[.!]?$/i,
  // Codex UsageLimitReachedError Display (openai/codex protocol/src/error.rs).
  // Plan promo copy and the reset suffix (`try again at 4:27 PM` vs `later`)
  // vary; keep the distinctive prefix and allow the rest of the line. Codex
  // writes its complete tool transcript to stderr, often with an `ERROR:` prefix.
  /^(?:error:\s*)?you(?:'|’)ve hit your usage limit(?:\s+for [^.]+)?\.(?:\s+[^\n]*)?$/i,
  /^your workspace is out of credits\.\s+(?:add credits to continue|ask your workspace owner to (?:add credits|refill in order to continue))[.]?$/i,
  /^you hit your spend cap set (?:in your workspace|by the owner of your workspace)\.\s+(?:increase your spend cap to continue|ask (?:your workspace owner|an owner) to increase (?:your |the )?spend cap(?: to continue)?)[.]?$/i,
  /^quota exceeded\.\s+check your plan and billing details[.]?$/i,
  /^to use codex with your chatgpt plan, upgrade to plus\b[^\n]*$/i,
  // OpenCode Go (anomalyco/opencode session/retry.ts): FreeUsageLimitError and
  // GoUsageLimitError are rewritten into these headless retry messages.
  /^(?:error:\s*)?free usage exceeded(?:,\s*subscribe to go)?[.]?$/i,
  /^(?:(?:AI_(?:APICall|Retry)Error|error):\s*)?(?:(?:\d+[-\s]?hour|weekly|daily|monthly)\s+)?usage limit reached\.(?:\s+it will reset in [^\n.]+(?:\.|$))?(?:\s+to continue using this model now, enable usage from your available balance\b[^\n]*)?$/i,
  /^subscription quota exceeded\.\s+you can continue using free models[.]?$/i,
  // Grok Build translates account/team exhaustion to these headless messages.
  /^you(?:'|’)ve hit the rate limit for your plan\.\s+upgrade your account or try again later[.]?$/i,
  /^you(?:'|’)ve hit your team(?:'|’)s api rate limit\.\s+ask a team admin to purchase more credits for higher limits, or try again later\.\s+see https:\/\/docs\.x\.ai\/developers\/rate-limits#rate-limit-tiers$/i,
  /^you(?:'|’)ve reached your free grok build usage limit for now\.\s+get supergrok for much higher limits, or try again later:\s+https:\/\/grok\.com\/supergrok\?referrer=grok-build$/i,
  /^resource-exhausted:\s+too many requests for team [^.]+\.\s+see https:\/\/console\.x\.ai\/team\/default\/rate-limits[.]?$/i,
  // Grok Build paid-balance exhaustion: headless CLI prints a pretty-printed
  // JSON Internal error (`"message": "API error (status 402 Payment Required): ..."`).
  // Allow a JSON `"...": "` prefix so the diagnostic still matches inside that object.
  /(?:^|:\s*")(?:api error \(status 402 payment required\):\s*)?grok build usage balance exhausted\b/i,
  /(?:^|:\s*")api error \(status 402 payment required\)/i,
  // Goose maps provider HTTP 402 responses to this error and can exit zero.
  /^(?:error:\s*)?credits exhausted:\s+[^\n]+$/i,
  /^(?:⚠\s*)?individual quota reached\.\s+please upgrade your subscription to increase your limits[.]?$/i,
  /^resource_exhausted\s*\(code 429\):\s*individual quota reached\.\s+contact your administrator to enable overages(?:\.\s+resets?\b[^\n]*)?[.]?$/i,
] as const;

// These are intentionally evaluated line-by-line and only when the line looks
// like a provider diagnostic. Agent transcripts routinely contain source code,
// diffs, test counts, and docs that mention HTTP 429 / "Too Many Requests".
const PROVIDER_LIMIT_PATTERNS = [
  // Covers "rate limit error/exceeded/reached" and rate_limit_error (AI SDK).
  /rate[ _-]?limit(?: error| exceeded| reached)/i,
  /\brate_limit(?:_error)?\b/i,
  /\btoo many requests\b/i,
  /\bquota exceeded\b/i,
  /\binsufficient balance\b/i,
  // Require an HTTP/status/error context below before accepting a 429.
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

/** Error raised when a harness reaches an account-wide usage or rate limit. */
export class UsageLimitError extends Error {
  constructor(public readonly resetHint?: string) {
    super(`Agent usage limit reached${resetHint ? ` (resets ${resetHint})` : ""}`);
    this.name = "UsageLimitError";
  }
}

/**
 * Extract a human-readable reset hint from limit output, if present.
 *
 * @param text - One diagnostic line
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
 * Provider rate-limit phrases need stronger evidence than a subscription
 * limit phrase. In particular, a bare `429` or `Too Many Requests` in agent
 * stdout is often just text from a file the agent inspected.
 */
function isLikelyProviderDiagnostic(line: OutputLine): boolean {
  const trimmed = line.normalized.trim();
  if (isSourceOrDiffLine(trimmed)) {
    return false;
  }

  // Accept structured or explicitly diagnostic output from SDK-backed
  // harnesses (for example AI_RetryError and JSON error responses). Do not
  // inherently trust stderr: Codex uses it for its complete tool transcript.
  if (
    /^(?:(?:api|provider)\s+)?(?:error|fatal|warning)\b/i.test(trimmed) ||
    /^\[API Error:\s*429\b[^\n]*\]$/i.test(trimmed) ||
    /^(?:AI_RetryError|Too Many Requests)\b/i.test(trimmed) ||
    /^HTTP\s*429\b/i.test(trimmed) ||
    /^(?:internal error|error:\s*internal error)\b/i.test(trimmed) ||
    /^\s*[{"[].*(?:rate_limit|quota|insufficient balance|add credits|payment required|usage balance exhausted).*[}\]]\s*$/i.test(
      trimmed,
    ) ||
    /\b(?:last error|provider (?:error|response)|response status|returned (?:an? )?(?:error|status)|request failed|retrying)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  // Preserve concise provider messages such as "rate limit exceeded" while
  // rejecting longer prose/source lines that merely mention the phrase.
  return /^(?:rate[ _-]?limit(?: error| exceeded| reached)|rate_limit(?:_error)?|too many requests|quota exceeded|(?:error:\s*)?insufficient balance\.\s+please add credits to continue|(?:http\s*)?429(?:\s+too many requests)?)\s*[.!]?$/i.test(
    trimmed,
  );
}

/** Read a reset-only line immediately following the matched diagnostic. */
function extractAdjacentResetHint(
  stdout: string,
  stderr: string,
  matchedLine: OutputLine,
): string | undefined {
  for (const stream of [stderr, stdout]) {
    const lines = outputLines(stream);
    const index = lines.findIndex((line) => line.raw === matchedLine.raw);
    const nextLine = index >= 0 ? lines[index + 1]?.normalized.trim() : undefined;
    if (nextLine && /^resets?\s+(?:at\s+|in\s+)?[0-9][^\n]*[.]?$/i.test(nextLine)) {
      return extractResetHint(nextLine);
    }
  }
  return undefined;
}

/**
 * Find a usage-limit line without scanning arbitrary transcript content as if
 * it were a provider diagnostic.
 */
function findUsageLimitLine(stdout: string, stderr: string): OutputLine | undefined {
  // Check stderr first because it is the conventional diagnostic channel, then
  // inspect stdout for explicit subscription-limit and structured SDK errors.
  const lines = [...outputLines(stderr), ...outputLines(stdout)].flatMap((line) => {
    // `opencode run --print-logs --log-level ERROR` mirrors its structured log
    // line to stderr. Match the provider error value without weakening the
    // source/diff safeguards for ordinary agent transcript lines.
    if (/\blevel=ERROR\b/.test(line.normalized)) {
      const match = line.normalized.match(/\berror\.error="((?:\\.|[^"\\])*)"/);
      if (match?.[1]) {
        return [
          line,
          {
            raw: line.raw,
            normalized: match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
          },
        ];
      }
    }
    return [line];
  });

  return lines.find((line) => {
    const normalized = line.normalized.trim();
    // Codex (and some other CLIs) prefix diagnostics with `ERROR:`. Strip it
    // only for subscription-limit matching so a prefixed Codex message is
    // still detected without treating arbitrary transcript lines as errors.
    const diagnostic = normalized.replace(/^(?:error:\s*)/i, "");
    if (!normalized || isSourceOrDiffLine(normalized) || isSourceOrDiffLine(diagnostic)) {
      return false;
    }

    if (
      USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(diagnostic) || pattern.test(normalized))
    ) {
      return true;
    }

    return (
      PROVIDER_LIMIT_PATTERNS.some((pattern) => pattern.test(normalized)) &&
      isLikelyProviderDiagnostic(line)
    );
  });
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
  const matchedLine = findUsageLimitLine(stdout, stderr);
  if (!matchedLine) {
    return { limited: false };
  }

  return {
    limited: true,
    // Only extract a reset hint from the matched diagnostic line. Searching
    // the entire transcript can borrow an unrelated "try again" from source
    // code or a tool result, as happened with the Cloudflare tunnel bundle.
    resetsAt:
      extractResetHint(matchedLine.normalized) ||
      extractAdjacentResetHint(stdout, stderr, matchedLine),
    matchedLine: matchedLine.raw.trim(),
  };
}
