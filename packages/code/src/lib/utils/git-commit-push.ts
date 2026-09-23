import { Utils } from "./registry";

/**
 * Park uncommitted work (including untracked files) in a labelled stash
 * entry so a following `reset --hard` / `clean` cannot destroy it.
 *
 * Best-effort: a failure is reported but never blocks the workflow, which
 * then falls back to the plain destructive cleanup.
 *
 * @param label - Task key (or similar) recorded in the stash message
 * @param options - Optional git working directory
 * @returns Whether a stash entry was created
 */
export async function stashWorkingDirectory(
  label: string,
  options?: { cwd?: string },
): Promise<boolean> {
  const cwd = options?.cwd;

  if (!(await Utils.hasUncommittedChanges(cwd))) {
    return false;
  }

  const message = `devintern-code: pre-branch backup for ${label}`;
  const stashResult = await Utils.executeGitCommand(
    [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      message,
      // Repo-wide (the cleanup that follows resets the whole tree), minus the
      // tool's own state directory — stashing it away would delete the live
      // SQLite database just as surely as `git clean` would.
      "--",
      ":/",
      // `top` anchors the exclusion at the repo root; without it the pattern
      // is relative to the cwd and a run started from a subdirectory would
      // still stash away the project's state directory.
      ":(top,exclude,glob)**/.devintern-code/**",
    ],
    options,
  );

  if (!stashResult.success) {
    console.warn(`⚠️  Could not back up uncommitted changes: ${stashResult.error}`);
    console.warn("   They will be discarded by the cleanup below.");
    return false;
  }

  const stashSha = await Utils.executeGitCommand(["rev-parse", "stash@{0}"], options);
  const restoreRef = stashSha.success ? stashSha.output : "stash@{0}";

  console.log(`🧺 Backed up uncommitted changes to a git stash ("${message}")`);
  console.log(`   Restore with: git stash apply ${restoreRef}`);
  return true;
}

/**
 * Stage all changes and create an implementation commit.
 *
 * @param taskKey - JIRA issue key for the commit message
 * @param taskSummary - Issue summary for the commit message
 * @param options - Verbose logging, author override, and cwd
 */
export async function commitChanges(
  taskKey: string,
  taskSummary: string,
  options?: {
    verbose?: boolean;
    author?: { name: string; email: string };
    cwd?: string;
  },
): Promise<{ success: boolean; message: string; hookError?: string }> {
  const verbose = options?.verbose ?? false;
  const author = options?.author;
  const cwd = options?.cwd;

  try {
    // Check if we're in a git repository
    if (!(await Utils.isGitRepository(cwd))) {
      return {
        success: false,
        message: "Not in a git repository",
      };
    }

    // Safety check: prevent commits directly to protected branches
    const currentBranch = await Utils.getCurrentBranch(cwd);
    if (currentBranch && (await Utils.isProtectedBranch(currentBranch, cwd))) {
      return {
        success: false,
        message: `Cannot commit directly to protected branch '${currentBranch}'. Please create a feature branch first.`,
      };
    }

    // Check if there are any changes to commit
    if (!(await Utils.hasUncommittedChanges(cwd))) {
      return {
        success: false,
        message: "No changes to commit",
      };
    }

    // Add all changes. `-A` without a pathspec stages the entire working
    // tree even when git runs from a subdirectory (e.g. a monorepo
    // package), whereas `git add .` silently limits staging to the cwd and
    // produces a partial commit.
    const addResult = await Utils.executeGitCommand(["add", "-A"], {
      verbose,
      cwd,
    });
    if (!addResult.success) {
      return {
        success: false,
        message: `Failed to stage changes: ${addResult.error}`,
      };
    }

    // Create commit message
    const commitMessage = `feat: implement ${taskKey} - ${taskSummary}`;

    // Build commit command with optional author override
    const commitArgs: string[] = [];

    // If author is provided, use -c flags to override user.name and user.email
    if (author) {
      commitArgs.push("-c", `user.name=${author.name}`);
      commitArgs.push("-c", `user.email=${author.email}`);
    }

    commitArgs.push("commit", "-m", commitMessage);

    // Commit changes
    const commitResult = await Utils.executeGitCommand(commitArgs, {
      verbose,
      cwd,
    });
    if (commitResult.success) {
      // Post-commit guard: the working tree must be clean now. A dirty tree
      // means the commit is partial (e.g. hooks generated or modified files
      // during the commit). Sweep the remainder into the same commit once;
      // if the tree still isn't clean, fail loudly so callers don't push an
      // incomplete commit or open an incomplete PR.
      if (await Utils.hasUncommittedChanges(cwd)) {
        const amendAdd = await Utils.executeGitCommand(["add", "-A"], { verbose, cwd });
        const amendArgs = author
          ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`]
          : [];
        amendArgs.push("commit", "--amend", "--no-edit");
        const amendResult = amendAdd.success
          ? await Utils.executeGitCommand(amendArgs, { verbose, cwd })
          : amendAdd;
        if (!amendResult.success || (await Utils.hasUncommittedChanges(cwd))) {
          return {
            success: false,
            message: `Commit for ${taskKey} was created but the working tree still has uncommitted changes; refusing to continue with a partial commit. Please review and commit the remaining changes manually.`,
          };
        }
      }
      return {
        success: true,
        message: `Successfully committed changes for ${taskKey}`,
      };
    }

    // Treat any commit failure as a potential hook/fixable error
    // The full error context (stdout + stderr) will be passed to Agent
    // to diagnose and fix. This is more generic than keyword matching and
    // handles all types of commit failures (hooks, linting, tests, etc.)
    const fullError = [commitResult.error, commitResult.output].filter(Boolean).join("\n").trim();

    return {
      success: false,
      message: `Failed to commit changes: ${commitResult.error}`,
      hookError: fullError || commitResult.error,
    };
  } catch (error) {
    return {
      success: false,
      message: `Git commit failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Push the current branch to `origin`, setting upstream on first push.
 *
 * @param options - Push safety, verbose logging, and working directory
 */
export async function pushCurrentBranch(options?: {
  verbose?: boolean;
  cwd?: string;
  expectedBranch?: string;
  expectedRemoteSha?: string;
}): Promise<{
  success: boolean;
  message: string;
  hookError?: string;
}> {
  const verbose = options?.verbose ?? false;
  const cwd = options?.cwd;
  const expectedBranch = options?.expectedBranch;
  const expectedRemoteSha = options?.expectedRemoteSha;

  try {
    // Get current branch name (from the specified working directory)
    const currentBranch = await Utils.getCurrentBranch(cwd);
    if (!currentBranch) {
      return {
        success: false,
        message: "Could not determine current branch",
      };
    }

    // Safety check: refuse to push if the worktree's HEAD is not on the
    // branch we expect. A misbehaving test in the PR's own tree (e.g. one
    // that `git init`s and commits fixture data into the worktree) can leave
    // HEAD detached or pointing at a stray branch like `tracking-test`.
    // Pushing blindly from that state publishes junk branches to the remote.
    // This is NOT a fixable hook error, so we hard-stop without retrying.
    if (expectedBranch && currentBranch !== expectedBranch) {
      return {
        success: false,
        message: `Refusing to push: worktree HEAD is on '${currentBranch}' but expected '${expectedBranch}'. The worktree git state was likely corrupted (e.g. by a test that manipulates git); aborting to avoid pushing a stray branch.`,
      };
    }

    // Safety check: prevent pushing protected branches (this is unusual but could happen)
    if (await Utils.isProtectedBranch(currentBranch)) {
      return {
        success: false,
        message: `Cannot push protected branch '${currentBranch}'. This should not happen - please create a feature branch.`,
      };
    }

    if (expectedRemoteSha) {
      const descendant = await Utils.executeGitCommand(
        ["merge-base", "--is-ancestor", expectedRemoteSha, "HEAD"],
        { cwd },
      );
      if (!descendant.success) {
        return {
          success: false,
          message: `Refusing to push: HEAD is not descended from expected remote commit '${expectedRemoteSha}'.`,
        };
      }
    }

    // If the agent (or a previous attempt) already published this exact
    // commit, do not invoke `git push`. A no-op push still runs pre-push
    // hooks, and a flaky hook (e.g. a 30s test timeout) would abort PR
    // creation for a branch that is already on the remote.
    if (await Utils.remoteTrackingRefMatchesHead(currentBranch, { cwd })) {
      if (verbose) {
        console.log(
          `📤 Branch '${currentBranch}' already matches origin/${currentBranch}; skipping push`,
        );
      }
      return {
        success: true,
        message: `Branch '${currentBranch}' is already on remote`,
      };
    }

    if (verbose) {
      console.log(`📤 Pushing branch '${currentBranch}' to remote...`);
    }

    // Check if remote branch exists
    const remoteBranchExists = await Utils.executeGitCommand(
      ["ls-remote", "--heads", "origin", currentBranch],
      { verbose, cwd },
    );

    let pushResult;
    if (expectedRemoteSha || (remoteBranchExists.success && remoteBranchExists.output.trim())) {
      // The ancestry check above guarantees this update is a fast-forward.
      // Use a normal push so no conflict-resolution path can overwrite
      // remote history, even with a lease. A concurrent update is rejected
      // by Git and handled as divergence below.
      pushResult = await Utils.executeGitCommand(["push", "origin", currentBranch], {
        verbose,
        cwd,
      });
      if (pushResult.success) {
        return {
          success: true,
          message: `Successfully pushed '${currentBranch}' to remote`,
        };
      }
    } else {
      // Remote branch doesn't exist, push with -u flag to set upstream
      pushResult = await Utils.executeGitCommand(["push", "-u", "origin", currentBranch], {
        verbose,
        cwd,
      });
      if (pushResult.success) {
        return {
          success: true,
          message: `Successfully pushed '${currentBranch}' to remote and set upstream`,
        };
      }
    }

    // Check if this is a non-fixable git state error
    const fullError = [pushResult.error, pushResult.output].filter(Boolean).join("\n").trim();

    // Hook output can contain arbitrary text from the repository's test
    // suite, including simulated non-fast-forward diagnostics from
    // Git-related tests. Establish divergence from repository state after
    // every failed push instead of trusting any output string. This also
    // catches races whose server-side rejection omits the usual markers.
    const latestRemote = await Utils.executeGitCommand(
      ["ls-remote", "--heads", "origin", currentBranch],
      { verbose: false, cwd },
    );
    const remoteSha = latestRemote.success
      ? latestRemote.output.trim().split(/\s+/, 1)[0]
      : undefined;
    let remoteDiverged = false;

    if (remoteSha) {
      const remoteIsAncestor = await Utils.executeGitCommand(
        ["merge-base", "--is-ancestor", remoteSha, "HEAD"],
        { verbose: false, cwd },
      );
      remoteDiverged = !remoteIsAncestor.success;
    }

    // Non-fast-forward and similar errors are not fixable by @devintern/code
    // They require manual intervention (pull, rebase, or force push)
    if (remoteDiverged) {
      return {
        success: false,
        message: `Push rejected - branch diverged from remote. Run 'git pull --rebase' or 'git push --force' (dangerous): ${pushResult.error}`,
        // Don't mark as hookError since this is not fixable by @devintern/code
      };
    }

    // Treat other push failures as potential hook/fixable errors
    // The full error context (stdout + stderr) will be passed to Agent
    // A failing pre-push hook writes its diagnostics to stdout while git
    // itself only emits one stderr line ("error: failed to push some refs
    // to ..."); surfacing only stderr hides which hook command failed.
    return {
      success: false,
      message: `Failed to push branch: ${fullError || pushResult.error}`,
      hookError: fullError || pushResult.error,
    };
  } catch (error) {
    return {
      success: false,
      message: `Git push failed: ${(error as Error).message}`,
    };
  }
}

Object.assign(Utils, {
  stashWorkingDirectory,
  commitChanges,
  pushCurrentBranch,
});
