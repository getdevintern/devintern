/**
 * Shared credential redaction.
 *
 * Every redactor in the monorepo (error reports, worker logs, bug reports,
 * agent exit reasons, public PR comments, the demo scrubber) masks the same
 * credential shapes from {@link CREDENTIAL_PATTERNS}. Callers layer their own
 * extras (paths, emails, task keys) on top.
 *
 * Contexts passed to Sentry must never contain secrets in the first place,
 * but error messages can embed credentials (GitHub API errors, URLs with
 * tokens, Authorization headers). This is defense in depth, not a guarantee:
 * unknown formats and secrets in prose still pass through.
 *
 * Performance: every pattern must stay linear on long inputs. Token patterns
 * start with a lookbehind so a match can only begin where a run of word
 * characters begins; without it a long run with no match (a base64 blob, a
 * minified line) is rescanned from every offset, which is quadratic. A token
 * may still start right after `-` (`x-ghp_...`, `id-AKIA...`), like `\b`
 * allows: a greedy `{N,}` body either consumes the rest of the run or fails
 * within N characters, and fixed-length bodies fail at their length, so
 * restarting after each dash stays linear. The JWT rule is the exception: it
 * can scan a whole dash-joined run before failing on the missing `.`, so it
 * keeps `-` in its lookbehind. Fixed-length bodies get a lookahead so they do
 * not match a prefix of a longer word.
 */

/** Placeholder used in place of any detected secret. */
export const REDACTED = "[redacted]";

/** Placeholder for a whole PEM private-key block. */
export const REDACTED_PRIVATE_KEY = "[redacted private key]";

/** One credential shape with a stable label (used by leak scanners). */
export interface CredentialPattern {
  label: string;
  /** Global regular expression. */
  pattern: RegExp;
  /** Replacement string (may use `$1` back-references). */
  replacement: string;
}

/** Start-of-word anchor for token patterns (the `\b` rule, linear). */
const START = "(?<![A-Za-z0-9_])";

/** Stricter anchor for patterns that can fail late (see the JWT rule). */
const START_OF_RUN = "(?<![A-Za-z0-9_-])";

function token(label: string, body: string, start = START): CredentialPattern {
  return { label, pattern: new RegExp(`${start}${body}`, "g"), replacement: REDACTED };
}

/**
 * The shared list of credential shapes. Order matters: whole PEM blocks
 * before lone headers, `Bearer <token>` before JWTs so a bearer JWT stays
 * `Bearer [redacted]`.
 */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  {
    label: "private key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\s\S]{0,65536}?-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/g,
    replacement: REDACTED_PRIVATE_KEY,
  },
  {
    // A truncated block (no END marker) still masks its header.
    label: "private key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/g,
    replacement: REDACTED_PRIVATE_KEY,
  },
  {
    label: "bearer token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    label: "basic auth",
    pattern: /(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/]{4,}={0,2}/gi,
    replacement: `$1${REDACTED}`,
  },
  token("github token", "(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})"),
  token("gitlab token", "gl(?:pat|dt|ptt|rt|cbt)-[A-Za-z0-9_-]{16,}"),
  token("slack token", "xox[abeprs]-[A-Za-z0-9-]{10,}"),
  token("aws key id", "(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])"),
  token("openai/anthropic key", "sk-[A-Za-z0-9_-]{20,}"),
  token("stripe key", "[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}"),
  token("atlassian token", "ATATT[A-Za-z0-9_=-]{20,}"),
  token("linear key", "lin_(?:api|oauth)_[A-Za-z0-9]{20,}"),
  token("sentry token", "sntry[su]_[A-Za-z0-9_=+/-]{20,}"),
  token("polar token", "polar_[a-z]{2,4}_[A-Za-z0-9]{20,}"),
  token("npm token", "npm_[A-Za-z0-9]{30,}"),
  token("google api key", "AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])"),
  token("jwt", "eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", START_OF_RUN),
  {
    // https://user:password@host. The password stops at `/`, so repeated
    // `http://a:` without an `@` cannot rescan the rest of the input. `'` is
    // a legal userinfo character; `"` is not, and stopping there keeps a
    // match from spanning JSON strings.
    label: "url credentials",
    pattern: /(\bhttps?:\/\/)[^/\s:@"']{1,256}:[^/\s@"]+@/gi,
    replacement: `$1${REDACTED}@`,
  },
  {
    label: "query credentials",
    pattern:
      /([?&](?:token|access_token|refresh_token|id_token|private_token|client_secret|api[_-]?key|apikey|secret|password|signature|sig|key)=)[^&\s#]+/gi,
    replacement: `$1${REDACTED}`,
  },
];

/** Key names whose assigned value is treated as a credential. */
const SECRET_ASSIGNMENT_KEY =
  /token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key/i;

/**
 * How an assignment key relates to credentials:
 * - `"secret"`: the value is masked.
 * - `"count-or-secret"`: the key names a credential only through a word ending
 *   in `tokens`. That word is a usage count (`max_tokens`, `inputTokens`) or a
 *   list of credentials (`API_TOKENS`, `refreshTokens`), so the value is
 *   masked unless it is a plain number.
 * - `null`: not a credential key.
 *
 * The key is split into words on `_`/`-` and camelCase humps. A personal
 * access token key must have `pat` as a whole word (`GITLAB_PAT`, `clientPat`,
 * `pat`) or as an uppercase suffix of the last word (`MYPAT`), so `path`,
 * `patch`, `compatible`, and `compat_mode` are not mistaken for one.
 */
function classifyAssignmentKey(rawKey: string): "secret" | "count-or-secret" | null {
  const key = rawKey.replaceAll('"', "");
  const words = key.split(/[_-]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  if (words.some((word) => /^pat$/i.test(word))) return "secret";
  if ((words.at(-1) ?? "").endsWith("PAT")) return "secret";
  const kept = words.filter((word) => !/tokens$/i.test(word));
  if (SECRET_ASSIGNMENT_KEY.test(kept.join("_"))) return "secret";
  if (kept.length < words.length && SECRET_ASSIGNMENT_KEY.test(words.join("_"))) {
    return "count-or-secret";
  }
  return null;
}

/** A plain number, optionally quoted or followed by a separator (`4096,`). */
const NUMERIC_VALUE = /^["']?\d[\d,._]*["']?[,;]?$/;

/**
 * `KEY=value`, `KEY: value`, `"KEY": "value"`, and `?KEY=value` query
 * parameters. Only the key and separator are matched here; the key is a whole
 * run (anchored by lookbehind) checked with {@link classifyAssignmentKey}, and
 * the value is read only for secret keys. A non-secret key therefore never
 * swallows its value, so a secret key inside it (`error: {"password": "x"}`) is
 * still found, and a run like `a:a:a:...` stays linear. A key right after
 * `?`/`&` is a query parameter: its value stops at `&`, `#`, or whitespace so
 * the rest of the URL is kept.
 */
const ASSIGNMENT_KEY_PATTERN =
  /(?:(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)|("[A-Za-z0-9_-]+"))(\s*[:=]\s*)/g;
const ASSIGNMENT_VALUE_PATTERN = /"[^"\n]*"|'[^'\n]*'|\S+/y;
const QUERY_VALUE_PATTERN = /[^&\s#]+/y;

/** Mask values assigned to secret-looking keys. */
export function redactSecretAssignments(text: string): string {
  const keys = new RegExp(ASSIGNMENT_KEY_PATTERN.source, ASSIGNMENT_KEY_PATTERN.flags);
  const assigned = new RegExp(ASSIGNMENT_VALUE_PATTERN.source, ASSIGNMENT_VALUE_PATTERN.flags);
  const query = new RegExp(QUERY_VALUE_PATTERN.source, QUERY_VALUE_PATTERN.flags);
  let out = "";
  let copied = 0;
  for (let match = keys.exec(text); match; match = keys.exec(text)) {
    const key = match[1] ?? match[2] ?? "";
    const kind = classifyAssignmentKey(key);
    if (kind === null) continue;
    const before = match[1] === undefined ? "" : text[match.index - 1];
    const value = before === "?" || before === "&" ? query : assigned;
    const valueStart = keys.lastIndex;
    value.lastIndex = valueStart;
    const found = value.exec(text);
    if (!found) continue;
    if (kind === "count-or-secret" && NUMERIC_VALUE.test(found[0])) continue;
    out += `${text.slice(copied, valueStart)}${REDACTED}`;
    copied = value.lastIndex;
    keys.lastIndex = copied;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** Mask every shape in {@link CREDENTIAL_PATTERNS}. */
export function redactCredentialShapes(text: string): string {
  let out = text;
  for (const { pattern, replacement } of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Labels of the credential shapes still present in `text`. Already masked
 * values (`?token=[redacted]`) do not count: a shape is reported only when
 * redacting would change the text.
 */
export function findCredentialShapes(text: string): string[] {
  const labels = new Set<string>();
  for (const { label, pattern, replacement } of CREDENTIAL_PATTERNS) {
    if (text.replace(pattern, replacement) !== text) labels.add(label);
  }
  return [...labels];
}

/**
 * Scrub credential-looking substrings out of free text: secret-key
 * assignments, then every shared credential shape (including PEM blocks).
 */
export function redactText(text: string): string {
  return redactCredentialShapes(redactSecretAssignments(text));
}

/** Keys whose string values are dropped entirely when building context. */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|apikey|authorization|credential|private[-_]?key|cookie|session[-_]?id)/i;

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
