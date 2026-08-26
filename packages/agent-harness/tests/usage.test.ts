import { describe, expect, test } from "bun:test";

import {
  extractAgentUsage,
  findJsonUsageObjects,
  mergeAgentUsages,
} from "../src/usage.js";
import type { AgentUsage, UsageExtractionInput } from "../src/usage.js";


function extract(harness: string, stdout = "", stderr = ""): ReturnType<typeof extractAgentUsage> {
  const input: UsageExtractionInput = { harness, stdout, stderr };
  return extractAgentUsage(input);
}

describe("findJsonUsageObjects", () => {
  test("parses a whole-document JSON result with nested usage", () => {
    const text = JSON.stringify({
      type: "result",
      total_cost_usd: 0.42,
      modelUsage: {
        "claude-sonnet-4-5": {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
        },
      },
    });
    const found = findJsonUsageObjects(text);
    expect(found.length).toBeGreaterThan(0);
    const merged = found.reduce<Record<string, number | string | undefined>>((acc, raw) => {
      Object.assign(acc, raw);
      return acc;
    }, {});
    expect(merged.inputTokens).toBe(1000);
    expect(merged.outputTokens).toBe(500);
    expect(merged.cost).toBe(0.42);
  });

  test("does not double count aggregate + per-model views of the same tokens", () => {
    const text = JSON.stringify({
      costUSD: 1.5,
      usage: { input_tokens: 800, output_tokens: 400, total_tokens: 1200 },
      modelUsage: { "gpt-5": { input_tokens: 800, output_tokens: 400 } },
    });
    const found = findJsonUsageObjects(text);
    // The deepest subtree wins; the aggregate parent is skipped.
    const inputs = found.map((raw) => raw.inputTokens ?? null).filter((value) => value !== null);
    expect(inputs).toEqual([800]);
  });

  test("scans JSONL rows mixed into plain output", () => {
    const text = [
      "working...",
      `{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5}}}`,
      "done",
    ].join("\n");
    const found = findJsonUsageObjects(text);
    expect(found.length).toBe(1);
    expect(found[0]?.inputTokens).toBe(10);
    expect(found[0]?.outputTokens).toBe(5);
  });

  test("ignores prose mentioning costs", () => {
    expect(findJsonUsageObjects("The total cost is $5 and input tokens are large")).toEqual([]);
  });

  test("returns empty for non-JSON garbage", () => {
    expect(findJsonUsageObjects("{not json")).toEqual([]);
  });

  test("JSONL usage rows far from the end of a transcript are ignored", () => {
    const filler = Array.from({ length: 200 }, (_, i) => `doing work ${i}`).join("\n");
    const after = Array.from({ length: 80 }, (_, i) => `more work ${i}`).join("\n");
    const text = `${filler}\n{"usage": {"prompt_tokens": 120, "completion_tokens": 30}}\n${after}`;
    // Only the whole-document parse is trusted; mid-transcript JSONL rows
    // look like app/test output, not provider reporting.
    expect(findJsonUsageObjects(text)).toEqual([]);
  });
});

describe("extractAgentUsage", () => {
  test("claude-code structured result yields complete usage", () => {
    const usage = extract(
      "claude-code",
      JSON.stringify({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.12,
        modelUsage: { "claude-sonnet-4-5": { inputTokens: 900, outputTokens: 300 } },
      }),
    );
    expect(usage).not.toBeNull();
    expect(usage?.source).toBe("structured_output");
    expect(usage?.inputTokens).toBe(900);
    expect(usage?.outputTokens).toBe(300);
    expect(usage?.reportedCost).toBe(0.12);
    expect(usage?.costCurrency).toBe("USD");
    expect(usage?.complete).toBe(true);
  });

  test("claude-code plain-text mode reports explicit unknown (null)", () => {
    expect(extract("claude-code", "Implemented the feature.\n\nDone.")).toBeNull();
  });

  test("codex --jsonl turn events yield token counts", () => {
    const usage = extract(
      "codex",
      '{"type":"turn.completed","usage":{"input_tokens":17439,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
    );
    expect(usage?.inputTokens).toBe(17439);
    expect(usage?.cachedInputTokens).toBe(11008);
    expect(usage?.outputTokens).toBe(5);
  });

  test("opencode --format json step_finish events yield full token breakdown", () => {
    const usage = extract(
      "opencode",
      '{"type":"step_finish","part":{"tokens":{"total":9527,"input":2151,"output":11,"reasoning":5,"cache":{"write":0,"read":7360}},"cost":0}}',
    );
    expect(usage?.inputTokens).toBe(2151);
    expect(usage?.cachedInputTokens).toBe(7360);
    expect(usage?.outputTokens).toBe(11);
    expect(usage?.reasoningTokens).toBe(5);
    expect(usage?.totalTokens).toBe(9527);
  });

  test("grok --output-format json result yields tokens and provider cost", () => {
    const usage = extract(
      "grok",
      JSON.stringify({
        text: "ok",
        usage: { input_tokens: 3472, cache_read_input_tokens: 11520, output_tokens: 37 },
        total_cost_usd: 0.00219742,
        modelUsage: { "grok-4": { inputTokens: 3472, outputTokens: 37 } },
      }),
    );
    expect(usage?.inputTokens).toBe(3472);
    expect(usage?.cachedInputTokens).toBe(11520);
    expect(usage?.totalTokens).toBeNull();
    expect(usage?.reportedCost).toBeCloseTo(0.00219742);
    expect(usage?.complete).toBe(true);
  });

  test("unstructured output (prose, summaries, source) yields explicit null", () => {
    // Real default-mode outputs: no structured usage → unknown, never guesses.
    expect(extract("codex", "ok\n", "tokens used\n6,530\n")).toBeNull();
    expect(extract("grok", "ok\n")).toBeNull();
    expect(extract("opencode", "ok\n")).toBeNull();
    const stdout = ["const inputTokens = config.input;", "+ total cost: $999", "done"].join("\n");
    expect(extract("goose", stdout)).toBeNull();
    expect(extract("codex", "", "done\ntokens used: 500\ntotal cost: $0.42")).toBeNull();
  });

  test("model-only JSON (configs, fixtures) is not usage", () => {
    expect(extract("opencode", '{"name":"x","model":"y","scripts":{"t":"t"}}')).toBeNull();
  });

  test("malformed JSON degrades to null instead of throwing", () => {
    expect(extract("opencode", '{"usage": {"input_truncated')).toBeNull();
  });

  test("zero-token sessions stay zero, not null", () => {
    const usage = extract(
      "claude-code",
      JSON.stringify({ modelUsage: { "claude-haiku-4": { inputTokens: 0, outputTokens: 0 } } }),
    );
    expect(usage?.inputTokens).toBe(0);
    expect(usage?.outputTokens).toBe(0);
  });
});

describe("mergeAgentUsages", () => {
  const base: AgentUsage = {
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    model: "claude-sonnet-4-5",
    reportedCost: 0.01,
    costCurrency: "USD",
    source: "structured_output",
    complete: true,
  };

  test("sums tokens and costs across sessions without double counting", () => {
    const merged = mergeAgentUsages([base, { ...base, reportedCost: 0.02 }]);
    expect(merged?.inputTokens).toBe(200);
    expect(merged?.outputTokens).toBe(100);
    expect(merged?.reportedCost).toBeCloseTo(0.03);
    expect(merged?.sessions).toBe(2);
    expect(merged?.complete).toBe(true);
  });

  test("null survives when no session reported a category", () => {
    const merged = mergeAgentUsages([base, { ...base, cachedInputTokens: 7 }]);
    expect(merged?.cachedInputTokens).toBe(7); // first session had none
  });

  test("all-null usages produce an explicit unknown-exposure record", () => {
    const merged = mergeAgentUsages([null, null]);
    expect(merged).not.toBeNull();
    expect(merged?.sessions).toBe(2);
    expect(merged?.sessionsWithoutUsage).toBe(2);
    expect(merged?.complete).toBe(false);
    expect(merged?.inputTokens).toBeNull();
  });

  test("empty list merges to null", () => {
    expect(mergeAgentUsages([])).toBeNull();
  });

  test("mixed models are flagged", () => {
    const merged = mergeAgentUsages([base, { ...base, model: "gpt-5" }]);
    expect(merged?.mixedModels).toBe(true);
    expect(merged?.model).toBe("claude-sonnet-4-5");
  });

  test("incomplete sessions mark the merge incomplete", () => {
    const merged = mergeAgentUsages([{ ...base, complete: false }]);
    expect(merged?.complete).toBe(false);
  });
});
