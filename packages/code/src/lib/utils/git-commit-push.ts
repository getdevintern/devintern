import { executeGitCommandWithConfigLockRetry, hasConfigLockError } from "./git-exec";
import { hasUncommittedWork, stageWorkTreeChanges } from "./git-stage";
import { Utils } from "./registry";

/**
 * Park uncommitted work (including untracked files) in a labelled stash
 * commit so a following `reset --hard` / `clean` cannot destroy it. The
 * commit is then moved to `refs/devintern/backups/<label>-<timestamp>` and
 * dropped from the stash stack shared by every worktree of the repository.
 *
 * Best-effort: a failure is reported but never blocks the workflow, which
 * then falls back to the plain destructive cleanup.
 *
 * @param label - Task key (or similar) recorded in the stash message
 * @param options - Optional git working directory
 * @returns Whether a backup was created
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

  const moved = await moveStashToBackupRef(label, message, options);
  if (moved.ok) {
    console.log(`🧺 Backed up uncommitted changes to ${moved.ref} ("${message}")`);
    console.log(`   Restore with: git stash apply ${moved.sha}`);
  } else {
    console.warn(`⚠️  Could not move the backup off the git stash stack: ${moved.reason}`);
    console.log(`🧺 Backed up uncommitted changes to a git stash ("${message}")`);
    console.log(`   Restore with: git stash apply ${moved.sha ?? "stash@{0}"}`);
  }

  await pruneOldBackupRefs(options);
  return true;
}

/** Namespace for pre-branch backups, kept apart from the shared `refs/stash`. */
const BACKUP_REF_PREFIX = "refs/devintern/backups/";

const BACKUP_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const BACKUP_PRUNE_LIMIT = 50;

type BackupMoveResult =
  | { ok: true; ref: string; sha: string }
  | { ok: false; reason: string; sha?: string };

/**
 * Turn a label into a single `git check-ref-format`-safe path component.
 *
 * @param label - Free-form task label
 * @returns Sanitized component (never empty)
 */
function sanitizeBackupRefLabel(label: string): string {
  const cleaned = label
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return cleaned || "backup";
}

/**
 * Store the stash entry just created by {@link stashWorkingDirectory} under a
 * DevIntern-owned ref and drop it from `refs/stash`, which every worktree of
 * the repository shares. Only the entry carrying this run's message is moved,
 * and it is dropped by index after re-checking its SHA, so a concurrent stash
 * from a sibling worktree is never touched. On any failure the stash entry is
 * left in place.
 *
 * @param label - Task label used for the ref name
 * @param message - Exact stash message passed to `git stash push`
 * @param options - Optional git working directory
 */
async function moveStashToBackupRef(
  label: string,
  message: string,
  options?: { cwd?: string },
): Promise<BackupMoveResult> {
  const list = await Utils.executeGitCommand(["stash", "list", "--format=%H%x09%s"], options);
  if (!list.success) {
    return { ok: false, reason: list.error ?? "git stash list failed" };
  }

  // Newest first: the first entry with our message is the one just pushed
  // (subject is "On <branch>: <message>" or "WIP on …" style with our text).
  const entries = list.output.split("\n").filter(Boolean);
  const index = entries.findIndex((line) =>
    line.slice(line.indexOf("\t") + 1).endsWith(`: ${message}`),
  );
  if (index === -1) {
    return { ok: false, reason: "the new stash entry was not found" };
  }
  const sha = entries[index].split("\t")[0];

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const ref = `${BACKUP_REF_PREFIX}${sanitizeBackupRefLabel(label)}-${timestamp}`;
  // The empty old value makes this create-only, so an existing ref is never clobbered.
  const update = await Utils.executeGitCommand(
    ["update-ref", "-m", message, ref, sha, ""],
    options,
  );
  if (!update.success) {
    return { ok: false, reason: update.error ?? "git update-ref failed", sha };
  }

  const stashRef = `stash@{${index}}`;
  const current = await Utils.executeGitCommand(
    ["rev-parse", "--verify", "--quiet", stashRef],
    options,
  );
  if (!current.success || current.output !== sha) {
    // The stack moved under us; the backup is safe under `ref`, leave the stash alone.
    return { ok: true, ref, sha };
  }

  const drop = await Utils.executeGitCommand(["stash", "drop", "--quiet", stashRef], options);
  if (!drop.success) {
    console.warn(
      `⚠️  Backup saved to ${ref}, but its stash entry could not be dropped: ${drop.error}`,
    );
  }
  return { ok: true, ref, sha };
}

/**
 * Delete backup refs older than the retention window. Bounded per call and
 * best-effort: failures are ignored.
 *
 * @param options - Optional git working directory
 */
async function pruneOldBackupRefs(options?: { cwd?: string }): Promise<void> {
  const refs = await Utils.executeGitCommand(
    ["for-each-ref", "--format=%(refname)%09%(committerdate:unix)", BACKUP_REF_PREFIX],
    options,
  );
  if (!refs.success || !refs.output) return;

  const cutoff = Math.floor(Date.now() / 1000) - BACKUP_RETENTION_SECONDS;
  const stale = refs.output
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([name, date]) => name && Number(date) > 0 && Number(date) < cutoff)
    .slice(0, BACKUP_PRUNE_LIMIT);

  for (const [name] of stale) {
    await Utils.executeGitCommand(["update-ref", "-d", name], options);
  }
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

    // Check if there are any changes to commit. Untracked sandbox
    // placeholders (`/dev/null` mounts, or the empty files they leave behind)
    // are not changes: `git status --porcelain` would count them.
    const workDir = cwd ?? process.cwd();
    const work = hasUncommittedWork(workDir);
    if (!work.success) {
      return { success: false, message: `Failed to check for changes: ${work.error}` };
    }
    if (!work.dirty) {
      return {
        success: false,
        message: "No changes to commit",
      };
    }

    // Stage the entire working tree (from its top level even when git runs
    // from a monorepo package subdirectory) except sandbox placeholders.
    // `git add -A` would fail fatally on a `/dev/null` mount or commit the
    // empty file a mount point leaves behind.
    const staged = stageWorkTreeChanges(workDir);
    if (!staged.success) {
      return {
        success: false,
        message: `Failed to stage changes: ${staged.error}`,
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
      if (hasUncommittedWork(workDir).dirty) {
        const restaged = stageWorkTreeChanges(workDir);
        const amendArgs = author
          ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`]
          : [];
        amendArgs.push("commit", "--amend", "--no-edit");
        const amendResult = restaged.success
          ? await Utils.executeGitCommand(amendArgs, { verbose, cwd })
          : restaged;
        const after = hasUncommittedWork(workDir);
        if (!amendResult.success || !after.success || after.dirty) {
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
        // `push -u` exits 0 even when recording the upstream lost the shared
        // config lock to a concurrent task. Nothing here depends on the
        // upstream (pushes name origin/<branch> explicitly), so restore it
        // best-effort for interactive use without failing delivery.
        if (hasConfigLockError(pushResult)) {
          await executeGitCommandWithConfigLockRetry(
            ["branch", `--set-upstream-to=origin/${currentBranch}`, currentBranch],
            { verbose, cwd },
          );
        }
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
