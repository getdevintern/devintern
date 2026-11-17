/**
 * Agent model and reasoning-effort override resolution.
 *
 * Model identifiers are harness- and plugin-specific: `opencode-go/deepseek-v4.1-flash`
 * means nothing to Grok Build, and `grok-4.7` means nothing to OpenCode. A single
 * `AGENT_MODEL` therefore cannot be applied blindly across a failover chain — it
 * would hand every fallback a model its CLI cannot resolve, making the fallback
 * unusable.
 *
 * Resolution per spawn:
 * 1. A per-task override from the task description (see
 *    `execution-preferences.ts`), delivered through `runtime-overrides.ts`.
 * 2. `<HARNESS>_MODEL` (e.g. `OPENCODE_MODEL`, `GROK_MODEL`) — explicit override
 *    for that harness, valid for primary and fallback entries alike.
 * 3. `AGENT_MODEL` — when the harness is the only configured entry, or the
 *    primary (first) entry of a multi-harness chain.
 * 4. Unset — a fallback harness runs with its own default model.
 *
 * `DEVINTERN_HARNESS_CHAIN` carries the original chain into a worker child,
 * whose `AGENT_HARNESS` is pinned to the active entry so failover can work.
 * Without it the child cannot tell whether the pinned harness is the primary or
 * a fallback, and would leak `AGENT_MODEL` onto the fallback again.
 *
 * AGENT_EFFORT tunes the reasoning depth of the underlying agent alongside the
 * model (low / medium / high). It is emitted only by harnesses with effort
 * support (Codex config override; pi model-string suffix); others ignore it with
 * a warning. Invalid values fail with a clear message. A per-task effort
 * preference takes precedence over the environment for that task.
 */

import { getHarness, parseAgentEffort, parseHarnessList } from "@devintern/agent-harness";
import type { AgentEffort } from "@devintern/agent-harness";

import { getAgentRuntimeOverrides } from "./runtime-overrides";

/**
 * Internal env var that preserves the configured failover chain inside a worker
 * child, whose `AGENT_HARNESS` is pinned to one entry.
 */
export const HARNESS_CHAIN_ENV = "DEVINTERN_HARNESS_CHAIN";

/**
 * Model env var for one harness (`claude-code` → `CLAUDE_CODE_MODEL`).
 *
 * @param harnessName - Canonical harness name from the registry.
 * @returns The environment variable that overrides that harness's model.
 */
export function harnessModelEnvKey(harnessName: string): string {
  return `${harnessName.toUpperCase().replace(/-/g, "_")}_MODEL`;
}

/**
 * Canonical name of the harness this spawn will use.
 *
 * @param harnessName - Explicit harness name when the caller already resolved one.
 * @returns The canonical active name; defaults to the primary chain entry.
 */
function activeHarnessName(harnessName?: string): string {
  if (harnessName) {
    return canonicalHarnessName(harnessName);
  }
  return parseHarnessList(process.env.AGENT_HARNESS)[0];
}

/**
 * Canonical registry name for a harness id or alias.
 *
 * @param harnessName - Harness id or alias.
 * @returns The registered canonical name, or the input when it is unknown.
 */
function canonicalHarnessName(harnessName: string): string {
  return getHarness(harnessName)?.name ?? harnessName;
}

/**
 * Read only the `<HARNESS>_MODEL` value for a harness.
 *
 * Unlike {@link resolveAgentModel}, this ignores `AGENT_MODEL` and per-task
 * overrides. It is used to describe what a harness will run after a task
 * switches harnesses, where the global model is intentionally not carried over.
 *
 * @param harnessName - Harness that will be spawned.
 * @returns The harness-specific model, or `undefined` when unset.
 */
export function resolveHarnessModel(harnessName?: string): string | undefined {
  const active = activeHarnessName(harnessName);
  return process.env[harnessModelEnvKey(active)]?.trim() || undefined;
}

/**
 * The configured chain, in priority order.
 *
 * A worker child carries the original chain separately because its
 * `AGENT_HARNESS` is pinned to the active entry.
 *
 * @returns Canonical harness names, primary first.
 */
function configuredChain(): string[] {
  return parseHarnessList(process.env[HARNESS_CHAIN_ENV] || process.env.AGENT_HARNESS);
}

/**
 * Read the model for one harness spawn, if any.
 *
 * A per-task override wins over every environment value, but only for the
 * harness it was resolved for. `null` suppresses `AGENT_MODEL` (used when a
 * task switched harnesses, since the global model is harness-specific) while
 * still allowing that harness's own `<HARNESS>_MODEL`.
 *
 * @param harnessName - Harness that will be spawned. Omit in a worker child to
 *   use the pinned active entry.
 * @param chainOverride - Configured chain, when the caller already resolved it
 *   (the worker startup banner). Defaults to the env-configured chain.
 * @returns The model id to pass to the harness, or `undefined` to let the
 *   harness use its own default.
 */
export function resolveAgentModel(
  harnessName?: string,
  chainOverride?: readonly string[],
): string | undefined {
  const chain = chainOverride && chainOverride.length > 0 ? [...chainOverride] : configuredChain();
  const active = activeHarnessName(harnessName);
  const specific = resolveHarnessModel(active);
  const override = getAgentRuntimeOverrides();
  const overrideApplies =
    override?.model !== undefined &&
    (override.harness === undefined || canonicalHarnessName(override.harness) === active);

  if (overrideApplies) {
    if (override.model !== null) {
      return override.model;
    }
    // A `null` override only suppresses the global `AGENT_MODEL`, which is
    // harness-specific and unsafe to carry onto a newly selected harness. The
    // harness's own `<HARNESS>_MODEL` was configured for exactly this spawn, so
    // it still applies.
    return specific;
  }

  if (specific) {
    return specific;
  }

  const global = process.env.AGENT_MODEL?.trim();
  if (!global) {
    return undefined;
  }

  // Single-harness setups (and explicit `--harness` picks with no chain) keep
  // the historical behavior: AGENT_MODEL applies to whatever harness runs.
  // In a chain it applies only to the primary, so a fallback never receives a
  // model id from a different provider.
  const multiHarness = chain.length > 1;
  if (!multiHarness || active === chain[0]) {
    return global;
  }
  return undefined;
}

/**
 * Read the configured reasoning effort, if any.
 *
 * A per-task override wins over `AGENT_EFFORT`.
 *
 * @throws {InvalidAgentEffortError} when AGENT_EFFORT is set to a value
 *   outside low / medium / high — fail loudly instead of spawning agents
 *   with a silently ignored (or worse, misparsed) setting.
 */
export function resolveAgentEffort(): AgentEffort | undefined {
  const override = getAgentRuntimeOverrides();
  if (override?.effort !== undefined) {
    return override.effort;
  }
  return parseAgentEffort(process.env.AGENT_EFFORT);
}
