/**
 * Versioned model-pricing catalog and cost estimation.
 *
 * When a harness reports provider-computed cost, that value always wins.
 * Otherwise {@link estimateUsageCost} prices normalized token counts against
 * this catalog. Every estimate records the catalog version used so historical
 * rows stay explainable after prices change — costs are never recalculated
 * during reads.
 *
 * Prices are USD per million tokens, list price, and deliberately coarse:
 * they power budget caps and dashboards, not invoicing. Unknown models return
 * `null` (no fabricated cost) rather than a guess from a similar-sounding
 * family.
 */

/** Bump when catalog entries change; persisted with every estimate. */
export const PRICING_CATALOG_VERSION = "2026-08-01";

/** Currency all catalog prices (and therefore estimates) are expressed in. */
export const PRICING_CURRENCY = "USD";

export interface ModelPricing {
  /** USD per million prompt/input tokens. */
  inputPerMTok: number;
  /** USD per million completion/output tokens. */
  outputPerMTok: number;
  /** USD per million cache-read tokens (defaults to the input price). */
  cachedInputPerMTok?: number;
  /**
   * USD per million reasoning tokens billed separately from output
   * (defaults to the output price).
   */
  reasoningPerMTok?: number;
}

interface CatalogEntry extends ModelPricing {
  /** Canonical model name recorded with estimates matched by this entry. */
  canonicalModel: string;
}

/**
 * Longest-prefix match table. Keys are lowercase model-id prefixes as they
 * appear in CLI output (`claude-sonnet-4-5`, `gpt-5.2-codex`,
 * `gemini-3-pro`, …). More specific prefixes must simply be longer keys —
 * matching sorts by key length descending.
 */
const CATALOG: Record<string, CatalogEntry> = {
  // Anthropic
  "claude-opus-4": {
    canonicalModel: "claude-opus-4",
    inputPerMTok: 15,
    outputPerMTok: 75,
    cachedInputPerMTok: 1.5,
  },
  "claude-sonnet-4": {
    canonicalModel: "claude-sonnet-4",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.3,
  },
  "claude-haiku-4": {
    canonicalModel: "claude-haiku-4",
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cachedInputPerMTok: 0.08,
  },
  "claude-3-7-sonnet": {
    canonicalModel: "claude-3-7-sonnet",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.3,
  },
  "claude-3-5-sonnet": {
    canonicalModel: "claude-3-5-sonnet",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.3,
  },
  "claude-3-5-haiku": {
    canonicalModel: "claude-3-5-haiku",
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cachedInputPerMTok: 0.08,
  },
  "claude-3-opus": {
    canonicalModel: "claude-3-opus",
    inputPerMTok: 15,
    outputPerMTok: 75,
    cachedInputPerMTok: 1.5,
  },
  // OpenAI
  "gpt-5": {
    canonicalModel: "gpt-5",
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cachedInputPerMTok: 0.125,
  },
  "gpt-4.1": {
    canonicalModel: "gpt-4.1",
    inputPerMTok: 2,
    outputPerMTok: 8,
    cachedInputPerMTok: 0.5,
  },
  "o4-mini": {
    canonicalModel: "o4-mini",
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cachedInputPerMTok: 0.275,
  },
  "o3-mini": {
    canonicalModel: "o3-mini",
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cachedInputPerMTok: 0.55,
  },
  o3: { canonicalModel: "o3", inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 },
  "gpt-4o": {
    canonicalModel: "gpt-4o",
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cachedInputPerMTok: 1.25,
  },
  // Google
  "gemini-2.5-pro": {
    canonicalModel: "gemini-2.5-pro",
    inputPerMTok: 1.25,
    outputPerMTok: 10,
  },
  "gemini-2.5-flash": {
    canonicalModel: "gemini-2.5-flash",
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
  },
  "gemini-3-pro": {
    canonicalModel: "gemini-3-pro",
    inputPerMTok: 2,
    outputPerMTok: 12,
  },
  "gemini-3-flash": {
    canonicalModel: "gemini-3-flash",
    inputPerMTok: 0.35,
    outputPerMTok: 2.75,
  },
  // xAI
  "grok-4": {
    canonicalModel: "grok-4",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.75,
  },
  "grok-3": {
    canonicalModel: "grok-3",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.75,
  },
  "grok-code-fast": {
    canonicalModel: "grok-code-fast-1",
    inputPerMTok: 0.2,
    outputPerMTok: 1.5,
    cachedInputPerMTok: 0.02,
  },
  // DeepSeek
  "deepseek-chat": { canonicalModel: "deepseek-chat", inputPerMTok: 0.27, outputPerMTok: 1.1 },
  "deepseek-reasoner": {
    canonicalModel: "deepseek-reasoner",
    inputPerMTok: 0.55,
    outputPerMTok: 2.19,
  },
  // Moonshot
  "kimi-k2": {
    canonicalModel: "kimi-k2",
    inputPerMTok: 0.6,
    outputPerMTok: 2.5,
    cachedInputPerMTok: 0.15,
  },
  // Alibaba
  "qwen3-coder": {
    canonicalModel: "qwen3-coder-plus",
    inputPerMTok: 0.45,
    outputPerMTok: 1.8,
  },
  "qwen-coder": {
    canonicalModel: "qwen3-coder-plus",
    inputPerMTok: 0.45,
    outputPerMTok: 1.8,
  },
};

/** Longest-prefix match of a raw model id against the catalog. */
export function lookupModelPricing(
  rawModel: string,
): (ModelPricing & { canonicalModel: string }) | null {
  const normalized = rawModel.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  let best: { prefix: string; entry: CatalogEntry } | null = null;
  for (const [prefix, entry] of Object.entries(CATALOG)) {
    if (normalized.startsWith(prefix) && (best === null || prefix.length > best.prefix.length)) {
      best = { prefix, entry };
    }
  }
  if (!best) {
    return null;
  }
  return { ...best.entry, canonicalModel: best.entry.canonicalModel };
}

/** Result of pricing one usage reading; `costUsd` stays null when unknown. */
export interface UsageCostEstimate {
  costUsd: number | null;
  currency: string;
  pricingVersion: string | null;
}

function roundUsd(cost: number): number {
  // Micro-dollar precision keeps many small sessions summable without noise.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Estimate cost for usage without a provider-reported price.
 *
 * Returns `{costUsd: null}` (never zero, never a guessed model's price) when
 * the model is unknown to the catalog or no token counts are usable.
 *
 * @param params - Normalized token counts plus the reported model id.
 */
export function estimateUsageCost(params: {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  model: string | null;
}): UsageCostEstimate {
  if (!params.model) {
    return { costUsd: null, currency: PRICING_CURRENCY, pricingVersion: null };
  }
  const pricing = lookupModelPricing(params.model);
  if (!pricing) {
    return { costUsd: null, currency: PRICING_CURRENCY, pricingVersion: null };
  }

  let input = params.inputTokens;
  let output = params.outputTokens;

  // Some providers report only an overall total; split it using a coarse
  // ratio rather than pretending both sides are known exactly.
  if (
    (input === null || output === null) &&
    params.totalTokens !== null &&
    params.totalTokens !== undefined
  ) {
    input ??= Math.floor(params.totalTokens * 0.8);
    output ??= Math.max(0, params.totalTokens - input);
  }
  if (input === null && output === null) {
    return { costUsd: null, currency: PRICING_CURRENCY, pricingVersion: null };
  }

  const cached = params.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, (input ?? 0) - cached);
  const cachedPrice = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const reasoning = params.reasoningTokens ?? 0;
  const reasoningPrice = pricing.reasoningPerMTok ?? pricing.outputPerMTok;

  const cost =
    (uncachedInput / 1_000_000) * pricing.inputPerMTok +
    (cached / 1_000_000) * cachedPrice +
    (Math.max(0, (output ?? 0) - reasoning) / 1_000_000) * pricing.outputPerMTok +
    (reasoning / 1_000_000) * reasoningPrice;

  return {
    costUsd: roundUsd(cost),
    currency: PRICING_CURRENCY,
    pricingVersion: PRICING_CATALOG_VERSION,
  };
}
