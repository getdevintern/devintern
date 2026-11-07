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
  harnessCliPathEnvKey,
  listHarnesses,
  parseAgentEffort,
  parseHarnessList,
  resolveExecutablePathStrict,
  resolveHarness,
  resolveModelAlias,
  InvalidAgentEffortError,
} from "@devintern/agent-harness";
import type { AgentEffort, ResolvedHarness } from "@devintern/agent-harness";

import { Utils } from "../utils";
import { isWorkerChild } from "../worker/usage-limit-protocol";
import { HARNESS_CHAIN_ENV, resolveAgentModel, resolveHarnessModel } from "./model";

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
 * Resolve a task-selected harness executable and fail with an actionable,
 * preference-specific error when it cannot be found.
 *
 * The resolver intentionally skips `AGENT_CLI_PATH` for an explicitly selected
 * harness (so a global path captured for the environment-selected primary
 * cannot stick to a different CLI), so the error must point at that harness's
 * own `<HARNESS>_CLI_PATH` instead.
 *
 * @param agent - Harness selected by the task description.
 * @returns The executable path to spawn.
 * @throws {ExecutionPreferencesError} when the CLI is not installed/on PATH.
 */
function resolveTaskHarnessPath(agent: ResolvedHarness): string {
  // The strict resolver already appends "CLI not found"; avoid "Kimi CLI CLI".
  const displayName = agent.harness.displayName.replace(/\s+CLI$/i, "");
  try {
    return resolveExecutablePathStrict(agent.path, displayName);
  } catch (error) {
    const envKey = harnessCliPathEnvKey(agent.harness.name);
    const detail = error instanceof Error ? error.message : String(error);
    throw new ExecutionPreferencesError(
      `Cannot run harness "${agent.harness.name}" for this task: ${detail} ` +
        `For a task-selected harness, set ${envKey}; AGENT_CLI_PATH applies only to the ` +
        `environment-selected primary harness.`,
    );
  }
}

/**
 * Outcome of resolving one `Model:` preference against the spawn harness.
 *
 * `ignoredModel` means the value was deliberately not applied; `warning` is a
 * note to surface when the value is applied but not resolved from a built-in
 * family.
 */
interface ModelPreferenceSelection {
  modelOverride: string | null | undefined;
  displayModel?: string;
  modelAlias?: string;
  ignoredModel?: string;
  ignoredModelNote?: string;
  warning?: string;
}

/**
 * Resolve a task's model preference for the harness this spawn will use.
 *
 * @param input.model - Raw `Model:` value from the description
 * @param input.harnessName - Harness the spawn runs on
 * @param input.chain - Configured failover chain (empty outside a worker child)
 * @param input.pinnedFallback - True when the spawn is a fallback entry
 * @param input.harnessExplicit - True when the task named the harness
 * @returns The override, display model, and any ignored/warning detail
 * @throws {ExecutionPreferencesError} when an explicitly selected harness
 *   cannot run the requested family
 */
function resolveModelPreference(input: {
  model: string;
  harnessName: string;
  chain: readonly string[];
  pinnedFallback: boolean;
  harnessExplicit: boolean;
}): ModelPreferenceSelection {
  const resolution = resolveModelAlias({ harness: input.harnessName, model: input.model });
  // An exact id or a family we cannot resolve was written without a harness,
  // so it targets the primary chain entry. A fallback is a fresh child process
  // whose pinned harness cannot be assumed to understand that value;
  // AGENT_MODEL is already suppressed for fallbacks, and a per-task override
  // must follow the same rule or the fallback CLI fails before failover can
  // continue. An explicit `Harness:` naming the pinned entry opts back in.
  if (input.pinnedFallback && !input.harnessExplicit && resolution.kind !== "resolved") {
    return {
      modelOverride: undefined,
      displayModel: resolveAgentModel(input.harnessName, input.chain),
      ignoredModel: input.model,
      ignoredModelNote:
        `   ⚠️  Model "${input.model}" ignored: this worker run is pinned to fallback ` +
        `harness "${input.harnessName}" for failover.`,
    };
  }

  if (resolution.kind === "error") {
    if (input.harnessExplicit) {
      // The task named this harness, so an incompatible family is an
      // authoring mistake worth failing on.
      throw new ExecutionPreferencesError(resolution.reason);
    }
    // The environment selected this harness and the author did not name one.
    // The built-in catalog only covers a subset of harnesses, so the value may
    // still be a native alias that CLI understands: pass it through instead of
    // failing the task before the harness can decide.
    return {
      modelOverride: resolution.model,
      displayModel: resolution.model,
      warning:
        `   ⚠️  Model "${resolution.model}" is not a known family for harness ` +
        `"${input.harnessName}"; passing it through to the harness as-is.`,
    };
  }

  return {
    modelOverride: resolution.model,
    displayModel: resolution.model,
    ...(resolution.kind === "resolved" ? { modelAlias: resolution.alias } : {}),
  };
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
  let ignoredHarness: string | undefined;
  if (preferences.harness) {
    const requested =
      getHarness(preferences.harness) ?? getHarness(preferences.harness.toLowerCase());
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
      if (isWorkerChild() || process.env[HARNESS_CHAIN_ENV]) {
        // The worker pins this child to the active failover entry and retries
        // on the next entry after exit 75. Re-selecting a harness here would
        // keep retrying the same (possibly limited) CLI and make the parent
        // record limit windows against the wrong chain entry.
        ignoredHarness = requested.name;
        result.notes.push(
          `   ⚠️  Harness "${requested.name}" ignored: this worker run is pinned to ` +
            `"${currentAgent.harness.name}" for failover. Reorder AGENT_HARNESS to change the ` +
            `active harness, or run the task interactively.`,
        );
      } else {
        const agent = resolveHarness({ harnessName: requested.name });
        agent.path = resolveTaskHarnessPath(agent);
        result.agent = agent;
        harnessChanged = true;
      }
    }
  }

  // 2. Model ---------------------------------------------------------------
  let aliasResolved = false;
  let ignoredModel: string | undefined;
  let ignoredModelNote: string | undefined;
  // In a worker child the configured chain is preserved separately because
  // AGENT_HARNESS is pinned to the active (possibly fallback) entry.
  const chain = process.env[HARNESS_CHAIN_ENV]
    ? parseHarnessList(process.env[HARNESS_CHAIN_ENV])
    : [];
  const pinnedFallback = chain.length > 1 && result.agent.harness.name !== chain[0];
  if (preferences.model) {
    if (ignoredHarness) {
      // The model was written for the harness we just ignored. Resolving it
      // against the pinned harness would either fail (a family from another
      // provider) or silently pick that harness's equivalent model, so skip it
      // and keep the pinned harness's configured default.
      ignoredModel = preferences.model;
      ignoredModelNote = `   ⚠️  Model "${ignoredModel}" ignored: it belongs to the ignored harness "${ignoredHarness}".`;
      result.displayModel = resolveAgentModel(result.agent.harness.name);
    } else {
      const selection = resolveModelPreference({
        model: preferences.model,
        harnessName: result.agent.harness.name,
        chain,
        pinnedFallback,
        harnessExplicit: Boolean(preferences.harness),
      });
      result.modelOverride = selection.modelOverride;
      result.displayModel = selection.displayModel;
      if (selection.modelAlias) {
        result.modelAlias = selection.modelAlias;
        aliasResolved = true;
      }
      ignoredModel = selection.ignoredModel;
      ignoredModelNote = selection.ignoredModelNote;
      if (selection.warning) {
        result.notes.push(selection.warning);
      }
    }
  } else if (harnessChanged) {
    // AGENT_MODEL is harness-specific; carrying it onto a harness the author
    // did not choose would often be invalid. Fall back to the new harness's
    // own <HARNESS>_MODEL (or its default). The null override suppresses only
    // the global AGENT_MODEL, so a configured per-harness model still applies.
    result.modelOverride = null;
    result.displayModel = resolveHarnessModel(result.agent.harness.name);
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
  if (ignoredModel) {
    result.notes.push(ignoredModelNote ?? `   ⚠️  Model "${ignoredModel}" ignored.`);
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
        effort = parseAgentEffort(preferences.effort.toLowerCase());
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
