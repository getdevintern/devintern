import { beginRunStep } from "../state/run-recorder";

import type { ReviewFeedback } from "../../types/auto-review";

/** A phase of a task run. Steps share the same prepared task context. */
export interface TaskStep<Context> {
  name: string;
  run(context: Context): Promise<TaskStepResult | void>;
}

export type TaskStepResult = (
  | { kind: "continue" }
  | { kind: "warn"; reason: string }
  | {
      kind: "halt";
      reason: string;
      /**
       * `incomplete`: the work stopped short and needs a human.
       * `stop`: a deliberate stop that is not a success (push/review failed).
       * `noop`: nothing needed doing; the run completed successfully.
       */
      haltKind?: "incomplete" | "stop" | "noop";
    }
  | { kind: "repeat"; from: string; maxRepeats: number; reason?: string; feedback?: ReviewFeedback }
) & { data?: Record<string, unknown> };

export interface TaskStepRecord {
  step: string;
  result: TaskStepResult;
}

export type TaskStepsResult =
  | { kind: "completed" }
  | {
      kind: "halted";
      step: string;
      reason: string;
      haltKind?: "incomplete" | "stop" | "noop";
    };

/**
 * Execute task steps in order. A step may halt or repeat an earlier phase;
 * repeats must declare their own bound so a failed verification cannot loop
 * indefinitely. Ordinary errors propagate to the task's existing failure
 * handler, including account-wide usage limits.
 */
export async function runTaskSteps<Context>(
  steps: readonly TaskStep<Context>[],
  context: Context,
): Promise<TaskStepsResult> {
  const indexByName = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (!step.name || indexByName.has(step.name)) {
      throw new Error(`Task step name must be unique and nonempty: '${step.name}'`);
    }
    indexByName.set(step.name, index);
  }

  const repeatCounts = new Map<number, number>();
  const retryCounts = new Map<number, number>();
  const shared = context as {
    results?: TaskStepRecord[];
    warnings?: string[];
    loopbackFeedback?: ReviewFeedback;
    loopbackReason?: string;
    artifacts?: { beginStep?(step: string, iteration: number): void };
  };
  const executions = new Map<string, number>();
  let index = 0;
  while (index < steps.length) {
    const step = steps[index]!;
    const execution = (executions.get(step.name) ?? 0) + 1;
    executions.set(step.name, execution);
    shared.artifacts?.beginStep?.(step.name, execution);
    let result: TaskStepResult | void;
    const completeStep = beginRunStep(step.name);
    try {
      result = await step.run(context);
    } catch (error) {
      // A plugin can import StepExecutionError through a separately loaded
      // public entrypoint, so identify it by name across module copies.
      if (error instanceof Error && error.name === "StepExecutionError") {
        const retries = (retryCounts.get(index) ?? 0) + 1;
        retryCounts.set(index, retries);
        if (retries <= 1) continue;
        const halt: TaskStepResult = { kind: "halt", reason: error.message };
        shared.results?.push({ step: step.name, result: halt });
        return { kind: "halted", step: step.name, reason: error.message };
      }
      throw error;
    } finally {
      completeStep();
    }
    shared.results?.push({ step: step.name, result: result ?? { kind: "continue" } });
    if (!result || result.kind === "continue") {
      index++;
      continue;
    }

    if (result.kind === "warn") {
      console.warn(`⚠️  ${step.name}: ${result.reason}`);
      shared.warnings?.push(`${step.name}: ${result.reason}`);
      index++;
      continue;
    }

    if (result.kind === "halt") {
      return {
        kind: "halted",
        step: step.name,
        reason: result.reason,
        ...(result.haltKind ? { haltKind: result.haltKind } : {}),
      };
    }

    const targetIndex = indexByName.get(result.from);
    if (targetIndex === undefined || targetIndex >= index) {
      throw new Error(
        `Task step '${step.name}' cannot repeat unknown or later step '${result.from}'`,
      );
    }
    if (!Number.isSafeInteger(result.maxRepeats) || result.maxRepeats < 1) {
      throw new Error(`Task step '${step.name}' needs a positive maxRepeats bound`);
    }

    const repeats = (repeatCounts.get(index) ?? 0) + 1;
    if (repeats > result.maxRepeats) {
      return {
        kind: "halted",
        step: step.name,
        reason: `Task step '${step.name}' exceeded its repeat limit (${result.maxRepeats})`,
      };
    }
    repeatCounts.set(index, repeats);
    shared.loopbackFeedback = result.feedback;
    shared.loopbackReason = result.reason;
    index = targetIndex;
  }

  return { kind: "completed" };
}
