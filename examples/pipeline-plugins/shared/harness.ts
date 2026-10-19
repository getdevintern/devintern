/**
 * Test harness for the pipeline-plugin examples.
 *
 * It drives a plugin's `StepDefinition` through the real public
 * {@link runTaskSteps} step runner from `@getdevintern/code/pipeline` against a
 * deterministic {@link PipelineContext}. That means success, warn, halt, repeat,
 * and `StepExecutionError` retry behavior are the same code paths the installed
 * CLI uses — the examples are not asserting against a hand-rolled imitation.
 *
 * This file is test scaffolding only. A plugin copied into a project does not
 * depend on it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunArtifactRegistry } from "../../../packages/code/src/lib/artifacts/registry";
import { runTaskSteps } from "@getdevintern/code/pipeline";
import type {
  PipelineContext,
  ReviewFeedback,
  ReviewFeedbackItem,
  ReviewPriority,
  StepDefinition,
  TaskStep,
  TaskStepsResult,
} from "@getdevintern/code/pipeline";

/** Priority ordering mirrored from the installed auto-review implementation. */
const PRIORITY_WEIGHTS: Record<ReviewPriority, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

/** Produces agent stdout for a prompt; `call` is 1-based and increments per invocation. */
export type AgentResponder = (prompt: string, call: number) => string | Promise<string>;

export interface TestContextOptions {
  /** Repository worktree the step runs in. */
  workingDir: string;
  /** Artifact directory; defaults to `workingDir`. */
  outputDir?: string;
  taskKey?: string;
  taskSummary?: string;
  taskContent?: string;
  prTargetBranch?: string;
  committed?: boolean;
  enableGit?: boolean;
  createPr?: boolean;
  autoReview?: boolean;
  /** Unified diff returned by `context.getDiff()`. */
  diff?: string;
  /** Agent stdout: a fixed string, a per-call sequence, or a responder function. */
  agentOutput?: string | string[] | AgentResponder;
}

/** A {@link PipelineContext} whose mutable result/warning arrays are guaranteed present. */
export interface TestContext extends PipelineContext {
  results: NonNullable<PipelineContext["results"]>;
  warnings: NonNullable<PipelineContext["warnings"]>;
}

function responderFor(output: TestContextOptions["agentOutput"]): AgentResponder {
  if (typeof output === "function") return output;
  if (Array.isArray(output)) {
    return (_prompt, call) => output[Math.min(call - 1, output.length - 1)] ?? "";
  }
  return () => output ?? "";
}

/** Parse the first JSON object from agent output, mirroring the runtime helper. */
export function parseFeedback(output: string): ReviewFeedback {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new Error("agent output did not contain a JSON verdict");
  }
  return JSON.parse(output.slice(start, end + 1)) as ReviewFeedback;
}

/** Build a deterministic {@link PipelineContext} for exercising a plugin step. */
export function createTestContext(options: TestContextOptions): TestContext {
  const respond = responderFor(options.agentOutput);
  let calls = 0;
  return {
    artifacts: new RunArtifactRegistry(
      options.workingDir,
      options.outputDir ?? options.workingDir,
      join(options.workingDir, "artifacts-test.db"),
    ),
    taskKey: options.taskKey ?? "DEMO-1",
    taskSummary: options.taskSummary ?? "Example task",
    projectSettings: null,
    taskContent: options.taskContent ?? "Implement the example change.",
    taskFile: join(options.workingDir, "task-details.md"),
    workingDir: options.workingDir,
    outputDir: options.outputDir ?? options.workingDir,
    output: "Implementation output",
    committed: options.committed ?? true,
    prTargetBranch: options.prTargetBranch ?? "main",
    enableGit: options.enableGit ?? true,
    createPr: options.createPr ?? true,
    allowNoChanges: false,
    skipComments: false,
    autoReview: options.autoReview ?? false,
    autoReviewIterations: 2,
    maxTurns: 500,
    warnings: [],
    results: [],
    runAgentPrompt: async (prompt) => respond(prompt, ++calls),
    getDiff: () => options.diff ?? "",
    parseReviewFeedback: (output) => parseFeedback(output),
    filterByPriority: (items: ReviewFeedbackItem[], min: ReviewPriority) =>
      items.filter((item) => PRIORITY_WEIGHTS[item.priority] >= PRIORITY_WEIGHTS[min]),
  };
}

export interface RunDefinitionOptions {
  /** Steps to run before the plugin, used to observe `repeat` targets. */
  before?: TaskStep<PipelineContext>[];
  /** Steps to run after the plugin, used to inspect `context.results`. */
  after?: TaskStep<PipelineContext>[];
  /** Options passed to `definition.create(config)`. */
  config?: Record<string, unknown>;
}

/** Create the plugin step and run it through the public step runner. */
export async function runDefinition(
  definition: StepDefinition,
  context: PipelineContext,
  options: RunDefinitionOptions = {},
): Promise<TaskStepsResult> {
  const step = definition.create(options.config ?? {});
  const steps: TaskStep<PipelineContext>[] = [
    ...(options.before ?? []),
    step,
    ...(options.after ?? []),
  ];
  return runTaskSteps(steps, context);
}

/** Create a disposable temp directory that tests clean up in `afterEach`. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove a temp directory created by {@link makeTempDir}. */
export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
