import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
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
import { resolveOutputDir } from "../config/output-dir";
import {
  getTodoStatusForProject,
  loadProjectSettings,
  resolveProjectKey,
} from "../config/project-settings";
import { DEFAULT_AUTO_REVIEW_ITERATIONS } from "../review/auto-review-config";
import { resolvePipelineSteps } from "../task/pipeline-config";
import { finalizeAgentRun } from "./run-harness-finalize";
import type { FinalizeContext } from "./run-harness-git";
import { recordIncompleteAttempt } from "../state/retry-state";
import type { TaskTrackerClient } from "../trackers/client";
import { formatAgentInputNeededMarkdown } from "../trackers/shared/markdown-comment-formatter";
import { resolveAgentEffort, resolveAgentModel } from "./model";
import { getSandbox } from "./sandbox";
import type { VerifyConfig } from "./verify";

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
  verify?: VerifyConfig;
}

export type AgentSessionResult =
  | { kind: "halted" }
  | { kind: "complete"; context: Omit<FinalizeContext, "resolve" | "reject"> };

/**
 * Run the main agent harness implementation session for a formatted task.
 *
 * @param input - Implementation run inputs
 */
export async function runAgentSession(
  input: RunAgentHarnessOptions,
  promptOverride?: string,
): Promise<AgentSessionResult> {
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

  return new Promise<AgentSessionResult>((resolve, reject) => {
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
        args: [...agentArgs, ...buildPromptArgs(harness, promptOverride ?? taskContent)],
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
          resolve({ kind: "halted" });
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
            resolve({ kind: "halted" });
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
            resolve({ kind: "halted" });
            return;
          }

          resolve({
            kind: "complete",
            context: {
              ...input,
              maxTurns,
              enableGit,
              createPr,
              prTargetBranch,
              skipComments,
              hookRetries,
              gitAuthor,
              autoReview,
              autoReviewIterations,
              isPlanRetry,
              prTargetBranchExplicit,
              requestedPrTargetBranch,
              taskContent,
              stdoutOutput,
              projectSettings,
            },
          });
        } else {
          console.log(`❌ Agent exited with non-zero code ${code}`);
          console.log("   No JIRA comment will be posted due to execution failure");
          reject(new Error(`Agent exited with code ${code}`));
        }
      });
    })().catch(reject);
  });
}

/** Run implementation and deliver it when the agent completed meaningful work. */
export async function runAgentHarness(input: RunAgentHarnessOptions): Promise<void> {
  const configuredPipeline = loadProjectSettings()?.pipeline;
  const pipelineSteps = await resolvePipelineSteps(
    configuredPipeline ??
      (input.verify
        ? {
            steps: [
              { use: "implement" },
              { use: "commit" },
              { use: "verify", ...input.verify },
              { use: "auto-review" },
              { use: "finalize" },
            ],
          }
        : undefined),
    process.cwd(),
  );
  const session = await runAgentSession(input);
  if (session.kind === "halted") return;
  await new Promise<void>((resolve, reject) => {
    finalizeAgentRun({
      ...session.context,
      pipelineSteps,
      runRepair: async (prompt) => {
        const repair = await runAgentSession(input, prompt);
        return repair.kind === "complete"
          ? { kind: "complete", stdout: repair.context.stdoutOutput }
          : { kind: "halted" };
      },
      resolve,
      reject,
    });
  });
}
