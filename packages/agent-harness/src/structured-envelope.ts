/**
 * Per-harness schemas for structured (JSON) output envelopes.
 *
 * Every harness that sets `supportsStructuredOutput` emits its own
 * machine-readable shape — there is no cross-harness envelope format. This
 * module is the single registry of those exact shapes so callers can (a) dig
 * the model's final reply out of the envelope without field-name sniffing and
 * (b) surface the usage/cost stats the envelopes report (Claude Code
 * `usage`/`total_cost_usd`, Codex `turn.completed`, opencode `step_finish`,
 * pi `usage`, qwen result entries).
 *
 * Schemas are keyed by `AgentHarness.name`. A harness whose schema is not
 * registered here yields `{}` — callers must treat that as "envelope not
 * understood" and fall back to their legacy raw-stdout handling rather than
 * guessing fields. **Adding a new structured-output harness therefore
 * requires adding its schema below** (see the readme checklist).
 *
 * Field names below follow each CLI's documented JSON mode:
 *
 * - **claude-code** — `--output-format json`: single
 *   `{type:"result", result, usage:{input_tokens, cache_creation_input_tokens,
 *   cache_read_input_tokens, output_tokens}, total_cost_usd}` envelope.
 * - **codex** — `--json`: JSONL thread/turn/item events; the reply is the
 *   last `item.completed` whose `item.type` is `agent_message`, usage rides
 *   on `turn.completed` (`input_tokens`, `cached_input_tokens`,
 *   `output_tokens`, `total_tokens`).
 * - **opencode** — `--format json`: JSONL events; reply text on
 *   `{type:"text", part:{text}}`, usage/cost on `step_finish`
 *   (`part.tokens.input/output/reasoning/cache.read/cache.write`,
 *   `part.cost`).
 * - **qwen** — `--output-format json`: JSON array of messages whose final
 *   entry is a Claude-style `{type:"result", result, usage}` summary.
 * - **kimi** — `--output-format stream-json`: JSONL chat messages
 *   (`{role:"assistant", content}` — string or `[{type:"text", text}]`
 *   blocks).
 * - **cline** — `--json`: JSONL conversation messages; assistant text rides
 *   on `{type:"say", say:"text", text}` records (kilo-code's CLI follows the
 *   same shape — best-effort until verified upstream).
 * - **pi** — `--mode json`: JSONL session events; the reply is the assistant
 *   `message` content of `message_end`, usage on the event-level `usage`
 *   (`input`, `output`, `cacheRead`, `cacheWrite`).
 * - **cursor / grok / deepseek** — single result object carrying the reply
 *   text in `result` (best-effort; these CLIs document "single result
 *   object" without pinning the field).
 * - **goose / antigravity** — single result envelope carrying the reply text
 *   in `response`.
 */

/**
 * Token usage normalized across harness envelope shapes. Fields the harness
 * does not report stay `undefined` — consumers must not assume all fields.
 */
export interface StructuredTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

/** Usage/cost stats recovered from a harness's structured envelope. */
export interface StructuredRunStats {
  usage?: StructuredTokenUsage;
  /** Total run cost in USD, when the harness envelope reports one. */
  costUsd?: number;
}

/** Reply + stats extracted from one harness's structured output value. */
export interface HarnessStructuredReply extends StructuredRunStats {
  /**
   * The model's final reply: the parsed JSON payload when the reply text was
   * JSON, the raw reply text otherwise, or the object the harness carried
   * directly. `undefined` when the value does not match the harness's
   * envelope schema (callers fall back to their legacy extraction path).
   */
  reply?: unknown;
}

/** Exact structured-envelope schema for one harness. */
interface HarnessEnvelopeSchema {
  /**
   * Readable reply text carried by one parsed envelope/event object, or
   * `undefined` when that object carries no reply under this schema.
   */
  replyText(value: unknown): string | undefined;
  /**
   * Object-valued reply carried directly by one envelope/event object
   * (e.g. Claude-style envelopes whose `result` is the payload itself).
   */
  replyObject?(value: unknown): unknown | undefined;
  /** Usage/cost stats carried by one envelope/event object. */
  stats?(value: unknown): StructuredRunStats | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty string guard. */
function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Finite-number guard (envelopes occasionally emit `null`/strings). */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse reply text as JSON, returning the text itself when it is not JSON. */
function parseReplyText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Collect only the defined fields of a partial usage record. */
function usageOf(usage: StructuredTokenUsage): StructuredTokenUsage | undefined {
  const defined = Object.fromEntries(
    Object.entries(usage).filter(([, tokenCount]) => tokenCount !== undefined),
  );
  return Object.keys(defined).length > 0 ? defined : undefined;
}

/** Single-result envelope whose reply rides on one top-level text field. */
function resultEnvelope(replyField: string): HarnessEnvelopeSchema {
  return {
    replyText(value) {
      return isRecord(value) ? asText(value[replyField]) : undefined;
    },
    replyObject(value) {
      return isRecord(value) && isRecord(value[replyField]) ? value[replyField] : undefined;
    },
  };
}

/** Chat-message reply: `content` string or `[{type:"text", text}]` blocks. */
function messageReplyText(value: unknown): string | undefined {
  if (!isRecord(value) || (value.role !== undefined && value.role !== "assistant")) {
    return undefined;
  }
  const content = value.content;
  if (typeof content === "string") {
    return asText(content);
  }
  if (Array.isArray(content)) {
    const blocks = content
      .map((block) => (isRecord(block) ? asText(block.text) : undefined))
      .filter((text): text is string => text !== undefined);
    return asText(blocks.join("\n"));
  }
  return undefined;
}

/** Claude-style usage object (`input_tokens` / `output_tokens` / cache). */
function claudeStyleUsage(value: Record<string, unknown>): StructuredRunStats | undefined {
  const usage = value.usage;
  if (!isRecord(usage)) {
    return undefined;
  }
  return {
    usage: usageOf({
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      cacheReadTokens: asNumber(usage.cache_read_input_tokens),
      cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
    }),
  };
}

/** Claude Code: single result envelope with usage + total cost. */
const CLAUDE_CODE_ENVELOPE: HarnessEnvelopeSchema = {
  ...resultEnvelope("result"),
  stats(value) {
    if (!isRecord(value)) {
      return undefined;
    }
    const costUsd = asNumber(value.total_cost_usd);
    const claudeStats = claudeStyleUsage(value);
    if (!claudeStats) {
      return costUsd === undefined ? undefined : { costUsd };
    }
    return costUsd === undefined ? claudeStats : { ...claudeStats, costUsd };
  },
};

/** Codex `--json`: thread/turn/item JSONL events. */
const CODEX_EVENTS: HarnessEnvelopeSchema = {
  replyText(value) {
    if (!isRecord(value) || value.type !== "item.completed") {
      return undefined;
    }
    const item = value.item;
    if (!isRecord(item) || item.type !== "agent_message") {
      return undefined;
    }
    return asText(item.text);
  },
  stats(value) {
    if (!isRecord(value) || value.type !== "turn.completed") {
      return undefined;
    }
    const usage = value.usage;
    if (!isRecord(usage)) {
      return undefined;
    }
    return {
      usage: usageOf({
        inputTokens: asNumber(usage.input_tokens),
        outputTokens: asNumber(usage.output_tokens),
        cacheReadTokens: asNumber(usage.cached_input_tokens),
        totalTokens: asNumber(usage.total_tokens),
      }),
    };
  },
};

/** opencode `--format json`: step/text part events. */
const OPENCODE_EVENTS: HarnessEnvelopeSchema = {
  replyText(value) {
    if (!isRecord(value) || value.type !== "text") {
      return undefined;
    }
    const part = value.part;
    return isRecord(part) ? asText(part.text) : undefined;
  },
  stats(value) {
    if (!isRecord(value) || value.type !== "step_finish") {
      return undefined;
    }
    const part = value.part;
    if (!isRecord(part)) {
      return undefined;
    }
    const costUsd = asNumber(part.cost);
    const tokens = part.tokens;
    if (!isRecord(tokens)) {
      return costUsd === undefined ? undefined : { costUsd };
    }
    const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
    return {
      usage: usageOf({
        inputTokens: asNumber(tokens.input),
        outputTokens: asNumber(tokens.output),
        reasoningTokens: asNumber(tokens.reasoning),
        cacheReadTokens: cache ? asNumber(cache.read) : undefined,
        cacheCreationTokens: cache ? asNumber(cache.write) : undefined,
        totalTokens: asNumber(tokens.total),
      }),
      ...(costUsd === undefined ? {} : { costUsd }),
    };
  },
};

/** Qwen `--output-format json`: message array ending in a result entry. */
const QWEN_MESSAGES: HarnessEnvelopeSchema = {
  replyText(value) {
    if (!isRecord(value) || value.type !== "result") {
      return undefined;
    }
    return asText(value.result);
  },
  replyObject(value) {
    if (!isRecord(value) || value.type !== "result") {
      return undefined;
    }
    return isRecord(value.result) ? value.result : undefined;
  },
  stats: (value) =>
    isRecord(value) && value.type === "result" ? claudeStyleUsage(value) : undefined,
};

/** Kimi `--output-format stream-json`: JSONL chat messages. */
const KIMI_MESSAGES: HarnessEnvelopeSchema = {
  replyText: messageReplyText,
};

/** Cline `--json` (and kilo-code): `{type:"say", say:"text", text}` records. */
const CLINE_SAY_EVENTS: HarnessEnvelopeSchema = {
  replyText(value) {
    if (!isRecord(value) || value.type !== "say") {
      return undefined;
    }
    // Assistant text records pin `say:"text"`; older builds omit the field.
    if (value.say !== undefined && value.say !== "text") {
      return undefined;
    }
    return asText(value.text);
  },
};

/** Pi `--mode json`: session events with message content + usage. */
const PI_EVENTS: HarnessEnvelopeSchema = {
  replyText(value) {
    if (!isRecord(value) || value.type !== "message_end") {
      return undefined;
    }
    return messageReplyText(value.message);
  },
  stats(value) {
    if (!isRecord(value)) {
      return undefined;
    }
    const usage = value.usage;
    if (!isRecord(usage)) {
      return undefined;
    }
    return {
      usage: usageOf({
        inputTokens: asNumber(usage.input),
        outputTokens: asNumber(usage.output),
        cacheReadTokens: asNumber(usage.cacheRead),
        cacheCreationTokens: asNumber(usage.cacheWrite),
      }),
    };
  },
};

/**
 * Exact envelope schemas for the built-in structured-output harnesses, keyed
 * by `AgentHarness.name`. Harnesses without an entry here yield `{}` from
 * {@link extractHarnessStructuredReply} — add the schema when adding the
 * harness (see the readme checklist).
 */
const ENVELOPE_SCHEMAS: Record<string, HarnessEnvelopeSchema> = {
  "claude-code": CLAUDE_CODE_ENVELOPE,
  codex: CODEX_EVENTS,
  opencode: OPENCODE_EVENTS,
  qwen: QWEN_MESSAGES,
  kimi: KIMI_MESSAGES,
  cline: CLINE_SAY_EVENTS,
  "kilo-code": CLINE_SAY_EVENTS,
  pi: PI_EVENTS,
  cursor: resultEnvelope("result"),
  grok: resultEnvelope("result"),
  deepseek: resultEnvelope("result"),
  goose: resultEnvelope("response"),
  antigravity: resultEnvelope("response"),
};

/** Merge two partial stats records; later values win per defined key. */
function mergeStats(
  base: StructuredRunStats | undefined,
  next: StructuredRunStats,
): StructuredRunStats {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(next).filter(([, stat]) => stat !== undefined)),
  };
}

/**
 * Interpret a harness's parsed structured output per its exact envelope
 * schema: recover the model's final reply plus the usage/cost stats the
 * envelope reports.
 *
 * - Arrays (NDJSON event streams, buffered message arrays): the reply comes
 *   from the last entry matching the schema — the model's final message —
 *   and stats accumulate across entries (last reported value wins).
 * - Objects (single-envelope harnesses): reply and stats come from the same
 *   document; an object-valued reply field is returned as the payload
 *   directly.
 * - Unknown harness names / values that match no schema yield `{}` so
 *   callers can fall back to their legacy raw-stdout extraction instead of
 *   guessing at envelope fields.
 *
 * @param harnessName - `AgentHarness.name` of the run's harness.
 * @param value - Parsed `StructuredOutputResult.value` for the run.
 */
export function extractHarnessStructuredReply(
  harnessName: string,
  value: unknown,
): HarnessStructuredReply {
  const schema = ENVELOPE_SCHEMAS[harnessName];
  if (!schema) {
    return {};
  }

  let stats: StructuredRunStats | undefined;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const entryStats = schema.stats?.(entry);
      if (entryStats) {
        stats = mergeStats(stats, entryStats);
      }
    }
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const entry = value[index];
      const text = schema.replyText(entry);
      if (text !== undefined) {
        return { reply: parseReplyText(text), ...stats };
      }
      const objectReply = schema.replyObject?.(entry);
      if (objectReply !== undefined) {
        return { reply: objectReply, ...stats };
      }
    }
    return stats ? { ...stats } : {};
  }

  if (isRecord(value)) {
    stats = schema.stats?.(value) ?? stats;
    const objectReply = schema.replyObject?.(value);
    if (objectReply !== undefined) {
      return { reply: objectReply, ...stats };
    }
    const text = schema.replyText(value);
    if (text !== undefined) {
      return { reply: parseReplyText(text), ...stats };
    }
  }

  return stats ? { ...stats } : {};
}

/**
 * Readable reply text carried by one parsed JSON event line (or envelope) of
 * a harness's structured output. Powers live-output taps: lines the schema
 * maps to assistant text can be shown as that text, everything else passes
 * through untouched.
 */
export function extractHarnessEventText(harnessName: string, value: unknown): string | undefined {
  return ENVELOPE_SCHEMAS[harnessName]?.replyText(value);
}
