import { dirname, join } from "path";
import { writeFileSync } from "fs";
import {
  buildPromptArgs,
  resolveExecutablePathWithRetry,
  spawnAgent,
  UsageLimitError,
} from "@devintern/agent-harness";
import { captureError } from "@devintern/utils";
import { runContext } from "../cli/context";
import { resolveOutputDir } from "../config/output-dir";
import { runAutoReviewLoop } from "../review/auto-review-loop";
import { recordRunStage } from "../state/run-recorder";
import { postImplementationComment } from "../task/implementation-comment";
import { Utils } from "../utils";
import { isCommitAlreadyComplete, runAgentHarnessToFixGitHook } from "./git-hook-fixer";
import { resolveAgentEffort, resolveAgentModel } from "./model";
import { createPlanImplementationPrompt, detectPlanOnlyBehavior, logHookErrorToFile } from "./plan";
import { createGitHelpers } from "./run-harness-git";
import type { FinalizeContext } from "./run-harness-git";
import { getSandbox } from "./sandbox";

export function finalizeAgentRun(ctx: FinalizeContext): void {
  const {
    taskFile,
    taskContent,
    stdoutOutput,
    harness,
    executablePath,
    maxTurns,
    taskKey,
    taskSummary,
    enableGit,
    task,
    createPr,
    prTargetBranch,
    tracker,
    skipComments,
    hookRetries,
    gitAuthor,
    autoReview,
    autoReviewIterations,
    isPlanRetry,
    resolve,
    reject,
  } = ctx;
  const { validatePrePushHook, pushWithHookRetry, createPrAndTransition } = createGitHelpers(ctx);
  if (enableGit && taskKey && taskSummary) {
    console.log("\n📝 Committing changes...");

    // Try committing with retry logic for git hook failures
    const handleCommitWithRetry = async () => {
      let attempt = 0;

      while (attempt <= hookRetries) {
        attempt++;
        const commitResult = await Utils.commitChanges(taskKey, taskSummary, {
          verbose: runContext.options.verbose,
          author: gitAuthor,
        });

        if (commitResult.success) {
          console.log(`✅ ${commitResult.message}`);
          return { success: true, result: commitResult };
        }

        // Check if this is a git hook error that we can try to fix
        if (commitResult.hookError && attempt <= hookRetries) {
          console.log(`\n⚠️  Git hook failed (attempt ${attempt}/${hookRetries + 1})`);

          // Try to fix the hook error with agent
          const fixed = await runAgentHarnessToFixGitHook(
            "commit",
            harness,
            executablePath,
            maxTurns,
          );

          // Log the hook error to file
          logHookErrorToFile(taskKey, "commit", attempt, commitResult.hookError, fixed);

          if (fixed) {
            if (await isCommitAlreadyComplete()) {
              console.log("✅ Commit already completed during hook fix");
              return {
                success: true,
                result: {
                  message: `Successfully committed changes for ${taskKey} (via hook fix)`,
                },
              };
            }

            console.log("\n🔄 Retrying commit after Agent fixed the issues...");
            continue;
          } else {
            console.log("\n❌ Could not fix git hook errors automatically");
            return { success: false, result: commitResult };
          }
        } else {
          // Not a hook error or out of retries
          if (attempt > hookRetries) {
            console.log(`\n❌ Max retries (${hookRetries}) exceeded for git hook fixes`);
          }
          console.log(`⚠️  ${commitResult.message}`);
          return { success: false, result: commitResult };
        }
      }

      return {
        success: false,
        result: { message: "Max retries exceeded" },
      };
    };

    handleCommitWithRetry()
      // oxlint-disable-next-line complexity -- commit-retry continuation branches on conflict resolution and plan-only detection; remedy: replace the `.then` with `await handleCommitWithRetry()` returning a typed result.
      .then(async ({ success, result }) => {
        if (!success) {
          // Check if this is a "plan only" scenario - Agent created a plan but didn't implement
          const noChangesToCommit = result.message === "No changes to commit";
          const planPath = noChangesToCommit ? detectPlanOnlyBehavior(stdoutOutput) : null;

          if (noChangesToCommit && planPath && !isPlanRetry) {
            // Agent only created a plan - run it again with instructions to implement
            console.log(
              "\n🔄 Agent created a plan but didn't implement it. Re-running to execute the plan...",
            );

            if (planPath !== "PLAN_DETECTED_NO_PATH") {
              console.log(`   Plan file detected: ${planPath}`);
            }

            // Create a new prompt to implement the plan
            const implementationPrompt = createPlanImplementationPrompt(planPath, taskContent);

            // Spawn agent again with the implementation prompt. Re-resolve
            // the CLI path here (rather than reusing the first spawn's) — a
            // long agent run may straddle an auto-update, so wait out any
            // swap in progress before this second spawn.
            const retryArgs = harness.buildArgs({
              maxTurns,
              skipPermissions: true,
              workingDir: process.cwd(),
              model: resolveAgentModel(),
              effort: resolveAgentEffort(),
            });
            const retryResolvedPath = await resolveExecutablePathWithRetry(executablePath, {
              displayName: harness.displayName,
            });
            const { child: retryProcess, cleanup: retrySandboxCleanup } = await spawnAgent({
              resolvedPath: retryResolvedPath,
              args: [...retryArgs, ...buildPromptArgs(harness, implementationPrompt)],
              spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
              sandbox: await getSandbox(harness.name),
            });

            let retryStdoutOutput = "";
            let retryStderrOutput = "";

            if (retryProcess.stdout) {
              retryProcess.stdout.on("data", (data: Buffer) => {
                const output = data.toString();
                retryStdoutOutput += output;
                process.stdout.write(output);
              });
            }

            if (retryProcess.stderr) {
              retryProcess.stderr.on("data", (data: Buffer) => {
                const output = data.toString();
                retryStderrOutput += output;
                process.stderr.write(output);
              });
            }

            retryProcess.on("close", async (retryCode: number | null) => {
              retrySandboxCleanup().catch(() => {});
              console.log("\n" + "=".repeat(60));

              if (retryCode === 0) {
                console.log("✅ Plan implementation completed");

                // Save updated implementation summary
                if (taskKey && retryStdoutOutput.trim()) {
                  try {
                    const summaryFile = join(dirname(taskFile), "implementation-summary.md");
                    writeFileSync(
                      summaryFile,
                      `# Plan Implementation Output\n\n${retryStdoutOutput}`,
                      "utf8",
                    );
                    console.log(`\n💾 Updated implementation summary: ${summaryFile}`);
                  } catch (saveError) {
                    console.warn(`⚠️  Failed to save implementation summary: ${saveError}`);
                  }
                }

                // Try to commit the changes from plan implementation
                console.log("\n📝 Committing plan implementation changes...");
                const retryCommitResult = await Utils.commitChanges(taskKey, taskSummary, {
                  verbose: runContext.options.verbose,
                  author: gitAuthor,
                });

                if (retryCommitResult.success) {
                  console.log(`✅ ${retryCommitResult.message}`);

                  // Continue with PR creation if requested
                  if (createPr && task) {
                    // Validate pre-push hook locally BEFORE pushing
                    console.log("\n🔍 Validating pre-push hook locally (before pushing)...");
                    const planHookValidation = await validatePrePushHook(
                      "plan implementation validation",
                    );
                    if (!planHookValidation.success) {
                      console.log("   Cannot proceed without passing pre-push hook validation");
                      resolve();
                      return;
                    }

                    const planPushOutcome = await pushWithHookRetry();

                    if (planPushOutcome.success) {
                      if (tracker && !skipComments && retryStdoutOutput.trim()) {
                        try {
                          await postImplementationComment(
                            tracker,
                            taskKey,
                            retryStdoutOutput,
                            taskSummary,
                          );
                        } catch (commentError) {
                          console.warn(
                            `⚠️  Failed to post implementation comment: ${commentError}`,
                          );
                        }
                      }

                      await createPrAndTransition(retryStdoutOutput);
                    }
                  }
                } else {
                  console.log(`⚠️  ${retryCommitResult.message}`);
                  console.log(
                    'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
                  );
                }
              } else {
                console.log("⚠️  Plan implementation failed");
              }

              resolve();
            });

            retryProcess.on("error", (error: Error) => {
              retrySandboxCleanup().catch(() => {});
              console.error(`❌ Failed to re-run Agent: ${error.message}`);
              resolve();
            });

            return;
          }

          console.log(
            'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
          );
          resolve();
          return;
        }

        // Create pull request if requested
        if (createPr && task) {
          // Step 1: Validate pre-push hook locally BEFORE any push
          console.log("\n🔍 Validating pre-push hook locally (before pushing)...");
          const initialHookValidation = await validatePrePushHook("initial validation");

          if (!initialHookValidation.success) {
            console.log("   Cannot proceed without passing pre-push hook validation");
            resolve();
            return;
          }

          // Step 2: Run auto-review with skipPush if enabled
          const currentBranch = await Utils.getCurrentBranch();
          let autoReviewRan = false;

          if (autoReview && currentBranch) {
            try {
              console.log("\n🔄 Running auto-review loop (without pushing)...");

              const baseOutputDir = resolveOutputDir();
              const taskDir = taskKey
                ? join(baseOutputDir, taskKey.toLowerCase())
                : join(baseOutputDir, `auto-review-${Date.now()}`);

              const autoReviewResult = await runAutoReviewLoop({
                repository: "local/repo",
                prNumber: 0,
                prBranch: currentBranch,
                baseBranch: prTargetBranch,
                harness,
                executablePath,
                maxIterations: autoReviewIterations,
                minPriority: "medium",
                workingDir: process.cwd(),
                outputDir: taskDir,
                skipPush: true,
              });

              const summaryPath = join(taskDir, "auto-review-summary.json");
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

              autoReviewRan = true;

              // Step 3: After auto-review, validate hooks again
              console.log("\n🔍 Re-validating pre-push hook after auto-review improvements...");
              const postAutoReviewValidation = await validatePrePushHook(
                "post auto-review validation",
              );

              if (!postAutoReviewValidation.success) {
                console.log(
                  "   Cannot proceed - auto-review changes failed pre-push hook validation",
                );
                resolve();
                return;
              }
            } catch (autoReviewError) {
              if (autoReviewError instanceof UsageLimitError) {
                reject(autoReviewError);
                return;
              }
              recordRunStage("auto_review", {
                status: "failed",
                summary: `loop errored: ${(autoReviewError as Error).message}`,
              });
              console.warn(`\n⚠️  Auto-review loop failed: ${(autoReviewError as Error).message}`);
              console.log("   Continuing with push and PR creation...");
            }
          }

          // Step 4: Push with hook retry
          const pushOutcome = await pushWithHookRetry();

          if (pushOutcome.success) {
            if (taskKey && tracker && stdoutOutput.trim() && !skipComments) {
              try {
                console.log("\n💬 Posting implementation summary to task tracker...");
                await postImplementationComment(tracker, taskKey, stdoutOutput, taskSummary);
              } catch (commentError) {
                console.warn(
                  `⚠️  Failed to post implementation comment to task tracker: ${commentError}`,
                );
                console.log("   Push succeeded, but task tracker comment failed");
              }
            } else if (skipComments && taskKey) {
              console.log("\n⏭️  Skipping task tracker comment posting (--skip-comments)");
            }

            await createPrAndTransition(stdoutOutput, autoReviewRan);
          } else {
            console.log("   Cannot create PR without pushing branch to remote");
          }
        } else {
          // No PR requested, but commit succeeded - post to task tracker here
          if (taskKey && tracker && stdoutOutput.trim() && !skipComments) {
            try {
              console.log("\n💬 Posting implementation summary to task tracker...");
              await postImplementationComment(tracker, taskKey, stdoutOutput, taskSummary);
            } catch (commentError) {
              console.warn(
                `⚠️  Failed to post implementation comment to task tracker: ${commentError}`,
              );
              console.log("   Commit succeeded, but task tracker comment failed");
            }
          } else if (skipComments && taskKey) {
            console.log("\n⏭️  Skipping task tracker comment posting (--skip-comments)");
          }
        }
        resolve();
      })
      .catch((commitError) => {
        console.log(`⚠️  Failed to commit changes: ${commitError.message}`);
        console.log(
          'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
        );
        // Agent output exists but was never committed — track the
        // degradation; captureError redacts credential-like text.
        captureError(commitError, { taskKey, stage: "commit" });
        resolve(); // Still resolve since Agent succeeded
      });
  } else {
    resolve();
  }
}
