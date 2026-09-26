import { spawn } from "child_process";
import { Utils } from "./registry";

/**
 * Execute a git subprocess and capture stdout/stderr.
 *
 * @param args - Git CLI arguments (without `git` prefix)
 * @param options - Verbose logging and working directory
 */
export async function executeGitCommand(
  args: string[],
  options?: {
    verbose?: boolean;
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ success: boolean; output: string; error?: string }> {
  const verbose = options?.verbose ?? false;
  const cwd = options?.cwd;

  if (verbose) {
    console.log(`🔧 Executing: git ${args.join(" ")}${cwd ? ` (in ${cwd})` : ""}`);
  }

  return new Promise((resolve) => {
    const useProcessGroup = Boolean(options?.timeoutMs) && process.platform !== "win32";
    const git = spawn("git", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd || process.cwd(),
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      detached: useProcessGroup,
    });

    let output = "";
    let error = "";
    let settled = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null, spawnError?: Error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (settled) {
        return;
      }
      settled = true;
      const result = {
        success: !timedOut && !spawnError && code === 0,
        output: output.trim(),
        error: timedOut
          ? `Git command timed out after ${options?.timeoutMs}ms`
          : spawnError?.message || error.trim(),
      };

      if (verbose) {
        if (!result.success) {
          console.error(`❌ Git command failed (exit code ${code})`);
          if (result.error) {
            console.error(`   Error: ${result.error}`);
          }
          if (result.output) {
            console.error(`   Output: ${result.output}`);
          }
        } else {
          console.log(`✅ Git command succeeded`);
        }
      }

      resolve(result);
    };

    git.stdout.on("data", (data) => {
      const text = data.toString();
      output += text;
      if (verbose) {
        process.stdout.write(text);
      }
    });

    git.stderr.on("data", (data) => {
      const text = data.toString();
      error += text;
      if (verbose) {
        process.stderr.write(text);
      }
    });

    git.on("error", (spawnError) => finish(null, spawnError));
    git.on("close", (code) => finish(code));

    if (options?.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        let killedProcessGroup = false;
        if (useProcessGroup && git.pid) {
          try {
            process.kill(-git.pid, "SIGKILL");
            killedProcessGroup = true;
          } catch {
            // The process may have exited between the timeout and termination.
          }
        }
        if (process.platform === "win32" && git.pid) {
          const taskkill = spawn("taskkill", ["/PID", String(git.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          taskkill.on("error", () => git.kill("SIGKILL"));
          taskkill.on("close", (code) => {
            if (code !== 0) {
              git.kill("SIGKILL");
            }
          });
          return;
        }
        if (!killedProcessGroup) {
          git.kill("SIGKILL");
        }
      }, options.timeoutMs);
    }
  });
}

/** @returns `true` when the current directory is inside a git repository */
export async function isGitRepository(cwd?: string): Promise<boolean> {
  const result = await Utils.executeGitCommand(["rev-parse", "--git-dir"], { cwd });
  return result.success;
}

/**
 * Get the current checked-out branch name.
 *
 * @param cwd - Optional git working directory
 */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  const result = await Utils.executeGitCommand(["branch", "--show-current"], {
    cwd,
  });
  return result.success ? result.output : null;
}

/**
 * Check for staged or unstaged changes in the working tree.
 *
 * @param cwd - Optional git working directory
 */
export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  const result = await Utils.executeGitCommand(["status", "--porcelain"], {
    cwd,
  });
  return result.success && result.output.length > 0;
}

/**
 * Test whether a git ref exists locally.
 *
 * @param ref - Full ref name (e.g. `refs/heads/main`)
 * @param options - Optional working directory
 */
export async function gitRefExists(ref: string, options?: { cwd?: string }): Promise<boolean> {
  const result = await Utils.executeGitCommand(
    ["show-ref", "--verify", "--quiet", ref],
    options?.cwd ? { cwd: options.cwd } : undefined,
  );
  return result.success;
}

/**
 * Check whether a branch exists on the `origin` remote.
 *
 * @param branch - Branch name (without `refs/heads/` prefix)
 * @param options - Verbose logging and working directory
 */
export async function remoteBranchExists(
  branch: string,
  options?: {
    verbose?: boolean;
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<boolean> {
  const result = await Utils.executeGitCommand(["ls-remote", "--heads", "origin", branch], {
    ...options,
    timeoutMs: options?.timeoutMs ?? 5000,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      ...options?.env,
    },
  });
  return result.success && result.output.trim().length > 0;
}

/**
 * Check out a branch, creating a tracking branch from origin when needed.
 *
 * @param branch - Branch name to check out
 * @param options - Verbose logging and working directory
 */
export async function checkoutBranch(
  branch: string,
  options?: { verbose?: boolean; cwd?: string },
): Promise<{ success: boolean; error?: string }> {
  const localCheckout = await Utils.executeGitCommand(["checkout", branch], options);
  if (localCheckout.success) {
    return { success: true };
  }

  const remoteRef = `origin/${branch}`;
  if (await Utils.gitRefExists(`refs/remotes/${remoteRef}`, options)) {
    const trackCheckout = await Utils.executeGitCommand(
      ["checkout", "-B", branch, "--track", remoteRef],
      options,
    );
    if (trackCheckout.success) {
      return { success: true };
    }
    return { success: false, error: trackCheckout.error };
  }

  return { success: false, error: localCheckout.error };
}

/**
 * Whether local HEAD is already published at `origin/<branch>`.
 *
 * Uses the remote-tracking ref (no network). A successful `git push`
 * updates that ref, so this is a reliable "already pushed" check that
 * does not re-run pre-push hooks.
 *
 * @param branch - Remote branch name without `refs/heads/`
 * @param options - Optional working directory
 */
export async function remoteTrackingRefMatchesHead(
  branch: string,
  options?: { cwd?: string },
): Promise<boolean> {
  const gitOptions = options?.cwd ? { cwd: options.cwd } : undefined;
  const head = await Utils.executeGitCommand(["rev-parse", "HEAD"], gitOptions);
  if (!head.success || !head.output.trim()) {
    return false;
  }
  const remote = await Utils.executeGitCommand(
    ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
    gitOptions,
  );
  if (!remote.success || !remote.output.trim()) {
    return false;
  }
  return head.output.trim() === remote.output.trim();
}

/**
 * Test whether a branch name is a protected integration branch.
 *
 * @param branch - Branch name (defaults to current branch)
 */
export async function isProtectedBranch(branch?: string, cwd?: string): Promise<boolean> {
  try {
    const currentBranch = branch || (await Utils.getCurrentBranch(cwd));
    if (!currentBranch) {
      return false;
    }

    const protectedBranches = ["main", "master", "develop", "development", "staging", "production"];
    return protectedBranches.includes(currentBranch.toLowerCase());
  } catch {
    return false;
  }
}

Object.assign(Utils, {
  executeGitCommand,
  isGitRepository,
  getCurrentBranch,
  hasUncommittedChanges,
  gitRefExists,
  remoteBranchExists,
  checkoutBranch,
  remoteTrackingRefMatchesHead,
  isProtectedBranch,
});
