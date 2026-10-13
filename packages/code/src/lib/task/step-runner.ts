/** A phase of a task run. Steps share the same prepared task context. */
export interface TaskStep<Context> {
  name: string;
  run(context: Context): Promise<TaskStepResult | void>;
}

export type TaskStepResult =
  | { kind: "continue" }
  | { kind: "halt"; reason: string }
  | { kind: "repeat"; from: string; maxRepeats: number };

export type TaskStepsResult =
  | { kind: "completed" }
  | { kind: "halted"; step: string; reason: string };

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
  let index = 0;
  while (index < steps.length) {
    const step = steps[index]!;
    const result = await step.run(context);
    if (!result || result.kind === "continue") {
      index++;
      continue;
    }

    if (result.kind === "halt") {
      return { kind: "halted", step: step.name, reason: result.reason };
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
    index = targetIndex;
  }

  return { kind: "completed" };
}
