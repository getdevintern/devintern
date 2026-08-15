/**
 * Pipeline runner: executes steps in order, owning retry counting (for
 * execution errors), loopback bounding (for verdict failures), and Halt
 * handling. Limits live in one place - steps stay simple.
 */

import { UsageLimitError } from "../errors";
import { StepExecutionError, StepStatus } from "./types";
import type { PipelineStep, StepResult, TaskContext } from "./types";

export interface PipelineOptions {
  /**
   * Called when a step halts with `haltKind: "incomplete"` (or a loopback /
   * retry budget is exhausted). Typically posts the incomplete-implementation
   * comment and reverts the ticket to To Do.
   */
  onHalt?: (ctx: TaskContext, result: StepResult) => Promise<void>;
  /** Retries per step after the first {@link StepExecutionError} (default 1). */
  maxStepRetries?: number;
  /** Loopback bound per step when the step result doesn't specify one (default 3). */
  defaultMaxLoopbacks?: number;
}

export class Pipeline {
  constructor(
    private readonly steps: PipelineStep[],
    private readonly options: PipelineOptions = {},
  ) {}

  /**
   * Run all steps against the shared context.
   *
   * Throws when a step throws anything other than {@link StepExecutionError}
   * (e.g. {@link UsageLimitError}, which must abort a batch, or agent
   * timeouts / non-zero exits). Halts resolve normally so batch processing
   * can continue with the next task.
   */
  async run(ctx: TaskContext): Promise<void> {
    const maxRetries = this.options.maxStepRetries ?? 1;
    const defaultMaxLoopbacks = this.options.defaultMaxLoopbacks ?? 3;
    const retries = new Map<number, number>();
    const loopbacks = new Map<number, number>();

    let i = 0;
    while (i < this.steps.length) {
      const step = this.steps[i];
      let result: StepResult;

      try {
        result = await step.run(ctx);
      } catch (error) {
        if (error instanceof UsageLimitError) {
          // Account-global limit: never retry, abort the whole batch.
          throw error;
        }
        if (error instanceof StepExecutionError) {
          const attempts = (retries.get(i) ?? 0) + 1;
          retries.set(i, attempts);
          if (attempts <= maxRetries) {
            console.log(
              `\n🔁 Step '${step.name}' failed (${error.message}); retrying (attempt ${attempts + 1})...`,
            );
            continue;
          }
          result = {
            status: StepStatus.Halt,
            haltKind: "incomplete",
            reason: `Step '${step.name}' failed after ${attempts + 1} attempt(s): ${error.message}`,
          };
        } else {
          throw error;
        }
      }

      ctx.results.push(result);

      switch (result.status) {
        case StepStatus.Continue:
          i++;
          break;

        case StepStatus.WarnContinue:
          if (result.reason) {
            ctx.warnings.push(`${step.name}: ${result.reason}`);
          }
          i++;
          break;

        case StepStatus.Loopback: {
          const targetName = result.loopbackTo ?? "implement";
          const targetIndex = this.steps.findIndex((s) => s.name === targetName);
          if (targetIndex === -1) {
            await this.halt(ctx, {
              status: StepStatus.Halt,
              haltKind: "incomplete",
              reason: `Step '${step.name}' requested loopback to unknown step '${targetName}'`,
            });
            return;
          }
          const count = (loopbacks.get(i) ?? 0) + 1;
          const bound = result.maxLoopbacks ?? defaultMaxLoopbacks;
          if (count > bound) {
            console.log(
              `\n🛑 Step '${step.name}' exhausted its loopback budget (${bound} iteration(s))`,
            );
            await this.halt(ctx, {
              status: StepStatus.Halt,
              haltKind: "incomplete",
              reason:
                result.reason ??
                `Step '${step.name}' still failing after ${bound} loopback iteration(s)`,
            });
            return;
          }
          loopbacks.set(i, count);
          if (result.loopbackFeedback) {
            ctx.loopbackFeedback = result.loopbackFeedback;
          }
          console.log(
            `\n🔄 Step '${step.name}' looping back to '${targetName}' (iteration ${count}/${bound})...`,
          );
          i = targetIndex;
          break;
        }

        case StepStatus.Halt:
          await this.halt(ctx, result);
          return;
      }
    }
  }

  private async halt(ctx: TaskContext, result: StepResult): Promise<void> {
    if ((result.haltKind ?? "incomplete") === "incomplete" && this.options.onHalt) {
      await this.options.onHalt(ctx, result);
    }
  }
}
