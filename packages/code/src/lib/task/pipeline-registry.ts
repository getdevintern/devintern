import type { TaskStepResult } from "./step-runner";

/** Fields available to a custom delivery step. */
export interface PipelineContext {
  taskKey?: string;
  taskSummary?: string;
  taskContent: string;
  workingDir: string;
  outputDir: string;
  output: string;
  committed: boolean;
  prTargetBranch: string;
  warnings: string[];
}

export interface PipelineStep {
  name: string;
  run(context: PipelineContext): Promise<TaskStepResult | void>;
}

/** Default export from a plugin module. */
export interface StepDefinition {
  name: string;
  create(config: Record<string, unknown>): PipelineStep;
}

const registryKey = Symbol.for("@getdevintern/code/pipeline/registry");
const registry = globalThis as typeof globalThis &
  Record<symbol, Map<string, StepDefinition> | undefined>;
const reservedNames = new Set([
  "clarity",
  "implement",
  "commit",
  "verify",
  "auto-review",
  "finalize",
  "publish",
  "repair",
]);

function definitions(): Map<string, StepDefinition> {
  return (registry[registryKey] ??= new Map());
}

/** Register a step factory. Names must not replace a different definition. */
export function registerStep(definition: StepDefinition): void {
  if (
    !definition ||
    typeof definition.name !== "string" ||
    !definition.name.trim() ||
    typeof definition.create !== "function"
  ) {
    throw new Error("Pipeline step definition needs a name and create(config) function");
  }
  if (reservedNames.has(definition.name) || definition.name.startsWith("__")) {
    throw new Error(`Pipeline step name '${definition.name}' is reserved`);
  }
  const existing = definitions().get(definition.name);
  if (existing && existing !== definition) {
    throw new Error(`A pipeline step named '${definition.name}' is already registered`);
  }
  definitions().set(definition.name, definition);
}

export function getStep(name: string): StepDefinition | undefined {
  return definitions().get(name);
}

export function listSteps(): StepDefinition[] {
  return [...definitions().values()];
}

/** Request one retry when a plugin fails for a transient execution reason. */
export class StepExecutionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StepExecutionError";
  }
}
