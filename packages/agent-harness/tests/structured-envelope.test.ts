import { describe, expect, test } from "bun:test";

import {
  extractHarnessEventText,
  extractHarnessStructuredReply,
} from "../src/structured-envelope.js";

// Envelope fixtures follow each CLI's documented JSON mode (see the module
// header in src/structured-envelope.ts for the per-harness shape notes).
const CLAUDE_ENVELOPE = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1234,
  result: '{"summary": "S", "description": "D"}',
  usage: {
    input_tokens: 4,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 200,
    output_tokens: 50,
  },
  total_cost_usd: 0.0123,
};

const CODEX_EVENTS = [
  { type: "thread.started", thread_id: "t1" },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "draft" } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: '{"ok":true}' } },
  {
    type: "turn.completed",
    usage: { input_tokens: 24763, cached_input_tokens: 1024, output_tokens: 122, total_tokens: 24885 },
  },
];

const OPENCODE_EVENTS = [
  { type: "step_start", part: { id: "prt_1", type: "step-start" } },
  { type: "text", part: { id: "prt_2", type: "text", text: "partial" } },
  { type: "text", part: { id: "prt_3", type: "text", text: '{"done":1}' } },
  {
    type: "step_finish",
    part: {
      id: "prt_4",
      type: "step-finish",
      reason: "stop",
      cost: 0.014087,
      tokens: { total: 11168, input: 2, output: 34, reasoning: 0, cache: { write: 11132, read: 0 } },
    },
  },
];

describe("extractHarnessStructuredReply", () => {
  test("claude-code envelope: reply, token usage, and cost", () => {
    const extracted = extractHarnessStructuredReply("claude-code", CLAUDE_ENVELOPE);
    expect(extracted.reply).toEqual({ summary: "S", description: "D" });
    expect(extracted.usage).toEqual({
      inputTokens: 4,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
    });
    expect(extracted.costUsd).toBe(0.0123);
  });

  test("claude-code envelope without usage fields yields only the reply", () => {
    const extracted = extractHarnessStructuredReply("claude-code", {
      type: "result",
      result: "plain text",
    });
    expect(extracted.reply).toBe("plain text");
    expect(extracted.usage).toBeUndefined();
    expect(extracted.costUsd).toBeUndefined();
  });

  test("claude-code object-valued result is taken as the payload directly", () => {
    const payload = { summary: "S", description: "D" };
    const extracted = extractHarnessStructuredReply("claude-code", {
      type: "result",
      result: payload,
      total_cost_usd: 0.5,
    });
    expect(extracted.reply).toEqual(payload);
    expect(extracted.costUsd).toBe(0.5);
  });

  test("codex events: last agent_message is the reply, turn.completed carries usage", () => {
    const extracted = extractHarnessStructuredReply("codex", CODEX_EVENTS);
    expect(extracted.reply).toEqual({ ok: true });
    expect(extracted.usage).toEqual({
      inputTokens: 24763,
      outputTokens: 122,
      cacheReadTokens: 1024,
      totalTokens: 24885,
    });
  });

  test("codex ignores non-agent_message items and turn events without usage", () => {
    const extracted = extractHarnessStructuredReply("codex", [
      { type: "item.completed", item: { type: "command_execution", text: "ls -la" } },
      { type: "turn.completed", usage: {} },
    ]);
    expect(extracted.reply).toBeUndefined();
    expect(extracted.usage).toBeUndefined();
  });

  test("opencode events: text parts are the reply, step_finish carries usage and cost", () => {
    const extracted = extractHarnessStructuredReply("opencode", OPENCODE_EVENTS);
    expect(extracted.reply).toEqual({ done: 1 });
    expect(extracted.usage).toEqual({
      inputTokens: 2,
      outputTokens: 34,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 11132,
      totalTokens: 11168,
    });
    expect(extracted.costUsd).toBe(0.014087);
  });

  test("qwen message array: the result entry carries reply and usage", () => {
    const extracted = extractHarnessStructuredReply("qwen", [
      { type: "system", subtype: "session_start" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "working" }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: '{"summary": "S", "description": "D"}',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    expect(extracted.reply).toEqual({ summary: "S", description: "D" });
    expect(extracted.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test("kimi message stream: last assistant message content is the reply", () => {
    const extracted = extractHarnessStructuredReply("kimi", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "checking" },
      { role: "tool", tool_call_id: "tc_1", content: "listing" },
      { role: "assistant", content: [{ type: "text", text: '{"subtasks":[]}' }] },
    ]);
    expect(extracted.reply).toEqual({ subtasks: [] });
  });

  test("cline say events: assistant text records carry the reply", () => {
    const extracted = extractHarnessStructuredReply("cline", [
      { type: "say", say: "api_req_started", text: "request meta" },
      { type: "say", say: "text", text: '{"summary": "S", "description": "D"}' },
    ]);
    expect(extracted.reply).toEqual({ summary: "S", description: "D" });
  });

  test("pi events: message_end content is the reply, event usage carries tokens", () => {
    const extracted = extractHarnessStructuredReply("pi", [
      { type: "session", version: 3, id: "s1" },
      { type: "message_update", usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 1 } },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: '{"ok":2}' }] },
        usage: { input: 10, output: 9, cacheRead: 5, cacheWrite: 1 },
      },
    ]);
    expect(extracted.reply).toEqual({ ok: 2 });
    expect(extracted.usage).toEqual({
      inputTokens: 10,
      outputTokens: 9,
      cacheReadTokens: 5,
      cacheCreationTokens: 1,
    });
  });

  test.each([
    ["cursor", { result: '{"a":1}' }],
    ["grok", { result: '{"a":1}' }],
    ["deepseek", { result: '{"a":1}' }],
    ["goose", { response: '{"a":1}' }],
    ["antigravity", { response: '{"a":1}' }],
  ])("%s single-result envelope reply field", (harnessName, envelope) => {
    const extracted = extractHarnessStructuredReply(harnessName, envelope);
    expect(extracted.reply).toEqual({ a: 1 });
  });

  test("unknown harness yields no reply and no stats (fail-open for callers)", () => {
    expect(extractHarnessStructuredReply("stub", { result: '{"a":1}' })).toEqual({});
    expect(extractHarnessStructuredReply("stub", [CODEX_EVENTS[0]])).toEqual({});
  });

  test("envelope mismatch yields nothing instead of guessing fields", () => {
    // A qwen-style result entry is not a claude-code `result` string.
    expect(extractHarnessStructuredReply("claude-code", [{ type: "result" }])).toEqual({});
    // A claude envelope is not a codex item stream.
    expect(extractHarnessStructuredReply("codex", { type: "result", result: "x" })).toEqual({});
  });
});

describe("extractHarnessEventText", () => {
  test("returns reply text for schema-matching event lines", () => {
    expect(extractHarnessEventText("codex", CODEX_EVENTS[1])).toBe("draft");
    expect(extractHarnessEventText("opencode", OPENCODE_EVENTS[1])).toBe("partial");
    expect(extractHarnessEventText("cline", { type: "say", say: "text", text: "hello" })).toBe(
      "hello",
    );
    expect(extractHarnessEventText("claude-code", CLAUDE_ENVELOPE)).toBe(
      '{"summary": "S", "description": "D"}',
    );
  });

  test("returns undefined for non-text events and unknown harnesses", () => {
    expect(extractHarnessEventText("codex", CODEX_EVENTS[0])).toBeUndefined();
    expect(extractHarnessEventText("codex", CODEX_EVENTS[3])).toBeUndefined();
    expect(extractHarnessEventText("stub", { result: "text" })).toBeUndefined();
  });
});
