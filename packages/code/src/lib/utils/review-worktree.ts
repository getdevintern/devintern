import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import type { GitCommandResult, GitOptions } from "./types";
import { GIT_CLEAN_ARGS } from "./constants";
import { logVerbose } from "./general";
import { Utils } from "./registry";
import { withRepoGitLock } from "./repo-git-lock";
import {
  acquireReviewWorktreeLease,
  deleteReviewWorktreeLease,
  isReviewWorktreeLeased,
  readReviewWorktreeLease,
  releaseReviewWorktreeLease,
} from "./review-worktree-lease";

/** Idle review worktrees kept per repository never drop below this. */
export const REVIEW_WORKTREE_MIN_IDLE_CAP = 2;

/** Idle review worktrees unused for longer than this are always removed. */
export const REVIEW_WORKTREE_IDLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Env var the worker sets on PR job subprocesses so their cleanup keeps as
 * many idle worktrees per repository as can run at once.
 */
export const MAX_CONCURRENCY_PER_REPO_ENV = "DEVINTERN_MAX_CONCURRENCY_PER_REPO";

/**
 * Idle review worktrees kept per repository: `max(maxConcurrencyPerRepo, 2)`.
 *
 * @param maxConcurrencyPerRepo - Per-repo job limit; read from
 *   {@link MAX_CONCURRENCY_PER_REPO_ENV} when omitted (1 when unset)
 */
export function reviewWorktreeIdleCap(maxConcurrencyPerRepo?: number): number {
  const fromEnv = Number.parseInt(process.env[MAX_CONCURRENCY_PER_REPO_ENV] ?? "", 10);
  const limit = maxConcurrencyPerRepo ?? (Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 1);
  return Math.max(limit, REVIEW_WORKTREE_MIN_IDLE_CAP);
}

function reviewWorktreeBasePath(): string {
  return process.env.DEVINTERN_REVIEW_WORKTREE_PATH || "/tmp/devintern-review-worktree";
}

/**
 * Absolute common git directory of the repository at `cwd` (the bare clone,
 * or a checkout's `.git`); null outside a repository.
 */
async function resolveGitCommonDir(cwd?: string): Promise<string | null> {
  const result = await Utils.executeGitCommand(["rev-parse", "--git-common-dir"], {
    verbose: false,
    cwd,
  });
  const dir = result.output.trim();
  if (!result.success || !dir) return null;
  return isAbsolute(dir) ? dir : resolve(cwd || process.cwd(), dir);
}

/** Run `fn` under the repository's git metadata lock when the repo resolved. */
function withOptionalGitLock<T>(gitDir: string | null, fn: () => Promise<T>): Promise<T> {
  return gitDir && existsSync(gitDir) ? withRepoGitLock(gitDir, fn) : fn();
}

/**
 * Common git directory that owns a linked worktree, read from its `.git`
 * file (`gitdir: <common>/worktrees/<name>`); null when it is not one.
 */
function worktreeOwnerGitDir(worktreePath: string): string | null {
  try {
    const dotGit = readFileSync(join(worktreePath, ".git"), "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(dotGit);
    if (!match) return null;
    const adminDir = resolve(worktreePath, match[1]!.trim());
    let common = "../..";
    try {
      common = readFileSync(join(adminDir, "commondir"), "utf8").trim() || common;
    } catch {
      // Older layouts: <common>/worktrees/<name>
    }
    return resolve(adminDir, common);
  } catch {
    return null;
  }
}

/**
 * Release this process's lease on a review worktree without removing it, so
 * a later review of the same branch can reuse it (dependencies stay cached)
 * and cleanup can count it as idle. Call in `finally` after the job.
 */
export function releaseReviewWorktree(worktreePath: string): void {
  releaseReviewWorktreeLease(worktreePath);
}

/**
 * Remove a git worktree directory and unregister it from git.
 *
 * A worktree leased by another live process is left in place.
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
    const lease = readReviewWorktreeLease(worktreePath);
    if (lease && lease.pid !== process.pid && isReviewWorktreeLeased(worktreePath)) {
      logVerbose(verbose, `⏭️  Worktree ${worktreePath} is in use by pid ${lease.pid}; keeping it`);
      return { success: true };
    }
    if (!existsSync(worktreePath)) {
      deleteReviewWorktreeLease(worktreePath);
      if (verbose) {
        console.log(`⏭️  Worktree does not exist: ${worktreePath}`);
      }
      return { success: true };
    }

    if (verbose) {
      console.log(`\n🗑️  Removing worktree: ${worktreePath}`);
    }

    const gitDir = worktreeOwnerGitDir(worktreePath) ?? (await resolveGitCommonDir(cwd));
    await withOptionalGitLock(gitDir, async () => {
      // Try to remove via git first
      const removeResult = await Utils.executeGitCommand(
        ["worktree", "remove", worktreePath, "--force"],
        { verbose, cwd: gitDir && existsSync(gitDir) ? gitDir : cwd },
      );

      if (!removeResult.success) {
        if (verbose) {
          console.log(`   Git worktree remove failed, deleting directory...`);
        }
        // Forcefully delete the directory
        rmSync(worktreePath, { recursive: true, force: true });
      }
    });
    deleteReviewWorktreeLease(worktreePath);

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
 * same branch reuses its directory across reviews (deps stay cached).
 *
 * The worktree is leased to this process from here until
 * {@link releaseReviewWorktree} / {@link removeReviewWorktree} (or until the
 * process exits), so concurrent PR jobs' cleanups leave it alone. Idle
 * worktrees of other branches are pruned down to a per-repository cap. The
 * shared git metadata steps (fetch, worktree add, branch updates) run under
 * the repository's git metadata lock; the dependency install does not.
 *
 * @param branch - PR head branch to check out
 * @param options - Verbose logging; `installDependencies: false` skips the
 *   package install for read-only agents (the merge-safety review reads the
 *   diff and code; CI has already built and tested the PR)
 */
export async function prepareReviewWorktree(
  branch: string,
  options?: { verbose?: boolean; cwd?: string; installDependencies?: boolean },
): Promise<{ success: boolean; path?: string; error?: string }> {
  const verbose = options?.verbose ?? false;
  const cwd = options?.cwd;
  const installDependencies = options?.installDependencies ?? true;
  // Options for git commands that must run against the *source* repository
  // (worktree add/remove, fetch, branch -D). Distinct from `cwd: worktreePath`
  // calls below, which operate inside the created worktree.
  const repoOpts = { verbose, cwd };
  const repoOptsQuiet = { verbose: false, cwd };

  // Branch-scoped worktree path - one directory per PR branch
  const worktreePath = Utils.getReviewWorktreePath(branch);
  let leased = false;
  try {
    acquireReviewWorktreeLease(worktreePath);
    leased = true;

    // Remove idle worktrees left over from reviews of other branches.
    await Utils.cleanupStaleReviewWorktrees(worktreePath, { verbose, cwd });

    logVerbose(verbose, `\n📂 Preparing review worktree for branch: ${branch}`);
    logVerbose(verbose, `   Worktree path: ${worktreePath}`);

    const gitDir = await resolveGitCommonDir(cwd);
    const prepared = await withOptionalGitLock(gitDir, async () => {
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
          return { success: true };
        }

        // Worktree is corrupted or invalid - clean it up
        logVerbose(verbose, `   Worktree is invalid/corrupted, cleaning up...`);
        await removeInvalidReviewWorktree(worktreePath, repoOptsQuiet);
      }

      return createReviewWorktree(worktreePath, branch, verbose, repoOpts, repoOptsQuiet);
    });
    if (!prepared.success) {
      releaseReviewWorktreeLease(worktreePath);
      return { success: false, error: prepared.error };
    }

    // Install dependencies so agents that build or test have what they need.
    // Outside the git lock: installs take minutes and touch only the worktree.
    if (installDependencies) await Utils.prepareWorktreeForAgent(worktreePath, { verbose });
    logVerbose(verbose, `✅ Worktree preparation complete!`);
    return { success: true, path: worktreePath };
  } catch (error) {
    if (leased) releaseReviewWorktreeLease(worktreePath);
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
  const base = reviewWorktreeBasePath();
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

/** An idle review worktree considered for removal. */
interface IdleReviewWorktree {
  path: string;
  /** Last use: the directory mtime, stamped when its lease is released. */
  lastUsedMs: number;
}

/**
 * Remove idle sibling review worktrees left over from reviews of other
 * branches, bounding `/tmp` disk use without touching live ones.
 *
 * - Worktrees with a live lease (a running job, in any process) are skipped.
 *   A lease whose pid is dead counts as idle.
 * - Per owning repository, idle worktrees unused for more than
 *   {@link REVIEW_WORKTREE_IDLE_MAX_AGE_MS} are removed, then the oldest
 *   others until at most `idleCap` remain ({@link reviewWorktreeIdleCap}).
 * - The `keepPath` (the worktree being prepared) and the bare base path
 *   (`/tmp/devintern-review-worktree`, the path project test suites target)
 *   are never removed.
 *
 * Each repository's removals run under its git metadata lock and re-check
 * the lease right before removing, so a job that leases a worktree while the
 * cleanup runs keeps it.
 *
 * @param keepPath - Branch-scoped worktree path to preserve
 * @param options - Verbose logging, the source repository, the idle cap, and
 *   a clock for tests
 */
export async function cleanupStaleReviewWorktrees(
  keepPath: string,
  options?: { verbose?: boolean; cwd?: string; idleCap?: number; now?: number },
): Promise<void> {
  const verbose = options?.verbose ?? false;
  const cwd = options?.cwd;
  const now = options?.now ?? Date.now();
  const idleCap = options?.idleCap ?? reviewWorktreeIdleCap();
  const base = reviewWorktreeBasePath();
  const parent = dirname(base);
  const prefix = basename(base);
  const keepName = basename(keepPath);

  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }

  // Group idle candidates by the repository that owns them ("" = orphaned
  // directories with no readable worktree link).
  const groups = new Map<string, IdleReviewWorktree[]>();
  for (const entry of entries) {
    if (!entry.startsWith(`${prefix}-`) || entry === keepName) continue;
    const path = join(parent, entry);
    let lastUsedMs: number;
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) continue;
      lastUsedMs = stat.mtimeMs;
    } catch {
      continue;
    }
    if (isReviewWorktreeLeased(path, now)) continue;
    const owner = worktreeOwnerGitDir(path) ?? "";
    const group = groups.get(owner) ?? [];
    group.push({ path, lastUsedMs });
    groups.set(owner, group);
  }

  for (const [owner, idle] of groups) {
    idle.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    const expired = idle.filter((item) => now - item.lastUsedMs > REVIEW_WORKTREE_IDLE_MAX_AGE_MS);
    const fresh = idle.filter((item) => !expired.includes(item));
    const overCap = fresh.slice(0, Math.max(0, fresh.length - idleCap));
    const doomed = [...expired, ...overCap];
    if (doomed.length === 0) continue;

    const ownerDir = owner && existsSync(owner) ? owner : null;
    await withOptionalGitLock(ownerDir, async () => {
      for (const { path } of doomed) {
        // Re-check under the lock: a job may have leased it meanwhile.
        if (isReviewWorktreeLeased(path)) continue;
        if (verbose) {
          console.log(`   🧹 Removing idle review worktree: ${path}`);
        }
        if (ownerDir) {
          await Utils.executeGitCommand(["worktree", "remove", path, "--force"], {
            verbose: false,
            cwd: ownerDir,
          });
        }
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          // Ignore
        }
        deleteReviewWorktreeLease(path);
      }
      if (ownerDir) {
        await Utils.executeGitCommand(["worktree", "prune"], { verbose: false, cwd: ownerDir });
      }
    });
  }

  // Drop dangling registrations (including ones from old worktree paths) in
  // the source repository too.
  const sourceGitDir = await resolveGitCommonDir(cwd);
  if (sourceGitDir && !groups.has(sourceGitDir)) {
    await withOptionalGitLock(sourceGitDir, () =>
      Utils.executeGitCommand(["worktree", "prune"], { verbose: false, cwd }),
    );
  }
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
  return { success: true };
}

Object.assign(Utils, {
  removeReviewWorktree,
  pullReviewWorktreeBranch,
  prepareReviewWorktree,
  getReviewWorktreePath,
  cleanupStaleReviewWorktrees,
  releaseReviewWorktree,
});
