import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  buildPromptArgs,
  detectIncompleteImplementation,
  detectMaxTurnsReached,
  detectOpenQuestions,
  detectUsageLimit,
  findMaxTurnsReachedLine,
  reapTree,
  resolveExecutablePathWithRetry,
  spawnAgent,
  UsageLimitError,
} from "@devintern/agent-harness";
import type { AgentHarness } from "@devintern/agent-harness";
import { captureError } from "@devintern/utils";
import { runContext } from "../cli/context";
import { PRManager } from "../code-host";
import { resolveOutputDir } from "../config/output-dir";
import {
  getPrStatusForProject,
  getTodoStatusForProject,
  loadProjectSettings,
  resolveProjectKey,
} from "../config/project-settings";
import { DEFAULT_AUTO_REVIEW_ITERATIONS } from "../review/auto-review-config";
import { runAutoReviewLoop } from "../review/auto-review-loop";
import { recordIncompleteAttempt } from "../state/retry-state";
import { recordRunPr, recordRunStage } from "../state/run-recorder";
import { parseGitHubPrUrl, recordAgentPrFromUrl } from "../state/worker-state";
import { postImplementationComment } from "../task/implementation-comment";
import type { TaskTrackerClient } from "../trackers/client";
import { formatAgentInputNeededMarkdown } from "../trackers/shared/markdown-comment-formatter";
import { Utils } from "../utils";
import { isCommitAlreadyComplete, runAgentHarnessToFixGitHook } from "./git-hook-fixer";
import { resolveAgentEffort, resolveAgentModel } from "./model";
import { createPlanImplementationPrompt, detectPlanOnlyBehavior, logHookErrorToFile } from "./plan";
import { getSandbox } from "./sandbox";

interface RunAgentHarnessOptions {
  taskFile: string;
  harness: AgentHarness;
  executablePath: string;
  maxTurns?: number;
  taskKey?: string;
  taskSummary?: string;
  enableGit?: boolean;
  task?: any;
  createPr?: boolean;
  prTargetBranch?: string;
  tracker?: TaskTrackerClient;
  skipComments?: boolean;
  hookRetries?: number;
  gitAuthor?: { name: string; email: string };
  autoReview?: boolean;
  autoReviewIterations?: number;
  isPlanRetry?: boolean;
  prTargetBranchExplicit?: boolean;
  requestedPrTargetBranch?: string;
}

/**
 * Run the main agent harness implementation session for a formatted task.
 *
 * @param input - Implementation run inputs
 */
export async function runAgentHarness(input: RunAgentHarnessOptions): Promise<void> {
  const {
    taskFile,
    harness,
    executablePath,
    maxTurns = 500,
    taskKey,
    taskSummary,
    enableGit = true,
    task,
    createPr = false,
    prTargetBranch = "main",
    tracker,
    skipComments = false,
    hookRetries = 10,
    gitAuthor,
    autoReview = false,
    autoReviewIterations = DEFAULT_AUTO_REVIEW_ITERATIONS,
    isPlanRetry = false,
    prTargetBranchExplicit = false,
    requestedPrTargetBranch,
  } = input;
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the run.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    (async () => {
      // Check if task file exists
      if (!existsSync(taskFile)) {
        reject(new Error(`Task file not found: ${taskFile}`));
        return;
      }

      // Load project settings
      const projectSettings = loadProjectSettings();

      // Read the task content
      const taskContent = readFileSync(taskFile, "utf8");

      const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

      const agentArgs = harness.buildArgs({
        maxTurns,
        skipPermissions: true,
        workingDir: process.cwd(),
        model: resolveAgentModel(),
        effort: resolveAgentEffort(),
      });
      console.log(`🚀 Launching ${harness.displayName}...`);
      console.log(`   Command: ${executablePath} ${agentArgs.join(" ")}`);
      console.log(`   Input: ${taskFile}`);
      console.log(`   Timeout: ${timeoutMinutes} minutes`);
      console.log(
        `   Output: All ${harness.displayName} output will be displayed below in real-time`,
      );
      console.log("\n" + "=".repeat(60));

      // Capture stderr to detect max turns error and stdout for JIRA comment
      let stderrOutput = "";
      let stdoutOutput = "";
      let timedOut = false;
      let usageLimit: ReturnType<typeof detectUsageLimit> | undefined;

      // Spawn agent process with enhanced permissions and max turns
      const { child: codeAgent, cleanup: sandboxCleanup } = await spawnAgent({
        resolvedPath,
        args: [...agentArgs, ...buildPromptArgs(harness, taskContent)],
        spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
        sandbox: await getSandbox(harness.name),
      });

      const stopOnUsageLimit = (): void => {
        if (usageLimit?.limited) return;
        const detected = detectUsageLimit(stdoutOutput, stderrOutput);
        if (detected.limited) {
          usageLimit = detected;
          reapTree(codeAgent, "SIGTERM");
        }
      };

      const timeout = setTimeout(
        () => {
          timedOut = true;
          console.error(
            `\n⏰ ${harness.displayName} process timed out after ${timeoutMinutes} minutes, killing...`,
          );
          reapTree(codeAgent, "SIGTERM");
          setTimeout(() => {
            if (!codeAgent.killed) {
              reapTree(codeAgent, "SIGKILL");
            }
            sandboxCleanup().catch(() => {});
          }, 10_000);
        },
        timeoutMinutes * 60 * 1000,
      );

      // Capture and display stdout output
      if (codeAgent.stdout) {
        codeAgent.stdout.on("data", (data: Buffer) => {
          const output = data.toString();
          stdoutOutput += output;
          stopOnUsageLimit();
          process.stdout.write(output);
        });
      }

      // Capture stderr output for error detection while ensuring it's visible to user
      if (codeAgent.stderr) {
        codeAgent.stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          stderrOutput += output;
          stopOnUsageLimit();
          process.stderr.write(output);
        });
      }

      // Handle errors
      codeAgent.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (error.code === "ENOENT") {
          reject(
            new Error(
              `${harness.displayName} CLI not found at: ${executablePath}\nPlease install ${harness.displayName} or specify the correct path with --agent-path`,
            ),
          );
        } else {
          reject(new Error(`Failed to run ${harness.displayName}: ${error.message}`));
        }
      });

      // Handle process exit
      // oxlint-disable-next-line complexity -- agent close handler fans out sandbox cleanup, output flushing, and failure reporting; remedy: extract `handleAgentClose(code)` on the run context.
      codeAgent.on("close", async (code: number | null) => {
        clearTimeout(timeout);
        sandboxCleanup().catch(() => {});
        console.log("\n" + "=".repeat(60));

        if (timedOut) {
          console.log(`⏰ ${harness.displayName} timed out after ${timeoutMinutes} minutes`);
          reject(new Error(`${harness.displayName} timed out after ${timeoutMinutes} minutes`));
          return;
        }

        // A usage/rate limit is account-global — abort the batch rather than
        // treating this task as a normal failure (every other task would fail too).
        const usage = usageLimit ?? detectUsageLimit(stdoutOutput, stderrOutput);
        if (usage.limited) {
          console.log(
            `\n⏳ ${harness.displayName} hit a usage limit${
              usage.resetsAt ? ` (resets ${usage.resetsAt})` : ""
            }`,
          );
          if (usage.matchedLine) {
            console.log(`   Matched output: ${usage.matchedLine}`);
          }
          reject(new UsageLimitError(usage.resetsAt));
          return;
        }

        const maxTurnsReached = detectMaxTurnsReached(
          stdoutOutput,
          stderrOutput,
          harness.supportsMaxTurns === true,
        );

        if (maxTurnsReached) {
          console.log("⚠️  Agent reached maximum turns limit without completing the task");
          console.log("   The task may be too complex or require more turns to complete");
          console.log(
            "   Consider breaking it into smaller tasks or increasing the max-turns limit",
          );
          const matchedLine = findMaxTurnsReachedLine(stdoutOutput, stderrOutput);
          if (matchedLine) {
            console.log(`   Matched output: ${matchedLine}`);
          }

          // Save incomplete implementation for analysis
          if (taskKey && stdoutOutput.trim()) {
            try {
              const baseOutputDir = resolveOutputDir();
              const taskDir = join(baseOutputDir, taskKey.toLowerCase());
              const summaryFile = join(taskDir, "implementation-summary-incomplete.md");

              writeFileSync(summaryFile, stdoutOutput, "utf8");
              console.log(`\n💾 Saved incomplete implementation to: ${summaryFile}`);

              // Post incomplete implementation comment (no duplicate check here
              // since we already skip tasks with existing incomplete comments)
              if (tracker && !skipComments && task) {
                try {
                  await tracker.postIncompleteImplementationComment(
                    taskKey,
                    stdoutOutput,
                    taskSummary,
                  );
                  recordIncompleteAttempt(
                    taskKey,
                    process.env.TASK_TRACKER || "jira",
                    tracker.extractDescriptionText(task),
                  );
                } catch (commentError) {
                  console.warn(
                    `⚠️  Failed to post incomplete implementation comment to JIRA: ${commentError}`,
                  );
                }
              }

              // Transition back to "To Do" status if configured
              if (tracker && !skipComments && taskKey && projectSettings) {
                const projectKey = resolveProjectKey(taskKey, task);
                const todoStatus = getTodoStatusForProject(projectKey, projectSettings);
                if (todoStatus && todoStatus.trim()) {
                  try {
                    console.log(
                      `\n🔄 Moving ${taskKey} back to '${todoStatus}' due to max turns reached...`,
                    );
                    await tracker.transitionStatus(taskKey, todoStatus.trim());
                    console.log(`✅ Task moved to '${todoStatus}'`);
                  } catch (statusError) {
                    console.warn(
                      `⚠️  Failed to transition task to '${todoStatus}': ${
                        (statusError as Error).message
                      }`,
                    );
                  }
                }
              }
            } catch (saveError) {
              console.warn(`⚠️  Failed to save implementation summary: ${saveError}`);
            }
          }

          console.log("\n⏭️  Skipping commit and moving to next task (if any)...");

          // Resolve instead of reject to allow batch processing to continue
          resolve();
          return;
        }

        if (code === 0) {
          // Even if exit code is 0, check if Agent actually completed meaningful work.
          // Only inspect stdout: stderr often contains transient "Error:" lines from
          // recovered tool failures (especially with Cursor CLI).
          const { incomplete: seemsIncomplete, reasons: incompleteReasons } =
            detectIncompleteImplementation(stdoutOutput);

          // Save implementation summary to task directory (even if incomplete for analysis)
          if (taskKey && stdoutOutput.trim()) {
            try {
              const baseOutputDir = resolveOutputDir();
              const taskDir = join(baseOutputDir, taskKey.toLowerCase());
              const summaryFile = join(
                taskDir,
                seemsIncomplete
                  ? "implementation-summary-incomplete.md"
                  : "implementation-summary.md",
              );

              writeFileSync(summaryFile, stdoutOutput, "utf8");
              console.log(`\n💾 Saved implementation summary to: ${summaryFile}`);
            } catch (saveError) {
              console.warn(`⚠️  Failed to save implementation summary: ${saveError}`);
            }
          }

          if (seemsIncomplete) {
            console.log("⚠️  Agent execution completed but appears to be incomplete or failed");
            console.log(`   Reasons: ${incompleteReasons.join("; ")}`);
            console.log("   Check the output above for specific issues");
            console.log("\n⏭️  Skipping commit and moving to next task (if any)...");

            // Post incomplete implementation comment (no duplicate check here
            // since we already skip tasks with existing incomplete comments)
            if (tracker && !skipComments && taskKey && stdoutOutput.trim() && task) {
              try {
                await tracker.postIncompleteImplementationComment(
                  taskKey,
                  stdoutOutput,
                  taskSummary,
                );
                recordIncompleteAttempt(
                  taskKey,
                  process.env.TASK_TRACKER || "jira",
                  tracker.extractDescriptionText(task),
                );
              } catch (commentError) {
                console.warn(
                  `⚠️  Failed to post incomplete implementation comment to JIRA: ${commentError}`,
                );
              }
            }

            // Transition back to "To Do" status if configured
            if (tracker && !skipComments && taskKey && projectSettings) {
              const projectKey = resolveProjectKey(taskKey, task);
              const todoStatus = getTodoStatusForProject(projectKey, projectSettings);
              if (todoStatus && todoStatus.trim()) {
                try {
                  console.log(
                    `\n🔄 Moving ${taskKey} back to '${todoStatus}' due to incomplete implementation...`,
                  );
                  await tracker.transitionStatus(taskKey, todoStatus.trim());
                  console.log(`✅ Task moved to '${todoStatus}'`);
                } catch (statusError) {
                  console.warn(
                    `⚠️  Failed to transition task to '${todoStatus}': ${
                      (statusError as Error).message
                    }`,
                  );
                }
              }
            }

            // Don't commit or continue processing when implementation is incomplete
            // Just resolve to allow batch processing to continue
            resolve();
            return;
          } else {
            console.log("✅ Agent execution completed successfully");
          }

          // Agent finished by asking the user questions instead of implementing.
          // Committing here would ship an answer nobody gave, so surface the
          // questions and stop before the git/PR flow.
          const openQuestions = detectOpenQuestions(stdoutOutput);
          if (openQuestions.awaitingInput) {
            console.log("\n⏸️  Agent is asking questions and needs your input before proceeding:");
            for (const question of openQuestions.questions) {
              console.log(`   • ${question}`);
            }

            if (tracker && !skipComments && taskKey) {
              try {
                await tracker.postComment(taskKey, {
                  format: "markdown",
                  body: formatAgentInputNeededMarkdown(openQuestions.questions),
                });
                console.log("💬 Posted the questions as a comment on the task");
              } catch (commentError) {
                console.warn(`⚠️  Failed to post questions comment: ${commentError}`);
              }
            }

            console.log("\n⏭️  Skipping commit and PR until the questions are answered...");
            resolve();
            return;
          }

          // --- Shared helpers for hook validation, push, and PR creation ---
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
                const fixed = await runAgentHarnessToFixGitHook(
                  "push",
                  harness,
                  executablePath,
                  maxTurns,
                );
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
                const fixed = await runAgentHarnessToFixGitHook(
                  "push",
                  harness,
                  executablePath,
                  maxTurns,
                );
                logHookErrorToFile(
                  taskKey ?? "unknown",
                  "push",
                  attempt,
                  pushResult.hookError,
                  fixed,
                );
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

          const createPrAndTransition = async (
            implementationOutput: string,
            autoReviewRan = false,
          ) => {
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

                if (taskKey && tracker && !skipComments) {
                  const projectKey = resolveProjectKey(taskKey, task);
                  const prStatus = getPrStatusForProject(projectKey, projectSettings);
                  if (prStatus && prStatus.trim()) {
                    try {
                      console.log("\n🔄 Transitioning JIRA status after PR creation...");
                      await tracker.transitionStatus(taskKey, prStatus.trim());
                    } catch (statusError) {
                      console.warn(
                        `⚠️  Failed to transition JIRA status: ${(statusError as Error).message}`,
                      );
                      console.log("   PR was created successfully, but status transition failed");
                    }
                  }
                } else if (skipComments) {
                  console.log("\n⏭️  Skipping task tracker status transition (--skip-comments)");
                }

                if (autoReviewRan) {
                  console.log(
                    "\n✅ Auto-review was completed before push (see summary file for details)",
                  );
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

          // Commit changes if git is enabled and we have task details
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
                    const implementationPrompt = createPlanImplementationPrompt(
                      planPath,
                      taskContent,
                    );

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
                            const summaryFile = join(
                              dirname(taskFile),
                              "implementation-summary.md",
                            );
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
                            console.log(
                              "\n🔍 Validating pre-push hook locally (before pushing)...",
                            );
                            const planHookValidation = await validatePrePushHook(
                              "plan implementation validation",
                            );
                            if (!planHookValidation.success) {
                              console.log(
                                "   Cannot proceed without passing pre-push hook validation",
                              );
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
                      console.log(
                        "\n🔍 Re-validating pre-push hook after auto-review improvements...",
                      );
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
                      console.warn(
                        `\n⚠️  Auto-review loop failed: ${(autoReviewError as Error).message}`,
                      );
                      console.log("   Continuing with push and PR creation...");
                    }
                  }

                  // Step 4: Push with hook retry
                  const pushOutcome = await pushWithHookRetry();

                  if (pushOutcome.success) {
                    if (taskKey && tracker && stdoutOutput.trim() && !skipComments) {
                      try {
                        console.log("\n💬 Posting implementation summary to task tracker...");
                        await postImplementationComment(
                          tracker,
                          taskKey,
                          stdoutOutput,
                          taskSummary,
                        );
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
        } else {
          console.log(`❌ Agent exited with non-zero code ${code}`);
          console.log("   No JIRA comment will be posted due to execution failure");
          reject(new Error(`Agent exited with code ${code}`));
        }
      });
    })().catch(reject);
  });
}
