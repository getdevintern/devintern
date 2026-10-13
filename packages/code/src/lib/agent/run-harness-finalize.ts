import { writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  buildPromptArgs,
  resolveExecutablePathWithRetry,
  spawnAgent,
  UsageLimitError,
} from "@devintern/agent-harness";
import { captureError } from "@devintern/utils";
import { runContext } from "../cli/context";
import { resolveOutputDir } from "../config/output-dir";
import { getTodoStatusForProject, resolveProjectKey } from "../config/project-settings";
import { runAutoReviewLoop } from "../review/auto-review-loop";
import { recordIncompleteAttempt } from "../state/retry-state";
import { recordRunStage } from "../state/run-recorder";
import { postImplementationComment } from "../task/implementation-comment";
import { Utils } from "../utils";
import { isCommitAlreadyComplete, runAgentHarnessToFixGitHook } from "./git-hook-fixer";
import { resolveAgentEffort, resolveAgentModel } from "./model";
import { createPlanImplementationPrompt, detectPlanOnlyBehavior, logHookErrorToFile } from "./plan";
import { createGitHelpers } from "./run-harness-git";
import type { FinalizeContext } from "./run-harness-git";
import { getSandbox } from "./sandbox";
import { runTaskSteps } from "../task/step-runner";
import type { TaskStep } from "../task/step-runner";
import type { ReviewFeedback } from "../../types/auto-review";
import { buildRepairPrompt, verifyImplementation } from "./verify";

type GitHelpers = ReturnType<typeof createGitHelpers>;

export interface DeliveryState {
  context: FinalizeContext;
  helpers: GitHelpers;
  output: string;
  committed: boolean;
  planRetry: boolean;
  autoReviewRan: boolean;
  pendingFeedback?: ReviewFeedback;
}

/** Commit once, allowing the agent to repair pre-commit hook failures. */
async function commitWithHookRetry(ctx: FinalizeContext, taskKey: string, taskSummary: string) {
  let attempt = 0;
  while (attempt <= ctx.hookRetries) {
    attempt++;
    const result = await Utils.commitChanges(taskKey, taskSummary, {
      verbose: runContext.options.verbose,
      author: ctx.gitAuthor,
    });
    if (result.success) {
      console.log(`✅ ${result.message}`);
      return { success: true, result };
    }
    if (result.hookError && attempt <= ctx.hookRetries) {
      console.log(`\n⚠️  Git hook failed (attempt ${attempt}/${ctx.hookRetries + 1})`);
      const fixed = await runAgentHarnessToFixGitHook(
        "commit",
        ctx.harness,
        ctx.executablePath,
        ctx.maxTurns,
      );
      logHookErrorToFile(taskKey, "commit", attempt, result.hookError, fixed);
      if (fixed) {
        if (await isCommitAlreadyComplete()) {
          console.log("✅ Commit already completed during hook fix");
          return {
            success: true,
            result: { message: `Successfully committed changes for ${taskKey} (via hook fix)` },
          };
        }
        console.log("\n🔄 Retrying commit after Agent fixed the issues...");
        continue;
      }
      console.log("\n❌ Could not fix git hook errors automatically");
      return { success: false, result };
    }
    if (attempt > ctx.hookRetries) {
      console.log(`\n❌ Max retries (${ctx.hookRetries}) exceeded for git hook fixes`);
    }
    console.log(`⚠️  ${result.message}`);
    return { success: false, result };
  }
  return { success: false, result: { message: "Max retries exceeded" } };
}

/** Retry a plan-only agent once and commit its implementation. */
async function implementPlan(
  ctx: FinalizeContext,
  taskKey: string,
  taskSummary: string,
  planPath: string,
): Promise<string | undefined> {
  console.log(
    "\n🔄 Agent created a plan but didn't implement it. Re-running to execute the plan...",
  );
  if (planPath !== "PLAN_DETECTED_NO_PATH") console.log(`   Plan file detected: ${planPath}`);
  const prompt = createPlanImplementationPrompt(planPath, ctx.taskContent);
  const args = ctx.harness.buildArgs({
    maxTurns: ctx.maxTurns,
    skipPermissions: true,
    workingDir: process.cwd(),
    model: resolveAgentModel(),
    effort: resolveAgentEffort(),
  });
  const resolvedPath = await resolveExecutablePathWithRetry(ctx.executablePath, {
    displayName: ctx.harness.displayName,
  });
  const { child, cleanup } = await spawnAgent({
    resolvedPath,
    args: [...args, ...buildPromptArgs(ctx.harness, prompt)],
    spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
    sandbox: await getSandbox(ctx.harness.name),
  });

  const output = await new Promise<string | undefined>((resolve) => {
    let stdout = "";
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (data: Buffer) => process.stderr.write(data.toString()));
    child.on("error", (error: Error) => {
      cleanup().catch(() => {});
      console.error(`❌ Failed to re-run Agent: ${error.message}`);
      resolve(undefined);
    });
    child.on("close", (code: number | null) => {
      cleanup().catch(() => {});
      console.log("\n" + "=".repeat(60));
      if (code !== 0) {
        console.log("⚠️  Plan implementation failed");
        resolve(undefined);
        return;
      }
      resolve(stdout);
    });
  });
  if (output === undefined) return undefined;

  console.log("✅ Plan implementation completed");
  if (output.trim()) {
    try {
      const summaryFile = join(dirname(ctx.taskFile), "implementation-summary.md");
      writeFileSync(summaryFile, `# Plan Implementation Output\n\n${output}`, "utf8");
      console.log(`\n💾 Updated implementation summary: ${summaryFile}`);
    } catch (error) {
      console.warn(`⚠️  Failed to save implementation summary: ${error}`);
    }
  }
  console.log("\n📝 Committing plan implementation changes...");
  const result = await Utils.commitChanges(taskKey, taskSummary, {
    verbose: runContext.options.verbose,
    author: ctx.gitAuthor,
  });
  if (result.success) {
    console.log(`✅ ${result.message}`);
    return output;
  }
  console.log(`⚠️  ${result.message}`);
  console.log(
    'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
  );
  return undefined;
}

/** Commit the implementation, including the existing plan-only retry. */
export async function commitImplementation(state: DeliveryState): Promise<boolean> {
  const ctx = state.context;
  const { taskKey, taskSummary } = ctx;
  if (!(ctx.enableGit && taskKey && taskSummary)) return false;
  console.log("\n📝 Committing changes...");
  const outcome = await commitWithHookRetry(ctx, taskKey, taskSummary);
  if (outcome.success) {
    state.committed = true;
    return true;
  }

  const planPath =
    outcome.result.message === "No changes to commit" ? detectPlanOnlyBehavior(state.output) : null;
  if (planPath && !ctx.isPlanRetry) {
    const output = await implementPlan(ctx, taskKey, taskSummary, planPath);
    if (output !== undefined) {
      state.output = output;
      state.planRetry = true;
      state.committed = true;
      return true;
    }
    return false;
  }
  console.log(
    'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
  );
  return false;
}

/** Validate hooks and run optional local auto-review before the push. */
export async function reviewImplementation(state: DeliveryState): Promise<boolean> {
  const ctx = state.context;
  if (!(ctx.createPr && ctx.task)) return true;
  console.log("\n🔍 Validating pre-push hook locally (before pushing)...");
  const initial = await state.helpers.validatePrePushHook(
    state.planRetry ? "plan implementation validation" : "initial validation",
  );
  if (!initial.success) {
    console.log("   Cannot proceed without passing pre-push hook validation");
    return false;
  }
  if (state.planRetry) return true;

  const branch = await Utils.getCurrentBranch();
  if (!(ctx.autoReview && branch)) return true;
  try {
    console.log("\n🔄 Running auto-review loop (without pushing)...");
    const baseOutputDir = resolveOutputDir();
    const taskDir = ctx.taskKey
      ? join(baseOutputDir, ctx.taskKey.toLowerCase())
      : join(baseOutputDir, `auto-review-${Date.now()}`);
    const result = await runAutoReviewLoop({
      repository: "local/repo",
      prNumber: 0,
      prBranch: branch,
      baseBranch: ctx.prTargetBranch,
      harness: ctx.harness,
      executablePath: ctx.executablePath,
      maxIterations: ctx.autoReviewIterations,
      minPriority: "medium",
      workingDir: process.cwd(),
      outputDir: taskDir,
      skipPush: true,
    });
    const summaryPath = join(taskDir, "auto-review-summary.json");
    writeFileSync(summaryPath, JSON.stringify(result, null, 2));
    console.log(`\n📄 Auto-review summary saved to: ${summaryPath}`);
    recordRunStage("auto_review", {
      status: result.success ? "succeeded" : "failed",
      summary: `${result.iterations} iteration(s), ${result.success ? "approved" : "incomplete"}`,
      detail: {
        iterations: result.iterations,
        success: result.success,
        finalFeedback: result.finalFeedback,
      },
    });
    state.autoReviewRan = true;
    console.log("\n🔍 Re-validating pre-push hook after auto-review improvements...");
    const postReview = await state.helpers.validatePrePushHook("post auto-review validation");
    if (!postReview.success) {
      console.log("   Cannot proceed - auto-review changes failed pre-push hook validation");
      return false;
    }
  } catch (error) {
    if (error instanceof UsageLimitError) throw error;
    recordRunStage("auto_review", {
      status: "failed",
      summary: `loop errored: ${(error as Error).message}`,
    });
    console.warn(`\n⚠️  Auto-review loop failed: ${(error as Error).message}`);
    console.log("   Continuing with push and PR creation...");
  }
  return true;
}

/** Push, comment, and create a PR after the commit/review phases. */
export async function publishImplementation(state: DeliveryState): Promise<void> {
  const ctx = state.context;
  const { taskKey, taskSummary, tracker, skipComments } = ctx;
  if (ctx.createPr && ctx.task) {
    const pushed = await state.helpers.pushWithHookRetry();
    if (!pushed.success) {
      console.log("   Cannot create PR without pushing branch to remote");
      return;
    }
  }

  if (
    !(state.planRetry && !ctx.createPr) &&
    taskKey &&
    tracker &&
    state.output.trim() &&
    !skipComments
  ) {
    try {
      if (!state.planRetry) console.log("\n💬 Posting implementation summary to task tracker...");
      await postImplementationComment(tracker, taskKey, state.output, taskSummary);
    } catch (error) {
      console.warn(`⚠️  Failed to post implementation comment: ${error}`);
      if (!state.planRetry) {
        console.log(
          ctx.createPr
            ? "   Push succeeded, but task tracker comment failed"
            : "   Commit succeeded, but task tracker comment failed",
        );
      }
    }
  } else if (skipComments && taskKey && !state.planRetry) {
    console.log("\n⏭️  Skipping task tracker comment posting (--skip-comments)");
  }
  if (ctx.createPr && ctx.task) {
    await state.helpers.createPrAndTransition(state.output, state.autoReviewRan);
  }
}

async function repairImplementation(state: DeliveryState) {
  const feedback = state.pendingFeedback;
  if (!feedback) return;
  state.pendingFeedback = undefined;
  if (!state.context.runRepair) {
    return { kind: "halt" as const, reason: "Implementation repair is unavailable" };
  }
  const result = await state.context.runRepair(
    buildRepairPrompt(state.context.taskContent, feedback),
  );
  if (result.kind === "halted") {
    return { kind: "halt" as const, reason: "Agent could not complete verification repairs" };
  }
  state.output = result.stdout;
  if (!(await commitImplementation(state))) {
    return { kind: "halt" as const, reason: "Verification repairs were not committed" };
  }
  return;
}

async function reportVerificationHalt(state: DeliveryState, reason: string): Promise<void> {
  const ctx = state.context;
  const { taskKey, tracker, task } = ctx;
  const report = `Verification stopped: ${reason}\n\n${state.output}`;
  if (taskKey) {
    try {
      const taskDir = join(resolveOutputDir(), taskKey.toLowerCase());
      writeFileSync(join(taskDir, "implementation-summary-incomplete.md"), report, "utf8");
    } catch (error) {
      console.warn(`⚠️  Failed to save incomplete verification summary: ${error}`);
    }
  }
  if (!(taskKey && tracker && task && !ctx.skipComments)) return;
  try {
    await tracker.postIncompleteImplementationComment(taskKey, report, ctx.taskSummary);
    recordIncompleteAttempt(
      taskKey,
      process.env.TASK_TRACKER || "jira",
      tracker.extractDescriptionText(task),
    );
  } catch (error) {
    console.warn(`⚠️  Failed to post verification failure: ${error}`);
  }
  const todoStatus = getTodoStatusForProject(resolveProjectKey(taskKey, task), ctx.projectSettings);
  if (todoStatus?.trim()) {
    try {
      await tracker.transitionStatus(taskKey, todoStatus.trim());
    } catch (error) {
      console.warn(`⚠️  Failed to move ${taskKey} back to '${todoStatus}': ${error}`);
    }
  }
}

const commitStep: TaskStep<DeliveryState> = {
  name: "commit",
  run: async (state) =>
    (await commitImplementation(state))
      ? undefined
      : { kind: "halt", reason: "Implementation was not committed" },
};

const reviewStep: TaskStep<DeliveryState> = {
  name: "auto-review",
  run: async (state) =>
    (await reviewImplementation(state))
      ? undefined
      : { kind: "halt", reason: "Pre-push validation failed" },
};

const publishStep: TaskStep<DeliveryState> = { name: "publish", run: publishImplementation };

function deliverySteps(verify: boolean): readonly TaskStep<DeliveryState>[] {
  if (!verify) return [commitStep, reviewStep, publishStep];
  return [
    commitStep,
    { name: "repair", run: repairImplementation },
    { name: "verify", run: verifyImplementation },
    reviewStep,
    publishStep,
  ];
}

/** Run the existing commit, review, and publish flow as separate steps. */
export function finalizeAgentRun(ctx: FinalizeContext): void {
  const state: DeliveryState = {
    context: ctx,
    helpers: createGitHelpers(ctx),
    output: ctx.stdoutOutput,
    committed: false,
    planRetry: false,
    autoReviewRan: false,
  };
  runTaskSteps(deliverySteps(Boolean(ctx.verify)), state)
    .then(async (result) => {
      if (result.kind === "halted" && ["repair", "verify"].includes(result.step)) {
        await reportVerificationHalt(state, result.reason);
      }
      ctx.resolve();
    })
    .catch((error: unknown) => {
      if (error instanceof UsageLimitError) {
        ctx.reject(error);
        return;
      }
      console.log(`⚠️  Failed to commit changes: ${(error as Error).message}`);
      console.log(
        'You can commit changes manually with: git add . && git commit -m "feat: implement task"',
      );
      captureError(error, { taskKey: ctx.taskKey, stage: "commit" });
      ctx.resolve();
    });
}
