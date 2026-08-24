/**
 * Normalized token/cost usage contract.
 *
 * Every harness can report consumption through structured output (a JSON
 * result document or JSONL event stream — e.g. `codex exec --json`,
 * `opencode run --format json`, `grok -p --output-format json`).
 * {@link extractAgentUsage} normalizes whatever structured data a finished
 * session's captured output contains into one {@link AgentUsage} value:
 *
 * - Unavailable values stay `null` — never zero — so callers can distinguish
 *   "the provider did not report this" from "this really was 0".
 * - Only structured output is trusted. Human-readable summary lines are
 *   deliberately ignored: heuristics over free text misread echoed task
 *   content, test output, and agent prose, so unstructured output means
 *   unknown usage, not flaky guesses.
 *
 * Extractors are defensive by design: harness CLIs change their output
 * between versions, so any parse failure degrades to fewer populated fields
 * (or `null` overall) instead of throwing into the run pipeline.
 */

import { stripAnsi } from "./output-lines.js";

/** Where a usage reading was extracted from. */
export type UsageSource =
  | "structured_output" // embedded/piped JSON result object or JSONL events
  | "session_artifacts" // on-disk session transcripts written by the CLI
  | "mixed"; // merged from sessions with differing sources

/** Normalized usage for one agent session. All numeric fields may be null. */
export interface AgentUsage {
  /** Prompt (+ cache-write) input tokens as reported by the provider. */
  inputTokens: number | null;
  /** Completion/output tokens (includes reasoning tokens when not separate). */
  outputTokens: number | null;
  /** Cache-read / cached-input tokens, when reported separately. */
  cachedInputTokens: number | null;
  /** Reasoning/thinking tokens, when reported separately. */
  reasoningTokens: number | null;
  /**
   * Total tokens across categories. Populated only when the provider reports
   * a total directly; never inferred from incomplete parts.
   */
  totalTokens: number | null;
  /**
   * Model the session ran on, as reported by the CLI (may be an alias).
   * Null when the harness does not surface it in headless output.
   */
  model: string | null;
  /** Provider-computed cost (USD unless {@link costCurrency} says otherwise). */
  reportedCost: number | null;
  costCurrency: string | null;
  /** Primary source of this extraction. */
  source: UsageSource;
  /**
   * True when both input and output tokens were found and the model (or a
   * provider cost) is known. Partial reads are still returned, just with
   * `complete: false`.
   */
  complete: boolean;
}

/** Inputs available to a usage extractor after a session exits. */
export interface UsageExtractionInput {
  harness: string;
  stdout: string;
  stderr: string;
}

function emptyUsage(source: UsageSource): AgentUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    model: null,
    reportedCost: null,
    costCurrency: null,
    source,
    complete: false,
  };
}

/**
 * A usage value counts as complete when token totals exist for both prompt
 * and completion sides and we know what model (or cost) produced them.
 */
function isComplete(usage: AgentUsage): boolean {
  const hasTokenPair = usage.inputTokens !== null && usage.outputTokens !== null;
  if (!hasTokenPair && usage.totalTokens === null) {
    return false;
  }
  return usage.model !== null || usage.reportedCost !== null;
}

function finalize(usage: AgentUsage): AgentUsage {
  return { ...usage, complete: isComplete(usage) };
}

// ---------------------------------------------------------------------------
// JSON scanning (structured output embedded in stdout/stderr)
// ---------------------------------------------------------------------------

interface RawUsageFields {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  model?: string;
  cost?: number;
  currency?: string;
}

const JSON_USAGE_FIELD_ALIASES: Record<keyof RawUsageFields, readonly string[]> = {
  inputTokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokenCount", "tokens.input"],
  outputTokens: [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "candidatesTokenCount",
    "tokens.output",
  ],
  cachedInputTokens: [
    "cache_read_input_tokens",
    "cached_input_tokens",
    "cachedContentTokenCount",
    "cache_read_tokens",
    "prompt_tokens_details.cached_tokens",
    "tokens.cache.read",
  ],
  reasoningTokens: [
    "reasoning_tokens",
    "completion_tokens_details.reasoning_tokens",
    "tokens.reasoning",
  ],
  totalTokens: ["total_tokens", "totalTokens", "total_token_count", "tokens.total"],
  model: ["model", "modelId", "model_id"],
  cost: ["total_cost_usd", "cost_usd", "costUSD", "total_cost", "cost"],
  currency: ["currency", "cost_currency"],
};

/** Read a dotted alias ("a.b") out of a nested object. */
function readDotted(object: Record<string, unknown>, path: string): unknown {
  let current: unknown = object;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function firstNumber(object: Record<string, unknown>, aliases: readonly string[]): number | null {
  for (const alias of aliases) {
    const value = readDotted(object, alias);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function firstString(object: Record<string, unknown>, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const value = readDotted(object, alias);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/** Map loose JSON keys onto the normalized shape; undefined fields stay absent. */
export function normalizeJsonUsage(object: Record<string, unknown>): RawUsageFields | null {
  const raw: RawUsageFields = {};
  const input = firstNumber(object, JSON_USAGE_FIELD_ALIASES.inputTokens);
  const output = firstNumber(object, JSON_USAGE_FIELD_ALIASES.outputTokens);
  const total = firstNumber(object, JSON_USAGE_FIELD_ALIASES.totalTokens);
  const cost = firstNumber(object, JSON_USAGE_FIELD_ALIASES.cost);
  const model = firstString(object, JSON_USAGE_FIELD_ALIASES.model);
  // A bare `model` key (configs, fixtures, API payloads) is not usage; at
  // least one consumption number must be present.
  if (input === null && output === null && total === null && cost === null) {
    return null;
  }
  if (input !== null) {
    raw.inputTokens = input;
  }
  if (output !== null) {
    raw.outputTokens = output;
  }
  const cached = firstNumber(object, JSON_USAGE_FIELD_ALIASES.cachedInputTokens);
  if (cached !== null) {
    raw.cachedInputTokens = cached;
  }
  const reasoning = firstNumber(object, JSON_USAGE_FIELD_ALIASES.reasoningTokens);
  if (reasoning !== null) {
    raw.reasoningTokens = reasoning;
  }
  if (total !== null) {
    raw.totalTokens = total;
  }
  if (model !== null) {
    raw.model = model;
  }
  if (cost !== null) {
    raw.cost = cost;
  }
  const currency = firstString(object, JSON_USAGE_FIELD_ALIASES.currency);
  if (currency !== null) {
    raw.currency = currency;
  }
  return raw;
}

const NUMERIC_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "totalTokens",
  "cost",
] as const;

/**
 * Sum sibling contributions: per-model breakdowns describe disjoint token
 * buckets, so their counts and costs add up.
 */
function sumContributions(list: RawUsageFields[]): RawUsageFields | null {
  if (list.length === 0) {
    return null;
  }
  if (list.length === 1) {
    return list[0]!;
  }
  const out: RawUsageFields = {};
  for (const key of NUMERIC_USAGE_KEYS) {
    let sum: number | undefined;
    for (const item of list) {
      const value = item[key];
      if (typeof value === "number") {
        sum = (sum ?? 0) + value;
      }
    }
    if (sum !== undefined) {
      out[key] = sum;
    }
  }
  for (const key of ["model", "currency"] as const) {
    out[key] = list.find((item) => item[key] !== undefined)?.[key];
  }
  return out;
}

/**
 * Keys whose direct-child object is an *aggregate* usage view. When present,
 * it wins over sibling breakdowns (per-model maps describe the same tokens).
 */
const AGGREGATE_USAGE_KEYS = new Set(["usage"]);

/** Reduce one parsed JSON document to a single usage contribution.
 *
 * - Per-model maps (`modelUsage`) are disjoint siblings → summed.
 * - An aggregate `usage` sibling wins over breakdowns describing the same
 *   tokens (no double counting).
 * - Parent-only fields (a top-level provider cost) survive.
 * - Transcript arrays hold cumulative rows → last row wins.
 */
function collectFromParsed(root: unknown): RawUsageFields | null {
  if (root === null || typeof root !== "object") {
    return null;
  }
  if (Array.isArray(root)) {
    let last: RawUsageFields | null = null;
    for (const item of root) {
      const contribution = collectFromParsed(item);
      if (contribution) {
        last = contribution;
      }
    }
    return last;
  }

  const record = root as Record<string, unknown>;
  let aggregate: RawUsageFields | null = null;
  const breakdowns: RawUsageFields[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || typeof value !== "object") {
      continue;
    }
    const contribution = collectFromParsed(value);
    if (!contribution) {
      continue;
    }
    if (AGGREGATE_USAGE_KEYS.has(key)) {
      aggregate ??= contribution;
    } else {
      breakdowns.push(contribution);
    }
  }

  const self = normalizeJsonUsage(record);
  const children = aggregate ?? sumContributions(breakdowns);
  if (self === null) {
    return children;
  }
  if (children === null) {
    return self;
  }
  // Both levels carry usage fields: token counts come from the deeper,
  // more granular view; parent-exclusive totals (provider-reported cost)
  // win over values derived from the breakdown.
  const merged: RawUsageFields = { ...children };
  for (const key of NUMERIC_USAGE_KEYS) {
    if (merged[key] === undefined && self[key] !== undefined) {
      merged[key] = self[key];
    }
  }
  if (self.cost !== undefined) {
    merged.cost = self.cost;
  }
  if (self.currency !== undefined) {
    merged.currency = self.currency;
  }
  if (!merged.model && self.model !== undefined) {
    merged.model = self.model;
  }
  return merged;
}

const USAGE_MARKER_SENTINEL =
  /"(?:input_tokens|inputTokens|prompt_tokens|output_tokens|outputTokens|completion_tokens|total_tokens|totalTokens|total_cost_usd|costUSD|modelUsage|usage|tokens)"/;

/**
 * Summary lines appear at the end of a run; scanning the whole transcript
 * would risk matching source code, test output, or docs the agent printed.
 */
const TAIL_SCAN_LINES = 60;

/**
 * Find usage-bearing JSON objects in a captured stream.
 *
 * Handles streams that are entirely one JSON document (structured result
 * mode) plus single-line JSON / JSONL rows near the end of plain output.
 * Everything else is ignored, which keeps echoed fixtures, app logs, and
 * test output from being mistaken for provider reporting.
 */
export function findJsonUsageObjects(text: string): RawUsageFields[] {
  if (!text || !text.includes("{")) {
    return [];
  }
  const found: RawUsageFields[] = [];
  const trimmed = stripAnsi(text).trim();

  const whole = collectFromParsed(safeParse(trimmed));
  if (whole) {
    return [whole];
  }

  for (const line of trimmed.split(/\r?\n/).slice(-TAIL_SCAN_LINES)) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !USAGE_MARKER_SENTINEL.test(candidate)) {
      continue;
    }
    const contribution = collectFromParsed(safeParse(candidate));
    if (contribution) {
      found.push(contribution);
    }
  }
  return found;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mergeRawIntoUsage(usage: AgentUsage, raw: RawUsageFields): void {
  if (raw.inputTokens !== undefined) {
    usage.inputTokens = raw.inputTokens;
  }
  if (raw.outputTokens !== undefined) {
    usage.outputTokens = raw.outputTokens;
  }
  if (raw.cachedInputTokens !== undefined) {
    usage.cachedInputTokens = raw.cachedInputTokens;
  }
  if (raw.reasoningTokens !== undefined) {
    usage.reasoningTokens = raw.reasoningTokens;
  }
  if (raw.totalTokens !== undefined) {
    usage.totalTokens = raw.totalTokens;
  }
  if (raw.model !== undefined) {
    usage.model = raw.model;
  }
  if (raw.cost !== undefined) {
    usage.reportedCost = raw.cost;
    usage.costCurrency = raw.currency ?? "USD";
  }
}

// ---------------------------------------------------------------------------
// Per-harness extractors
// ---------------------------------------------------------------------------

/**
 * Extract usage from a finished session's captured output.
 *
 * Only structured output counts: whole-document JSON results and usage-bearing
 * JSONL rows near the end of the stream. Human-readable summary lines are
 * deliberately ignored — heuristics over free text misread echoed task
 * content, test output, and agent prose, so anything not structured stays
 * unknown instead of flaky.
 */
function extractStructuredUsage(input: UsageExtractionInput): AgentUsage | null {
  const jsonCandidates = [
    ...findJsonUsageObjects(input.stdout),
    ...findJsonUsageObjects(input.stderr),
  ];
  if (jsonCandidates.length === 0) {
    return null;
  }
  const usage = emptyUsage("structured_output");
  for (const raw of jsonCandidates) {
    mergeRawIntoUsage(usage, raw);
  }
  return finalize(usage);
}

/**
 * Normalize a finished agent session's output into usage data.
 *
 * Returns `null` when no structured usage was found — that is an explicit
 * "usage unknown" rather than zeros or a guess.
 *
 * @param input - Harness id plus the session's captured stdout/stderr.
 */
export function extractAgentUsage(input: UsageExtractionInput): AgentUsage | null {
  try {
    return extractStructuredUsage(input);
  } catch {
    // Extraction must never break the run pipeline.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multi-session merging (implementation + feasibility + review sessions)
// ---------------------------------------------------------------------------

export interface MergedAgentUsage extends AgentUsage {
  /** Number of contributing sessions. */
  sessions: number;
  /** Sessions that yielded no usage signal at all (unknown exposure). */
  sessionsWithoutUsage: number;
  /** True when at least one contributing session had a different model. */
  mixedModels: boolean;
}

/**
 * Merge usage from every session attributable to one run without double
 * counting: token categories sum across sessions, `null` survives when no
 * session reported a category, costs are summed only over sessions that
 * reported them.
 */
export function mergeAgentUsages(usages: (AgentUsage | null)[]): MergedAgentUsage | null {
  const present = usages.filter((usage): usage is AgentUsage => usage !== null);
  const merged: MergedAgentUsage = {
    ...emptyUsage(present.length === 0 ? "structured_output" : present[0]!.source),
    sessions: usages.length,
    sessionsWithoutUsage: usages.length - present.length,
    mixedModels: false,
  };

  if (present.length === 0) {
    return merged.sessions > 0 ? merged : null;
  }

  const referenceSource = present[0]!.source;
  merged.source = present.every((usage) => usage.source === referenceSource)
    ? referenceSource
    : "mixed";

  const models = new Set<string>();
  for (const usage of present) {
    merged.inputTokens = sumNullable(merged.inputTokens, usage.inputTokens);
    merged.outputTokens = sumNullable(merged.outputTokens, usage.outputTokens);
    merged.cachedInputTokens = sumNullable(merged.cachedInputTokens, usage.cachedInputTokens);
    merged.reasoningTokens = sumNullable(merged.reasoningTokens, usage.reasoningTokens);
    merged.totalTokens = sumNullable(merged.totalTokens, usage.totalTokens);
    merged.reportedCost = sumNullable(merged.reportedCost, usage.reportedCost);
    if (usage.costCurrency) {
      merged.costCurrency = merged.costCurrency ?? usage.costCurrency;
    }
    if (usage.model) {
      models.add(usage.model);
      merged.model = merged.model ?? usage.model;
    }
  }
  merged.mixedModels = models.size > 1;

  const allComplete = present.every((usage) => usage.complete);
  merged.complete = allComplete && merged.sessionsWithoutUsage === 0;
  return merged;
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return a + b;
}
