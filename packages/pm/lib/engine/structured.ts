/**
 * Structured (JSON) agent output for the PM engine.
 *
 * When the configured harness declares `supportsStructuredOutput`, the engine
 * requests the harness CLI's JSON mode (`AgentRunOptions.structuredOutput`)
 * and reads the already-parsed payload from `AgentRunResult.structured`
 * instead of scraping JSON out of raw transcript text. The parsed value is
 * interpreted through the harness's **exact envelope schema**
 * (`extractHarnessStructuredReply` in `@devintern/agent-harness`) — every
 * structured-output harness wraps the model's reply in its own shape (Claude
 * Code a single `{"type":"result",...}` envelope, Codex/Opencode/Kilo/Cline/
 * Kimi/Pi NDJSON events, Qwen a buffered message array), so generic
 * field-name sniffing is never used.
 *
 * - **Envelope unwrapping.** {@link structuredPayloadFromResult} digs the
 *   model's reply out of the configured harness's envelope shape and
 *   validates it with the existing payload validators (`isStoryPayload`,
 *   `isDecompositionPayload`). When the harness has no registered schema or
 *   its envelope does not match, the engine falls back to accepting the
 *   parsed value directly and then to the tolerant `extractJsonPayload`
 *   repair on raw stdout — never to envelope field guessing.
 * - **Usage/cost stats.** The same schemas recover the token usage and cost
 *   the envelopes report, surfaced to callers via the `onAgentUsage` event.
 * - **Readable streaming.** With JSON mode on, the raw stdout chunks fed to
 *   `onAgentChunk` are JSON events rather than transcript text — desktop's
 *   live agent output view would show machine noise. The tap produced by
 *   {@link createReadableStdoutTap} rewrites JSON event lines that carry
 *   readable assistant text (per the harness schema) into that text and
 *   passes everything else through untouched (diagnostic/log lines,
 *   non-JSON output).
 *
 * Failure handling stays fail-open toward the legacy path: when structured
 * parsing fails (`structured.ok === false`) or the unwrapped payload does not
 * validate, the engine falls back to the tolerant `extractJsonPayload` repair
 * on raw stdout before surfacing a `parse-failed` error.
 */

import type { AgentRunResult, StructuredRunStats } from "@devintern/agent-harness";
import { extractHarnessEventText, extractHarnessStructuredReply } from "@devintern/agent-harness";
import { extractJsonPayload } from "./json.js";
import { EngineError } from "./types.js";

/**
 * Read the engine's payload from a run that requested structured output.
 *
 * The parsed structured value is interpreted via the harness's exact
 * envelope schema. Returns `{ ok: true, payload }` when the unwrapped reply
 * validates as the expected payload (or, for a string reply, when the reply
 * text can be repaired by {@link extractJsonPayload}); a schema-less value
 * that already validates as the payload is accepted as-is. Any other
 * outcome returns `{ ok: false }` so the caller falls back to the legacy
 * raw-stdout extraction path. Never throws.
 *
 * @param result - The completed agent run result.
 * @param harnessName - Configured harness id (`AgentHarness.name`) whose
 *   envelope schema should interpret `result.structured.value`.
 * @param validate - Type guard for the expected payload shape.
 * @param invalidMessage - Error message when the reply fails validation.
 */
export function structuredPayloadFromResult<T>(
  result: AgentRunResult,
  harnessName: string,
  validate: (value: unknown) => value is T,
  invalidMessage: string,
): { ok: true; payload: T; stats?: StructuredRunStats } | { ok: false } {
  const structured = result.structured;
  if (!structured?.ok) {
    return { ok: false };
  }

  const { reply, ...stats } = extractHarnessStructuredReply(harnessName, structured.value);
  const withStats = <P>(payload: P): { ok: true; payload: P; stats?: StructuredRunStats } => ({
    ok: true,
    payload,
    ...(Object.keys(stats).length > 0 ? { stats } : {}),
  });

  if (reply !== undefined) {
    if (validate(reply)) {
      return withStats(reply);
    }
    if (typeof reply === "string") {
      try {
        return withStats(extractJsonPayload(reply, validate, invalidMessage));
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        return { ok: false };
      }
    }
    return { ok: false };
  }

  // Harness without a matching envelope (unregistered schema or an
  // atypical payload): accept the parsed value when it already is the
  // payload, otherwise defer to the legacy raw-stdout repair.
  if (validate(structured.value)) {
    return { ok: true, payload: structured.value };
  }
  return { ok: false };
}

/** Rewrite one complete stdout line for human consumption. */
function readableEventLine(line: string, harnessName: string): string {
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
  const text = extractHarnessEventText(harnessName, parsed);
  return typeof text === "string" && text.trim().length > 0 ? text : line;
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
 * reply text under the harness's envelope schema is forwarded as that text
 * (with its newline restored), while every other line — logs, diagnostics,
 * non-text JSON, non-JSON output — passes through unchanged. Returns
 * `undefined` when there is no sink, so callers can wire `onStdout`
 * unconditionally.
 *
 * @param harnessName - Configured harness id (`AgentHarness.name`) whose
 *   event schema decides which lines carry readable text.
 * @param sink - Existing stdout chunk callback (e.g. `onAgentChunk`).
 */
export function createReadableStdoutTap(
  harnessName: string,
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
        sink(`${readableEventLine(line, harnessName)}\n`);
        newlineIndex = pending.indexOf("\n");
      }
    },
    flush() {
      if (!pending) {
        return;
      }
      const remainder = pending;
      pending = "";
      sink(readableEventLine(remainder, harnessName));
    },
  };
}
