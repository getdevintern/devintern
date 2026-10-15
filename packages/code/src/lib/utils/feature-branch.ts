import { lstatSync, realpathSync, rmSync } from "fs";
import { basename, dirname, join } from "path";
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

/**
 * Check out an existing feature branch so a re-run can inherit a prior
 * attempt's work (session pickup). Prefers a local branch; falls back to
 * creating a tracking branch from `origin/<branch>` when only the remote ref
 * exists. Never creates a new branch name and never runs the destructive
 * pre-branch cleanup, so already-landed changes survive.
 *
 * @param branch - Recorded branch to resume
 * @param options.ownedWorktreeRoot - Directory containing disposable fleet
 * worktrees. Without it, branch-holding worktrees are always left untouched.
 */
export async function continueFeatureBranch(
  branch: string,
  options?: { cwd?: string; ownedWorktreeRoot?: string },
): Promise<{ success: boolean; branchName: string; message: string }> {
  const cwd = options?.cwd;
  const gitOpts = cwd ? { cwd } : undefined;
  try {
    if (!(await Utils.isGitRepository(cwd))) {
      return { success: false, branchName: branch, message: "Not in a git repository" };
    }

    // Best-effort refresh of the remote ref so a branch pushed by the prior
    // attempt is available locally.
    await Utils.executeGitCommand(["fetch", "origin", branch], gitOpts);

    const checkout = await Utils.executeGitCommand(["checkout", branch], gitOpts);
    if (checkout.success) {
      return { success: true, branchName: branch, message: `Resumed existing branch '${branch}'` };
    }

    // A fleet run interrupted by a crash keeps its worktree for debugging
    // (repo-manager), and that worktree still holds the recorded branch, so a
    // plain checkout is refused with "'<branch>' is already used by worktree at
    // ...". Git emits that on stderr (`error`), not stdout (`output`). Free the
    // branch by removing the holding worktree — keeping its commits — and retry.
    let conflict = isWorktreeConflict(checkout);
    if (conflict) {
      const freed = await removeWorktreeHoldingBranch(branch, gitOpts, options?.ownedWorktreeRoot);
      if (freed.removed) {
        const retry = await Utils.executeGitCommand(["checkout", branch], gitOpts);
        if (retry.success) {
          // Bring back any uncommitted work stashed while freeing the holder so
          // the resumed attempt inherits it rather than starting from the
          // branch's committed state alone.
          await restorePreservedStash(freed.preservedStash, gitOpts);
          return {
            success: true,
            branchName: branch,
            message: `Resumed existing branch '${branch}'`,
          };
        }
        conflict = isWorktreeConflict(retry);
      }
    }

    const remoteExists = await Utils.gitRefExists(`refs/remotes/origin/${branch}`, { cwd });
    if (remoteExists && !conflict) {
      const create = await Utils.executeGitCommand(
        ["checkout", "-b", branch, `origin/${branch}`],
        gitOpts,
      );
      if (create.success) {
        return { success: true, branchName: branch, message: `Resumed remote branch '${branch}'` };
      }
    }

    return {
      success: false,
      branchName: branch,
      message: `Could not resume branch '${branch}': ${checkout.error ?? "branch not available"}`,
    };
  } catch (error) {
    return {
      success: false,
      branchName: branch,
      message: `Git operation failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Best-effort description of work already landed on `branch` relative to a base
 * (commits and a diff stat). Returns undefined when either ref is missing or git
 * fails, so callers never treat absence as proof of no work.
 */
export async function collectLandedWork(
  branch: string,
  baseBranch: string,
  options?: { cwd?: string },
): Promise<string | undefined> {
  const gitOpts = options?.cwd ? { cwd: options.cwd } : undefined;
  try {
    const [log, stat] = await Promise.all([
      Utils.executeGitCommand(
        ["log", "--oneline", "--no-decorate", `${baseBranch}..${branch}`],
        gitOpts,
      ),
      Utils.executeGitCommand(["diff", "--stat", `${baseBranch}...${branch}`], gitOpts),
    ]);
    const sections: string[] = [];
    if (log.success && log.output.trim()) {
      sections.push(`Commits:\n${log.output.trim()}`);
    }
    if (stat.success && stat.output.trim()) {
      sections.push(`Changes:\n${stat.output.trim()}`);
    }

    // An interrupted fleet run keeps its worktree, and that worktree may hold
    // edits the agent never committed. Surface them here so the resumed prompt
    // does not present the branch as covering only its committed state.
    const held = await findWorktreeHoldingPath(branch, gitOpts);
    if (held) {
      const status = await Utils.executeGitCommand(["status", "--porcelain"], { cwd: held });
      if (status.success && status.output.trim()) {
        sections.push(
          `Uncommitted changes left in the interrupted worktree ` +
            `(preserved and restored when the branch is resumed):\n${status.output.trim()}`,
        );
      }
    }
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  } catch {
    return undefined;
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

/** Whether a failed checkout was refused because a worktree holds the branch. */
function isWorktreeConflict(result: GitCommandResult): boolean {
  return (
    Boolean(result.error?.includes("already used by worktree")) ||
    result.output.includes("already used by worktree")
  );
}

/** Path of the worktree currently holding `branchName`, if any. */
async function findWorktreeHoldingPath(
  branchName: string,
  gitOpts: GitOptions,
): Promise<string | null> {
  const worktreeListResult = await Utils.executeGitCommand(
    ["worktree", "list", "--porcelain"],
    gitOpts,
  );
  if (!worktreeListResult.success) {
    return null;
  }
  return findWorktreePathForBranch(worktreeListResult.output, branchName);
}

/** Outcome of freeing a branch from the worktree that held it. */
interface FreeWorktreeResult {
  /** True only when the worktree was actually removed. */
  removed: boolean;
  /** Stash message of uncommitted work preserved from the worktree, if any. */
  preservedStash?: string;
}

/**
 * Outcome of trying to preserve a worktree's uncommitted work before removal.
 *
 * `unpreservable` means the state could not be checked, or dirty work could
 * not be stashed. Removal would risk discarding the edits pickup protects.
 */
type PreserveResult =
  | { kind: "clean" }
  | { kind: "preserved"; stash: string }
  | { kind: "unpreservable" };

/**
 * Preserve uncommitted changes left in `worktreePath` by stashing them. Stash
 * entries live in the repository shared by every worktree, so they outlive the
 * worktree's removal and can be restored on the resumed branch.
 *
 * @returns "preserved" with the stash message when work was stashed, "clean"
 * when the worktree had nothing to lose, and "unpreservable" when its state
 * could not be checked or dirty work could not be stashed.
 */
async function preserveUncommittedWork(
  worktreePath: string,
  branchName: string,
): Promise<PreserveResult> {
  const status = await Utils.executeGitCommand(["status", "--porcelain"], { cwd: worktreePath });
  if (!status.success) {
    return { kind: "unpreservable" };
  }
  if (!status.output.trim()) {
    return { kind: "clean" };
  }

  const message = `devintern: recovered uncommitted work from worktree holding ${branchName}`;
  const stash = await Utils.executeGitCommand(
    ["stash", "push", "--include-untracked", "-m", message],
    { cwd: worktreePath },
  );
  if (!stash.success) {
    console.warn(
      `⚠️  Could not preserve uncommitted changes in ${worktreePath}: ${
        stash.error ?? "stash failed"
      }`,
    );
    return { kind: "unpreservable" };
  }
  console.log(`💾 Preserved uncommitted work from ${worktreePath} as stash: ${message}`);
  return { kind: "preserved", stash: message };
}

/** Restore a stash preserved by {@link preserveUncommittedWork} onto the current branch. */
async function restorePreservedStash(
  message: string | undefined,
  gitOpts: GitOptions,
): Promise<void> {
  if (!message) {
    return;
  }
  const list = await Utils.executeGitCommand(["stash", "list"], gitOpts);
  const entry = list.output.split("\n").find((line) => line.includes(message));
  const ref = entry?.split(":")[0]?.trim();
  if (!ref) {
    console.warn(`⚠️  Preserved work stash not found; it remains available via 'git stash list'`);
    return;
  }
  const pop = await Utils.executeGitCommand(["stash", "pop", ref], gitOpts);
  if (pop.success) {
    console.log(`✅ Restored preserved uncommitted work from stash ${ref}`);
  } else {
    console.warn(`⚠️  Could not restore preserved work from ${ref}: ${pop.error ?? "pop failed"}`);
    console.warn("   It is still available via 'git stash list'.");
  }
}

/**
 * Remove the worktree holding `branchName` so the branch can be checked out,
 * without deleting the branch ref itself (resume must keep its commits).
 *
 * Any uncommitted edits the interrupted attempt left behind are stashed first
 * so force-removing the worktree does not silently discard them. When the tree
 * is dirty and stashing fails, the removal is aborted and the holder is left in
 * place: losing the edits is worse than failing to resume.
 *
 * @returns whether the worktree was actually removed, plus the preserved stash.
 */
async function removeWorktreeHoldingBranch(
  branchName: string,
  gitOpts: GitOptions,
  ownedWorktreeRoot: string | undefined,
): Promise<FreeWorktreeResult> {
  const worktreeToRemove = await findWorktreeHoldingPath(branchName, gitOpts);
  if (!worktreeToRemove) {
    return { removed: false };
  }

  // Only disposable fleet worktrees may be removed. A primary checkout has a
  // .git directory; linked worktrees have a .git file. Resolve paths to prevent
  // a symlink inside the owned root from granting ownership of another tree.
  try {
    if (
      !ownedWorktreeRoot ||
      dirname(realpathSync(worktreeToRemove)) !== realpathSync(ownedWorktreeRoot) ||
      basename(worktreeToRemove) === "base" ||
      !lstatSync(join(worktreeToRemove, ".git")).isFile()
    ) {
      return { removed: false };
    }
  } catch {
    return { removed: false };
  }

  console.log(`⚠️  Branch '${branchName}' is checked out in ${worktreeToRemove}, freeing it...`);
  const preservation = await preserveUncommittedWork(worktreeToRemove, branchName);
  if (preservation.kind === "unpreservable") {
    console.warn(
      `⚠️  Refusing to remove worktree at ${worktreeToRemove}: it holds uncommitted ` +
        `changes that could not be stashed. Leaving it in place to avoid data loss.`,
    );
    return { removed: false };
  }
  const preservedStash = preservation.kind === "preserved" ? preservation.stash : undefined;

  const removeResult = await Utils.executeGitCommand(
    ["worktree", "remove", worktreeToRemove, "--force"],
    gitOpts,
  );
  if (!removeResult.success) {
    // Git can refuse removal of a primary, locked, or submodule-containing
    // checkout. Never bypass that refusal with a recursive filesystem delete.
    return { removed: false, ...(preservedStash ? { preservedStash } : {}) };
  }

  // Report the real outcome: the holder must actually be gone, otherwise the
  // caller cannot check the branch out and must not be told it was freed.
  const stillHeld = await findWorktreeHoldingPath(branchName, gitOpts);
  const removed = !stillHeld;
  if (removed) {
    console.log(`✅ Freed branch '${branchName}' from worktree at ${worktreeToRemove}`);
  } else {
    console.warn(`⚠️  Could not free branch '${branchName}' from worktree at ${worktreeToRemove}`);
  }
  return { removed, ...(preservedStash ? { preservedStash } : {}) };
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
  continueFeatureBranch,
  collectLandedWork,
});
