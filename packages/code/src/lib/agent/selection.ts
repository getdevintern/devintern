/**
 * Per-entry agent selection for workspace `[[automations]]` / `[[estimations]]`.
 *
 * A scheduled entry may name the agent (`harness`) and `model` / reasoning
 * `effort` for its own runs, overriding the workspace-wide `AGENT_HARNESS` /
 * `AGENT_MODEL` / `AGENT_EFFORT` resolved from the environment layers. The
 * selection is validated here so a bad value fails `workspace.toml` parsing
 * with an actionable message instead of silently falling back.
 *
 * Precedence for an entry's runs: entry field > team/repo env > workspace
 * env > harness default. `model` is harness-specific and is never validated
 * cross-harness; omitting it leaves the model to the harness default (or the
 * inherited env value when one is set). Disallowed effort on a harness that
 * does not support it is ignored at run time by the harness runners, which
 * warn instead of failing.
 */

import { getHarness, listHarnesses, parseAgentEffort } from "@devintern/agent-harness";
import type { AgentEffort } from "@devintern/agent-harness";

/** Optional per-entry agent overrides parsed from an automation/estimation. */
export interface AgentSelection {
  /** Canonical harness name for this entry's runs (validated on parse). */
  harness?: string;
  /** Harness-specific model string; undefined keeps the harness default. */
  model?: string;
  /** Reasoning effort for harnesses that support it. */
  effort?: AgentEffort;
}

/** Copy only the selection fields actually set on a source object. */
export function pickAgentSelection(source: AgentSelection): AgentSelection {
  return {
    ...(source.harness ? { harness: source.harness } : {}),
    ...(source.model ? { model: source.model } : {}),
    ...(source.effort ? { effort: source.effort } : {}),
  };
}

/**
 * Validate the optional `harness`, `model`, and `effort` fields of one
 * automation/estimation table.
 *
 * Collects every problem in `errors` (the caller's shared list) and returns
 * the selection with the fields that validated. `harness` must name a single
 * registered harness (aliases resolve to their canonical name) so the entry's
 * run uses exactly the agent it names; `effort` reuses the shared
 * `parseAgentEffort` validator.
 *
 * @param table - Raw entry table.
 * @param options - `label` used in messages and the owning `id`, when known.
 * @param errors - Shared error accumulator.
 */
export function parseAgentSelection(
  table: Record<string, unknown>,
  options: { label: string; id?: string },
  errors: string[],
): AgentSelection {
  const { label } = options;
  const entrySuffix = options.id ? ` (entry "${options.id}")` : "";
  const selection: AgentSelection = {};

  const readNonEmptyString = (key: string): string | undefined => {
    const value = table[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${label}.${key} must be a non-empty string${entrySuffix}.`);
      return undefined;
    }
    return value.trim();
  };

  const harness = readNonEmptyString("harness");
  if (harness !== undefined) {
    const names = harness
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const canonical = names.map((name) => getHarness(name)).filter((h) => h !== undefined);
    if (names.length !== 1) {
      errors.push(
        `${label}.harness must name a single agent harness, got "${harness}"${entrySuffix}.`,
      );
    } else if (canonical.length !== 1) {
      const available = listHarnesses()
        .map((h) => `"${h.name}"`)
        .join(", ");
      errors.push(
        `${label}.harness "${harness}" is not a known agent harness${entrySuffix}. ` +
          `Available harnesses: ${available}.`,
      );
    } else {
      selection.harness = canonical[0]!.name;
    }
  }

  const model = readNonEmptyString("model");
  if (model !== undefined) {
    selection.model = model;
  }

  const effort = readNonEmptyString("effort");
  if (effort !== undefined) {
    try {
      selection.effort = parseAgentEffort(effort);
    } catch {
      errors.push(`${label}.effort "${effort}" must be one of low, medium, or high${entrySuffix}.`);
    }
  }

  return selection;
}

/**
 * Overlay an entry's agent selection onto a composed environment.
 *
 * Only fields the entry set are written, so omitted fields keep the value
 * from the environment layers (team/repo/workspace) or the harness default.
 * Mutates and returns `env` for chaining.
 */
export function applyAgentSelectionEnv(
  env: Record<string, string | undefined>,
  selection: AgentSelection | undefined,
): Record<string, string | undefined> {
  if (!selection) return env;
  if (selection.harness) env.AGENT_HARNESS = selection.harness;
  if (selection.model) env.AGENT_MODEL = selection.model;
  if (selection.effort) env.AGENT_EFFORT = selection.effort;
  return env;
}
