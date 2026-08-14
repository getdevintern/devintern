/**
 * Pipeline configuration: resolve `settings.pipeline.steps` entries into
 * step instances and load user step plugins (`pipeline.plugins`).
 */

import { isAbsolute, resolve } from "path";
import type { PipelineStepConfig } from "../../types/settings";
import { getStep, listSteps, registerStep } from "./registry";
import type { PipelineStep, StepDefinition } from "./types";

const loadedPluginSpecifiers = new Set<string>();

/**
 * The default pipeline, reproducing the classic flow:
 * implement -> commit -> auto-review -> push/comment/PR (finalize).
 *
 * The clarity check is not listed here: it runs in the task preamble (before
 * branch creation and the In-Progress transition), exactly as before.
 * `auto-review` gates itself on the `--auto-review` flag, so this list stays
 * static while behavior stays flag-driven.
 */
export const DEFAULT_PIPELINE: PipelineStepConfig[] = [
  { use: "implement" },
  { use: "commit" },
  { use: "auto-review" },
  { use: "finalize" },
];

/**
 * Resolve pipeline step configs into step instances.
 *
 * @param stepConfigs - `settings.pipeline.steps`; falls back to {@link DEFAULT_PIPELINE}
 * @throws When an entry is malformed or references an unknown step
 */
export function resolvePipelineSteps(stepConfigs?: PipelineStepConfig[]): PipelineStep[] {
  const configs = stepConfigs && stepConfigs.length > 0 ? stepConfigs : DEFAULT_PIPELINE;

  return configs.map((entry) => {
    if (!entry || typeof entry.use !== "string" || entry.use.length === 0) {
      throw new Error(
        `Invalid pipeline step entry ${JSON.stringify(entry)} - each entry must be an object with a 'use' field naming a registered step`,
      );
    }
    const definition = getStep(entry.use);
    if (!definition) {
      const available = listSteps()
        .map((step) => step.name)
        .join(", ");
      throw new Error(
        `Unknown pipeline step '${entry.use}'. Available steps: ${available}. ` +
          `Custom steps must be registered via 'pipeline.plugins' before they can be used.`,
      );
    }
    const { use: _use, ...config } = entry;
    return definition.create(config);
  });
}

/**
 * Load user pipeline plugins: dynamic-import each module and register its
 * default-exported {@link StepDefinition}.
 *
 * Entries are either file paths (resolved against `projectRoot`) or npm
 * package names (resolved from the project's node_modules at runtime).
 *
 * @throws With a clear message on load failure, missing/invalid default
 *   export, or a name collision with an existing step.
 */
export async function loadPlugins(
  plugins: string[] | undefined,
  projectRoot: string,
): Promise<void> {
  for (const entry of plugins ?? []) {
    const isPath = entry.startsWith(".") || isAbsolute(entry);
    const specifier = isPath ? resolve(projectRoot, entry) : entry;
    if (loadedPluginSpecifiers.has(specifier)) {
      continue;
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(specifier)) as Record<string, unknown>;
    } catch (importError) {
      throw new Error(
        `Failed to load pipeline plugin '${entry}': ${(importError as Error).message}`,
      );
    }

    const definition = mod.default as StepDefinition | undefined;
    if (
      !definition ||
      typeof definition !== "object" ||
      typeof definition.name !== "string" ||
      definition.name.length === 0 ||
      typeof definition.create !== "function"
    ) {
      throw new Error(
        `Pipeline plugin '${entry}' must default-export a StepDefinition ({ name, create }). ` +
          `${mod.default === undefined ? "The module has no default export." : `Got: ${typeof mod.default}`}`,
      );
    }

    registerStep(definition);
    loadedPluginSpecifiers.add(specifier);
  }
}
