import { spawn } from "child_process";
import { statSync } from "fs";
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

/** Git's message when another process holds a config file's `.lock`. */
export const CONFIG_LOCK_ERROR = /could not lock config file/i;

/** Delays between retries of a git command that lost the config lock race. */
const CONFIG_LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

/** Whether a git result reports a failed config lock (on stderr or stdout). */
export function hasConfigLockError(result: { output?: string; error?: string }): boolean {
  return CONFIG_LOCK_ERROR.test(result.error ?? "") || CONFIG_LOCK_ERROR.test(result.output ?? "");
}

/** Captures the config path from git's "could not lock config file" message. */
const CONFIG_LOCK_PATH = /could not lock config file (.+?): File exists/i;

/**
 * Explain a config lock failure caused by a sandbox placeholder rather than a
 * concurrent git process.
 *
 * Git writes its lock files with content and removes them within
 * milliseconds. An empty, read-only `config.lock` that persists is instead the
 * mount point a bubblewrap sandbox (e.g. Claude Code's) creates when it masks
 * the config of a repository it was granted write access to. It stays until
 * that sandboxed command exits, so no retry backoff outlasts it.
 *
 * @param result - A failed git result
 * @returns A hint to append to the error, or undefined when the lock looks
 *   like an ordinary one (or is already gone).
 */
export function describeConfigLockPlaceholder(result: {
  output?: string;
  error?: string;
}): string | undefined {
  const match = CONFIG_LOCK_PATH.exec(`${result.error ?? ""}\n${result.output ?? ""}`);
  if (!match?.[1]) return undefined;
  const lockPath = `${match[1]}.lock`;
  try {
    const stat = statSync(lockPath);
    if (!stat.isFile() || stat.size !== 0 || (stat.mode & 0o222) !== 0) return undefined;
  } catch {
    return undefined;
  }
  return (
    `${lockPath} is an empty read-only file, which is the mount point a sandboxed agent ` +
    `leaves while one of its commands runs (not a lock held by git). It clears when that ` +
    `command exits; do not delete it by hand. Check that no agent sandbox is granted write ` +
    `access to the shared repository directory itself.`
  );
}

/**
 * Run a git command that may write the shared config, retrying with backoff
 * while another process holds `config.lock`. Git never waits for that lock
 * itself; the holder is usually a concurrent task's own config write (a
 * `checkout -b` with tracking, a `push --set-upstream`) that finishes within
 * milliseconds. Fleet worktrees share one bare clone's config, so these races
 * are routine there.
 *
 * Only failed results are retried: a command that exits 0 while warning about
 * the lock (e.g. `push -u` that pushed but could not record the upstream) is
 * returned as-is so the caller decides whether the missing config matters.
 * The command must be safe to re-run after a lock failure.
 *
 * @param args - Git CLI arguments (without `git` prefix)
 * @param options - Options forwarded to `executeGitCommand`
 */
export async function executeGitCommandWithConfigLockRetry(
  args: string[],
  options?: {
    verbose?: boolean;
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ success: boolean; output: string; error?: string }> {
  let result = await Utils.executeGitCommand(args, options);
  for (const delayMs of CONFIG_LOCK_RETRY_DELAYS_MS) {
    if (result.success || !hasConfigLockError(result)) {
      return result;
    }
    await Bun.sleep(delayMs);
    result = await Utils.executeGitCommand(args, options);
  }
  const placeholder = result.success ? undefined : describeConfigLockPlaceholder(result);
  return placeholder
    ? { ...result, error: `${result.error ?? ""}\n${placeholder}`.trim() }
    : result;
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
    // `--track` writes `branch.<name>.*` into the (possibly shared) config;
    // `-B` makes the retry safe after a lock failure left the ref behind.
    const trackCheckout = await executeGitCommandWithConfigLockRetry(
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
