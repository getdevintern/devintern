/**
 * Resolve per-task execution preferences parsed from a task description.
 *
 * A task author can request a harness, model, or effort inline (see
 * {@link Utils.extractExecutionPreferences}) without changing the global
 * defaults. This module turns those raw strings into an effective selection:
 *
 * - the harness is validated against the registry (unknown names fail with the
 *   available list);
 * - the model may be a family / alias (resolved to the latest compatible model
 *   for that harness) or an exact identifier (passed through);
 * - effort is applied only when the harness supports it, otherwise the
 *   preference is ignored with a note and the task proceeds;
 * - conflicting or unavailable preferences fail with an actionable message
 *   instead of silently using different values.
 */

import {
  getHarness,
  listHarnesses,
  parseAgentEffort,
  resolveExecutablePathStrict,
  resolveHarness,
  resolveModelAlias,
  InvalidAgentEffortError,
} from "@devintern/agent-harness";
import type { AgentEffort, ResolvedHarness } from "@devintern/agent-harness";

import { Utils } from "../utils";
import { resolveAgentModel } from "./model";

/** Thrown when a task's execution preferences cannot be honored as written. */
export class ExecutionPreferencesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionPreferencesError";
  }
}

/** The effective agent selection for one task. */
export interface EffectiveExecutionPreferences {
  /** Harness + executable path to run the task with. */
  agent: ResolvedHarness;
  /**
   * Runtime model override for this task: a string pins the model, `null`
   * suppresses `AGENT_MODEL` (harness was switched), `undefined` keeps the
   * environment default.
   */
  modelOverride: string | null | undefined;
  /** Concrete model to surface to the user, when known. */
  displayModel?: string;
  /** Family / alias name when the model was resolved from one. */
  modelAlias?: string;
  /** Validated effort to apply, when the selected harness supports it. */
  effort?: AgentEffort;
  /** True when effort was requested but the harness cannot apply it. */
  effortIgnored: boolean;
  /** Human-readable lines describing the effective selection. */
  notes: string[];
}

/**
 * Resolve the execution preferences embedded in a task description.
 *
 * @param input.description - Task description text (may be undefined)
 * @param input.currentAgent - Harness resolved from the environment at startup
 * @returns The effective harness/model/effort plus summary lines
 * @throws {ExecutionPreferencesError} when a preference is unknown, conflicting,
 *   incompatible, or malformed
 */
export function resolveExecutionPreferences(input: {
  description: string | undefined;
  currentAgent: ResolvedHarness;
}): EffectiveExecutionPreferences {
  const { description, currentAgent } = input;
  const { preferences, conflicts } = Utils.extractExecutionPreferences(description);

  if (conflicts.length > 0) {
    const details = conflicts
      .map(({ field, values }) => `${field} (${values.join(", ")})`)
      .join("; ");
    throw new ExecutionPreferencesError(
      `Conflicting execution preferences in the task description: ${details}. ` +
        `Specify exactly one value per preference.`,
    );
  }

  const result: EffectiveExecutionPreferences = {
    agent: currentAgent,
    modelOverride: undefined,
    effortIgnored: false,
    notes: [],
  };

  if (!preferences.harness && !preferences.model && !preferences.effort) {
    return result;
  }

  // 1. Harness -------------------------------------------------------------
  let harnessChanged = false;
  if (preferences.harness) {
    const requested = getHarness(preferences.harness);
    if (!requested) {
      const available = listHarnesses()
        .map((harness) => `"${harness.name}"`)
        .join(", ");
      throw new ExecutionPreferencesError(
        `Unknown agent harness "${preferences.harness}" in the task description. ` +
          `Available harnesses: ${available}.`,
      );
    }

    if (requested.name !== currentAgent.harness.name) {
      const agent = resolveHarness({ harnessName: requested.name });
      agent.path = resolveExecutablePathStrict(agent.path, agent.harness.displayName);
      result.agent = agent;
      harnessChanged = true;
    }
  }

  // 2. Model ---------------------------------------------------------------
  let aliasResolved = false;
  if (preferences.model) {
    const resolution = resolveModelAlias({
      harness: result.agent.harness.name,
      model: preferences.model,
    });
    if (resolution.kind === "error") {
      throw new ExecutionPreferencesError(resolution.reason);
    }
    result.modelOverride = resolution.model;
    result.displayModel = resolution.model;
    if (resolution.kind === "resolved") {
      result.modelAlias = resolution.alias;
      aliasResolved = true;
    }
  } else if (harnessChanged) {
    // AGENT_MODEL is harness-specific; carrying it onto a harness the author
    // did not choose would often be invalid. Fall back to the new harness's
    // own default instead.
    result.modelOverride = null;
  } else {
    result.displayModel = resolveAgentModel(result.agent.harness.name);
  }

  // Surface the effective selection whenever the task asked for any preference,
  // so a task that only sets effort still shows which harness/model it runs on.
  result.notes.unshift(
    `   🤖 Harness: ${result.agent.harness.displayName} (${result.agent.harness.name})`,
  );
  if (result.displayModel) {
    result.notes.push(
      aliasResolved
        ? `   🧠 Model: ${result.displayModel} (alias "${preferences.model}")`
        : `   🧠 Model: ${result.displayModel}`,
    );
  } else {
    result.notes.push(`   🧠 Model: ${result.agent.harness.displayName} default`);
  }

  // 3. Effort --------------------------------------------------------------
  if (preferences.effort) {
    if (result.agent.harness.supportsEffort !== true) {
      // An unsupported harness ignores effort entirely, so the value does not
      // need to be valid before the task proceeds at the harness default.
      result.effortIgnored = true;
      result.notes.push(
        `   ⚠️  Effort "${preferences.effort}" ignored: ${result.agent.harness.displayName} does not support reasoning effort.`,
      );
    } else {
      let effort: AgentEffort | undefined;
      try {
        effort = parseAgentEffort(preferences.effort);
      } catch (error) {
        if (error instanceof InvalidAgentEffortError) {
          throw new ExecutionPreferencesError(
            `Invalid effort "${preferences.effort}" in the task description. ${error.message}`,
          );
        }
        throw error;
      }

      if (effort !== undefined) {
        result.effort = effort;
        result.notes.push(`   ⚡ Effort: ${effort}`);
      }
    }
  }

  return result;
}
