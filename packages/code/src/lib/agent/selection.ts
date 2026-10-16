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
 * env > harness default. `model`/`effort` are harness-specific, so they apply
 * only when the entry also names a `harness`; a model- or effort-only entry
 * leaves the inherited env value untouched rather than sending a string chosen
 * for one harness to whichever harness a failover chain later selects. When the
 * entry pins a harness other than the env's primary, an inherited
 * `AGENT_MODEL`/`AGENT_EFFORT` was chosen for that primary and is dropped too,
 * unless the entry sets its own. Disallowed effort on a harness that does not
 * support it is ignored at run time by the harness runners, which warn instead
 * of failing.
 */

import {
  getHarness,
  isHarnessInstalled,
  listHarnesses,
  parseAgentEffort,
  DEFAULT_HARNESS_NAME,
} from "@devintern/agent-harness";
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
 * Canonical name of the first (priority) harness named by an `AGENT_HARNESS`
 * value, or the default harness when the value is unset/empty.
 *
 * Mirrors the chain's own notion of "primary" (see `resolveHarnessChain`) so a
 * caller can tell whether a pinned harness is the one a global path override
 * was written for.
 */
export function primaryHarnessName(chain: string | undefined): string {
  const first = chain?.split(",")[0]?.trim();
  if (!first) return DEFAULT_HARNESS_NAME;
  return getHarness(first)?.name ?? first;
}

/** A scheduled entry whose pinned harness can be checked for installability. */
export interface HarnessPinnedEntry {
  /** Entry id, used in the warning. */
  id: string;
  /** Canonical harness name pinned by the entry, when set. */
  harness?: string;
}

/**
 * Warn about scheduled entries pinned to a harness whose CLI is not installed.
 *
 * A pinned `harness` opts the entry out of the workspace `AGENT_HARNESS`
 * failover chain (see `spawnAutomationProcess`), so a pin to a
 * registered-but-uninstalled harness — or one whose `<HARNESS>_CLI_PATH` points
 * at a missing executable — makes every occurrence fail with no failover.
 * `parseAgentSelection` validates only against the registry, so without this
 * check the misconfiguration stays silent until the first run; call this at
 * worker startup and on config reload to surface it early, mirroring the
 * installability warnings `resolveHarnessChain` already emits for the chain.
 *
 * The probe mirrors the pinned child's own resolution: `AGENT_CLI_PATH` is
 * honoured only when the pin is the env's primary harness (the path the child
 * keeps); a pin to any other harness resolves its own `<HARNESS>_CLI_PATH` or
 * default.
 *
 * @param entries - Automations and estimations with their parsed selection.
 * @param log - Warning sink (defaults to `console.warn`).
 */
export function warnUninstalledHarnessPins(
  entries: readonly HarnessPinnedEntry[],
  log: (message: string) => void = (message) => console.warn(message),
): void {
  const envPrimary = primaryHarnessName(process.env.AGENT_HARNESS);
  const installed = new Map<string, boolean>();
  for (const entry of entries) {
    if (!entry.harness) continue;
    const harness = getHarness(entry.harness);
    if (!harness) continue; // parseAgentSelection already rejects unknown names
    let ok = installed.get(harness.name);
    if (ok === undefined) {
      ok = isHarnessInstalled(harness, { includeGlobalCliPath: harness.name === envPrimary });
      installed.set(harness.name, ok);
    }
    if (ok) continue;
    const envKey = harness.name.toUpperCase().replace(/-/g, "_");
    log(
      `⚠️  Schedule "${entry.id}" is pinned to harness "${harness.name}", which is not installed. ` +
        `It opts out of failover, so it will fail until the CLI is installed or ${envKey}_CLI_PATH is set.`,
    );
  }
}

/**
 * Drop inherited CLI-path overrides that point at another harness's binary.
 *
 * `AGENT_CLI_PATH` names the env's primary harness binary. `CLAUDE_CLI_PATH` is
 * the resolver's backward-compatibility fallback for *any* harness
 * (`resolveEnvHarnessPath`: `env.CLAUDE_CLI_PATH // backward compatibility`), so
 * leaving it set would redirect a non-claude pin to the claude executable. Both
 * are dropped when they do not belong to `harnessName`; `CLAUDE_CLI_PATH` is
 * kept only when pinning claude-code, where it is the harness-specific path.
 *
 * @param env - Composed environment to mutate.
 * @param harnessName - Canonical harness the run is being pinned to.
 * @param envPrimaryHarness - Canonical name of the env's primary harness.
 */
export function dropForeignHarnessCliPaths(
  env: Record<string, string | undefined>,
  harnessName: string,
  envPrimaryHarness: string,
): void {
  if (envPrimaryHarness !== harnessName) {
    delete env.AGENT_CLI_PATH;
  }
  if (harnessName !== DEFAULT_HARNESS_NAME) {
    delete env.CLAUDE_CLI_PATH;
  }
}

/**
 * Overlay an entry's agent selection onto a composed environment.
 *
 * Only fields the entry set are written, so omitted fields keep the value
 * from the environment layers (team/repo/workspace) or the harness default.
 *
 * `model` and `effort` are harness-specific, so they are written only when the
 * entry also pins a `harness`. Without a `harness` the entry keeps the
 * workspace failover chain, and a model chosen for one harness must not be
 * handed to whichever fallback harness the chain selects.
 *
 * When the entry pins a harness other than the env's primary, the global
 * `AGENT_CLI_PATH` and the resolver's `CLAUDE_CLI_PATH` fallback (which name
 * the primary/claude binary) are dropped so the child resolves the pinned
 * harness's own `<HARNESS>_CLI_PATH` or default instead of spawning another
 * harness's executable. For the same reason an inherited `AGENT_MODEL` /
 * `AGENT_EFFORT` (chosen for the primary) is dropped unless the entry sets its
 * own value.
 *
 * Mutates and returns `env` for chaining.
 */
export function applyAgentSelectionEnv(
  env: Record<string, string | undefined>,
  selection: AgentSelection | undefined,
): Record<string, string | undefined> {
  if (!selection) return env;
  if (selection.harness) {
    const envPrimary = primaryHarnessName(env.AGENT_HARNESS);
    const changedHarness = envPrimary !== selection.harness;
    dropForeignHarnessCliPaths(env, selection.harness, envPrimary);
    env.AGENT_HARNESS = selection.harness;
    if (selection.model) {
      env.AGENT_MODEL = selection.model;
    } else if (changedHarness) {
      delete env.AGENT_MODEL;
    }
    if (selection.effort) {
      env.AGENT_EFFORT = selection.effort;
    } else if (changedHarness) {
      delete env.AGENT_EFFORT;
    }
  }
  return env;
}
