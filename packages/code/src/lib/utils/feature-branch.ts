import { rmSync } from "fs";
import type { GitCommandResult, GitOptions } from "./types";
import { GIT_CLEAN_ARGS } from "./constants";
import { Utils } from "./registry";

/**
 * Create and check out a `feature/{task-key}` branch from the default base.
 *
 * @param taskKey - JIRA issue key used in the branch name
 * @param baseBranch - Optional explicit base branch
 */
export async function createFeatureBranch(
  taskKey: string,
  baseBranch?: string,
  options?: { cwd?: string },
): Promise<{ success: boolean; branchName: string; message: string }> {
  const baseBranchName = `feature/${taskKey.toLowerCase()}`;
  let branchName = baseBranchName;
  let attemptCounter = 1;
  const cwd = options?.cwd;
  const gitOpts = cwd ? { cwd } : undefined;

  try {
    // Check if we're in a git repository
    if (!(await Utils.isGitRepository(cwd))) {
      return {
        success: false,
        branchName,
        message: "Not in a git repository",
      };
    }

    // Clean up any uncommitted changes and untracked files before creating branch
    // This ensures a clean state for the new feature branch
    console.log("🧹 Cleaning up working directory before creating feature branch...");

    // The cleanup below is destructive, so park any pre-existing work in a
    // stash entry first: the tree still ends up clean, but nothing is lost.
    await Utils.stashWorkingDirectory(taskKey, gitOpts);

    // Reset any staged or modified files
    const resetResult = await Utils.executeGitCommand(["reset", "--hard", "HEAD"], gitOpts);
    if (!resetResult.success) {
      console.warn(`⚠️  Failed to reset changes: ${resetResult.error}`);
    }

    // Remove untracked files and directories
    const cleanResult = await Utils.executeGitCommand(GIT_CLEAN_ARGS, gitOpts);
    if (!cleanResult.success) {
      console.warn(`⚠️  Failed to clean untracked files: ${cleanResult.error}`);
    }

    console.log("✅ Working directory cleaned");

    // Switch to target branch first (or main/master if not specified)
    const target = await resolveFeatureBaseBranch(baseBranch, cwd);
    if ("error" in target) {
      return {
        success: false,
        branchName,
        message: target.error,
      };
    }
    const { targetBranch, createFromRemote } = target;

    await syncFeatureBaseBranch(targetBranch, createFromRemote, gitOpts);

    // Find an available branch name by checking for existing branches.
    // Remote refs count as taken too: on a fresh clone, a previous attempt's
    // branch (and its PR) exists only as origin/<name>.
    const available = await findAvailableFeatureBranchName(baseBranchName, gitOpts);
    branchName = available.branchName;
    attemptCounter = available.attemptCounter;

    // Check if the branch is being used by a worktree and clean it up if needed
    await cleanupWorktreeHoldingBranch(branchName, gitOpts);

    // Create and checkout new branch from target branch
    const createResult = await createFeatureBranchRef(
      branchName,
      targetBranch,
      createFromRemote,
      gitOpts,
    );

    if (createResult.success) {
      const message =
        attemptCounter === 1
          ? `Created and switched to new branch '${branchName}' from ${targetBranch}`
          : `Created and switched to new branch '${branchName}' from ${targetBranch} (previous attempts existed)`;

      return {
        success: true,
        branchName,
        message,
      };
    }
    return {
      success: false,
      branchName,
      message: `Failed to create branch: ${createResult.error}`,
    };
  } catch (error) {
    return {
      success: false,
      branchName,
      message: `Git operation failed: ${(error as Error).message}`,
    };
  }
}

/** Resolve and check out the base branch, tolerating worktree-locked branches. */
async function resolveFeatureBaseBranch(
  baseBranch: string | undefined,
  cwd: string | undefined,
): Promise<{ targetBranch: string; createFromRemote: boolean } | { error: string }> {
  let targetBranch = baseBranch
    ? await Utils.resolveDefaultBranch(baseBranch, { cwd })
    : await Utils.getMainBranchName({ cwd });
  const currentBranch = await Utils.getCurrentBranch(cwd);

  // Track whether we should create branch from remote ref instead of local checkout
  let createFromRemote = false;

  if (currentBranch !== targetBranch) {
    let switchResult = await Utils.checkoutBranch(targetBranch, { cwd });

    // If checkout failed and we're trying a default branch (not user-specified),
    // try the alternative default branch
    if (!switchResult.success && !baseBranch) {
      const alternativeBranch = targetBranch === "main" ? "master" : "main";
      const alternativeExists =
        (await Utils.gitRefExists(`refs/heads/${alternativeBranch}`, { cwd })) ||
        (await Utils.gitRefExists(`refs/remotes/origin/${alternativeBranch}`, { cwd }));

      if (alternativeExists) {
        console.log(`⚠️  Branch '${targetBranch}' not found, trying '${alternativeBranch}'...`);
        targetBranch = alternativeBranch;
        switchResult = await Utils.checkoutBranch(alternativeBranch, { cwd });
      }
    }

    // Handle worktree conflict - target branch is locked by another worktree
    if (!switchResult.success && switchResult.error?.includes("already used by worktree")) {
      console.log(
        `⚠️  Target branch '${targetBranch}' is locked by a worktree, will create branch from remote...`,
      );
      createFromRemote = true;
    } else if (!switchResult.success) {
      return {
        error: `Failed to switch to ${targetBranch} branch: ${switchResult.error}`,
      };
    }
  }

  return { targetBranch, createFromRemote };
}

/** Fetch or pull the resolved base branch before branching from it. */
async function syncFeatureBaseBranch(
  targetBranch: string,
  createFromRemote: boolean,
  gitOpts: GitOptions,
): Promise<void> {
  if (createFromRemote) {
    // Fetch the target branch from remote without checking it out
    console.log(`📥 Fetching latest '${targetBranch}' from remote...`);
    const fetchResult = await Utils.executeGitCommand(
      ["fetch", "origin", `${targetBranch}:refs/remotes/origin/${targetBranch}`],
      gitOpts,
    );
    if (!fetchResult.success) {
      console.log(`⚠️  Failed to fetch '${targetBranch}': ${fetchResult.error}`);
      console.log("   Will try to create branch from local reference...");
    }
    return;
  }

  // Ensure target branch is up to date with remote
  console.log(`📥 Pulling latest changes for target branch '${targetBranch}'...`);
  const pullResult = await Utils.executeGitCommand(["pull", "origin", targetBranch], gitOpts);
  if (!pullResult.success) {
    console.log(`⚠️  Failed to pull latest changes for '${targetBranch}': ${pullResult.error}`);
    console.log("   Continuing with local version of the branch...");
  }
}

/**
 * Find an available branch name by checking for existing branches.
 *
 * Remote refs count as taken too: on a fresh clone, a previous attempt's
 * branch (and its PR) exists only as origin/<name>.
 */
async function findAvailableFeatureBranchName(
  baseBranchName: string,
  gitOpts: GitOptions,
): Promise<{ branchName: string; attemptCounter: number }> {
  let branchName = baseBranchName;
  let attemptCounter = 1;

  while (true) {
    const localExists = await Utils.executeGitCommand(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      gitOpts,
    );
    const remoteExists = localExists.success
      ? { success: true }
      : await Utils.executeGitCommand(
          ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
          gitOpts,
        );

    if (!localExists.success && !remoteExists.success) {
      // Branch doesn't exist, we can use this name
      break;
    }

    // Branch exists, try next attempt
    attemptCounter++;
    branchName = `${baseBranchName}-attempt-${attemptCounter}`;
  }

  return { branchName, attemptCounter };
}

/** Locate the worktree path holding `branchName` from `worktree list --porcelain`. */
function findWorktreePathForBranch(porcelain: string, branchName: string): string | null {
  const lines = porcelain.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("worktree ")) continue;

    const path = lines[i].substring("worktree ".length);
    // Check if this worktree has our branch
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("worktree "); j++) {
      if (lines[j] === `branch refs/heads/${branchName}`) {
        return path;
      }
    }
  }
  return null;
}

/** Remove any worktree currently holding `branchName`, then drop the branch. */
async function cleanupWorktreeHoldingBranch(
  branchName: string,
  gitOpts: GitOptions,
): Promise<void> {
  const worktreeListResult = await Utils.executeGitCommand(
    ["worktree", "list", "--porcelain"],
    gitOpts,
  );

  if (
    !worktreeListResult.success ||
    !worktreeListResult.output.includes(`branch refs/heads/${branchName}`)
  ) {
    return;
  }

  console.log(`⚠️  Branch '${branchName}' is checked out in a worktree, cleaning up...`);
  const worktreeToRemove = findWorktreePathForBranch(worktreeListResult.output, branchName);

  if (worktreeToRemove) {
    const removeResult = await Utils.executeGitCommand(
      ["worktree", "remove", worktreeToRemove, "--force"],
      gitOpts,
    );

    if (!removeResult.success) {
      // Try to forcibly delete the worktree directory and prune
      try {
        rmSync(worktreeToRemove, { recursive: true, force: true });
      } catch {
        // Ignore deletion errors
      }
      await Utils.executeGitCommand(["worktree", "prune"], gitOpts);
    }
    console.log(`✅ Cleaned up worktree at ${worktreeToRemove}`);
  }

  // Delete the branch if it still exists (it might after worktree removal)
  await Utils.executeGitCommand(["branch", "-D", branchName], gitOpts);
}

/** Create `branchName` from the target ref, recovering from worktree conflicts. */
async function createFeatureBranchRef(
  branchName: string,
  targetBranch: string,
  createFromRemote: boolean,
  gitOpts: GitOptions,
): Promise<GitCommandResult> {
  // When createFromRemote is true, we couldn't checkout targetBranch (worktree
  // conflict), so create from the remote or local reference instead.
  const createFromRef = createFromRemote ? `origin/${targetBranch}` : undefined; // undefined means create from HEAD (current branch)

  let createResult = await Utils.executeGitCommand(
    createFromRef ? ["checkout", "-b", branchName, createFromRef] : ["checkout", "-b", branchName],
    gitOpts,
  );

  // If creating from remote ref failed, try the local branch ref
  if (!createResult.success && createFromRemote) {
    console.log(`⚠️  Failed to create from origin/${targetBranch}, trying local ref...`);
    createResult = await Utils.executeGitCommand(
      ["checkout", "-b", branchName, targetBranch],
      gitOpts,
    );
  }

  // Handle worktree conflict that wasn't caught by the proactive check
  if (!createResult.success && createResult.error?.includes("already used by worktree")) {
    console.log(`⚠️  Branch '${branchName}' is still locked by a worktree, forcing cleanup...`);

    // Extract worktree path from error message
    const match = createResult.error.match(/already used by worktree at '([^']+)'/);
    if (match) {
      const worktreePath = match[1];

      // Force remove the worktree
      await Utils.executeGitCommand(["worktree", "remove", worktreePath, "--force"], gitOpts);

      // Also try to delete directory if still exists
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignore
      }

      // Prune worktree registry
      await Utils.executeGitCommand(["worktree", "prune"], gitOpts);

      // Delete the branch
      await Utils.executeGitCommand(["branch", "-D", branchName], gitOpts);

      console.log(`✅ Force cleaned up worktree at ${worktreePath}`);

      // Retry branch creation with same ref strategy
      createResult = await Utils.executeGitCommand(
        createFromRef
          ? ["checkout", "-b", branchName, createFromRef]
          : ["checkout", "-b", branchName],
        gitOpts,
      );
    }
  }

  return createResult;
}

Object.assign(Utils, {
  createFeatureBranch,
});
