/**
 * Defense-in-depth redaction for error reports.
 *
 * Contexts passed to Sentry must never contain secrets in the first place,
 * but error messages can embed credentials (GitHub API errors, URLs with
 * tokens, Authorization headers). These helpers scrub the obvious cases
 * before an event leaves the machine.
 */

/** Placeholder used in place of any detected secret. */
export const REDACTED = "[redacted]";

/** Keys whose string values are dropped entirely when building context. */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|apikey|authorization|credential|private[-_]?key|cookie|session[-_]?id)/i;

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_)
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: REDACTED },
  // Anthropic / OpenAI style API keys
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED },
  // Authorization headers
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, replacement: `Bearer ${REDACTED}` },
  // Basic auth embedded in URLs: https://user:password@host
  { pattern: /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replacement: `$1${REDACTED}@` },
  // Credentials passed as query parameters
  {
    pattern:
      /([?&](?:token|access_token|refresh_token|api[_-]?key|apikey|secret|password|signature|key)=)[^&\s]+/gi,
    replacement: `$1${REDACTED}`,
  },
];

/** Scrub credential-looking substrings out of free text. */
export function redactText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Recursively scrub a context object: string values pass through
 * {@link redactText}, and values under secret-shaped keys are replaced with
 * `[redacted]` regardless of content. Mutates nothing; never throws.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        typeof item === "string" && SECRET_KEY_PATTERN.test(key)
          ? REDACTED
          : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}
