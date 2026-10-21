/**
 * Redaction helpers for bug reports.
 *
 * This is defense in depth on top of "collect only safe fields": error
 * messages and logs routinely quote credentials, home paths, repository
 * slugs, and tracker keys. Every string that leaves the machine passes
 * through {@link redactReportText}.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { redactSecrets, stripAnsi } from "../observability/worker-logs";

export interface ReportRedactionOptions {
  /** Working directory replaced with `<repo>`. */
  cwd?: string;
  /** Home directory replaced with `~`. */
  homeDir?: string;
  /** `owner/repo` replaced with `<repo>` unless identifiers are shared. */
  repoSlug?: string | null;
  /** Task key replaced with `<task>` unless identifiers are shared. */
  taskKey?: string | null;
  /** Keep repository and task identifiers. */
  shareIdentifiers?: boolean;
  /** Hard cap after redaction. Defaults to 20,000 characters. */
  maxChars?: number;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// oxlint-disable-next-line no-control-regex -- control characters are removed by design
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Uppercase prefixes that look like tracker keys but are not. */
const TASK_KEY_STOP_LIST = new Set([
  "SHA",
  "HTTP",
  "HTTPS",
  "UTF",
  "DNS",
  "AWS",
  "UUID",
  "SSL",
  "TLS",
  "CVE",
  "ISO",
  "RFC",
  "API",
  "HTTP2",
]);

/** Escape a literal string for use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse `owner/repo` from a git remote URL (HTTPS, SSH, or scp-like).
 *
 * @param remote - Remote URL or filesystem path.
 * @returns The repository slug, or null when it cannot be determined.
 */
export function parseRepoSlug(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/\.git$/, "").replace(/\/+$/, "");
  const scp = cleaned.match(/^[^/@\s]+@[^:/\s]+:(.+)$/);
  const path = scp?.[1] ?? cleaned;
  if (path.includes("://")) {
    try {
      const url = new URL(path);
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length >= 2) {
        return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
      }
      return null;
    } catch {
      return null;
    }
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

/**
 * Best-effort repository slug for the current checkout.
 *
 * Returns null outside a git checkout or when git is unavailable. Bounded by a
 * short timeout so reporting never waits on a broken repository.
 */
export function detectRepoSlug(cwd: string = process.cwd()): string | null {
  try {
    const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    return parseRepoSlug(result.stdout);
  } catch {
    return null;
  }
}

/** Replace every literal occurrence of `needle` with `replacement`. */
function replaceLiteral(
  text: string,
  needle: string | null | undefined,
  replacement: string,
): string {
  if (!needle || !needle.trim()) return text;
  const pattern = new RegExp(escapeRegExp(needle.trim()), "g");
  return text.replace(pattern, replacement);
}

/**
 * Scrub credentials, paths, repository slugs, task keys, and email addresses
 * out of free text before it enters a report payload.
 *
 * The order matters: the working directory is replaced before the home
 * directory so a checkout under `$HOME` becomes `<repo>` rather than `~/repo`.
 */
export function redactReportText(text: string, options: ReportRedactionOptions = {}): string {
  const maxChars = options.maxChars ?? 20_000;
  let out = stripAnsi(text ?? "");
  out = redactSecrets(out);
  out = out
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(
      /([?&](?:token|access_token|refresh_token|api[_-]?key|apikey|secret|password|signature|key)=)[^&\s]+/gi,
      "$1[redacted]",
    );
  out = out.replace(CONTROL_CHARACTERS, "");
  out = replaceLiteral(out, options.cwd ?? process.cwd(), "<repo>");
  out = replaceLiteral(out, options.homeDir ?? homedir(), "~");
  if (!options.shareIdentifiers) {
    out = replaceLiteral(out, options.repoSlug ?? null, "<repo>");
    if (options.taskKey) {
      const key = options.taskKey.trim();
      if (key) {
        out = out.replace(new RegExp(`\\b${escapeRegExp(key)}\\b`, "g"), "<task>");
      }
    }
    // Logs from a multi-repo workspace can mention other tickets. Redact every
    // tracker-key-shaped token unless it is a known false positive.
    out = out.replace(/\b([A-Z][A-Z0-9]{1,19})-\d{1,10}\b/g, (match, prefix: string) =>
      TASK_KEY_STOP_LIST.has(prefix) ? match : "<task>",
    );
  }
  out = out.replace(EMAIL_PATTERN, "<email>");
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n");
  if (out.length > maxChars) {
    out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return out;
}

/**
 * Read an arbitrary value from a log line while keeping the source label
 * short and free of project paths.
 */
export function safeSourceLabel(path: string): string {
  return basename(path) || "log";
}
