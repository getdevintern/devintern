/**
 * Scrubbing and leak scanning for a demo snapshot recorded from a real
 * workspace (see `snapshot.ts --scrub`).
 *
 * Two layers:
 * - `scrub()` rewrites text: the shared credential shapes from
 *   `@devintern/utils` (`redactText`), the literal values of the
 *   operator's env files, the home directory, the host name, Tailscale
 *   names, and email addresses (bot noreply addresses stay), plus the
 *   names of repositories that must not appear (`deny`).
 * - `findLeaks()` re-checks scrubbed text for anything that still looks like
 *   a credential or a denied name. The recorder drops a transcript or
 *   artifact with any finding and fails the build if one remains elsewhere.
 *
 * Best-effort like every redactor: it is a gate in front of a human review,
 * not a replacement for one.
 */

import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";

// Relative import: dashboard-ui does not depend on the utils workspace
// package, and the barrel would pull in the error-tracking SDK.
import { findCredentialShapes, redactText } from "../../../utils/src/redact";

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const KEPT_EMAIL =
  /^(?:noreply@anthropic\.com|[^@]*noreply[^@]*@users\.noreply\.github\.com|noreply@github\.com|git@github\.com)$/i;
const TAILNET = /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Values of `KEY=value` lines in dotenv files, long enough to be secret material. */
export function loadSecretValues(paths: readonly string[]): string[] {
  const values = new Set<string>();
  for (const path of paths) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      const value = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
      // Short values (ports, booleans, ids like "jira") are not secrets and
      // would scrub ordinary words.
      if (value && value.length >= 12 && !/^https?:\/\/[^@]*$/.test(value)) values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export interface ScrubOptions {
  /** Literal secret values (from {@link loadSecretValues}). */
  secretValues: readonly string[];
  /** Names that must not appear (private repositories, their remotes). */
  deny: readonly string[];
}

export interface Scrubber {
  scrub(text: string): string;
  /** What still looks leaked in already scrubbed text (empty when clean). */
  findLeaks(text: string): string[];
  /** Whether raw text names a denied repository (checked before scrubbing). */
  mentionsDenied(text: string): boolean;
}

/** Build a scrubber for one recording. */
export function createScrubber(options: ScrubOptions): Scrubber {
  const home = homedir();
  const host = hostname();
  const user = home.split("/").filter(Boolean).at(-1);
  const deny = options.deny
    .filter((word) => word.length >= 3)
    .map((word) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(word)}(?![A-Za-z0-9_])`, "gi"));

  const scrub = (text: string): string => {
    let out = text;
    for (const value of options.secretValues) out = out.split(value).join("[redacted]");
    out = redactText(out);
    if (home.length > 1) out = out.split(home).join("~");
    if (user) out = out.replace(new RegExp(`/home/${escapeRegExp(user)}\\b`, "g"), "~");
    if (host.length >= 3) {
      out = out.replace(new RegExp(`\\b${escapeRegExp(host)}\\b`, "g"), "<host>");
    }
    out = out.replace(TAILNET, "<tailnet-host>");
    out = out.replace(EMAIL, (email) => (KEPT_EMAIL.test(email) ? email : "<email>"));
    for (const pattern of deny) out = out.replace(pattern, "<private-repo>");
    return out;
  };

  const findLeaks = (text: string): string[] => {
    const found: string[] = [];
    for (const value of options.secretValues) if (text.includes(value)) found.push("env value");
    found.push(...findCredentialShapes(text));
    for (const pattern of deny) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) found.push(`denied name ${pattern.source}`);
    }
    if (home.length > 1 && text.includes(home)) found.push("home path");
    return found;
  };

  const mentionsDenied = (text: string): boolean =>
    deny.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });

  return { scrub, findLeaks, mentionsDenied };
}

/** Apply `scrub` to every string in a parsed JSON value. */
export function scrubJson(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, scrub));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, scrubJson(child, scrub)]),
    );
  }
  return value;
}
