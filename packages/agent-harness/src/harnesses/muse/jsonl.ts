/**
 * Incremental JSONL parser for `muse exec --json` stdout.
 */

import type { MuseJsonlEvent, MuseJsonlParseState } from "./types.js";

/** Create an empty JSONL parse state. */
export function createMuseJsonlParseState(): MuseJsonlParseState {
  return {
    textParts: [],
    events: [],
    parseErrors: [],
    stepLimitReached: false,
  };
}

/**
 * Redact potentially sensitive content from a malformed line for diagnostics.
 *
 * @param line - Raw line that failed to parse.
 */
export function redactMalformedLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 80)}… (${trimmed.length} chars)`;
}

/**
 * Extract human-readable text from a parsed Muse JSONL event.
 *
 * Tolerates unknown event types; returns empty string when no text is found.
 *
 * @param event - Parsed event object.
 */
export function extractTextFromMuseEvent(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : undefined;

  if (type === "assistant" || type === "message" || type === "result" || type === "output") {
    if (typeof event.text === "string") {
      return event.text;
    }
    if (typeof event.content === "string") {
      return event.content;
    }
    if (typeof event.message === "string") {
      return event.message;
    }
  }

  if (typeof event.text === "string") {
    return event.text;
  }
  if (typeof event.content === "string") {
    return event.content;
  }
  if (typeof event.message === "string") {
    return event.message;
  }

  // Nested payload shapes
  const payload = event.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const nested = payload as Record<string, unknown>;
    if (typeof nested.text === "string") {
      return nested.text;
    }
    if (typeof nested.content === "string") {
      return nested.content;
    }
  }

  return "";
}

/**
 * Whether the event indicates a max-model-steps limit.
 *
 * @param event - Parsed event object.
 */
export function isMuseStepLimitEvent(event: Record<string, unknown>): boolean {
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  if (
    type.includes("step_limit") ||
    type.includes("max_model_steps") ||
    type.includes("max-model-steps")
  ) {
    return true;
  }
  if (event.step_limit_reached === true || event.max_model_steps_reached === true) {
    return true;
  }
  const message =
    (typeof event.message === "string" ? event.message : "") ||
    (typeof event.error === "string" ? event.error : "");
  return /max[- ]model[- ]steps|step limit/i.test(message);
}

/**
 * Parse one JSONL line and merge into parse state.
 *
 * @param state - Mutable parse state.
 * @param line - Single line (without trailing newline).
 * @returns Parsed event when JSON was valid, otherwise undefined.
 */
export function parseMuseJsonlLine(
  state: MuseJsonlParseState,
  line: string,
): MuseJsonlEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    state.parseErrors.push(`Malformed JSONL line: ${redactMalformedLine(trimmed)}`);
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    state.parseErrors.push(`JSONL line is not an object: ${redactMalformedLine(trimmed)}`);
    return undefined;
  }

  const raw = parsed as Record<string, unknown>;
  const event: MuseJsonlEvent = {
    raw,
    type: typeof raw.type === "string" ? raw.type : undefined,
  };
  state.events.push(event);

  if (isMuseStepLimitEvent(raw)) {
    state.stepLimitReached = true;
  }

  const text = extractTextFromMuseEvent(raw);
  if (text) {
    state.textParts.push(text);
  }

  return event;
}

/**
 * Feed a stdout chunk into the incremental JSONL parser.
 *
 * Handles partial lines across chunk boundaries.
 *
 * @param state - Mutable parse state.
 * @param buffer - Carry-over partial line buffer (mutated).
 * @param chunk - New stdout bytes as string.
 * @param onEvent - Optional callback for each parsed event (streaming).
 */
export function feedMuseJsonlChunk(
  state: MuseJsonlParseState,
  buffer: { partial: string },
  chunk: string,
  onEvent?: (event: MuseJsonlEvent) => void,
): void {
  const combined = buffer.partial + chunk;
  const lines = combined.split("\n");
  buffer.partial = lines.pop() ?? "";

  for (const line of lines) {
    const event = parseMuseJsonlLine(state, line);
    if (event && onEvent) {
      onEvent(event);
    }
  }
}

/**
 * Flush any remaining partial line at end of stream.
 *
 * @param state - Parse state.
 * @param buffer - Partial line buffer.
 * @param onEvent - Optional streaming callback.
 */
export function flushMuseJsonlBuffer(
  state: MuseJsonlParseState,
  buffer: { partial: string },
  onEvent?: (event: MuseJsonlEvent) => void,
): void {
  if (buffer.partial.trim()) {
    const event = parseMuseJsonlLine(state, buffer.partial);
    if (event && onEvent) {
      onEvent(event);
    }
  }
  buffer.partial = "";
}

/**
 * Join extracted text parts into normalized stdout.
 *
 * @param state - Parse state after stream completion.
 */
export function museNormalizedText(state: MuseJsonlParseState): string {
  return state.textParts.join("");
}
