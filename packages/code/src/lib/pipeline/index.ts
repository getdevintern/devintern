/**
 * Public pipeline API for `@devintern/code` plugin authors, exposed via the
 * `@devintern/code/pipeline` subpath export.
 *
 * A plugin module default-exports a {@link StepDefinition} and is referenced
 * in `.devintern-code/settings.json`:
 *
 * ```json
 * {
 *   "pipeline": {
 *     "plugins": ["./.devintern-code/steps/my-step.ts"],
 *     "steps": [
 *       { "use": "implement" },
 *       { "use": "commit" },
 *       { "use": "my-step", "threshold": 0.9 },
 *       { "use": "finalize" }
 *     ]
 *   }
 * }
 * ```
 */

export {
  StepExecutionError,
  StepStatus,
  type HaltKind,
  type PipelineStep,
  type StepDefinition,
  type StepResult,
  type TaskContext,
} from "./types";
export { Pipeline, type PipelineOptions } from "./pipeline";
export { getStep, listSteps, registerStep } from "./registry";
export { DEFAULT_PIPELINE, loadPlugins, resolvePipelineSteps } from "./config";
export {
  buildLoopbackPrompt,
  ImplementStep,
  runImplementation,
  type ImplementationRunResult,
} from "./steps/implement-step";
export { VerifyStep, type VerifyStepConfig, type VerifyStepDeps } from "./steps/verify-step";

// Agent-invocation + verdict-parse primitives for custom agent-backed steps.
export {
  filterByPriority,
  getPRDiff,
  parseReviewFeedback,
  runAgentPrompt,
} from "../auto-review-loop";
export type { ReviewFeedback, ReviewFeedbackItem, ReviewPriority } from "../../types/auto-review";
export type { PipelineConfig, PipelineStepConfig } from "../../types/settings";
export { UsageLimitError } from "../errors";
