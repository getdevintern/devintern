import { describe, expect, test } from "bun:test";

import {
  estimateUsageCost,
  lookupModelPricing,
  PRICING_CATALOG_VERSION,
} from "../src/usage-pricing.js";
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

  test("codex stderr summary line parses token totals", () => {
    const usage = extract("codex", "", "tokens used: 23,456\n");
    expect(usage?.totalTokens).toBe(23456);
    expect(usage?.source).toBe("stderr");
    expect(usage?.complete).toBe(false);
  });

  test("codex input/output summary lines parse separately", () => {
    const usage = extract("codex", "", "OpenAI Tokens used: 1,234 input (567 cached), 890 output");
    expect(usage?.inputTokens).toBe(1234);
    expect(usage?.cachedInputTokens).toBe(567);
    expect(usage?.outputTokens).toBe(890);
  });

  test("text summaries do not match source-looking lines", () => {
    const stdout = [
      "const inputTokens = config.input;",
      "+ total cost: $999",
      "done",
    ].join("\n");
    expect(extract("goose", stdout)).toBeNull();
  });

  test("unknown harness falls back to generic scanning", () => {
    const usage = extract(
      "future-cli",
      "",
      'Total tokens: 4321\nModel: future-model-x\ncost: $0.05',
    );
    expect(usage?.totalTokens).toBe(4321);
    expect(usage?.model).toBe("future-model-x");
    expect(usage?.reportedCost).toBeCloseTo(0.05);
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

describe("lookupModelPricing", () => {
  test("matches known model families case-insensitively", () => {
    expect(lookupModelPricing("Claude-Sonnet-4-5")?.canonicalModel).toBe("claude-sonnet-4");
    expect(lookupModelPricing("gpt-5.2-codex")?.canonicalModel).toBe("gpt-5");
    expect(lookupModelPricing("GEMINI-3-PRO")?.canonicalModel).toBe("gemini-3-pro");
  });

  test("longest prefix wins", () => {
    expect(lookupModelPricing("claude-opus-4-1")?.inputPerMTok).toBe(15);
    expect(lookupModelPricing("grok-code-fast-1")?.canonicalModel).toBe("grok-code-fast-1");
  });

  test("unknown models return null", () => {
    expect(lookupModelPricing("totally-made-up-9")).toBeNull();
    expect(lookupModelPricing("")).toBeNull();
  });
});

describe("estimateUsageCost", () => {
  test("prices known models per million tokens", () => {
    const estimate = estimateUsageCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      model: "claude-sonnet-4-5",
    });
    expect(estimate.costUsd).toBe(18); // 3 + 15
    expect(estimate.currency).toBe("USD");
    expect(estimate.pricingVersion).toBe(PRICING_CATALOG_VERSION);
  });

  test("cache-read tokens use the discounted price", () => {
    const estimate = estimateUsageCost({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 400_000,
      reasoningTokens: null,
      totalTokens: null,
      model: "claude-sonnet-4-5",
    });
    // 600k uncached * $3/M + 400k cached * $0.3/M
    expect(estimate.costUsd).toBeCloseTo(1.92, 6);
  });

  test("reasoning tokens bill at the reasoning price when separate", () => {
    const estimate = estimateUsageCost({
      inputTokens: 0,
      outputTokens: 100_000,
      cachedInputTokens: null,
      reasoningTokens: 40_000,
      totalTokens: null,
      model: "o3",
    });
    // 60k output * $8/M + 40k reasoning * $8/M = same here, but exercised
    expect(estimate.costUsd).toBeCloseTo(0.8, 6);
  });

  test("total-only usage splits with a documented ratio", () => {
    const estimate = estimateUsageCost({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: 1000,
      model: "gpt-5",
    });
    expect(estimate.costUsd).not.toBeNull();
    expect(estimate.pricingVersion).toBe(PRICING_CATALOG_VERSION);
  });

  test("unknown models never fabricate a cost", () => {
    const estimate = estimateUsageCost({
      inputTokens: 1000,
      outputTokens: 1000,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      model: "mystery-model-v2",
    });
    expect(estimate.costUsd).toBeNull();
    expect(estimate.pricingVersion).toBeNull();
  });

  test("missing model never fabricates a cost", () => {
    const estimate = estimateUsageCost({
      inputTokens: 1000,
      outputTokens: 1000,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      model: null,
    });
    expect(estimate.costUsd).toBeNull();
  });

  test("no usable token counts yield no cost even for known models", () => {
    const estimate = estimateUsageCost({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      model: "claude-sonnet-4-5",
    });
    expect(estimate.costUsd).toBeNull();
  });
});
