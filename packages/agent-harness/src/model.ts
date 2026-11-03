/**
 * Model family / alias resolution for agent harnesses.
 *
 * Agent CLIs often accept a short model *family* or *alias* (`sonnet`,
 * `gpt`, `astra`) alongside an exact model identifier
 * (`claude-sonnet-4-6`, `gpt-5.2`). The family always points at whatever the
 * provider currently recommends, while the exact id pins a version.
 *
 * DevIntern keeps a small, per-harness catalog of families so a task
 * preference can say `Model: astra` and get the latest compatible model for
 * the selected harness, without the author tracking version names. The
 * catalog is a snapshot maintained alongside the harnesses: register new
 * families with {@link registerModelAlias} (e.g. from a future release or a
 * test) and the newest id in each family is always the one resolved.
 *
 * Unrecognized values are passed through untouched so harness-native aliases
 * that DevIntern does not model (`sonnet`, provider-specific slugs) keep
 * working. A value that is a known family for a *different* harness fails with
 * an actionable incompatibility message instead of silently using it.
 */

/** A model family alias and the concrete models it maps to for one harness. */
export interface ModelAliasDefinition {
  /** Family / alias name, matched case-insensitively (e.g. `"astra"`). */
  alias: string;
  /** Harness id the family applies to, or `"*"` for any harness. */
  harness: string;
  /**
   * Concrete, harness-specific model identifiers, newest first. The first
   * entry is the "latest available" model and is what resolution returns.
   */
  models: readonly string[];
}

/** Result of resolving a requested model string for a harness. */
export type ModelAliasResolution =
  | {
      /**
       * The requested string matched a family for this harness; `model` is
       * the concrete identifier the harness should be invoked with.
       */
      kind: "resolved";
      /** Requested family / alias name. */
      alias: string;
      /** Concrete model identifier to pass to the harness. */
      model: string;
    }
  | {
      /** The requested string is not a known family; pass it through as-is. */
      kind: "passthrough";
      /** Original model string (trimmed). */
      model: string;
    }
  | {
      /**
       * The requested string is a known family but cannot be used with this
       * harness (wrong harness, or no models available). `reason` is ready to
       * surface to the user.
       */
      kind: "error";
      /** Original model string (trimmed). */
      model: string;
      /** Actionable explanation. */
      reason: string;
    };

/**
 * Default family catalog, keyed conceptually by alias then harness.
 *
 * These are snapshots of each provider's flagship family at release time; the
 * first entry of every list is the id DevIntern resolves to. Extend or
 * override at runtime with {@link registerModelAlias}.
 */
const DEFAULT_MODEL_ALIASES: readonly ModelAliasDefinition[] = [
  // Claude Code: `astra` names the flagship reasoning family.
  { alias: "astra", harness: "claude-code", models: ["claude-opus-4-6", "claude-opus-4-5"] },
  // Codex
  { alias: "gpt", harness: "codex", models: ["gpt-5.2", "gpt-5"] },
  { alias: "astra", harness: "codex", models: ["gpt-5.2", "gpt-5"] },
  // Antigravity
  { alias: "astra", harness: "antigravity", models: ["gemini-3-pro", "gemini-3-flash"] },
  // Grok
  { alias: "astra", harness: "grok", models: ["grok-4", "grok-3"] },
  // DeepSeek (Reasonix)
  { alias: "astra", harness: "deepseek", models: ["deepseek-reasoner", "deepseek-chat"] },
  // OpenCode / Cline / pi route to provider-qualified ids.
  { alias: "astra", harness: "opencode", models: ["anthropic/claude-opus-4-6"] },
  { alias: "astra", harness: "cline", models: ["anthropic/claude-opus-4-6"] },
  { alias: "astra", harness: "pi", models: ["claude-opus-4-6"] },
];

/** alias (lower-cased) → every harness-specific definition for that family. */
const modelAliases = new Map<string, ModelAliasDefinition[]>();

/** Seed the registry from {@link DEFAULT_MODEL_ALIASES}. */
function seedDefaultModelAliases(): void {
  modelAliases.clear();
  for (const definition of DEFAULT_MODEL_ALIASES) {
    registerModelAlias(definition);
  }
}

/**
 * Register (or extend) a model family for a harness.
 *
 * Registering an alias that already exists for the same harness replaces its
 * model list, so a release can repoint a family at newer ids without touching
 * call sites. Register the same alias for another harness to make it
 * available there too.
 *
 * @param definition - Family name, harness, and ordered model ids (latest first).
 */
export function registerModelAlias(definition: ModelAliasDefinition): void {
  const key = definition.alias.trim().toLowerCase();
  if (!key) {
    return;
  }
  const existing = modelAliases.get(key) ?? [];
  const withoutHarness = existing.filter((entry) => entry.harness !== definition.harness);
  withoutHarness.push({ ...definition, alias: key });
  modelAliases.set(key, withoutHarness);
}

/**
 * List registered model families, optionally filtered to one harness.
 *
 * @param harness - When set, include only families available for this harness
 *   (harness-specific matches plus `"*"` wildcards).
 * @returns A snapshot of matching definitions.
 */
export function listModelAliases(harness?: string): ModelAliasDefinition[] {
  const all = [...modelAliases.values()].flat();
  if (harness === undefined) {
    return all;
  }
  return all.filter((entry) => entry.harness === harness || entry.harness === "*");
}

/**
 * Restore the built-in family catalog, discarding runtime registrations.
 * Intended for tests that need a clean registry.
 */
export function resetModelAliases(): void {
  seedDefaultModelAliases();
}

/**
 * Resolve a requested model string for a specific harness.
 *
 * - A known family for the harness resolves to its newest concrete id.
 * - A known family for a *different* harness (or one with no models) returns
 *   an `"error"` result with an actionable message.
 * - Anything else is passed through as an exact identifier, so
 *   harness-native aliases DevIntern does not model keep working.
 *
 * @param input.harness - Harness id the model will run under.
 * @param input.model - Raw model string from a task preference or config.
 * @returns The resolution to apply, pass through, or reject.
 */
export function resolveModelAlias(input: { harness: string; model: string }): ModelAliasResolution {
  const requested = input.model.trim();
  const definitions = modelAliases.get(requested.toLowerCase()) ?? [];
  if (definitions.length === 0) {
    return { kind: "passthrough", model: requested };
  }

  // A harness-specific definition always wins over a wildcard, regardless of
  // registration order. Entries with no models cannot resolve, so the next
  // usable definition (for example a wildcard) gets a chance first.
  const exact = definitions.find((entry) => entry.harness === input.harness);
  const wildcard = definitions.find((entry) => entry.harness === "*");
  const forHarness = [exact, wildcard].find((entry) => entry && entry.models.length > 0);
  if (forHarness) {
    return { kind: "resolved", alias: requested, model: forHarness.models[0] };
  }

  if (exact || wildcard) {
    return {
      kind: "error",
      model: requested,
      reason:
        `Model family "${requested}" has no available models for harness "${input.harness}". ` +
        `Pass an exact model identifier instead.`,
    };
  }

  const availableHarnesses = [...new Set(definitions.map((entry) => entry.harness))];
  return {
    kind: "error",
    model: requested,
    reason:
      `Model family "${requested}" is not available for harness "${input.harness}". ` +
      `Available harnesses: ${availableHarnesses.join(", ")}. ` +
      `Pass an exact model identifier supported by "${input.harness}" instead.`,
  };
}

seedDefaultModelAliases();
