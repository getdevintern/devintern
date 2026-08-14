/**
 * Pipeline step registry. New steps can be registered at runtime (via
 * `pipeline.plugins` in settings.json or `registerStep()` from
 * `@devintern/code/pipeline`) or by editing this file.
 *
 * Mirrors the harness registry in `@devintern/agent-harness`.
 */

import type { StepDefinition } from "./types";
import { autoReviewStepDefinition } from "./steps/auto-review-step";
import { clarityStepDefinition } from "./steps/clarity-step";
import { commitStepDefinition } from "./steps/commit-step";
import { finalizeStepDefinition } from "./steps/finalize-step";
import { implementStepDefinition } from "./steps/implement-step";
import { verifyStepDefinition } from "./steps/verify-step";

const registry = new Map<string, StepDefinition>();

const BUILT_IN_STEPS: StepDefinition[] = [
  clarityStepDefinition,
  implementStepDefinition,
  commitStepDefinition,
  autoReviewStepDefinition,
  verifyStepDefinition,
  finalizeStepDefinition,
];

/**
 * Register a step definition for lookup by {@link getStep}.
 *
 * @param definition - Step definition; keyed by {@link StepDefinition.name}.
 * @throws When a different definition is already registered under the name.
 */
export function registerStep(definition: StepDefinition): void {
  const existing = registry.get(definition.name);
  if (existing && existing !== definition) {
    throw new Error(
      `A pipeline step named '${definition.name}' is already registered. ` +
        `Step names must be unique - rename your custom step.`,
    );
  }
  registry.set(definition.name, definition);
}

/**
 * Look up a registered step definition by its machine-readable name.
 *
 * @param name - Step identifier (e.g. `"implement"`).
 * @returns The step definition, or `undefined` if not registered.
 */
export function getStep(name: string): StepDefinition | undefined {
  return registry.get(name);
}

/**
 * Return every step definition currently registered in the global registry.
 *
 * @returns A snapshot of all registered step definitions.
 */
export function listSteps(): StepDefinition[] {
  return Array.from(registry.values());
}

/** Test-only: reset the registry back to the built-in steps. */
export function __resetStepsForTests(): void {
  registry.clear();
  registerBuiltInSteps();
}

function registerBuiltInSteps(): void {
  for (const definition of BUILT_IN_STEPS) {
    registry.set(definition.name, definition);
  }
}

// Register built-in steps -----------------------------------------------------
registerBuiltInSteps();
