import { existsSync, readdirSync, rmSync } from "fs";
import { basename, dirname, join } from "path";
import type { GitCommandResult, GitOptions } from "./types";
import { GIT_CLEAN_ARGS } from "./constants";
import { logVerbose } from "./general";
import { Utils } from "./registry";

/**
 * Remove a git worktree directory and unregister it from git.
 *
 * @param worktreePath - Absolute worktree path
 * @param options - Verbose logging and the owning repository directory
 *   (`git worktree remove` must run against the repo that owns the
 *   worktree; defaults to the current working directory)
 */
export async function removeReviewWorktree(
  worktreePath: string,
  options?: { verbose?: boolean; cwd?: string },
): Promise<{ success: boolean; error?: string }> {
  const verbose = options?.verbose ?? false;
  const cwd = options?.cwd;

  try {
    if (!existsSync(worktreePath)) {
      if (verbose) {
        console.log(`⏭️  Worktree does not exist: ${worktreePath}`);
      }
      return { success: true };
    }

    if (verbose) {
      console.log(`\n🗑️  Removing worktree: ${worktreePath}`);
    }

    // Try to remove via git first
    const removeResult = await Utils.executeGitCommand(
      ["worktree", "remove", worktreePath, "--force"],
      { verbose, cwd },
    );

    if (!removeResult.success) {
      if (verbose) {
        console.log(`   Git worktree remove failed, deleting directory...`);
      }
      // Forcefully delete the directory
      rmSync(worktreePath, { recursive: true, force: true });
    }

    if (verbose) {
      console.log(`✅ Worktree removed successfully`);
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Worktree removal failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Pull the latest changes for `branch` in `worktreePath`, logging when verbose.
 *
 * @param worktreePath - Worktree to pull inside
 * @param branch - Branch to pull
 * @param verbose - Whether to log progress
 */
export async function pullReviewWorktreeBranch(
  worktreePath: string,
  branch: string,
  verbose: boolean,
): Promise<void> {
  if (verbose) {
    console.log(`   Pulling latest changes...`);
  }
  await Utils.executeGitCommand(["pull", "origin", branch, "--ff-only"], {
    verbose,
    cwd: worktreePath,
  });
}

/**
 * Prepare or reuse a branch-scoped review worktree under
 * `/tmp/devintern-review-worktree-<branch>/`.
 *
 * The path is scoped to the branch so a PR's own test suite can never delete
 * the worktree the review is running in (see `getReviewWorktreePath`). The
 * same branch reuses its directory across reviews (deps stay cached);
 * worktrees from other branches are pruned to bound disk usage.
 *
 * @param branch - PR head branch to check out
 * @param options - Verbose logging
 */
export async function prepareReviewWorktree(
  branch: string,
  options?: { verbose?: boolean; cwd?: string },
): Promise<{ success: boolean; path?: string; error?: string }> {
  const verbose = options?.verbose ?? false;
  const cwd = options?.cwd;
  // Options for git commands that must run against the *source* repository
  // (worktree add/remove, fetch, branch -D). Distinct from `cwd: worktreePath`
  // calls below, which operate inside the created worktree.
  const repoOpts = { verbose, cwd };
  const repoOptsQuiet = { verbose: false, cwd };

  try {
    // Branch-scoped worktree path - one directory per PR branch
    const worktreePath = Utils.getReviewWorktreePath(branch);

    // Remove worktrees left over from reviews of other branches.
    await Utils.cleanupStaleReviewWorktrees(worktreePath, { verbose, cwd });

    logVerbose(verbose, `\n📂 Preparing review worktree for branch: ${branch}`);
    logVerbose(verbose, `   Worktree path: ${worktreePath}`);

    // Fetch latest from origin. Never with --depth: a depth-limited fetch
    // into a full clone marks the WHOLE repository shallow (.git/shallow),
    // breaking merge-base and future merges in the user's own checkout.
    // An incremental fetch only transfers missing objects anyway.
    logVerbose(verbose, `   Fetching branch ${branch} from origin...`);
    const fetchResult = await Utils.executeGitCommand(["fetch", "origin", branch], repoOpts);
    logVerbose(verbose, `   ✓ Fetch completed (success: ${fetchResult.success})`);

    if (!fetchResult.success) {
      console.warn(`⚠️  Fetch failed: ${fetchResult.error || fetchResult.output}`);
      console.warn(`   Continuing anyway - worktree may have cached version...`);
    }

    // Check if worktree directory exists on filesystem
    const worktreeExists = existsSync(worktreePath);
    logVerbose(verbose, `   Worktree directory exists: ${worktreeExists}`);

    if (worktreeExists) {
      if (await tryReuseReviewWorktree(worktreePath, branch, verbose)) {
        return { success: true, path: worktreePath };
      }

      // Worktree is corrupted or invalid - clean it up
      logVerbose(verbose, `   Worktree is invalid/corrupted, cleaning up...`);
      await removeInvalidReviewWorktree(worktreePath, repoOptsQuiet);
    }

    const created = await createReviewWorktree(
      worktreePath,
      branch,
      verbose,
      repoOpts,
      repoOptsQuiet,
    );
    if (!created.success) {
      return { success: false, error: created.error };
    }
    return { success: true, path: worktreePath };
  } catch (error) {
    return {
      success: false,
      error: `Worktree preparation failed: ${(error as Error).message}`,
    };
  }
}

/**
 * @returns Absolute path to the review worktree directory.
 *
 * @param branch - When provided, returns a *branch-scoped* path
 *   (`<base>-<sanitized-branch>`) so each PR review gets its own directory.
 *   This is what protects the live worktree: the base path is what project
 *   test suites target (either hardcoded, or via the default below), so a
 *   PR whose own tests call `prepareReviewWorktree` — e.g. devintern
 *   reviewing its own PRs — deletes the *base* path, never the branch-scoped
 *   directory the review is actually running in. Previously a single shared
 *   path meant such a test would `git worktree remove`/`rmSync` the live
 *   worktree out from under the running review, making the cwd vanish mid-run
 *   (surfacing as a misleading `posix_spawn ENOENT` when the hook-fixer agent
 *   was spawned). Without a branch, returns the base path.
 *
 * Honors `DEVINTERN_REVIEW_WORKTREE_PATH` so tests can point the base
 * worktree at an isolated directory.
 */
export function getReviewWorktreePath(branch?: string): string {
  const base = process.env.DEVINTERN_REVIEW_WORKTREE_PATH || "/tmp/devintern-review-worktree";
  if (!branch) {
    return base;
  }
  return `${base}-${sanitizeBranchForPath(branch)}`;
}

/**
 * Convert a git branch name into a filesystem-safe path segment.
 *
 * Collapses any run of characters outside `[a-zA-Z0-9._-]` (notably the `/`
 * in `feature/dev-16`) to a single `-`, then trims leading/trailing dashes.
 *
 * @param branch - Git branch name
 */
function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}

/**
 * Remove sibling review worktrees left over from reviews of *other* branches.
 *
 * With branch-scoped worktrees, each PR review creates its own directory under
 * the base path's parent. The webhook queue is sequential, so at most one is
 * live at a time; this prunes the rest to keep `/tmp` from accumulating stale
 * `node_modules`-heavy checkouts. The `keepPath` (the worktree currently being
 * prepared) is always preserved.
 *
 * @param keepPath - Branch-scoped worktree path to preserve
 * @param options - Verbose logging
 */
export async function cleanupStaleReviewWorktrees(
  keepPath: string,
  options?: { verbose?: boolean; cwd?: string },
): Promise<void> {
  const verbose = options?.verbose ?? false;
  const cwd = options?.cwd;
  const base = process.env.DEVINTERN_REVIEW_WORKTREE_PATH || "/tmp/devintern-review-worktree";
  const parent = dirname(base);
  const prefix = basename(base);
  const keepName = basename(keepPath);

  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }

  for (const entry of entries) {
    // Match the base worktree itself and any branch-scoped sibling, but never
    // the worktree we're keeping.
    if (entry !== prefix && !entry.startsWith(`${prefix}-`)) {
      continue;
    }
    if (entry === keepName) {
      continue;
    }

    const stalePath = join(parent, entry);
    if (verbose) {
      console.log(`   🧹 Removing stale review worktree: ${stalePath}`);
    }

    await Utils.executeGitCommand(["worktree", "remove", stalePath, "--force"], {
      verbose: false,
      cwd,
    });
    try {
      rmSync(stalePath, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }

  // Drop any dangling registrations the removals left behind.
  await Utils.executeGitCommand(["worktree", "prune"], { verbose: false, cwd });
}

/** Reuse an existing valid review worktree for `branch`; false when unusable. */
async function tryReuseReviewWorktree(
  worktreePath: string,
  branch: string,
  verbose: boolean,
): Promise<boolean> {
  // Check if it's a valid git worktree by testing if .git exists and is valid
  if (!existsSync(join(worktreePath, ".git"))) {
    return false;
  }

  // Try to verify it's a valid worktree
  const statusCheck = await Utils.executeGitCommand(["status", "--porcelain"], {
    verbose: false,
    cwd: worktreePath,
  });
  if (!statusCheck.success) {
    return false;
  }

  // Valid worktree - switch branch
  logVerbose(verbose, `   Switching to branch ${branch}...`);

  // Check if origin remote exists
  const originCheck = await Utils.executeGitCommand(["remote", "get-url", "origin"], {
    verbose: false,
    cwd: worktreePath,
  });
  const hasOrigin = originCheck.success;

  // Discard any leftover changes from previous reviews before switching
  await Utils.executeGitCommand(["reset", "--hard"], { verbose: false, cwd: worktreePath });
  await Utils.executeGitCommand(GIT_CLEAN_ARGS, { verbose: false, cwd: worktreePath });

  // Try checkout with -B to force create/reset branch tracking origin
  const switchResult = hasOrigin
    ? await Utils.executeGitCommand(["checkout", "-B", branch, "--track", `origin/${branch}`], {
        verbose,
        cwd: worktreePath,
      })
    : await Utils.executeGitCommand(["checkout", branch], { verbose, cwd: worktreePath });

  if (!switchResult.success) {
    return false;
  }

  // Pull latest changes if origin exists
  if (hasOrigin) {
    await Utils.pullReviewWorktreeBranch(worktreePath, branch, verbose);
  }

  // Clean again after checkout to remove any untracked files from the new branch state
  await Utils.executeGitCommand(GIT_CLEAN_ARGS, { verbose: false, cwd: worktreePath });
  logVerbose(verbose, `✅ Switched to branch ${branch}`);

  await Utils.prepareWorktreeForAgent(worktreePath, { verbose });
  return true;
}

/** Remove an invalid/corrupted review worktree and prune its registration. */
async function removeInvalidReviewWorktree(
  worktreePath: string,
  repoOptsQuiet: GitOptions,
): Promise<void> {
  // Remove from git's worktree registry (ignore errors)
  await Utils.executeGitCommand(["worktree", "remove", worktreePath, "--force"], repoOptsQuiet);

  // Remove directory itself (ignore errors)
  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  // Prune any stale worktree registrations
  await Utils.executeGitCommand(["worktree", "prune"], repoOptsQuiet);
}

/** Add a review worktree for `branch`, honoring an existing local branch. */
async function addReviewWorktree(
  worktreePath: string,
  branch: string,
  hasOrigin: boolean,
  localBranchExists: boolean,
  repoOpts: GitOptions,
  repoOptsQuiet: GitOptions,
): Promise<GitCommandResult> {
  const verbose = repoOpts?.verbose ?? false;
  if (!hasOrigin) {
    // No origin - use local branch
    return Utils.executeGitCommand(["worktree", "add", worktreePath, branch], repoOpts);
  }

  // With origin - try to create worktree tracking origin branch
  let branchExistsLocally = localBranchExists;

  if (branchExistsLocally) {
    // Local branch exists - try to delete it to avoid conflicts with -b flag
    const deleteResult = await Utils.executeGitCommand(["branch", "-D", branch], repoOptsQuiet);
    if (deleteResult.success) {
      branchExistsLocally = false;
    } else {
      logVerbose(
        verbose,
        `   Branch ${branch} could not be deleted (likely checked out elsewhere), will reuse it`,
      );
    }
  }

  if (!branchExistsLocally) {
    return Utils.executeGitCommand(
      ["worktree", "add", "--track", "-b", branch, worktreePath, `origin/${branch}`],
      repoOpts,
    );
  }

  // Branch exists and can't be deleted (e.g. checked out in main worktree)
  // Use --force to allow checkout even if branch is checked out elsewhere
  const createResult = await Utils.executeGitCommand(
    ["worktree", "add", "--force", worktreePath, branch],
    repoOpts,
  );
  if (createResult.success) {
    // Reset to origin to ensure we have the latest
    await Utils.executeGitCommand(["reset", "--hard", `origin/${branch}`], {
      verbose: false,
      cwd: worktreePath,
    });
    // Set up tracking
    await Utils.executeGitCommand(["branch", `--set-upstream-to=origin/${branch}`, branch], {
      verbose: false,
      cwd: worktreePath,
    });
  }
  return createResult;
}

/** Create a fresh review worktree, recovering from stale registrations. */
async function createReviewWorktree(
  worktreePath: string,
  branch: string,
  verbose: boolean,
  repoOpts: GitOptions,
  repoOptsQuiet: GitOptions,
): Promise<{ success: boolean; error?: string }> {
  logVerbose(verbose, `   Creating worktree at ${worktreePath}...`);

  // Check if the branch exists locally
  const localBranchCheck = await Utils.executeGitCommand(
    ["show-ref", "--verify", `refs/heads/${branch}`],
    repoOptsQuiet,
  );

  // Check if origin remote exists
  const originCheck = await Utils.executeGitCommand(["remote", "get-url", "origin"], repoOptsQuiet);
  const hasOrigin = originCheck.success;

  let createResult = await addReviewWorktree(
    worktreePath,
    branch,
    hasOrigin,
    localBranchCheck.success,
    repoOpts,
    repoOptsQuiet,
  );

  if (!createResult.success) {
    // If creation failed, it might be due to stale registrations - clean up
    const errorMsg = (createResult.error || "") + (createResult.output || "");

    if (errorMsg.includes("already registered") || errorMsg.includes("missing but")) {
      logVerbose(verbose, `   Cleaning up stale worktree registrations...`);

      // Prune stale worktrees silently
      await Utils.executeGitCommand(["worktree", "prune"], repoOptsQuiet);

      // Delete the local branch if it exists (may have been created by the failed first attempt)
      await Utils.executeGitCommand(["branch", "-D", branch], repoOptsQuiet);

      // Try again after pruning
      createResult = await addReviewWorktree(
        worktreePath,
        branch,
        hasOrigin,
        false,
        repoOpts,
        repoOptsQuiet,
      );
    } else if (
      errorMsg.includes("already exists") ||
      errorMsg.includes("already checked out") ||
      errorMsg.includes("already used by worktree")
    ) {
      // Branch exists locally and couldn't be deleted (checked out or used by another worktree)
      // Use --force to allow checkout even if branch is in use elsewhere
      logVerbose(
        verbose,
        `   Branch already exists or checked out elsewhere, creating worktree with --force...`,
      );

      createResult = await Utils.executeGitCommand(
        ["worktree", "add", "--force", worktreePath, branch],
        repoOpts,
      );

      if (createResult.success && hasOrigin) {
        // Reset to origin to ensure we have the latest
        await Utils.executeGitCommand(["reset", "--hard", `origin/${branch}`], {
          verbose: false,
          cwd: worktreePath,
        });
        await Utils.executeGitCommand(["branch", `--set-upstream-to=origin/${branch}`, branch], {
          verbose: false,
          cwd: worktreePath,
        });
      }
    }

    if (!createResult.success) {
      return {
        success: false,
        error: `Failed to create worktree: ${createResult.error || createResult.output}`,
      };
    }
  }

  logVerbose(verbose, `✅ Worktree ready at ${worktreePath}`);

  // Install dependencies to ensure Agent has everything needed
  await Utils.prepareWorktreeForAgent(worktreePath, { verbose });
  logVerbose(verbose, `✅ Worktree preparation complete!`);
  return { success: true };
}

Object.assign(Utils, {
  removeReviewWorktree,
  pullReviewWorktreeBranch,
  prepareReviewWorktree,
  getReviewWorktreePath,
  cleanupStaleReviewWorktrees,
});
