/**
 * Agent model and reasoning-effort override resolution.
 *
 * AGENT_MODEL (from the environment or `.devintern-code/.env`) names the
 * model each spawned harness should run with. The string is harness-specific
 * (see the harness CLI docs); harnesses without a model flag ignore it.
 *
 * AGENT_EFFORT tunes the reasoning depth of the underlying agent alongside
 * the model (low / medium / high). It is emitted only by harnesses with
 * effort support (Codex config override; pi model-string suffix); others
 * ignore it with a warning. Invalid values fail with a clear message.
 */

import { parseAgentEffort } from "@devintern/agent-harness";
import type { AgentEffort } from "@devintern/agent-harness";

/** Read the configured agent model, if any. */
export function resolveAgentModel(): string | undefined {
  const model = process.env.AGENT_MODEL?.trim();
  return model ? model : undefined;
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
