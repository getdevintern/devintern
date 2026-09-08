/**
 * Reasoning-effort support for agent harnesses.
 *
 * Several wrapped CLIs expose a reasoning-effort style control alongside the
 * model — as a dedicated flag (Claude Code `--effort`, Grok/`agy`/Reasonix
 * `--effort`), a flag under a different name (Cline `--thinking <level>`,
 * Opencode/Kilo `--variant <level>`), a config override (Codex's
 * `model_reasoning_effort`), or a model-string suffix (pi's
 * `<model>:<thinking>`). {@link AgentRunOptions.effort} flows through the
 * same path as `model`; harnesses declare support with the
 * `AgentHarness.supportsEffort` capability flag, mirroring
 * `supportsStructuredOutput`. Supporting harnesses emit (or compose) the
 * value in `buildArgs`; the rest ignore it — runners print a one-line
 * warning so a misconfiguration is visible, which keeps failover chains
 * mixing capable and incapable harnesses working.
 *
 * The option is a string union at the type level, but raw input arrives as
 * free-form env vars / CLI flags, so {@link parseAgentEffort} validates at
 * the config boundary and fails with the accepted values.
 */

import type { AgentEffort, AgentHarness, AgentRunOptions } from "./types.js";

/** Documented effort levels, ordered slowest/deepest → fastest/shallowest. */
export const AGENT_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high"];

/**
 * Whether the value is one of the documented effort levels.
 *
 * @param value - Raw value from env vars, CLI flags, or config files.
 */
export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && (AGENT_EFFORTS as readonly string[]).includes(value);
}

/**
 * Error thrown when a configured effort value is not one of
 * {@link AGENT_EFFORTS}.
 */
export class InvalidAgentEffortError extends Error {
  readonly value: string;

  constructor(value: string) {
    super(
      `Invalid agent effort "${value}". Valid values: ${AGENT_EFFORTS.join(", ")}. ` +
        `Set AGENT_EFFORT (or pass --effort) with one of those values, or unset it.`,
    );
    this.name = "InvalidAgentEffortError";
    this.value = value;
  }
}

/**
 * Validate a raw effort value from a config surface (env var, CLI flag).
 * Empty/whitespace-only input means "not set" and returns `undefined`.
 *
 * @param value - Raw value (e.g. `process.env.AGENT_EFFORT`).
 * @returns The validated effort, or `undefined` when unset.
 * @throws {InvalidAgentEffortError} on any other invalid value
 */
export function parseAgentEffort(value: string | undefined | null): AgentEffort | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!isAgentEffort(trimmed)) {
    throw new InvalidAgentEffortError(trimmed);
  }
  return trimmed;
}

/**
 * Warn once per run when effort was requested from a harness that cannot
 * apply it. Unlike unsupported structured output (fail closed), effort
 * degrades to a warning: failover chains routinely mix harnesses, and an
 * unsupported harness should keep running at its default effort rather than
 * abort the task.
 *
 * @param harness - Harness about to run.
 * @param options - Run options carrying the requested effort.
 */
export function warnEffortUnsupported(harness: AgentHarness, options: AgentRunOptions): void {
  if (options.effort && harness.supportsEffort !== true) {
    console.warn(
      `⚠️  ${harness.displayName} (${harness.name}) does not support reasoning effort; ` +
        `ignoring effort "${options.effort}". ` +
        `Supported harnesses: antigravity, cline, claude-code, codex, deepseek, grok, kilo-code, opencode, pi.`,
    );
  }
}
