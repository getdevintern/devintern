/**
 * Structured (JSON) output support for agent harnesses.
 *
 * Several wrapped CLIs can emit machine-readable JSON instead of styled
 * transcript text (Claude Code `--output-format json`, Codex `--json`,
 * Cline `--json`, Cursor `--output-format json`, ...). Requesting it is
 * opt-in per run via {@link AgentRunOptions.structuredOutput}; harnesses
 * declare support with the `AgentHarness.supportsStructuredOutput`
 * capability flag, mirroring `supportsMaxTurns`. Runners fail closed when
 * the option is requested from a harness without the capability instead of
 * silently returning plain text.
 *
 * Parsing is deliberately tolerant of real-world CLI behavior (ANSI styling,
 * interleaved log lines, NDJSON event streams) but fails closed on malformed
 * or truncated payloads, so downstream automation never mistakes partial
 * data for a complete result: {@link parseStructuredOutput} returns
 * `{ ok: false, error }` and callers still have the raw `stdout`/`stderr`.
 *
 * Transcript detectors (usage limit, max turns) keep scanning the raw
 * streams unchanged; JSON event lines can still match provider-diagnostic
 * patterns (e.g. `{"error":{"code":"1302",...}}`). The plain-text default
 * path is untouched.
 */

import type { AgentHarness, AgentRunOptions, StructuredOutputResult } from "./types.js";
import { stripAnsi } from "./output-lines.js";

/**
 * Error thrown when a caller requests structured (JSON) output from a
 * harness whose CLI cannot emit it.
 */
export class UnsupportedStructuredOutputError extends Error {
  readonly harnessName: string;

  constructor(harness: AgentHarness) {
    super(
      `${harness.displayName} (${harness.name}) does not support structured (JSON) output. ` +
        `Use a harness whose CLI can emit JSON, or omit structuredOutput for plain-text output.`,
    );
    this.name = "UnsupportedStructuredOutputError";
    this.harnessName = harness.name;
  }
}

/**
 * Fail closed when structured output is requested but the harness cannot
 * provide it. No-op when the option is unset (plain-text default).
 *
 * @throws {UnsupportedStructuredOutputError} when the CLI has no JSON mode
 */
export function assertStructuredOutputSupported(
  harness: AgentHarness,
  options: AgentRunOptions,
): void {
  if (options.structuredOutput === true && harness.supportsStructuredOutput !== true) {
    throw new UnsupportedStructuredOutputError(harness);
  }
}

/**
 * Recover the structured payload from captured agent stdout.
 *
 * Strategy, in order:
 *
 * 1. Parse the whole output as one JSON document (single-line or
 *    pretty-printed objects/arrays — Claude Code, Cursor, Grok, agy
 *    envelopes and Qwen message arrays).
 * 2. Parse NDJSON event streams line by line (Codex, Opencode, Kilo, Cline,
 *    Kimi, Pi), ignoring interleaved non-JSON log lines. A stream where some
 *    JSON-looking lines parse and others do not is treated as truncated and
 *    fails closed rather than returning a partial payload.
 * 3. Parse a `{...}` / `[...]` bracket span, covering pretty-printed
 *    documents embedded in banner/log noise (candidate open/close pairs, so
 *    banners like `[INFO] ...` don't break the span).
 *
 * @param stdout - Captured standard output (JSON mode goes to stdout)
 * @returns Parsed payload, or a failure reason; never throws
 */
export function parseStructuredOutput(stdout: string): StructuredOutputResult {
  const text = stripAnsi(stdout)
    .replace(/^\uFEFF/, "")
    .trim();

  if (!text) {
    return { ok: false, error: "agent produced no stdout to parse as structured output" };
  }

  // Whole-output document.
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Fall through to line- and span-based recovery.
  }

  const lines = text.split(/\r?\n/);
  const events: unknown[] = [];
  let malformedLine: number | undefined;
  let malformedReason: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    // A line plausibly beginning a JSON value. A bare `[` only counts when
    // followed by JSON-ish content, so log banners like `[INFO] ...` are not
    // misread as malformed arrays.
    const looksLikeJson = line.startsWith("{") || /^\[\s*[{"\d[\]-]/.test(line);
    if (!line || !looksLikeJson) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      malformedLine ??= index + 1;
      malformedReason ??= error instanceof Error ? error.message : String(error);
    }
  }

  if (malformedLine !== undefined) {
    if (events.length > 0) {
      // Mixed stream where some JSON lines parse and others do not: a
      // truncated or corrupt NDJSON stream. Fail closed instead of returning
      // a partial payload that downstream automation could mistake for a
      // complete result.
      return {
        ok: false,
        error:
          `malformed JSON at line ${malformedLine} (${malformedReason}); ` +
          `${events.length} complete JSON line(s) parsed before failing — ` +
          `output is likely truncated`,
      };
    }
    // Every JSON-looking line is a fragment (pretty-printed document embedded
    // in log noise); the span recovery below may still reconstruct it.
  } else if (events.length > 0) {
    // NDJSON event stream (Codex / Opencode / Kilo / Cline / Kimi / Pi),
    // optionally interleaved with non-JSON log lines.
    return { ok: true, value: events };
  }

  // Pretty-printed document embedded in log noise: parse a bracket span.
  // Log banners can themselves contain brackets (`[INFO] ...`), so try each
  // opening-bracket candidate against each closing-bracket candidate instead
  // of assuming the outermost pair bounds the document.
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((pos) => pos >= 0);
  starts.sort((a, b) => a - b);
  const ends = [text.lastIndexOf("}"), text.lastIndexOf("]")].filter((pos) => pos >= 0);
  ends.sort((a, b) => b - a);
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) {
        continue;
      }
      try {
        return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
      } catch {
        // Try the next candidate span.
      }
    }
  }

  return {
    ok: false,
    error:
      malformedLine !== undefined
        ? `malformed JSON at line ${malformedLine} (${malformedReason})`
        : "no JSON found in agent stdout",
  };
}
