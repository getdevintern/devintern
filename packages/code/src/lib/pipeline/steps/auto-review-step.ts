/**
 * The `auto-review` step: iterative self-review of the committed changes
 * before pushing (wraps `runAutoReviewLoop` with `skipPush: true`).
 *
 * Also performs the pre-push hook validations exactly where today's flow
 * does: an initial validation before the review loop and a re-validation
 * after it (review fixes may have broken hooks).
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { runAutoReviewLoop } from "../../auto-review-loop";
import { recordRunStage } from "../../run-recorder";
import { Utils } from "../../utils";
import { validatePrePushHook } from "./hook-helpers";
import type { ReviewPriority } from "../../../types/auto-review";
import { StepStatus } from "../types";
import type { PipelineStep, StepDefinition, StepResult, TaskContext } from "../types";

export interface AutoReviewStepConfig {
  /** Max review iterations (defaults to `ctx.autoReviewIterations`). */
  maxIterations?: number;
  /** Minimum priority to address (default "medium"). */
  minSeverity?: ReviewPriority;
}

export class AutoReviewStep implements PipelineStep {
  readonly name = "auto-review";

  constructor(private readonly config: AutoReviewStepConfig = {}) {}

  async run(ctx: TaskContext): Promise<StepResult> {
    if (!ctx.autoReview) {
      return { status: StepStatus.Continue, data: { skipped: true } };
    }
    // Auto-review only runs on committed changes headed for a PR (matches
    // the previous inline flow, which lived inside the create-PR branch).
    if (!(ctx.enableGit && ctx.taskKey && ctx.taskSummary && ctx.commitSucceeded)) {
      return { status: StepStatus.Continue, data: { skipped: true } };
    }
    if (!(ctx.createPr && ctx.task)) {
      return { status: StepStatus.Continue, data: { skipped: true } };
    }

    // Step 1: Validate pre-push hook locally BEFORE any push
    console.log("\n🔍 Validating pre-push hook locally (before pushing)...");
    const initialHookValidation = await validatePrePushHook(ctx, "initial validation");

    if (!initialHookValidation.success) {
      console.log("   Cannot proceed without passing pre-push hook validation");
      return {
        status: StepStatus.Halt,
        haltKind: "stop",
        reason: "Pre-push hook validation failed before auto-review",
      };
    }
    ctx.hookValidated = true;

    const currentBranch = await Utils.getCurrentBranch();
    if (!currentBranch) {
      return { status: StepStatus.Continue, data: { skipped: true } };
    }

    try {
      console.log("\n🔄 Running auto-review loop (without pushing)...");

      const autoReviewResult = await runAutoReviewLoop({
        repository: "local/repo",
        prNumber: 0,
        prBranch: currentBranch,
        baseBranch: ctx.prTargetBranch,
        harness: ctx.harness,
        executablePath: ctx.executablePath,
        maxIterations: this.config.maxIterations ?? ctx.autoReviewIterations,
        minPriority: this.config.minSeverity ?? "medium",
        workingDir: ctx.workingDir,
        outputDir: ctx.taskDir,
        skipPush: true,
      });

      const summaryPath = join(ctx.taskDir, "auto-review-summary.json");
      writeFileSync(summaryPath, JSON.stringify(autoReviewResult, null, 2));
      console.log(`\n📄 Auto-review summary saved to: ${summaryPath}`);

      recordRunStage("auto_review", {
        status: autoReviewResult.success ? "succeeded" : "failed",
        summary: `${autoReviewResult.iterations} iteration(s), ${
          autoReviewResult.success ? "approved" : "incomplete"
        }`,
        detail: {
          iterations: autoReviewResult.iterations,
          success: autoReviewResult.success,
          finalFeedback: autoReviewResult.finalFeedback,
        },
      });

      ctx.autoReviewRan = true;

      // Step 2: After auto-review, validate hooks again
      console.log("\n🔍 Re-validating pre-push hook after auto-review improvements...");
      const postAutoReviewValidation = await validatePrePushHook(
        ctx,
        "post auto-review validation",
      );

      if (!postAutoReviewValidation.success) {
        console.log("   Cannot proceed - auto-review changes failed pre-push hook validation");
        return {
          status: StepStatus.Halt,
          haltKind: "stop",
          reason: "Auto-review changes failed pre-push hook validation",
        };
      }
    } catch (autoReviewError) {
      recordRunStage("auto_review", {
        status: "failed",
        summary: `loop errored: ${(autoReviewError as Error).message}`,
      });
      console.warn(`\n⚠️  Auto-review loop failed: ${(autoReviewError as Error).message}`);
      console.log("   Continuing with push and PR creation...");
    }

    return { status: StepStatus.Continue };
  }
}

export const autoReviewStepDefinition: StepDefinition = {
  name: "auto-review",
  create: (config) => new AutoReviewStep(config as AutoReviewStepConfig),
};
