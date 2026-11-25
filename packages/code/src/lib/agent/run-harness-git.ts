import { captureError, redactText } from "@devintern/utils";
import type { AgentHarness } from "@devintern/agent-harness";
import { isWorkerTaskProcess, runContext } from "../cli/context";
import { PRManager } from "../code-host";
import { isFinalPrDeliveryAttempt, MAX_PR_DELIVERY_ATTEMPTS } from "../task/actioned-without-pr";
import { loadProjectSettings } from "../config/project-settings";
import { applyActionedTransition } from "../task/actioned-transition";
import { recordRunPr, recordRunPrFailure } from "../state/run-recorder";
import { parseGitHubPrUrl, recordAgentPrFromUrl } from "../state/worker-state";
import type { TaskTrackerClient } from "../trackers/client";
import type { Task } from "../../types/task-tracker";
import { Utils } from "../utils";
import { runAgentHarnessToFixGitHook } from "./git-hook-fixer";
import { logHookErrorToFile } from "./plan";
import type { VerifyConfig } from "./verify";
import type { ResolvedPipelineStep } from "../task/pipeline-config";

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
  /** Branch successfully inherited from a prior attempt. */
  resumeBranch?: string;
  task?: Task;
  createPr: boolean;
  /** Treat a run that makes no repository changes as a successful no-op. */
  allowNoChanges: boolean;
  prTargetBranch: string;
  tracker?: TaskTrackerClient;
  skipComments: boolean;
  hookRetries: number;
  gitAuthor?: { name: string; email: string };
  autoReview: boolean;
  autoReviewIterations: number;
  isPlanRetry: boolean;
  /**
   * `HEAD` captured before the implementation agent started. When it differs
   * after the run, the agent committed its own work, so a clean tree means
   * "nothing left for the pipeline to commit", not "the agent only planned".
   */
  headBeforeRun?: string;
  prTargetBranchExplicit: boolean;
  requestedPrTargetBranch?: string;
  verify?: VerifyConfig;
  pipelineSteps?: ResolvedPipelineStep[];
  /** Exposed to plugins as `PipelineContext.pipelineDir`; `null` for the built-in default. */
  pipelineDir?: string | null;
  artifactPolicy?: import("../artifacts/types").ArtifactPolicy;
  artifactUploader?: import("../artifacts/upload").LoadedArtifactUploader;
  runRepair?: (
    prompt: string,
  ) => Promise<{ kind: "complete"; stdout: string } | { kind: "halted" }>;
  projectSettings: ReturnType<typeof loadProjectSettings>;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Read the current `HEAD` commit.
 *
 * @returns `HEAD` SHA as reported by git, or `undefined` when the working
 * directory is not a git repository (or git is unavailable)
 */
export async function readHeadCommit(): Promise<string | undefined> {
  const result = await Utils.executeGitCommand(["rev-parse", "HEAD"]);
  const head = result.output.trim();
  return result.success && head ? head : undefined;
}

/**
 * Whether the implementation agent advanced `HEAD` during this run.
 *
 * Agents sometimes commit their own work and leave a clean tree, which the
 * pipeline's follow-up commit reports as "No changes to commit". Comparing
 * `HEAD` against the value captured before the agent started tells that apart
 * from a plan-only run, which changes nothing.
 *
 * @param ctx - Delivery context carrying the pre-run `HEAD`
 */
export async function headAdvancedDuringRun(ctx: FinalizeContext): Promise<boolean> {
  if (!ctx.headBeforeRun) return false;
  const current = await readHeadCommit();
  return current !== undefined && current !== ctx.headBeforeRun;
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

  // A PR failure on a supported code host tells the tracker so a person can
  // see the branch is pushed without a PR. A retryable failure also flags the
  // run so the worker leaves the ticket unmarked and re-runs it (bounded by
  // MAX_PR_DELIVERY_ATTEMPTS); a permanent one (missing config, 4xx
  // validation) is left unflagged so the ticket is marked actioned. The
  // comment only promises worker re-runs inside a worker process; an
  // interactive CLI run gets neutral re-run guidance instead.
  const notePrCreationFailure = async (
    message: string,
    options: { branch?: string; permanent?: boolean } = {},
  ) => {
    // Always on the run record (permanent or not): positive evidence for the
    // dashboard that this run asked for a PR and did not get one (so its branch
    // is worth re-queueing), and a succeeded run without a PR must not read as
    // "nothing to deliver" to a dependent task's gate.
    recordRunPrFailure(message);
    if (runContext.activeTaskContext) {
      runContext.activeTaskContext.prDeliveryFailure = {
        message,
        permanent: options.permanent === true,
      };
      if (!options.permanent) runContext.activeTaskContext.prCreationFailure = message;
    }
    if (!(taskKey && tracker) || skipComments) return;
    const { branch } = options;
    try {
      await tracker.postComment(taskKey, {
        format: "markdown",
        body: [
          "⚠️ **Pull request could not be created**",
          "",
          `${branch ? `The branch \`${branch}\` was pushed, but the` : "The"} pull request failed: ${redactText(message)}`,
          "",
          !isWorkerTaskProcess()
            ? options.permanent
              ? "This needs a configuration or repository fix. Re-run with `--create-pr` after fixing the cause."
              : "Re-run with `--create-pr` after fixing the cause."
            : options.permanent
              ? "This needs a configuration or repository fix, so the worker will not run this ticket again until it changes."
              : isFinalPrDeliveryAttempt(taskKey)
                ? `This was the last of ${MAX_PR_DELIVERY_ATTEMPTS} attempts, so the worker will not re-run this ticket. Edit the ticket to retry.`
                : `The worker will re-run the whole ticket on its next poll (a new agent session), up to ${MAX_PR_DELIVERY_ATTEMPTS} attempts in total, then stop until the ticket changes.`,
        ].join("\n"),
      });
    } catch (error) {
      console.warn(`⚠️  Failed to post PR failure comment: ${(error as Error).message}`);
    }
  };

  const createPrAndTransition = async (
    implementationOutput: string,
    autoReviewRan = false,
    artifactComment?: string,
  ) => {
    console.log("\n🔀 Creating pull request...");
    try {
      if (!task) {
        console.log("⚠️  No task available; skipping pull request creation");
        return;
      }
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
          artifactComment,
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
        return prResult;
      } else {
        console.log(`⚠️  PR creation failed: ${prResult.message}`);
        // The pipeline records the run as failed (pushed, no PR).
        // prResult.message can quote API errors; captureError redacts
        // token-like substrings.
        captureError(new Error(prResult.message || "PR creation failed"), {
          taskKey,
          stage: "create-pr",
        });
        if (!prResult.unsupportedPlatform) {
          await notePrCreationFailure(prResult.message || "PR creation failed", {
            branch: branchForPr,
            permanent: prResult.permanent === true,
          });
        }
      }
    } catch (prError) {
      console.log(`⚠️  PR creation failed: ${(prError as Error).message}`);
      captureError(prError, { taskKey, stage: "create-pr" });
      await notePrCreationFailure((prError as Error).message || "PR creation failed");
    }
    return undefined;
  };
  // --- End shared helpers ---

  return { validatePrePushHook, pushWithHookRetry, createPrAndTransition };
}
