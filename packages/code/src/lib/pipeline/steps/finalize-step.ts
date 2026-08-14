/**
 * The `finalize` step: pre-push hook validation (when not already validated
 * by auto-review), push with hook retry, implementation-summary comment, PR
 * creation, and post-PR status transition. Wraps the existing helpers from
 * the old `runAgentHarness` close handler; behavior is unchanged.
 */

import { PRManager } from "../../pr-client";
import { getPrStatusForProject, resolveProjectKey } from "../../project-settings";
import { recordRunPr } from "../../run-recorder";
import type { TaskTrackerClient } from "../../task-tracker-client";
import { Utils } from "../../utils";
import { parseGitHubPrUrl, recordAgentPrFromUrl } from "../../worker-state";
import { pushWithHookRetry, validatePrePushHook } from "./hook-helpers";
import { StepStatus } from "../types";
import type { PipelineStep, StepDefinition, StepResult, TaskContext } from "../types";

/**
 * Post a successful implementation summary comment to the task tracker.
 */
async function postImplementationComment(
  tracker: TaskTrackerClient,
  taskKey: string,
  agentOutput: string,
  taskSummary?: string,
): Promise<void> {
  try {
    await tracker.postImplementationComment(taskKey, agentOutput, taskSummary);
    console.log(`✅ Implementation summary posted to ${taskKey}`);
  } catch (error) {
    throw new Error(`Failed to post implementation comment: ${error}`);
  }
}

/** Create the PR and transition the ticket to its post-PR status. */
async function createPrAndTransition(
  ctx: TaskContext,
  implementationOutput: string,
  autoReviewRan = false,
): Promise<void> {
  console.log("\n🔀 Creating pull request...");
  try {
    const prManager = new PRManager();
    const branchForPr = await Utils.getCurrentBranch();

    if (!branchForPr) {
      console.log("⚠️  Could not determine current branch for PR creation");
      return;
    }
    if (await Utils.isProtectedBranch(branchForPr)) {
      console.error(`\n❌ Cannot create PR from protected branch '${branchForPr}'`);
      console.error("   This indicates a bug - feature branch was not created properly.");
      return;
    }

    // Ensure the PR target branch actually exists on the remote. A wrong or
    // missing target (e.g. `--pr-target-branch main` on a `master` repo) makes
    // GitHub reject the PR with "Validation Failed", leaving a pushed branch
    // and no PR. Fall back to the repo's real default branch in that case.
    let effectivePrTargetBranch = ctx.prTargetBranch;
    if (!(await Utils.remoteBranchExists(ctx.prTargetBranch, { verbose: ctx.verbose }))) {
      const defaultBranch = await Utils.getMainBranchName();
      if (defaultBranch !== ctx.prTargetBranch) {
        console.log(
          `⚠️  Target branch '${ctx.prTargetBranch}' not found on remote, falling back to '${defaultBranch}'`,
        );
        effectivePrTargetBranch = defaultBranch;
      }
    }

    const prResult = await prManager.createPullRequest(
      ctx.task,
      branchForPr,
      effectivePrTargetBranch,
      implementationOutput,
    );

    if (prResult.success) {
      console.log(`✅ Pull request created: ${prResult.url}`);

      if (prResult.url) {
        recordAgentPrFromUrl(prResult.url, branchForPr, ctx.taskKey);
        recordRunPr({ ...parseGitHubPrUrl(prResult.url), url: prResult.url });
      }

      if (ctx.taskKey && ctx.tracker && !ctx.skipComments) {
        const projectKey = resolveProjectKey(ctx.taskKey, ctx.task);
        const prStatus = getPrStatusForProject(projectKey, ctx.projectSettings);
        if (prStatus && prStatus.trim()) {
          try {
            console.log("\n🔄 Transitioning JIRA status after PR creation...");
            await ctx.tracker.transitionStatus(ctx.taskKey, prStatus.trim());
          } catch (statusError) {
            console.warn(`⚠️  Failed to transition JIRA status: ${(statusError as Error).message}`);
            console.log("   PR was created successfully, but status transition failed");
          }
        }
      } else if (ctx.skipComments) {
        console.log("\n⏭️  Skipping task tracker status transition (--skip-comments)");
      }

      if (autoReviewRan) {
        console.log("\n✅ Auto-review was completed before push (see summary file for details)");
      }
    } else {
      console.log(`⚠️  PR creation failed: ${prResult.message}`);
    }
  } catch (prError) {
    console.log(`⚠️  PR creation failed: ${(prError as Error).message}`);
  }
}

export class FinalizeStep implements PipelineStep {
  readonly name = "finalize";

  async run(ctx: TaskContext): Promise<StepResult> {
    if (!(ctx.enableGit && ctx.taskKey && ctx.taskSummary)) {
      return { status: StepStatus.Continue, data: { skipped: true } };
    }
    if (!ctx.commitSucceeded) {
      // Commit step already reported the failure; nothing to push or PR.
      return { status: StepStatus.Continue, data: { skipped: true } };
    }

    const output = ctx.implementationOutput;

    if (ctx.createPr && ctx.task) {
      // Validate pre-push hook locally BEFORE pushing (unless the
      // auto-review step already validated in this run).
      if (!ctx.hookValidated) {
        console.log("\n🔍 Validating pre-push hook locally (before pushing)...");
        const initialHookValidation = await validatePrePushHook(ctx, "initial validation");

        if (!initialHookValidation.success) {
          console.log("   Cannot proceed without passing pre-push hook validation");
          return {
            status: StepStatus.Halt,
            haltKind: "stop",
            reason: "Pre-push hook validation failed",
          };
        }
        ctx.hookValidated = true;
      }

      const pushOutcome = await pushWithHookRetry(ctx);

      if (pushOutcome.success) {
        if (ctx.taskKey && ctx.tracker && output.trim() && !ctx.skipComments) {
          try {
            console.log("\n💬 Posting implementation summary to task tracker...");
            await postImplementationComment(ctx.tracker, ctx.taskKey, output, ctx.taskSummary);
          } catch (commentError) {
            console.warn(
              `⚠️  Failed to post implementation comment to task tracker: ${commentError}`,
            );
            console.log("   Push succeeded, but task tracker comment failed");
          }
        } else if (ctx.skipComments && ctx.taskKey) {
          console.log("\n⏭️  Skipping task tracker comment posting (--skip-comments)");
        }

        await createPrAndTransition(ctx, output, ctx.autoReviewRan);
      } else {
        console.log("   Cannot create PR without pushing branch to remote");
      }
    } else {
      // No PR requested, but commit succeeded - post to task tracker here
      if (ctx.taskKey && ctx.tracker && output.trim() && !ctx.skipComments) {
        try {
          console.log("\n💬 Posting implementation summary to task tracker...");
          await postImplementationComment(ctx.tracker, ctx.taskKey, output, ctx.taskSummary);
        } catch (commentError) {
          console.warn(
            `⚠️  Failed to post implementation comment to task tracker: ${commentError}`,
          );
          console.log("   Commit succeeded, but task tracker comment failed");
        }
      } else if (ctx.skipComments && ctx.taskKey) {
        console.log("\n⏭️  Skipping task tracker comment posting (--skip-comments)");
      }
    }

    return { status: StepStatus.Continue };
  }
}

export const finalizeStepDefinition: StepDefinition = {
  name: "finalize",
  create: () => new FinalizeStep(),
};
