import { captureError } from "@devintern/utils";
import type { AgentHarness } from "@devintern/agent-harness";
import { runContext } from "../cli/context";
import { PRManager } from "../code-host";
import { loadProjectSettings } from "../config/project-settings";
import { applyActionedTransition } from "../task/actioned-transition";
import { recordRunPr } from "../state/run-recorder";
import { parseGitHubPrUrl, recordAgentPrFromUrl } from "../state/worker-state";
import type { TaskTrackerClient } from "../trackers/client";
import { Utils } from "../utils";
import { runAgentHarnessToFixGitHook } from "./git-hook-fixer";
import { logHookErrorToFile } from "./plan";

export interface FinalizeContext {
  taskFile: string;
  taskContent: string;
  stdoutOutput: string;
  harness: AgentHarness;
  executablePath: string;
  maxTurns: number;
  taskKey?: string;
  taskSummary?: string;
  enableGit: boolean;
  task?: any;
  createPr: boolean;
  prTargetBranch: string;
  tracker?: TaskTrackerClient;
  skipComments: boolean;
  hookRetries: number;
  gitAuthor?: { name: string; email: string };
  autoReview: boolean;
  autoReviewIterations: number;
  isPlanRetry: boolean;
  prTargetBranchExplicit: boolean;
  requestedPrTargetBranch?: string;
  projectSettings: ReturnType<typeof loadProjectSettings>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function createGitHelpers(ctx: FinalizeContext) {
  const {
    harness,
    executablePath,
    maxTurns,
    taskKey,
    task,
    tracker,
    skipComments,
    hookRetries,
    prTargetBranch,
    prTargetBranchExplicit,
    requestedPrTargetBranch,
    projectSettings,
  } = ctx;
  const validatePrePushHook = async (phase: string) => {
    let attempt = 0;
    while (attempt <= hookRetries) {
      attempt++;
      const hookResult = await Utils.runPrePushHookLocally({
        verbose: runContext.options.verbose,
      });
      if (hookResult.success) {
        if (attempt === 1) {
          console.log(`✅ ${hookResult.message}`);
        } else {
          console.log(`✅ Pre-push hook passed after ${attempt} attempt(s)`);
        }
        return { success: true, result: hookResult };
      }
      if (hookResult.hookError && attempt <= hookRetries) {
        console.log(
          `\n⚠️  Pre-push hook failed during ${phase} (attempt ${attempt}/${hookRetries + 1})`,
        );
        const fixed = await runAgentHarnessToFixGitHook("push", harness, executablePath, maxTurns);
        logHookErrorToFile(
          taskKey ?? "unknown",
          "push-local-validation",
          attempt,
          hookResult.hookError,
          fixed,
        );
        if (fixed) {
          console.log(
            `\n🔄 Retrying local hook validation after ${harness.displayName} fixed the issues...`,
          );
          continue;
        } else {
          console.log("\n❌ Could not fix pre-push hook errors automatically");
          return { success: false, result: hookResult };
        }
      } else {
        if (attempt > hookRetries) {
          console.log(`\n❌ Max retries (${hookRetries}) exceeded for pre-push hook fixes`);
        }
        console.log(`⚠️  ${hookResult.message}`);
        return { success: false, result: hookResult };
      }
    }
    return {
      success: false,
      result: { message: "Max retries exceeded" },
    };
  };

  const pushWithHookRetry = async () => {
    console.log("\n📤 Pushing branch to remote...");
    let attempt = 0;
    while (attempt <= hookRetries) {
      attempt++;
      const pushResult = await Utils.pushCurrentBranch({
        verbose: runContext.options.verbose,
      });
      if (pushResult.success) {
        console.log(`✅ ${pushResult.message}`);
        return { success: true, result: pushResult };
      }
      if (pushResult.hookError && attempt <= hookRetries) {
        console.log(
          `\n⚠️  Git pre-push hook failed during push (attempt ${attempt}/${hookRetries + 1})`,
        );
        const fixed = await runAgentHarnessToFixGitHook("push", harness, executablePath, maxTurns);
        logHookErrorToFile(taskKey ?? "unknown", "push", attempt, pushResult.hookError, fixed);
        if (fixed) {
          console.log(
            `\n🔄 Retrying push after ${harness.displayName} fixed and amended the commit...`,
          );
          continue;
        } else {
          console.log("\n❌ Could not fix git pre-push hook errors automatically");
          return { success: false, result: pushResult };
        }
      } else {
        if (attempt > hookRetries) {
          console.log(`\n❌ Max retries (${hookRetries}) exceeded for git hook fixes`);
        }
        console.log(`⚠️  ${pushResult.message}`);
        return { success: false, result: pushResult };
      }
    }
    return {
      success: false,
      result: { message: "Max retries exceeded" },
    };
  };

  const createPrAndTransition = async (implementationOutput: string, autoReviewRan = false) => {
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
      let effectivePrTargetBranch = prTargetBranch;
      if (
        !(await Utils.remoteBranchExists(prTargetBranch, {
          verbose: runContext.options.verbose,
        }))
      ) {
        const defaultBranch = await Utils.getMainBranchName();
        if (defaultBranch !== prTargetBranch) {
          console.log(
            `⚠️  Target branch '${prTargetBranch}' not found on remote, falling back to '${defaultBranch}'`,
          );
          effectivePrTargetBranch = defaultBranch;
        }
      }

      const prResult = await prManager.createPullRequest(
        task,
        branchForPr,
        effectivePrTargetBranch,
        implementationOutput,
        {
          targetBranchExplicit: prTargetBranchExplicit,
          requestedTargetBranch: requestedPrTargetBranch,
        },
      );

      if (prResult.success) {
        const changeLabel =
          prResult.changeRequest?.provider === "gitlab" ? "Merge request" : "Pull request";
        console.log(`✅ ${changeLabel} created: ${prResult.url}`);
        for (const warning of prResult.warnings ?? []) {
          console.warn(`⚠️  ${warning}`);
        }

        // Register the PR so worker review-polling watches it automatically.
        if (prResult.url) {
          recordAgentPrFromUrl(prResult.url, branchForPr, taskKey, prResult.changeRequest);
          const runChange = prResult.changeRequest
            ? {
                repo: prResult.changeRequest.projectPath,
                prNumber: prResult.changeRequest.number,
              }
            : parseGitHubPrUrl(prResult.url);
          recordRunPr({ ...runChange, url: prResult.url });
        }

        if (taskKey && tracker) {
          // Move the ticket to its actioned status (when configured) and record
          // a local actioned marker so the next sweep does not re-implement it.
          // Never allowed to fail the run that just created the PR.
          await applyActionedTransition({
            tracker,
            task,
            taskKey,
            skipComments,
            projectSettings,
          });
        } else if (skipComments) {
          console.log("\n⏭️  Skipping task tracker status transition (--skip-comments)");
        }

        if (autoReviewRan) {
          console.log("\n✅ Auto-review was completed before push (see summary file for details)");
        }
      } else {
        console.log(`⚠️  PR creation failed: ${prResult.message}`);
        // The run "succeeds" without a PR — a silent user-visible
        // degradation worth tracking. prResult.message can quote API
        // errors; captureError redacts token-like substrings.
        captureError(new Error(prResult.message || "PR creation failed"), {
          taskKey,
          stage: "create-pr",
        });
      }
    } catch (prError) {
      console.log(`⚠️  PR creation failed: ${(prError as Error).message}`);
      captureError(prError, { taskKey, stage: "create-pr" });
    }
  };
  // --- End shared helpers ---

  return { validatePrePushHook, pushWithHookRetry, createPrAndTransition };
}
