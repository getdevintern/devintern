/**
 * Structured (JSON) agent output for the PM engine.
 *
 * When the configured harness declares `supportsStructuredOutput`, the engine
 * requests the harness CLI's JSON mode (`AgentRunOptions.structuredOutput`)
 * and reads the already-parsed payload from `AgentRunResult.structured`
 * instead of scraping JSON out of raw transcript text. Two adjustments are
 * still needed on top of the raw parsed value:
 *
 * - **Envelope unwrapping.** Harnesses wrap the model's reply in their own
 *   machine-readable shape — Claude Code emits a single
 *   `{"type":"result",...,"result":"<reply text>"}` envelope, Codex/Opencode/
 *   Kilo/Cline/Kimi/Pi stream NDJSON events, Qwen buffers a message array.
 *   {@link unwrapStructuredPayload} digs the model's reply text out of those
 *   shapes so the existing payload validators (`isStoryPayload`,
 *   `isDecompositionPayload`) see the object they expect.
 * - **Readable streaming.** With JSON mode on, the raw stdout chunks fed to
 *   `onAgentChunk` are JSON events rather than transcript text — desktop's
 *   live agent output view would show machine noise. The tap produced by
 *   {@link createReadableStdoutTap} rewrites JSON event lines that carry
 *   readable assistant text into that text and passes everything else
 *   through untouched (diagnostic/log lines, non-JSON output).
 *
 * Failure handling stays fail-open toward the legacy path: when structured
 * parsing fails (`structured.ok === false`) or the unwrapped payload does not
 * validate, the engine falls back to the tolerant `extractJsonPayload` repair
 * on raw stdout before surfacing a `parse-failed` error.
 */

import type { AgentRunResult } from "@devintern/agent-harness";
import { extractJsonPayload } from "./json.js";
import { EngineError } from "./types.js";

/**
 * Object field names that may carry the model's reply text across harness
 * envelope shapes (Claude `result`, Antigravity/Goose `response`, Codex event
 * `text`, Qwen/Kimi/Cline message `content`, error `message`).
 */
const REPLY_TEXT_FIELDS = ["result", "response", "text", "content", "message"] as const;

/** How deep to search nested envelopes for reply text (Codex nests under `item`). */
const MAX_REPLY_TEXT_DEPTH = 2;

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * Find reply text inside one envelope/event object.
 *
 * Checks the entry's own fields first (so a top-level `result` string beats a
 * nested one), then descends into child objects/arrays up to
 * {@link MAX_REPLY_TEXT_DEPTH}. Returns `undefined` when nothing readable is
 * found.
 */
function extractReplyText(value: unknown, depth: number): string | undefined {
  if (typeof value === "string") {
    return hasText(value) ? value : undefined;
  }
  if (typeof value !== "object" || value === null || depth > MAX_REPLY_TEXT_DEPTH) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const field of REPLY_TEXT_FIELDS) {
    const direct = record[field];
    if (typeof direct === "string" && hasText(direct)) {
      return direct;
    }
  }
  for (const child of Object.values(record)) {
    if (typeof child !== "object" || child === null) continue;
    const text = extractReplyText(child, depth + 1);
    if (text !== undefined) return text;
  }
  return undefined;
}

/** Parse reply text as JSON, returning the text itself when it is not JSON. */
function parseReplyText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Unwrap a harness envelope around the model's reply.
 *
 * - Arrays (NDJSON event streams, buffered message arrays): walk backwards to
 *   the last entry carrying reply text — the model's final message — and
 *   parse it as JSON.
 * - Objects with a string `result`/`response` field (single-result envelopes:
 *   Claude Code, Cursor, Grok, Goose, Antigravity, DeepSeek): parse that
 *   reply text as JSON. An object-valued `result`/`response` is taken as the
 *   payload directly.
 * - Anything else (the payload itself) passes through unchanged.
 *
 * When reply text is not valid JSON it is returned as a string so callers can
 * run tolerant repair over the model's actual reply rather than the outer
 * envelope.
 *
 * @param value - Parsed structured payload from `AgentRunResult.structured`.
 * @returns The candidate payload, the raw reply text, or the input unchanged.
 */
export function unwrapStructuredPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const text = extractReplyText(value[index], 0);
      if (text !== undefined) {
        return parseReplyText(text);
      }
    }
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.result === "string") {
      return parseReplyText(record.result);
    }
    if (typeof record.response === "string") {
      return parseReplyText(record.response);
    }
    if (typeof record.result === "object" && record.result !== null) {
      return record.result;
    }
    if (typeof record.response === "object" && record.response !== null) {
      return record.response;
    }
  }

  return value;
}

/**
 * Read the engine's payload from a run that requested structured output.
 *
 * Returns `{ ok: true, payload }` only when the structured value (after
 * envelope unwrapping) validates as the expected payload — or when the
 * unwrapped reply text can be repaired by {@link extractJsonPayload}. Any
 * other outcome returns `{ ok: false }` so the caller falls back to the
 * legacy raw-stdout extraction path. Never throws.
 */
export function structuredPayloadFromResult<T>(
  result: AgentRunResult,
  validate: (value: unknown) => value is T,
  invalidMessage: string,
): { ok: true; payload: T } | { ok: false } {
  const structured = result.structured;
  if (!structured?.ok) {
    return { ok: false };
  }

  const unwrapped = unwrapStructuredPayload(structured.value);
  if (validate(unwrapped)) {
    return { ok: true, payload: unwrapped };
  }

  if (typeof unwrapped === "string") {
    try {
      return { ok: true, payload: extractJsonPayload(unwrapped, validate, invalidMessage) };
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return { ok: false };
    }
  }

  return { ok: false };
}

/** Rewrite one complete stdout line for human consumption. */
function readableEventLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return line;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return line;
  }
  const text = extractReplyText(parsed, 0);
  return typeof text === "string" && hasText(text) ? text : line;
}

export interface ReadableStdoutTap {
  /** Feed a raw stdout chunk; readable output flows to the sink. */
  forward(chunk: string): void;
  /** Forward any buffered (newline-less) remainder when the stream ends. */
  flush(): void;
}

/**
 * Build a display tap that turns JSON event lines into readable assistant
 * text for live output views.
 *
 * Raw chunks are buffered per line; a line that parses as JSON and carries
 * reply text is forwarded as that text (with its newline restored), while
 * every other line — logs, diagnostics, non-text JSON, non-JSON output —
 * passes through unchanged. Returns `undefined` when there is no sink, so
 * callers can wire `onStdout` unconditionally.
 *
 * @param sink - Existing stdout chunk callback (e.g. `onAgentChunk`).
 */
export function createReadableStdoutTap(
  sink: ((chunk: string) => void) | undefined,
): ReadableStdoutTap | undefined {
  if (!sink) {
    return undefined;
  }

  let pending = "";

  return {
    forward(chunk: string) {
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        sink(`${readableEventLine(line)}\n`);
        newlineIndex = pending.indexOf("\n");
      }
    },
    flush() {
      if (!pending) {
        return;
      }
      const remainder = pending;
      pending = "";
      sink(readableEventLine(remainder));
    },
  };
}
