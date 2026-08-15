/**
 * The `commit` step: commits implementation changes (with git-hook auto-fix
 * retries) right after `implement`, so later review/verify steps see the
 * changes in HEAD when diffing against the base branch.
 *
 * Also detects plan-only agent behavior ("No changes to commit" plus plan
 * language in the output) and loops back to `implement` once with a prompt
 * asking the agent to actually execute its plan.
 */

import { handleCommitWithRetry } from "./hook-helpers";
import { createPlanImplementationPrompt, detectPlanOnlyBehavior } from "./plan-detection";
import { StepStatus } from "../types";
import type { PipelineStep, StepDefinition, StepResult, TaskContext } from "../types";

export class CommitStep implements PipelineStep {
  readonly name = "commit";

  async run(ctx: TaskContext): Promise<StepResult> {
    if (!(ctx.enableGit && ctx.taskKey && ctx.taskSummary)) {
      ctx.commitSucceeded = false;
      return { status: StepStatus.Continue, data: { skipped: true } };
    }

    console.log("\n📝 Committing changes...");

    let outcome: Awaited<ReturnType<typeof handleCommitWithRetry>>;
    try {
      outcome = await handleCommitWithRetry(ctx, ctx.taskKey, ctx.taskSummary);
    } catch (commitError) {
      console.log(`⚠️  Failed to commit changes: ${(commitError as Error).message}`);
      console.log(
        'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
      );
      ctx.commitSucceeded = false;
      return {
        status: StepStatus.WarnContinue,
        reason: `Commit failed: ${(commitError as Error).message}`,
      };
    }

    if (outcome.success) {
      ctx.commitSucceeded = true;
      return { status: StepStatus.Continue };
    }

    // Check if this is a "plan only" scenario - Agent created a plan but didn't implement
    const noChangesToCommit = outcome.result.message === "No changes to commit";
    const planPath = noChangesToCommit ? detectPlanOnlyBehavior(ctx.implementationOutput) : null;

    if (noChangesToCommit && planPath && !ctx.isPlanRetry) {
      // Agent only created a plan - run it again with instructions to implement
      console.log(
        "\n🔄 Agent created a plan but didn't implement it. Re-running to execute the plan...",
      );

      if (planPath !== "PLAN_DETECTED_NO_PATH") {
        console.log(`   Plan file detected: ${planPath}`);
      }

      ctx.isPlanRetry = true;
      ctx.pendingPromptOverride = createPlanImplementationPrompt(planPath, ctx.taskContent);
      return {
        status: StepStatus.Loopback,
        loopbackTo: "implement",
        maxLoopbacks: 1,
        reason: "Agent produced a plan without implementing it",
      };
    }

    console.log(
      'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
    );
    ctx.commitSucceeded = false;
    return {
      status: StepStatus.WarnContinue,
      reason: `Commit failed: ${outcome.result.message}`,
    };
  }
}

export const commitStepDefinition: StepDefinition = {
  name: "commit",
  create: () => new CommitStep(),
};
