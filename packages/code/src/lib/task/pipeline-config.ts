import { isAbsolute, resolve } from "path";
import { pathToFileURL } from "url";
import type { PipelineConfig, PipelineStepConfig } from "../../types/settings";
import type { VerifyConfig } from "../agent/verify";
import type { ReviewPriority } from "../../types/auto-review";
import { getStep, listSteps, registerStep } from "./pipeline-registry";
import type { PipelineStep, StepDefinition } from "./pipeline-registry";

export type ResolvedPipelineStep =
  | { use: "commit" | "finalize" }
  | { use: "auto-review"; config: { maxIterations?: number; minSeverity?: ReviewPriority } }
  | { use: "verify"; config: VerifyConfig }
  | { use: "plugin"; step: PipelineStep };

export const DEFAULT_PIPELINE: readonly PipelineStepConfig[] = [
  { use: "implement" },
  { use: "commit" },
  { use: "auto-review" },
  { use: "finalize" },
];

/** Load step definitions from project files or installed packages. */
export async function loadPipelinePlugins(
  plugins: string[] | undefined,
  projectRoot: string,
): Promise<void> {
  if (
    plugins !== undefined &&
    (!Array.isArray(plugins) || plugins.some((item) => typeof item !== "string" || !item.trim()))
  ) {
    throw new Error("pipeline.plugins must be an array of nonempty module paths or package names");
  }
  for (const entry of plugins ?? []) {
    let module: { default?: unknown };
    try {
      const specifier =
        entry.startsWith(".") || isAbsolute(entry)
          ? resolve(projectRoot, entry)
          : Bun.resolveSync(entry, projectRoot);
      module = await import(pathToFileURL(specifier).href);
    } catch (error) {
      throw new Error(`Failed to load pipeline plugin '${entry}': ${(error as Error).message}`);
    }
    const definition = module.default as StepDefinition | undefined;
    if (!definition || typeof definition !== "object") {
      throw new Error(`Pipeline plugin '${entry}' must default-export a step definition`);
    }
    registerStep(definition);
  }
}

function verifyOptions(entry: PipelineStepConfig): VerifyConfig {
  const { use: _use, ...options } = entry;
  if (options.prompt !== undefined && typeof options.prompt !== "string") {
    throw new Error("verify.prompt must be a string");
  }
  if (
    options.onFail !== undefined &&
    !["loopback", "halt", "warn"].includes(options.onFail as string)
  ) {
    throw new Error("verify.onFail must be loopback, halt, or warn");
  }
  if (
    options.minSeverity !== undefined &&
    !["critical", "high", "medium", "low", "info"].includes(options.minSeverity as string)
  ) {
    throw new Error("verify.minSeverity must be a review priority");
  }
  if (
    options.maxIterations !== undefined &&
    (!Number.isSafeInteger(options.maxIterations) || (options.maxIterations as number) < 1)
  ) {
    throw new Error("verify.maxIterations must be a positive integer");
  }
  return options as VerifyConfig;
}

function resolveDeliveryEntry(entry: PipelineStepConfig, committed: boolean): ResolvedPipelineStep {
  const name = entry.use;
  if (name === "verify" || name === "auto-review" || name === "finalize") {
    if (!committed) throw new Error(`${name} must follow commit`);
    if (name === "verify") return { use: "verify", config: verifyOptions(entry) };
    if (name === "auto-review") {
      const { maxIterations, minSeverity } = entry;
      if (
        maxIterations !== undefined &&
        (!Number.isSafeInteger(maxIterations) || (maxIterations as number) < 1)
      ) {
        throw new Error("auto-review.maxIterations must be a positive integer");
      }
      if (
        minSeverity !== undefined &&
        !["critical", "high", "medium", "low", "info"].includes(minSeverity as string)
      ) {
        throw new Error("auto-review.minSeverity must be a review priority");
      }
      return {
        use: "auto-review",
        config: {
          maxIterations: maxIterations as number | undefined,
          minSeverity: minSeverity as ReviewPriority | undefined,
        },
      };
    }
    return { use: "finalize" };
  }
  const definition = getStep(name);
  if (!definition) {
    const available = [
      "clarity",
      "implement",
      "commit",
      "verify",
      "auto-review",
      "finalize",
      ...listSteps().map((step) => step.name),
    ].join(", ");
    throw new Error(`Unknown pipeline step '${name}'. Available steps: ${available}`);
  }
  const { use: _use, ...options } = entry;
  const step = definition.create(options);
  if (!step || typeof step.run !== "function" || step.name !== definition.name) {
    throw new Error(`Pipeline plugin step '${name}' returned an invalid step`);
  }
  return { use: "plugin", step };
}

/** Resolve and validate the delivery portion of a task's configured pipeline. */
export async function resolvePipelineSteps(
  config: PipelineConfig | undefined,
  projectRoot: string,
): Promise<ResolvedPipelineStep[]> {
  await loadPipelinePlugins(config?.plugins, projectRoot);
  const entries = config?.steps ?? DEFAULT_PIPELINE;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("pipeline.steps must be a nonempty array");
  }
  const delivery: ResolvedPipelineStep[] = [];
  let implemented = false;
  let committed = false;
  let finalized = false;
  let claritySeen = false;
  const usedPlugins = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry.use !== "string" || !entry.use.trim()) {
      throw new Error(`Invalid pipeline step at index ${index}: expected { use: string }`);
    }
    const name = entry.use;
    if (name === "clarity") {
      if (implemented || claritySeen || index !== 0) {
        throw new Error("clarity may appear once, before implement");
      }
      claritySeen = true; // Existing preamble runs clarity before the agent pipeline.
      continue;
    }
    if (name === "implement") {
      if (implemented || delivery.length > 0) {
        throw new Error("implement must appear once before delivery steps");
      }
      implemented = true;
      continue;
    }
    if (!implemented) throw new Error(`Pipeline step '${name}' must follow implement`);
    if (finalized) throw new Error(`Pipeline step '${name}' cannot follow finalize`);
    if (name === "commit") {
      if (committed) throw new Error("commit may appear only once");
      committed = true;
      delivery.push({ use: "commit" });
      continue;
    }
    const resolved = resolveDeliveryEntry(entry, committed);
    if (resolved.use === "plugin") {
      if (usedPlugins.has(resolved.step.name)) {
        throw new Error(`Pipeline plugin step '${resolved.step.name}' appears more than once`);
      }
      usedPlugins.add(resolved.step.name);
    }
    delivery.push(resolved);
    if (name === "finalize") finalized = true;
  }
  if (!implemented || !committed || !finalized) {
    throw new Error("pipeline.steps must include implement, commit, and finalize in that order");
  }
  return delivery;
}
