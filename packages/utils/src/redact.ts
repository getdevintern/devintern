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
 * start with a lookbehind so a match can only begin where a run of token
 * characters begins; without it a long run with no match (a base64 blob, a
 * minified line) is rescanned from every offset, which is quadratic. Unbounded
 * greedy bodies need no trailing anchor because they always consume the whole
 * run; fixed-length bodies get a lookahead so they do not match a prefix of a
 * longer word.
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

/** Start-of-run anchor for tokens whose body uses `[A-Za-z0-9_-]`. */
const START = "(?<![A-Za-z0-9_-])";

function token(label: string, body: string): CredentialPattern {
  return { label, pattern: new RegExp(`${START}${body}`, "g"), replacement: REDACTED };
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
  token("jwt", "eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}"),
  {
    // https://user:password@host. Bounded so repeated `http://a:` without an
    // `@` cannot rescan the rest of the input from every occurrence.
    label: "url credentials",
    pattern: /(\bhttps?:\/\/)[^/\s:@"']{1,256}:[^/\s@"']{1,1024}@/gi,
    replacement: `$1${REDACTED}@`,
  },
  {
    label: "query credentials",
    pattern:
      /([?&](?:token|access_token|refresh_token|id_token|private_token|client_secret|api[_-]?key|apikey|secret|password|signature|sig|key)=)[^&\s#]+/gi,
    replacement: `$1${REDACTED}`,
  },
];

/**
 * Key names whose assigned value is treated as a credential. The bare `pat`
 * alternative requires a non-alphanumeric character after it so ordinary words
 * that merely contain it (`path`, `patch`, `compatible`) are not mistaken for a
 * personal access token key; a prefix (`clientPat`, `MYPAT`) is still allowed.
 */
const SECRET_ASSIGNMENT_KEY =
  /token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|pat(?![A-Za-z0-9])/i;

/**
 * `KEY=value`, `KEY: value`, and `"KEY": "value"`. Only the key and separator
 * are matched here; the key is a whole run (anchored by lookbehind) checked
 * against {@link SECRET_ASSIGNMENT_KEY}, and the value is read only for secret
 * keys. A non-secret key therefore never swallows its value, so a secret key
 * inside it (`error: {"password": "x"}`) is still found, and a run like
 * `a:a:a:...` stays linear. Keys right after `?`/`&` are query parameters and
 * left to the query rule, which keeps the rest of the URL.
 */
const ASSIGNMENT_KEY_PATTERN =
  /(?:(?<![A-Za-z0-9_?&-])([A-Za-z0-9_-]+)|("[A-Za-z0-9_-]+"))(\s*[:=]\s*)/g;
const ASSIGNMENT_VALUE_PATTERN = /"[^"\n]*"|'[^'\n]*'|\S+/y;

/** Mask values assigned to secret-looking keys. */
export function redactSecretAssignments(text: string): string {
  const keys = new RegExp(ASSIGNMENT_KEY_PATTERN.source, ASSIGNMENT_KEY_PATTERN.flags);
  const value = new RegExp(ASSIGNMENT_VALUE_PATTERN.source, ASSIGNMENT_VALUE_PATTERN.flags);
  let out = "";
  let copied = 0;
  for (let match = keys.exec(text); match; match = keys.exec(text)) {
    const key = match[1] ?? match[2] ?? "";
    if (!SECRET_ASSIGNMENT_KEY.test(key)) continue;
    const valueStart = keys.lastIndex;
    value.lastIndex = valueStart;
    if (!value.exec(text)) continue;
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
