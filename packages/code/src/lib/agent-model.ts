/**
 * Agent model override resolution.
 *
 * AGENT_MODEL (from the environment or `.devintern-code/.env`) names the
 * model each spawned harness should run with. The string is harness-specific
 * (see the harness CLI docs); harnesses without a model flag ignore it.
 */

/** Read the configured agent model, if any. */
export function resolveAgentModel(): string | undefined {
  const model = process.env.AGENT_MODEL?.trim();
  return model ? model : undefined;
}
