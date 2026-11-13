/**
 * Per-job agent selection for workspace `[[automations]]`, `[[estimations]]`,
 * and automatic conflict resolution (`[workspace].conflict_resolution_*`).
 *
 * A job may name the agent (`harness`) and `model` / reasoning `effort` for its
 * own runs, overriding the workspace-wide `AGENT_HARNESS` / `AGENT_MODEL` /
 * `AGENT_EFFORT` resolved from the environment layers. The selection is
 * validated here so a bad value fails `workspace.toml` parsing with an
 * actionable message instead of silently falling back.
 *
 * Precedence for the job's runs: selection field > team/repo env > workspace
 * env > harness default.
 *
 * - With `harness`: the run is pinned to that one agent and opts out of the
 *   workspace failover chain. When the pin differs from the env's primary, an
 *   inherited `AGENT_MODEL`/`AGENT_EFFORT` (chosen for that primary) is dropped
 *   unless the selection sets its own.
 * - Without `harness`: the workspace chain (and failover) is kept. `model` is
 *   written to the primary harness's own `<HARNESS>_MODEL`, so it applies to
 *   the primary only and a fallback harness never receives a model id from a
 *   different provider. `effort` is harness-neutral and written to
 *   `AGENT_EFFORT`; a harness without effort support ignores it with a warning.
 */

import {
  getHarness,
  HARNESS_ALIASES,
  isHarnessInstalled,
  listHarnesses,
  parseAgentEffort,
  DEFAULT_HARNESS_NAME,
} from "@devintern/agent-harness";
import type { AgentEffort } from "@devintern/agent-harness";

import { harnessModelEnvKey } from "./model";
import { USAGE_LIMIT_FILE_ENV, WORKER_CHILD_ENV } from "../worker/usage-limit-protocol";

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
 * @param options - `label` used in messages, the owning `id` when known, and
 *   an optional `keyPrefix` (e.g. `conflict_resolution_`) prepended to the
 *   `harness` / `model` / `effort` key names.
 * @param errors - Shared error accumulator.
 */
export function parseAgentSelection(
  table: Record<string, unknown>,
  options: { label: string; id?: string; keyPrefix?: string },
  errors: string[],
): AgentSelection {
  const { label } = options;
  const prefix = options.keyPrefix ?? "";
  const entrySuffix = options.id ? ` (entry "${options.id}")` : "";
  const selection: AgentSelection = {};

  const readNonEmptyString = (field: string): string | undefined => {
    const key = `${prefix}${field}`;
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
        `${label}.${prefix}harness must name a single agent harness, got "${harness}"${entrySuffix}.`,
      );
    } else if (canonical.length !== 1) {
      const available = listHarnesses()
        .map((h) => `"${h.name}"`)
        .join(", ");
      errors.push(
        `${label}.${prefix}harness "${harness}" is not a known agent harness${entrySuffix}. ` +
          `Available harnesses: ${available}.`,
      );
    } else {
      selection.harness = canonical[0]!.name;
      // The child only ever sees the canonical name, so the resolver's
      // deprecated-alias warning would never fire; surface it here instead.
      const alias = HARNESS_ALIASES[names[0]!];
      if (alias?.deprecated && alias.warning) {
        console.warn(`⚠️  ${label}.${prefix}harness${entrySuffix}: ${alias.warning}`);
      }
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
      errors.push(
        `${label}.${prefix}effort "${effort}" must be one of low, medium, or high${entrySuffix}.`,
      );
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
      `⚠️  Job "${entry.id}" is pinned to harness "${harness.name}", which is not installed. ` +
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
 * Overlay a job's agent selection onto a composed environment.
 *
 * Only fields the selection set are written, so omitted fields keep the value
 * from the environment layers (team/repo/workspace) or the harness default.
 *
 * With `harness`, the env is pinned to that agent. When the pin differs from
 * the env's primary, the global `AGENT_CLI_PATH` and the resolver's
 * `CLAUDE_CLI_PATH` fallback (which name the primary/claude binary) are
 * dropped so the child resolves the pinned harness's own `<HARNESS>_CLI_PATH`
 * or default, and an inherited `AGENT_MODEL` / `AGENT_EFFORT` (chosen for the
 * primary) is dropped unless the selection sets its own value.
 *
 * `model` is always written to the target harness's own `<HARNESS>_MODEL`
 * (the pin, or the env's primary when no harness is set), which outranks
 * `AGENT_MODEL` and applies only to that harness. Without a pin, a failover
 * fallback therefore keeps its own default model.
 *
 * Mutates and returns `env` for chaining.
 */
export function applyAgentSelectionEnv(
  env: Record<string, string | undefined>,
  selection: AgentSelection | undefined,
): Record<string, string | undefined> {
  if (!selection) return env;
  const envPrimary = primaryHarnessName(env.AGENT_HARNESS);
  const target = selection.harness ?? envPrimary;
  if (selection.harness) {
    const changedHarness = envPrimary !== selection.harness;
    dropForeignHarnessCliPaths(env, selection.harness, envPrimary);
    env.AGENT_HARNESS = selection.harness;
    if (selection.model) {
      env.AGENT_MODEL = selection.model;
    } else if (changedHarness) {
      delete env.AGENT_MODEL;
    }
    if (!selection.effort && changedHarness) {
      delete env.AGENT_EFFORT;
    }
  }
  if (selection.model) env[harnessModelEnvKey(target)] = selection.model;
  if (selection.effort) env.AGENT_EFFORT = selection.effort;
  return env;
}

/**
 * Child env for a run pinned to one harness, bypassing worker failover.
 *
 * Neither the active failover entry nor a usage-limit failover can re-route a
 * job that named its agent. The worker-child marker is kept — and any hint
 * path inherited from an ancestor worker dropped — so a usage-limit abort
 * still exits 75 to the parent instead of falling through to one-shot success
 * handling; the caller decides what that exit means (it never re-spawns on
 * another harness).
 *
 * @param base - Composed environment (already carrying the selection).
 * @param harnessPin - Canonical harness the run is pinned to.
 */
export function pinnedHarnessChildEnv(
  base: Record<string, string | undefined>,
  harnessPin: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...base,
    AGENT_HARNESS: harnessPin,
    [WORKER_CHILD_ENV]: "1",
  };
  delete env[USAGE_LIMIT_FILE_ENV];
  // Guards direct callers that pin without pre-composing the selection.
  dropForeignHarnessCliPaths(env, harnessPin, primaryHarnessName(base.AGENT_HARNESS));
  return env;
}
