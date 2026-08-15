/**
 * The `clarity` step: opt-in pipeline wrapper around the feasibility
 * assessment (`runClarityCheck`).
 *
 * Note: the built-in preamble clarity check in `processSingleTask` runs
 * BEFORE branch creation and the In-Progress transition; this step runs at
 * its configured position in the pipeline (after those side effects). It is
 * not part of the default pipeline - add it via `pipeline.steps` when you
 * want a clarity gate inside a custom pipeline.
 */

import { runClarityCheck } from "../../clarity-check";
import { StepStatus } from "../types";
import type { PipelineStep, StepDefinition, StepResult, TaskContext } from "../types";

export class ClarityStep implements PipelineStep {
  readonly name = "clarity";

  async run(ctx: TaskContext): Promise<StepResult> {
    if (ctx.skipClarityCheck || !ctx.taskKey) {
      return { status: StepStatus.Continue, data: { skipped: true } };
    }

    try {
      const assessment = await runClarityCheck(
        ctx.taskFile,
        ctx.harness,
        ctx.executablePath,
        ctx.taskKey,
        ctx.tracker,
        ctx.skipComments,
      );

      if (assessment && !assessment.isImplementable) {
        return {
          status: StepStatus.Halt,
          haltKind: "stop",
          reason: `Task failed clarity assessment: ${assessment.summary}`,
        };
      }
      return { status: StepStatus.Continue };
    } catch (clarityError) {
      // Match the preamble behavior: a failed clarity check is a warning,
      // implementation proceeds.
      return {
        status: StepStatus.WarnContinue,
        reason: `Feasibility check failed, continuing with implementation: ${clarityError}`,
      };
    }
  }
}

export const clarityStepDefinition: StepDefinition = {
  name: "clarity",
  create: () => new ClarityStep(),
};
