/**
 * Per-task agent runtime overrides.
 *
 * The agent harness, model, and effort are normally read from the environment
 * (`.devintern-code/.env` / `--harness` flags) and resolved once per process.
 * A task description can request different values for a single task; the
 * pipeline records those here for the duration of that task so the deeper
 * spawn sites (implementation, clarity check, auto-review, hook fixes) all
 * observe the same effective values, then clears them for the next task.
 *
 * Task processing is strictly sequential, so a single module-level slot is
 * sufficient and matches how `runContext.resolvedAgent` already works.
 */

import type { AgentEffort } from "@devintern/agent-harness";

/** Model/effort values to use for the current task. */
export interface AgentRuntimeOverrides {
  /**
   * Overrides `AGENT_MODEL`. A string pins the model; `null` suppresses the
   * environment value (used when the task switched harnesses and the global
   * model is harness-specific and therefore unsafe to carry over). `undefined`
   * means "no override" — the environment value applies.
   */
  model?: string | null;
  /** Overrides `AGENT_EFFORT` when defined. */
  effort?: AgentEffort;
}

let currentOverrides: AgentRuntimeOverrides | null = null;

/**
 * Set the overrides for the task currently being processed.
 *
 * @param overrides - Model/effort values to apply, or `null` to clear.
 */
export function setAgentRuntimeOverrides(overrides: AgentRuntimeOverrides | null): void {
  currentOverrides = overrides;
}

/** The overrides for the task currently being processed, if any. */
export function getAgentRuntimeOverrides(): AgentRuntimeOverrides | null {
  return currentOverrides;
}

/** Clear any per-task overrides (called after each task). */
export function clearAgentRuntimeOverrides(): void {
  currentOverrides = null;
}
