/**
 * The `implement` step: runs the main agent harness implementation session.
 *
 * `runImplementation` is the primitive extracted from `runAgentHarness`'s
 * subprocess close handler in src/index.ts. It owns ONLY: spawn + capture +
 * timeout, usage-limit / max-turns / incomplete detection, and summary-file
 * saving. Commit / push / PR live in later steps so a verify loopback can
 * re-run implementation without re-committing mid-verification.
 */

import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  buildPromptArgs,
  detectIncompleteImplementation,
  detectMaxTurnsReached,
  detectOpenQuestions,
  detectUsageLimit,
  reapTree,
  resolveExecutablePathWithRetry,
  spawnAgent,
} from "@devintern/agent-harness";
import { UsageLimitError } from "../../errors";
import { getSandbox } from "../../sandbox";
import type { ReviewFeedback } from "../../../types/auto-review";
import { StepStatus } from "../types";
import type { PipelineStep, StepDefinition, StepResult, TaskContext } from "../types";

/** Result of one agent implementation run. */
export interface ImplementationRunResult {
  /** Full agent stdout. */
  stdout: string;
  /** Whether the run produced a (seemingly) complete implementation. */
  outcome: "complete" | "incomplete" | "awaiting-input";
  /** Reasons when `outcome === "incomplete"`. */
  incompleteReasons?: string[];
  /** Questions the agent needs answered before it can continue. */
  openQuestions?: string[];
}

/**
 * Run one agent implementation session for the task.
 *
 * @param ctx - Shared task context (harness, task file, output dirs)
 * @param promptOverride - When set, sent to the agent instead of the task
 *   file contents (used for plan-only retries and verify loopbacks)
 * @throws {UsageLimitError} When the agent hit an account-wide usage limit
 * @throws {Error} On timeout, spawn failure, or non-zero agent exit
 */
export async function runImplementation(
  ctx: TaskContext,
  promptOverride?: string,
): Promise<ImplementationRunResult> {
  const { harness, executablePath, maxTurns } = ctx;

  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the run.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    displayName: harness.displayName,
  });

  if (!existsSync(ctx.taskFile)) {
    throw new Error(`Task file not found: ${ctx.taskFile}`);
  }

  const promptContent = promptOverride ?? ctx.taskContent;

  const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

  const agentArgs = harness.buildArgs({
    maxTurns,
    skipPermissions: true,
    workingDir: ctx.workingDir,
  });
  console.log(`🚀 Launching ${harness.displayName}...`);
  console.log(`   Command: ${executablePath} ${agentArgs.join(" ")} --verbose`);
  console.log(`   Input: ${ctx.taskFile}`);
  console.log(`   Timeout: ${timeoutMinutes} minutes`);
  console.log(`   Output: All ${harness.displayName} output will be displayed below in real-time`);
  console.log("\n" + "=".repeat(60));

  let stderrOutput = "";
  let stdoutOutput = "";
  let timedOut = false;

  const { child: codeAgent, cleanup: sandboxCleanup } = await spawnAgent({
    resolvedPath,
    args: [...agentArgs, ...buildPromptArgs(harness, promptContent)],
    spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
    sandbox: await getSandbox(harness.name),
  });

  return new Promise((resolve, reject) => {
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
        }, 10_000);
      },
      timeoutMinutes * 60 * 1000,
    );

    // Capture and display stdout output
    if (codeAgent.stdout) {
      codeAgent.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutOutput += output;
        process.stdout.write(output);
      });
    }

    // Capture stderr output for error detection while ensuring it's visible to user
    if (codeAgent.stderr) {
      codeAgent.stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrOutput += output;
        process.stderr.write(output);
      });
    }

    // Handle errors
    codeAgent.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      sandboxCleanup().catch(() => {});
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
    codeAgent.on("close", (code: number | null) => {
      clearTimeout(timeout);
      sandboxCleanup().catch(() => {});
      console.log("\n" + "=".repeat(60));

      if (timedOut) {
        console.log(`⏰ ${harness.displayName} timed out after ${timeoutMinutes} minutes`);
        reject(new Error(`${harness.displayName} timed out after ${timeoutMinutes} minutes`));
        return;
      }

      // A usage/rate limit is account-global - abort the batch rather than
      // treating this task as a normal failure (every other task would fail too).
      const usage = detectUsageLimit(stdoutOutput, stderrOutput);
      if (usage.limited) {
        console.log(
          `\n⏳ ${harness.displayName} hit a usage limit${
            usage.resetsAt ? ` (resets ${usage.resetsAt})` : ""
          }`,
        );
        reject(new UsageLimitError(usage.resetsAt));
        return;
      }

      const maxTurnsReached = detectMaxTurnsReached(stdoutOutput, stderrOutput);

      if (maxTurnsReached) {
        console.log("⚠️  Agent reached maximum turns limit without completing the task");
        console.log("   The task may be too complex or require more turns to complete");
        console.log("   Consider breaking it into smaller tasks or increasing the max-turns limit");

        saveImplementationSummary(ctx, stdoutOutput, true);

        console.log("\n⏭️  Skipping commit and moving to next task (if any)...");

        resolve({
          stdout: stdoutOutput,
          outcome: "incomplete",
          incompleteReasons: ["Agent reached maximum turns limit without completing the task"],
        });
        return;
      }

      if (code === 0) {
        // Even if exit code is 0, check if Agent actually completed meaningful work.
        // Only inspect stdout: stderr often contains transient "Error:" lines from
        // recovered tool failures (especially with Cursor CLI).
        const { incomplete: seemsIncomplete, reasons: incompleteReasons } =
          detectIncompleteImplementation(stdoutOutput);

        // Save implementation summary to task directory (even if incomplete for analysis)
        saveImplementationSummary(ctx, stdoutOutput, seemsIncomplete);

        if (seemsIncomplete) {
          console.log("⚠️  Agent execution completed but appears to be incomplete or failed");
          console.log(`   Reasons: ${incompleteReasons.join("; ")}`);
          console.log("   Check the output above for specific issues");
          console.log("\n⏭️  Skipping commit and moving to next task (if any)...");

          resolve({
            stdout: stdoutOutput,
            outcome: "incomplete",
            incompleteReasons,
          });
          return;
        }

        const openQuestions = detectOpenQuestions(stdoutOutput);
        if (openQuestions.awaitingInput) {
          console.log("\n⏸️  Agent is asking questions and needs your input before proceeding:");
          for (const question of openQuestions.questions) {
            console.log(`   • ${question}`);
          }
          console.log("\n⏭️  Skipping commit and PR until the questions are answered...");
          resolve({
            stdout: stdoutOutput,
            outcome: "awaiting-input",
            openQuestions: openQuestions.questions,
          });
          return;
        }

        console.log("✅ Agent execution completed successfully");
        resolve({ stdout: stdoutOutput, outcome: "complete" });
      } else {
        console.log(`❌ Agent exited with non-zero code ${code}`);
        console.log("   No JIRA comment will be posted due to execution failure");
        reject(new Error(`Agent exited with code ${code}`));
      }
    });
  });
}

/** Persist the implementation summary (complete or incomplete) for analysis. */
function saveImplementationSummary(ctx: TaskContext, stdout: string, incomplete: boolean): void {
  if (!ctx.taskKey || !stdout.trim()) {
    return;
  }
  try {
    const summaryFile = join(
      ctx.taskDir,
      incomplete ? "implementation-summary-incomplete.md" : "implementation-summary.md",
    );
    writeFileSync(summaryFile, stdout, "utf8");
    console.log(
      incomplete
        ? `\n💾 Saved incomplete implementation to: ${summaryFile}`
        : `\n💾 Saved implementation summary to: ${summaryFile}`,
    );
  } catch (saveError) {
    console.warn(`⚠️  Failed to save implementation summary: ${saveError}`);
  }
}

/** Build the prompt for a re-implementation run driven by verify findings. */
export function buildLoopbackPrompt(taskContent: string, feedback: ReviewFeedback): string {
  const itemsList = feedback.items
    .map(
      (item, idx) =>
        `${idx + 1}. **[${item.priority.toUpperCase()}] ${item.category}** ${item.file ? `in \`${item.file}\`` : ""}${item.line ? ` (line ${item.line})` : ""}
   - Issue: ${item.issue}
   - Suggestion: ${item.suggestion}`,
    )
    .join("\n\n");

  return `Your previous implementation of this task did not satisfy the requirements. A verification pass found the following problems:

## Verification Summary
${feedback.summary}

## Findings to Address
${itemsList}

## Instructions
1. Address each finding above - make the implementation actually satisfy the task requirements
2. Make focused changes; do not start over unless necessary
3. Do NOT commit or push - this is handled automatically

For reference, here is the original task:
---
${taskContent}
---

Now fix the implementation.`;
}

/** Pipeline step wrapping {@link runImplementation}. */
export class ImplementStep implements PipelineStep {
  readonly name = "implement";

  async run(ctx: TaskContext): Promise<StepResult> {
    let promptOverride: string | undefined;
    if (ctx.pendingPromptOverride) {
      promptOverride = ctx.pendingPromptOverride;
      ctx.pendingPromptOverride = undefined;
    } else if (ctx.loopbackFeedback) {
      promptOverride = buildLoopbackPrompt(ctx.taskContent, ctx.loopbackFeedback);
      ctx.loopbackFeedback = undefined;
    }

    const result = await runImplementation(ctx, promptOverride);
    ctx.implementationOutput = result.stdout;

    if (result.outcome === "incomplete") {
      return {
        status: StepStatus.Halt,
        haltKind: "incomplete",
        reason: result.incompleteReasons?.join("; ") ?? "Implementation appears incomplete",
      };
    }
    if (result.outcome === "awaiting-input") {
      if (ctx.tracker && !ctx.skipComments && ctx.taskKey) {
        try {
          const questionList = (result.openQuestions ?? [])
            .map((question) => `- ${question}`)
            .join("\n");
          await ctx.tracker.postComment(ctx.taskKey, {
            format: "markdown",
            body:
              `🤖 The agent needs input before it can implement this task:\n\n${questionList}\n\n` +
              "Answer in the task description or a comment, then re-run devintern.",
          });
          console.log("💬 Posted the questions as a comment on the task");
        } catch (commentError) {
          console.warn(`⚠️  Failed to post questions comment: ${commentError}`);
        }
      }
      return {
        status: StepStatus.Halt,
        haltKind: "stop",
        reason: "Agent is awaiting user input",
      };
    }
    return { status: StepStatus.Continue };
  }
}

export const implementStepDefinition: StepDefinition = {
  name: "implement",
  create: () => new ImplementStep(),
};
