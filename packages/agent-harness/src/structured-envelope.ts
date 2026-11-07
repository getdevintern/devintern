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
 * Field names below follow each CLI's documented JSON mode. Open-source CLIs
 * are **verified against upstream source** (repo + file linked); closed-source
 * CLIs (claude-code, cursor, antigravity) are taken from their official docs.
 *
 * - **claude-code** — `--output-format json`: single
 *   `{type:"result", result, usage:{input_tokens, cache_creation_input_tokens,
 *   cache_read_input_tokens, output_tokens}, total_cost_usd}` envelope
 *   (closed source; docs.claude.com/en/docs/claude-code/headless).
 * - **codex** — `--json`: JSONL thread/turn/item events
 *   (github.com/openai/codex, `codex-rs/exec/src/exec_events.rs`); the reply
 *   is the last `item.completed` whose `item.type` is `agent_message`
 *   (`item.text`), usage rides on `turn.completed`
 *   (`usage.{input_tokens, cached_input_tokens, cache_write_input_tokens,
 *   output_tokens, reasoning_output_tokens}` — there is **no** `total_tokens`
 *   field upstream).
 * - **opencode** — `--format json`: JSONL events (github.com/sst/opencode,
 *   `packages/opencode/src/cli/cmd/run.ts`); reply text on
 *   `{type:"text", part:{text}}`, usage/cost on `step_finish`
 *   (`part.cost`, `part.tokens.{input, output, reasoning, cache.read,
 *   cache.write}` — there is **no** `tokens.total` upstream). Every event
 *   carries `timestamp` + `sessionID`; the banner goes to stderr in JSON
 *   mode, so stdout is pure JSONL.
 * - **qwen** — `--output-format json`: JSON array of messages whose final
 *   entry is a Claude-style `{type:"result", result, usage}` summary
 *   (github.com/QwenLM/qwen-code,
 *   `packages/cli/src/nonInteractive/io/JsonOutputAdapter.ts`; `usage` also
 *   carries an optional `total_tokens`).
 * - **kimi** — `--output-format stream-json` (with `--print`): JSONL chat
 *   messages `{role:"assistant", content}` — `content` is a plain string when
 *   the message holds a single text part, otherwise `[{type:"text"|"think",
 *   ...}]` blocks (github.com/MoonshotAI/kimi-cli,
 *   `src/kimi_cli/ui/print/visualize.py`, `packages/kosong/src/kosong/message.py`).
 * - **cline** — `--json`: NDJSON records whose final
 *   `{ts, type:"run_result", finishReason, iterations, usage, durationMs,
 *   text, model}` carries the reply (`text`) and aggregated camelCase usage
 *   (`usage.{inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?,
 *   totalCost?}`) (github.com/cline/cline,
 *   `apps/cli/src/runtime/run-agent.ts` + `sdk/packages/shared/src/agents/
 *   types.ts` `LegacyAgentUsage`). Streaming text also arrives as
 *   `{ts, type:"agent_event", event:{type:"content_end", contentType:"text",
 *   text}}` — the `say`-record shape exists only in the VS Code extension.
 * - **kilo-code** — `kilo run --format json`: opencode-style JSONL events —
 *   the CLI is an opencode fork with the same `emit()` implementation
 *   (github.com/Kilo-Org/kilocode, `packages/opencode/src/cli/cmd/run.ts`),
 *   so it shares opencode's schema below.
 * - **pi** — `--mode json` (pairs with `-p`): JSONL session events (first
 *   line is a `{type:"session"}` header); the reply is the assistant
 *   `message` of `message_end` (`message.content` text blocks), usage is
 *   camelCase `{input, output, cacheRead, cacheWrite, reasoning?,
 *   totalTokens, cost}` — event-level on `message_update` and nested at
 *   `message.usage` on `message_end` (github.com/earendil-works/pi-mono —
 *   moved from badlogic/pi-mono, `packages/coding-agent/src/modes/
 *   json-event.ts`, `packages/ai/src/types.ts`).
 * - **cursor** — single result object carrying the reply text in `result`
 *   (closed source; Cursor CLI documents "single result object" without
 *   pinning the field).
 * - **deepseek (reasonix)** — `--output-format json`: a single
 *   `{type:"result", subtype, is_error, duration_ms, num_turns, result,
 *   usage:{input_tokens, output_tokens, cache_read_input_tokens,
 *   cache_creation_input_tokens, estimated?}, total_cost?, total_cost_usd?}`
 *   object on stdout (github.com/esengine/DeepSeek-Reasonix,
 *   `internal/cli/run_output.go` `runResult`).
 * - **grok** — `--output-format json`: one object carrying the reply text in
 *   `text`, a Claude-style `usage` (plus `reasoning_tokens`/`total_tokens`),
 *   and `total_cost_usd` when the bill is complete. Verified against the
 *   open-source CLI (github.com/xai-org/grok-build,
 *   `crates/codegen/xai-grok-pager/src/headless.rs`, `build_json_result`):
 *   the field mix is deliberate (`text`/`stopReason`/`sessionId` camelCase,
 *   usage snake_case) and frozen for external-tool compatibility. The reply
 *   text may embed the JSON payload after narration prose — see
 *   {@link parseReplyText}.
 * - **goose** — `goose run --output-format json`: one pretty-printed
 *   `{messages:[...], metadata:{total_tokens, input_tokens?, output_tokens?,
 *   cache_read_input_tokens?, cache_write_input_tokens?, cost_usd?, status}}`
 *   document; the reply is the last assistant message's `content` text
 *   blocks (github.com/block/goose, `crates/goose-cli/src/session/mod.rs`
 *   `JsonOutput` — there is **no** `response` field upstream).
 * - **antigravity** — single result envelope carrying the reply text in
 *   `response` (closed source; Google's agy CLI).
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

/**
 * Balanced top-level `{...}` spans of `text`, with brace matching that
 * respects string state so braces inside string literals (and escapes)
 * don't throw off the scan. Spans come in document order.
 */
function balancedObjectSpans(text: string): string[] {
  const spans: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        spans.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return spans;
}

/**
 * Parse reply text as JSON, recovering the payload when the model wraps it
 * in narration: a fenced ```json block, or a bare object embedded before /
 * after prose (observed live on grok headless, where `text` reads
 * `I'll inspect ...today.{"summary":...}`). Whole-text JSON still wins, and
 * unparseable text is returned as-is so callers keep their raw-reply
 * fallback instead of guessing.
 */
function parseReplyText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not a whole-text document — try embedded-JSON recovery below.
  }
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as unknown;
    } catch {
      // Fall through to balanced-span recovery.
    }
  }
  for (const span of balancedObjectSpans(text)) {
    try {
      return JSON.parse(span) as unknown;
    } catch {
      // Try the next candidate span.
    }
  }
  return text;
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

/**
 * Claude-style usage object: snake_case `input_tokens` / `output_tokens` /
 * cache fields (claude-code, qwen), extended with `reasoning_tokens` /
 * `total_tokens` where reported (grok). Absent fields stay out of the
 * result via {@link usageOf}.
 */
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
      reasoningTokens: asNumber(usage.reasoning_tokens),
      totalTokens: asNumber(usage.total_tokens),
    }),
  };
}

/**
 * Usage + cost of a Claude-style single envelope: `usage` plus an optional
 * top-level `total_cost_usd` (claude-code, grok).
 */
function claudeStyleStats(value: Record<string, unknown>): StructuredRunStats | undefined {
  const costUsd = asNumber(value.total_cost_usd);
  const usageStats = claudeStyleUsage(value);
  if (!usageStats) {
    return costUsd === undefined ? undefined : { costUsd };
  }
  return costUsd === undefined ? usageStats : { ...usageStats, costUsd };
}

/** Claude Code: single result envelope with usage + total cost. */
const CLAUDE_CODE_ENVELOPE: HarnessEnvelopeSchema = {
  ...resultEnvelope("result"),
  stats: (value) => (isRecord(value) ? claudeStyleStats(value) : undefined),
};

/** Codex `--json`: thread/turn/item JSONL events (openai/codex exec_events.rs). */
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
        cacheCreationTokens: asNumber(usage.cache_write_input_tokens),
        reasoningTokens: asNumber(usage.reasoning_output_tokens),
      }),
    };
  },
};

/** opencode `--format json` (and the kilo-code fork): step/text part events. */
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

/**
 * Cline `--json` (apps/cli `run-agent.ts`): NDJSON records ending in
 * `{type:"run_result", text, usage}` — camelCase usage per upstream
 * `LegacyAgentUsage`. Streaming assistant text also arrives nested as
 * `{type:"agent_event", event:{type:"content_end", contentType:"text", text}}`.
 */
const CLINE_EVENTS: HarnessEnvelopeSchema = {
  replyText(value) {
    if (!isRecord(value)) {
      return undefined;
    }
    if (value.type === "run_result") {
      return asText(value.text);
    }
    if (value.type === "agent_event") {
      const event = value.event;
      if (isRecord(event) && event.type === "content_end" && event.contentType === "text") {
        return asText(event.text);
      }
    }
    return undefined;
  },
  stats(value) {
    if (!isRecord(value) || value.type !== "run_result") {
      return undefined;
    }
    const usage = value.usage;
    if (!isRecord(usage)) {
      return undefined;
    }
    const costUsd = asNumber(usage.totalCost);
    return {
      usage: usageOf({
        inputTokens: asNumber(usage.inputTokens),
        outputTokens: asNumber(usage.outputTokens),
        cacheReadTokens: asNumber(usage.cacheReadTokens),
        cacheCreationTokens: asNumber(usage.cacheWriteTokens),
      }),
      ...(costUsd === undefined ? {} : { costUsd }),
    };
  },
};

/**
 * Pi `--mode json` (earendil-works/pi-mono): session events. The reply is
 * the `message_end` assistant message; usage is camelCase and rides
 * event-level on `message_update` and at `message.usage` on `message_end`
 * (the last reported value wins, so the final message's usage stands).
 */
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
    let usage: unknown;
    if (value.type === "message_update") {
      usage = value.usage;
    } else if (value.type === "message_end") {
      usage = isRecord(value.message) ? value.message.usage : undefined;
    }
    if (!isRecord(usage)) {
      return undefined;
    }
    const cost = isRecord(usage.cost) ? asNumber(usage.cost.total) : undefined;
    return {
      usage: usageOf({
        inputTokens: asNumber(usage.input),
        outputTokens: asNumber(usage.output),
        cacheReadTokens: asNumber(usage.cacheRead),
        cacheCreationTokens: asNumber(usage.cacheWrite),
        reasoningTokens: asNumber(usage.reasoning),
        totalTokens: asNumber(usage.totalTokens),
      }),
      ...(cost === undefined ? {} : { costUsd: cost }),
    };
  },
};

/**
 * Grok Build `--output-format json`: single result envelope with the reply
 * text in `text` and Claude-style usage + total cost. Shape verified against
 * the open-source CLI (xai-org/grok-build `headless.rs` `build_json_result`)
 * — the reply field is `text`, not `result`.
 */
const GROK_ENVELOPE: HarnessEnvelopeSchema = {
  ...resultEnvelope("text"),
  stats: (value) => (isRecord(value) ? claudeStyleStats(value) : undefined),
};

/**
 * DeepSeek Reasonix `--output-format json`
 * (esengine/DeepSeek-Reasonix `run_output.go` `runResult`): single result
 * envelope with the reply in `result`, Claude-style snake_case usage, and
 * `total_cost_usd` (compat alias of `total_cost`).
 */
const DEEPSEEK_ENVELOPE: HarnessEnvelopeSchema = {
  ...resultEnvelope("result"),
  stats: (value) => (isRecord(value) ? claudeStyleStats(value) : undefined),
};

/**
 * Goose `--output-format json` (block/goose `session/mod.rs`): one
 * pretty-printed `{messages, metadata}` document — there is no `response`
 * field. The reply is the last assistant message's `content` text blocks;
 * usage/cost live in `metadata` (snake_case; optional fields are omitted
 * when `None`, `total_tokens`/`status` always serialize).
 */
const GOOSE_DOCUMENT: HarnessEnvelopeSchema = {
  replyText(value) {
    if (!isRecord(value) || !Array.isArray(value.messages)) {
      return undefined;
    }
    for (let index = value.messages.length - 1; index >= 0; index -= 1) {
      const text = messageReplyText(value.messages[index]);
      if (text !== undefined) {
        return text;
      }
    }
    return undefined;
  },
  stats(value) {
    if (!isRecord(value) || !isRecord(value.metadata)) {
      return undefined;
    }
    const metadata = value.metadata;
    const costUsd = asNumber(metadata.cost_usd);
    return {
      usage: usageOf({
        inputTokens: asNumber(metadata.input_tokens),
        outputTokens: asNumber(metadata.output_tokens),
        cacheReadTokens: asNumber(metadata.cache_read_input_tokens),
        cacheCreationTokens: asNumber(metadata.cache_write_input_tokens),
        totalTokens: asNumber(metadata.total_tokens),
      }),
      ...(costUsd === undefined ? {} : { costUsd }),
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
  cline: CLINE_EVENTS,
  "kilo-code": OPENCODE_EVENTS,
  pi: PI_EVENTS,
  cursor: resultEnvelope("result"),
  grok: GROK_ENVELOPE,
  deepseek: DEEPSEEK_ENVELOPE,
  goose: GOOSE_DOCUMENT,
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
