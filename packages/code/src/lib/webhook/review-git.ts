import type { ResolvedHarness } from "@devintern/agent-harness";
import { GitHubAppAuth } from "../code-host/github/app-auth";
import { WorkerState } from "../state/worker-state";
import { Utils } from "../utils";
import { isCommitAlreadyComplete, runAgentHarnessToFixGitHook } from "../agent/git-hook-fixer";
import { runAutoReviewLoop } from "../review/auto-review-loop";
import { processReviewComment } from "../code-host/github/webhook";
import type { WebhookServerConfig } from "../../types/github-webhooks";

import { debugLog, resolveActiveHarness } from "./runtime";

/** Git / config context shared by the review publish helpers. */
export interface ReviewGitContext {
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  config: WebhookServerConfig;
  gitAuthor: { name: string; email: string } | undefined;
  harness: ResolvedHarness["harness"];
  executablePath: string;
  maxTurns: number;
  hookRetries: number;
}

/** Raw review comment shape accepted by {@link processReviewComment}. */
export type RawReviewComment = Parameters<typeof processReviewComment>[0];

/** Resolve the App bot identity for commit attribution, if configured. */
export async function resolveReviewGitAuthor(
  config: WebhookServerConfig,
): Promise<{ name: string; email: string } | undefined> {
  const githubAppAuth = GitHubAppAuth.fromEnvironment();
  if (!githubAppAuth) return undefined;
  try {
    const gitAuthor = await githubAppAuth.getGitAuthor();
    debugLog(config, `Commits will be authored by: ${gitAuthor.name}`);
    return gitAuthor;
  } catch (error) {
    debugLog(config, `Could not get GitHub App author info: ${(error as Error).message}`);
    return undefined;
  }
}

/** Apply the bot identity to the worktree's git config. */
export async function configureReviewGitAuthor(
  worktreePath: string,
  gitAuthor: { name: string; email: string },
  config: WebhookServerConfig,
): Promise<void> {
  await Utils.executeGitCommand(["config", "user.name", gitAuthor.name], {
    verbose: config.debug,
    cwd: worktreePath,
  });
  await Utils.executeGitCommand(["config", "user.email", gitAuthor.email], {
    verbose: config.debug,
    cwd: worktreePath,
  });
  console.log(`🤖 Git author set to: ${gitAuthor.name}`);
}

/** Drop comments this worker already addressed; returns the remaining set. */
export function filterAddressedReviewComments(
  owner: string,
  repo: string,
  allRawComments: RawReviewComment[],
): { rawComments: RawReviewComment[]; alreadyAddressed: number } {
  const workerState = new WorkerState();
  const addressedCommentIds = new Set(
    allRawComments
      .filter((c) => workerState.isCommentAddressed(`${owner}/${repo}`, "review", c.id))
      .map((c) => c.id),
  );
  workerState.close();

  const rawComments = allRawComments.filter((c) => !addressedCommentIds.has(c.id));
  return { rawComments, alreadyAddressed: allRawComments.length - rawComments.length };
}

/** Count commits that exist locally ahead of `origin/<branch>`. */
export async function countCommitsAhead(worktreePath: string, branch: string): Promise<number> {
  const result = await Utils.executeGitCommand(["rev-list", "--count", `origin/${branch}..HEAD`], {
    verbose: false,
    cwd: worktreePath,
  });
  return parseInt(result.output?.trim() || "0", 10);
}

/** Run the auto-review loop when the reviewer used an auto-review trigger. */
export async function runTriggeredAutoReview(params: {
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  config: WebhookServerConfig;
  reviewBody: string | null;
}): Promise<void> {
  const { owner, repo, prNumber, branch, baseBranch, worktreePath, config, reviewBody } = params;
  console.log(`\n🔄 Auto-review trigger detected: "${reviewBody?.trim()}"`);
  console.log("   Skipping normal review flow, running auto-review loop directly...");

  const autoReviewOutputDir = `/tmp/devintern-auto-review-${prNumber}`;
  const { harness: reviewHarness, path: reviewPath } = resolveActiveHarness();
  try {
    const autoReviewResult = await runAutoReviewLoop({
      repository: `${owner}/${repo}`,
      prNumber,
      prBranch: branch,
      baseBranch,
      harness: reviewHarness,
      executablePath: reviewPath,
      maxIterations: config.autoReviewMaxIterations,
      minPriority: "medium",
      workingDir: worktreePath,
      outputDir: autoReviewOutputDir,
    });

    if (autoReviewResult.success) {
      console.log(
        `✅ Auto-review completed successfully after ${autoReviewResult.iterations} iteration(s)`,
      );
    } else {
      console.warn(
        `⚠️  Auto-review completed but some issues remain after ${autoReviewResult.iterations} iteration(s)`,
      );
    }

    console.log(`\n✅ Successfully completed auto-review for PR #${prNumber}`);
  } catch (error) {
    console.error(`❌ Auto-review loop failed: ${(error as Error).message}`);
    // Don't fall through to normal flow - just return
  }
}

/** Restore the review branch if the agent checked out something else. */
export async function restoreReviewBranch(ctx: ReviewGitContext): Promise<boolean> {
  const currentBranch = await Utils.getCurrentBranch(ctx.worktreePath);
  if (!currentBranch || currentBranch === ctx.branch) {
    return true;
  }

  console.warn(
    `⚠️  Agent switched from '${ctx.branch}' to '${currentBranch}' during execution, switching back...`,
  );
  const switchBack = await Utils.executeGitCommand(["checkout", ctx.branch], {
    verbose: ctx.config.debug,
    cwd: ctx.worktreePath,
  });
  if (!switchBack.success) {
    // If simple checkout fails (dirty state conflicts), try stashing first
    console.warn(`   Simple checkout failed, trying stash + checkout...`);
    await Utils.executeGitCommand(["stash", "--include-untracked"], {
      verbose: false,
      cwd: ctx.worktreePath,
    });
    const switchAfterStash = await Utils.executeGitCommand(["checkout", ctx.branch], {
      verbose: ctx.config.debug,
      cwd: ctx.worktreePath,
    });
    if (!switchAfterStash.success) {
      console.error(
        `❌ Failed to switch back to branch '${ctx.branch}': ${switchAfterStash.error}`,
      );
      return false;
    }
    await Utils.executeGitCommand(["stash", "pop"], {
      verbose: false,
      cwd: ctx.worktreePath,
    });
  }
  console.log(`✅ Switched back to '${ctx.branch}'`);
  return true;
}

/** Commit changes the agent left behind, retrying through hook failures. */
export async function commitUncommittedReviewChanges(ctx: ReviewGitContext): Promise<boolean> {
  let commitAttempt = 0;
  let commitSuccess = false;

  while (commitAttempt <= ctx.hookRetries && !commitSuccess) {
    commitAttempt++;
    const commitResult = await Utils.commitChanges(
      `PR-${ctx.prNumber}`,
      `Address review feedback`,
      { verbose: ctx.config.debug, author: ctx.gitAuthor, cwd: ctx.worktreePath },
    );

    if (commitResult.success) {
      console.log("✅ Changes committed successfully");
      commitSuccess = true;
      break;
    }

    // Check if this is a git hook error that we can try to fix
    if (commitResult.hookError && commitAttempt <= ctx.hookRetries) {
      console.log(
        `\n⚠️  Git pre-commit hook failed (attempt ${commitAttempt}/${ctx.hookRetries + 1})`,
      );

      // Try to fix the hook error with agent
      const fixed = await runAgentHarnessToFixGitHook(
        "commit",
        ctx.harness,
        ctx.executablePath,
        ctx.maxTurns,
        ctx.worktreePath,
        ctx.branch,
      );

      if (fixed) {
        if (await isCommitAlreadyComplete(ctx.worktreePath)) {
          console.log("✅ Commit already completed during hook fix");
          commitSuccess = true;
          break;
        }

        console.log(`\n🔄 Retrying commit after ${ctx.harness.displayName} fixed the issues...`);
        continue;
      } else {
        console.log("\n❌ Could not fix git hook errors automatically");
        break;
      }
    } else {
      // Not a hook error or out of retries
      if (commitAttempt > ctx.hookRetries) {
        console.log(`\n❌ Max retries (${ctx.hookRetries}) exceeded for git hook fixes`);
      }
      console.error(`\n❌ Failed to commit changes: ${commitResult.message}`);
      return false;
    }
  }

  if (!commitSuccess) {
    console.error("❌ Failed to commit changes after retries");
    return false;
  }
  return true;
}

/** Validate the pre-push hook locally, asking the agent to repair failures. */
export async function validateLocalPrePushHook(
  phase: string,
  ctx: ReviewGitContext,
): Promise<boolean> {
  let attempt = 0;

  while (attempt <= ctx.hookRetries) {
    attempt++;
    const hookResult = await Utils.runPrePushHookLocally({
      verbose: ctx.config.debug,
      cwd: ctx.worktreePath,
    });

    if (hookResult.success) {
      if (attempt === 1) {
        console.log(`✅ ${hookResult.message}`);
      } else {
        console.log(`✅ Pre-push hook passed after ${attempt} attempt(s)`);
      }
      return true;
    }

    // Check if this is a hook error that we can try to fix
    if (hookResult.hookError && attempt <= ctx.hookRetries) {
      console.log(
        `\n⚠️  Pre-push hook failed during ${phase} (attempt ${attempt}/${ctx.hookRetries + 1})`,
      );

      // Try to fix the hook error with agent
      const fixed = await runAgentHarnessToFixGitHook(
        "push",
        ctx.harness,
        ctx.executablePath,
        ctx.maxTurns,
        ctx.worktreePath,
        ctx.branch,
      );

      if (fixed) {
        console.log(
          `\n🔄 Retrying local hook validation after ${ctx.harness.displayName} fixed the issues...`,
        );
        continue;
      } else {
        console.log("\n❌ Could not fix pre-push hook errors automatically");
        return false;
      }
    } else {
      // Not a hook error or out of retries
      if (attempt > ctx.hookRetries) {
        console.log(`\n❌ Max retries (${ctx.hookRetries}) exceeded for pre-push hook fixes`);
      }
      console.error(`\n❌ Pre-push hook validation failed: ${hookResult.message}`);
      return false;
    }
  }

  return false;
}

/** Optionally run the auto-review loop (skipPush), then re-validate the hook. */
export async function runAutoReviewBeforePush(
  ctx: ReviewGitContext,
): Promise<{ autoReviewRan: boolean; ok: boolean }> {
  if (!ctx.config.autoReview) {
    return { autoReviewRan: false, ok: true };
  }

  console.log("\n🔄 Running auto-review loop (without pushing)...");
  const autoReviewOutputDir = `/tmp/devintern-auto-review-${ctx.prNumber}`;
  const { harness: reviewHarness, path: reviewPath } = resolveActiveHarness();
  try {
    const autoReviewResult = await runAutoReviewLoop({
      repository: `${ctx.owner}/${ctx.repo}`,
      prNumber: ctx.prNumber,
      prBranch: ctx.branch,
      baseBranch: ctx.baseBranch,
      harness: reviewHarness,
      executablePath: reviewPath,
      maxIterations: ctx.config.autoReviewMaxIterations,
      minPriority: "medium",
      workingDir: ctx.worktreePath,
      outputDir: autoReviewOutputDir,
      skipPush: true, // Don't push during auto-review iterations
    });

    if (autoReviewResult.success) {
      console.log(
        `✅ Auto-review completed successfully after ${autoReviewResult.iterations} iteration(s)`,
      );
    } else {
      console.warn(
        `⚠️  Auto-review completed but some issues remain after ${autoReviewResult.iterations} iteration(s)`,
      );
    }

    // Re-validate local hook after auto-review (auto-review changes may have broken things)
    console.log("\n🔍 Re-validating pre-push hook after auto-review improvements...");
    if (!(await validateLocalPrePushHook("post auto-review validation", ctx))) {
      console.error("❌ Cannot proceed - auto-review changes failed pre-push hook validation");
      return { autoReviewRan: true, ok: false };
    }
    return { autoReviewRan: true, ok: true };
  } catch (error) {
    console.error(`❌ Auto-review loop failed: ${(error as Error).message}`);
    // Continue with push even if auto-review fails
    return { autoReviewRan: false, ok: true };
  }
}

/** Push the reviewed commits, retrying through pre-push hook failures. */
export async function pushReviewedChanges(
  ctx: ReviewGitContext,
  finalCommitsAhead: number,
  autoReviewRan: boolean,
): Promise<boolean> {
  console.log(
    `\n📤 Pushing ${finalCommitsAhead}${autoReviewRan ? "+ auto-review" : ""} commit(s)...`,
  );

  let pushAttempt = 0;
  let pushSuccess = false;

  while (pushAttempt <= ctx.hookRetries && !pushSuccess) {
    pushAttempt++;
    const pushResult = await Utils.pushCurrentBranch({
      verbose: ctx.config.debug,
      cwd: ctx.worktreePath,
      expectedBranch: ctx.branch,
    });

    if (pushResult.success) {
      console.log("✅ Changes pushed successfully");
      pushSuccess = true;
      break;
    }

    // Check if this is a git hook error that we can try to fix
    if (pushResult.hookError && pushAttempt <= ctx.hookRetries) {
      console.log(
        `\n⚠️  Git pre-push hook failed during actual push (attempt ${pushAttempt}/${ctx.hookRetries + 1})`,
      );

      // Try to fix the hook error with agent
      const fixed = await runAgentHarnessToFixGitHook(
        "push",
        ctx.harness,
        ctx.executablePath,
        ctx.maxTurns,
        ctx.worktreePath,
        ctx.branch,
      );

      if (fixed) {
        console.log(
          `\n🔄 Retrying push after ${ctx.harness.displayName} fixed and amended the commit...`,
        );
        continue;
      } else {
        console.log("\n❌ Could not fix git pre-push hook errors automatically");
        break;
      }
    } else {
      // Not a hook error or out of retries
      if (pushAttempt > ctx.hookRetries) {
        console.log(`\n❌ Max retries (${ctx.hookRetries}) exceeded for git hook fixes`);
      }
      console.error(`\n❌ Failed to push changes: ${pushResult.message}`);
      return false;
    }
  }

  if (!pushSuccess) {
    console.error("❌ Failed to push changes after retries");
    return false;
  }
  return true;
}

/** Validate the hook, optionally auto-review, then push the reviewed commits. */
export async function publishReviewChanges(
  ctx: ReviewGitContext,
  finalCommitsAhead: number,
): Promise<boolean> {
  // Step 1: Validate pre-push hook locally BEFORE any push
  console.log("\n🔍 Validating pre-push hook locally (before pushing)...");
  if (!(await validateLocalPrePushHook("initial validation", ctx))) {
    console.error("❌ Cannot proceed without passing pre-push hook validation");
    return false;
  }

  // Step 2: Optionally auto-review locally (with skipPush) and re-validate.
  const { autoReviewRan, ok } = await runAutoReviewBeforePush(ctx);
  if (!ok) {
    return false;
  }

  // Step 3: Now do the actual push (hooks already validated, should succeed)
  return pushReviewedChanges(ctx, finalCommitsAhead, autoReviewRan);
}

/**
 * Prepare the shared review worktree checked out to a PR branch.
 *
 * @param branch - PR head branch name
 * @param verbose - Enable verbose git logging
 * @returns Worktree path, or `null` on failure
 */
export async function prepareRepository(branch: string, verbose = false): Promise<string | null> {
  const isGitRepo = await Utils.isGitRepository();
  if (!isGitRepo) {
    console.error("❌ Not in a git repository");
    return null;
  }

  // Prepare the single reusable worktree
  console.log(`   Preparing worktree for ${branch}...`);
  const worktreeResult = await Utils.prepareReviewWorktree(branch, {
    verbose,
  });

  if (!worktreeResult.success) {
    console.error(`❌ Failed to prepare worktree: ${worktreeResult.error}`);
    return null;
  }

  console.log(`   Worktree ready at: ${worktreeResult.path}`);
  return worktreeResult.path || null;
}
