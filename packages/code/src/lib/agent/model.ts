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
 * 1. `<HARNESS>_MODEL` (e.g. `OPENCODE_MODEL`, `GROK_MODEL`) — explicit override
 *    for that harness, valid for primary and fallback entries alike.
 * 2. `AGENT_MODEL` — when the harness is the only configured entry, or the
 *    primary (first) entry of a multi-harness chain.
 * 3. Unset — a fallback harness runs with its own default model.
 *
 * `DEVINTERN_HARNESS_CHAIN` carries the original chain into a worker child,
 * whose `AGENT_HARNESS` is pinned to the active entry so failover can work.
 * Without it the child cannot tell whether the pinned harness is the primary or
 * a fallback, and would leak `AGENT_MODEL` onto the fallback again.
 *
 * AGENT_EFFORT tunes the reasoning depth of the underlying agent alongside the
 * model (low / medium / high). It is emitted only by harnesses with effort
 * support (Codex config override; pi model-string suffix); others ignore it with
 * a warning. Invalid values fail with a clear message.
 */

import { getHarness, parseAgentEffort, parseHarnessList } from "@devintern/agent-harness";
import type { AgentEffort } from "@devintern/agent-harness";

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
    return getHarness(harnessName)?.name ?? harnessName;
  }
  return parseHarnessList(process.env.AGENT_HARNESS)[0];
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
  const specific = process.env[harnessModelEnvKey(active)]?.trim();
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
 * @throws {InvalidAgentEffortError} when AGENT_EFFORT is set to a value
 *   outside low / medium / high — fail loudly instead of spawning agents
 *   with a silently ignored (or worse, misparsed) setting.
 */
export function resolveAgentEffort(): AgentEffort | undefined {
  return parseAgentEffort(process.env.AGENT_EFFORT);
}
