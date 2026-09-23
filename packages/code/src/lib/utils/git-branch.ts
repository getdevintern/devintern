import { Utils } from "./registry";

/**
 * Resolve the repository default branch, honoring a preferred name when present.
 *
 * The preferred name is kept when it exists locally or on `origin`. Otherwise
 * this falls back to {@link getMainBranchName} so callers that pass a stale
 * conventional default (`master` on a `main` repo, or the reverse) do not
 * issue a doomed `git fetch` for a ref the remote does not have.
 *
 * @param preferredBranch - Optional branch to prefer when it exists
 * @param options - Optional working directory
 */
export async function resolveDefaultBranch(
  preferredBranch?: string,
  options?: { cwd?: string },
): Promise<string> {
  if (preferredBranch) {
    if (
      (await Utils.gitRefExists(`refs/heads/${preferredBranch}`, options)) ||
      (await Utils.gitRefExists(`refs/remotes/origin/${preferredBranch}`, options))
    ) {
      return preferredBranch;
    }

    if (await Utils.remoteBranchExists(preferredBranch, { cwd: options?.cwd })) {
      return preferredBranch;
    }
  }

  return Utils.getMainBranchName(options);
}

/**
 * Detect the repository default branch from remote metadata, with local
 * conventional-branch fallbacks for repositories without a reachable origin.
 *
 * @param options - Optional working directory
 */
export async function getMainBranchName(options?: { cwd?: string }): Promise<string> {
  const gitOptions = options?.cwd ? { cwd: options.cwd } : undefined;

  let sshCommand = process.env.GIT_SSH_COMMAND;
  if (sshCommand === undefined) {
    const configuredSshCommand = await Utils.executeGitCommand(
      ["config", "--get", "core.sshCommand"],
      gitOptions,
    );
    if (!configuredSshCommand.success || !configuredSshCommand.output) {
      sshCommand = "ssh -o BatchMode=yes";
    }
  }

  // Ask the remote first. refs/remotes/origin/HEAD is only a local cache and can
  // remain pointed at `master` after the repository changes its default to `main`.
  const remoteHead = await Utils.executeGitCommand(["ls-remote", "--symref", "origin", "HEAD"], {
    ...gitOptions,
    timeoutMs: 5000,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      ...(sshCommand === undefined ? {} : { GIT_SSH_COMMAND: sshCommand }),
    },
  });
  if (remoteHead.success) {
    const match = remoteHead.output.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m);
    const branchName = match?.[1]?.trim();
    if (branchName) {
      return branchName;
    }
  }

  // Fall back to the cached remote HEAD when origin is temporarily unreachable.
  const cachedRemoteHead = await Utils.executeGitCommand(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    gitOptions,
  );
  if (cachedRemoteHead.success) {
    const branchName = cachedRemoteHead.output.replace("refs/remotes/origin/", "").trim();
    if (branchName) {
      return branchName;
    }
  }

  for (const branch of ["main", "master"]) {
    if (await Utils.gitRefExists(`refs/heads/${branch}`, options)) {
      return branch;
    }
    if (await Utils.gitRefExists(`refs/remotes/origin/${branch}`, options)) {
      return branch;
    }
  }

  const currentBranch = await Utils.getCurrentBranch(options?.cwd);
  if (currentBranch === "main" || currentBranch === "master") {
    return currentBranch;
  }

  return "main";
}

/**
 * Fetch a branch from `origin` so `refs/remotes/origin/<branch>` exists locally.
 *
 * @param branch - Remote branch name
 * @param options - Verbose logging and working directory
 */
export async function fetchRemoteBranch(
  branch: string,
  options?: { verbose?: boolean; cwd?: string },
): Promise<{ success: boolean; error?: string }> {
  const gitOptions = options?.cwd ? { cwd: options.cwd, verbose: options?.verbose } : options;

  const targetedFetch = await Utils.executeGitCommand(
    ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`],
    gitOptions,
  );
  if (targetedFetch.success) {
    return { success: true };
  }

  const branchFetch = await Utils.executeGitCommand(["fetch", "origin", branch], gitOptions);
  if (branchFetch.success) {
    return { success: true };
  }

  return { success: false, error: branchFetch.error ?? targetedFetch.error };
}

/**
 * Pull latest commits for a branch from `origin`.
 *
 * Resolves a missing preferred name to the repository default first so a
 * stale `master`/`main` request does not `git fetch` a ref the remote lacks.
 * Fetches the branch from `origin` when it is not available locally before checkout.
 *
 * @param branch - Branch to update
 * @param options - Verbose logging
 */
export async function pullLatestChanges(
  branch: string,
  options?: {
    verbose?: boolean;
    cwd?: string;
  },
): Promise<{ success: boolean; message: string }> {
  const verbose = options?.verbose ?? false;
  const cwd = options?.cwd;

  try {
    // Check if we're in a git repository
    if (!(await Utils.isGitRepository(cwd))) {
      return {
        success: false,
        message: "Not in a git repository",
      };
    }

    // Check for uncommitted changes
    if (await Utils.hasUncommittedChanges(cwd)) {
      return {
        success: false,
        message:
          "There are uncommitted changes — skipping the pull. They are backed up to a git stash when the feature branch is created.",
      };
    }

    const requestedBranch = branch;
    branch = await Utils.resolveDefaultBranch(requestedBranch, { cwd });
    if (verbose && branch !== requestedBranch) {
      console.log(`⚠️  Branch '${requestedBranch}' not found, trying '${branch}'...`);
    }

    const currentBranch = await Utils.getCurrentBranch(cwd);

    // Switch to target branch if not already on it
    if (currentBranch !== branch) {
      if (verbose) {
        console.log(`📥 Switching to branch '${branch}'...`);
      }
      let targetBranch = branch;
      let fetchedTargetBeforeCheckout = false;

      const targetExistsLocally =
        (await Utils.gitRefExists(`refs/heads/${targetBranch}`, { cwd })) ||
        (await Utils.gitRefExists(`refs/remotes/origin/${targetBranch}`, { cwd }));
      if (!targetExistsLocally) {
        if (verbose) {
          console.log(`📥 Fetching '${targetBranch}' from origin...`);
        }
        await Utils.fetchRemoteBranch(targetBranch, { verbose, cwd });
        fetchedTargetBeforeCheckout = true;
      }

      let switchResult = await Utils.checkoutBranch(targetBranch, { verbose, cwd });

      if (!switchResult.success && !fetchedTargetBeforeCheckout) {
        if (verbose) {
          console.log(`📥 Fetching '${targetBranch}' from origin...`);
        }
        await Utils.fetchRemoteBranch(targetBranch, { verbose, cwd });
        switchResult = await Utils.checkoutBranch(targetBranch, { verbose, cwd });
      }

      if (!switchResult.success) {
        const alternativeBranch = targetBranch === "main" ? "master" : "main";
        const alternativeExists =
          (await Utils.gitRefExists(`refs/heads/${alternativeBranch}`, { cwd })) ||
          (await Utils.gitRefExists(`refs/remotes/origin/${alternativeBranch}`, { cwd }));

        if (alternativeExists) {
          if (verbose) {
            console.log(`⚠️  Branch '${targetBranch}' not found, trying '${alternativeBranch}'...`);
          }
          targetBranch = alternativeBranch;
          switchResult = await Utils.checkoutBranch(targetBranch, { verbose, cwd });
        }
      }

      if (!switchResult.success) {
        return {
          success: false,
          message: `Failed to switch to branch '${branch}': ${switchResult.error}`,
        };
      }

      branch = targetBranch;
    }

    if (verbose) {
      console.log(`📥 Pulling latest changes for branch '${branch}'...`);
    }

    // Pull latest changes
    const pullResult = await Utils.executeGitCommand(["pull", "origin", branch], {
      verbose,
      cwd,
    });

    if (pullResult.success) {
      return {
        success: true,
        message: `Successfully pulled latest changes for '${branch}'`,
      };
    }

    return {
      success: false,
      message: `Failed to pull changes: ${pullResult.error}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Git pull failed: ${(error as Error).message}`,
    };
  }
}

Object.assign(Utils, {
  resolveDefaultBranch,
  getMainBranchName,
  fetchRemoteBranch,
  pullLatestChanges,
});
