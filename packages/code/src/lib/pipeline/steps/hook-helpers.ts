/**
 * Git-hook-aware commit / validate / push helpers with agent-assisted retry.
 *
 * Extracted from the `runAgentHarness` close handler in src/index.ts; the
 * closures became module functions taking the shared {@link TaskContext}.
 * Behavior (messages, retry bounds, outcomes) is unchanged.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isCommitAlreadyComplete, runAgentHarnessToFixGitHook } from "../../git-hook-fixer";
import { Utils } from "../../utils";
import type { TaskContext } from "../types";

interface HookOutcome {
  success: boolean;
  result: { message: string; hookError?: string };
}

/** Append a git hook failure record to the task's hook error log. */
export function logHookErrorToFile(
  taskKey: string,
  hookType: string,
  attempt: number,
  error: string,
  fixed: boolean,
): void {
  try {
    const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
    const taskDir = join(baseOutputDir, taskKey.toLowerCase());
    const hookErrorFile = join(taskDir, "git-hook-errors.log");

    const timestamp = new Date().toISOString();
    const status = fixed ? "FIXED" : "FAILED";
    const logEntry = `
${"=".repeat(80)}
Timestamp: ${timestamp}
Hook Type: ${hookType}
Attempt: ${attempt}
Status: ${status}
Error:
${error}
${"=".repeat(80)}
`;

    // Append to log file
    const existingContent = existsSync(hookErrorFile)
      ? readFileSync(hookErrorFile, "utf8")
      : "# Git Hook Errors Log\n\n";

    writeFileSync(hookErrorFile, existingContent + logEntry, "utf8");
    console.log(`💾 Hook error logged to: ${hookErrorFile}`);
  } catch (saveError) {
    console.warn(`⚠️  Failed to save hook error to file: ${saveError}`);
  }
}

/** Validate the pre-push hook locally, letting the agent fix failures. */
export async function validatePrePushHook(ctx: TaskContext, phase: string): Promise<HookOutcome> {
  const { hookRetries, harness, executablePath, maxTurns } = ctx;
  let attempt = 0;
  while (attempt <= hookRetries) {
    attempt++;
    const hookResult = await Utils.runPrePushHookLocally({
      verbose: ctx.verbose,
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
        ctx.taskKey ?? "unknown",
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
}

/** Push the current branch, letting the agent fix pre-push hook failures. */
export async function pushWithHookRetry(ctx: TaskContext): Promise<HookOutcome> {
  const { hookRetries, harness, executablePath, maxTurns } = ctx;
  console.log("\n📤 Pushing branch to remote...");
  let attempt = 0;
  while (attempt <= hookRetries) {
    attempt++;
    const pushResult = await Utils.pushCurrentBranch({
      verbose: ctx.verbose,
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
      logHookErrorToFile(ctx.taskKey ?? "unknown", "push", attempt, pushResult.hookError, fixed);
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
}

/** Commit staged changes, letting the agent fix commit hook failures. */
export async function handleCommitWithRetry(
  ctx: TaskContext,
  taskKey: string,
  taskSummary: string,
): Promise<HookOutcome> {
  const { hookRetries, harness, executablePath, maxTurns } = ctx;
  let attempt = 0;

  while (attempt <= hookRetries) {
    attempt++;
    const commitResult = await Utils.commitChanges(taskKey, taskSummary, {
      verbose: ctx.verbose,
      author: ctx.gitAuthor,
    });

    if (commitResult.success) {
      console.log(`✅ ${commitResult.message}`);
      return { success: true, result: commitResult };
    }

    // Check if this is a git hook error that we can try to fix
    if (commitResult.hookError && attempt <= hookRetries) {
      console.log(`\n⚠️  Git hook failed (attempt ${attempt}/${hookRetries + 1})`);

      // Try to fix the hook error with agent
      const fixed = await runAgentHarnessToFixGitHook("commit", harness, executablePath, maxTurns);

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
}
