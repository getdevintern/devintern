import { existsSync, statSync } from "fs";
import { join } from "path";
import { Utils } from "./registry";

/**
 * Resolve the directory containing git hooks, respecting `core.hooksPath`
 * (falling back to `.git/hooks`, shared across worktrees).
 *
 * @param cwd - Repository working directory
 * @returns The hook directory, or `error` when the git dir cannot be found
 */
async function resolveHookDir(cwd: string): Promise<{ hookDir?: string; error?: string }> {
  const hooksPathResult = await Utils.executeGitCommand(["config", "--get", "core.hooksPath"], {
    verbose: false,
    cwd,
  });

  if (hooksPathResult.success && hooksPathResult.output?.trim()) {
    const configured = hooksPathResult.output.trim();
    if (configured.startsWith("/")) {
      return { hookDir: configured };
    }
    // Relative core.hooksPath is resolved from the repo root.
    const repoRootResult = await Utils.executeGitCommand(["rev-parse", "--show-toplevel"], {
      verbose: false,
      cwd,
    });
    return repoRootResult.success && repoRootResult.output?.trim()
      ? { hookDir: join(repoRootResult.output.trim(), configured) }
      : { hookDir: configured };
  }

  // Use --git-common-dir to find hooks in worktrees (hooks are shared).
  const gitDirResult = await Utils.executeGitCommand(["rev-parse", "--git-common-dir"], {
    verbose: false,
    cwd,
  });
  if (!gitDirResult.success || !gitDirResult.output?.trim()) {
    return { error: "Could not determine .git directory" };
  }
  const gitDir = gitDirResult.output.trim();
  // Handle both absolute and relative git dir paths.
  return { hookDir: gitDir.startsWith("/") ? join(gitDir, "hooks") : join(cwd, gitDir, "hooks") };
}

/**
 * Run the local `pre-push` hook without pushing (dry validation).
 *
 * @param options - Verbose logging and working directory
 */
export async function runPrePushHookLocally(options?: {
  verbose?: boolean;
  cwd?: string;
}): Promise<{
  success: boolean;
  message: string;
  hookError?: string;
}> {
  const verbose = options?.verbose ?? false;
  const cwd = options?.cwd ?? process.cwd();

  try {
    // Get current branch
    const currentBranch = await Utils.getCurrentBranch(cwd);
    if (!currentBranch) {
      return {
        success: false,
        message: "Could not determine current branch",
      };
    }

    // Find the hook path (respects core.hooksPath configuration)
    const hookResolution = await resolveHookDir(cwd);
    if (hookResolution.error) {
      return {
        success: false,
        message: hookResolution.error,
      };
    }
    const hookPath = join(hookResolution.hookDir ?? "", "pre-push");

    // Check if hook exists
    if (!existsSync(hookPath)) {
      if (verbose) {
        console.log("   No pre-push hook found, skipping local validation");
      }
      return {
        success: true,
        message: "No pre-push hook found (nothing to validate)",
      };
    }

    // Check if hook is executable (on Unix systems)
    try {
      const stats = statSync(hookPath);
      const isExecutable = (stats.mode & 0o111) !== 0;
      if (!isExecutable) {
        if (verbose) {
          console.log("   Pre-push hook exists but is not executable, skipping");
        }
        return {
          success: true,
          message: "Pre-push hook is not executable (skipping)",
        };
      }
    } catch {
      // On Windows or if stat fails, try running anyway
    }

    // Get remote URL
    const remoteUrlResult = await Utils.executeGitCommand(["remote", "get-url", "origin"], {
      verbose: false,
      cwd,
    });
    if (!remoteUrlResult.success || !remoteUrlResult.output?.trim()) {
      return {
        success: false,
        message: "Could not get remote URL for origin",
      };
    }
    const remoteUrl = remoteUrlResult.output.trim();

    // Get local SHA (HEAD)
    const localShaResult = await Utils.executeGitCommand(["rev-parse", "HEAD"], {
      verbose: false,
      cwd,
    });
    if (!localShaResult.success || !localShaResult.output?.trim()) {
      return {
        success: false,
        message: "Could not get local HEAD SHA",
      };
    }
    const localSha = localShaResult.output.trim();

    // Get remote SHA (origin/branch) - may be all zeros if branch doesn't exist remotely
    const remoteShaResult = await Utils.executeGitCommand(
      ["rev-parse", `origin/${currentBranch}`],
      { verbose: false, cwd },
    );
    const remoteSha =
      remoteShaResult.success && remoteShaResult.output?.trim()
        ? remoteShaResult.output.trim()
        : "0000000000000000000000000000000000000000";

    // Construct the stdin content for the pre-push hook
    const stdinContent = `refs/heads/${currentBranch} ${localSha} refs/heads/${currentBranch} ${remoteSha}\n`;

    if (verbose) {
      console.log(`   Running pre-push hook: ${hookPath}`);
      console.log(`   Remote: origin (${remoteUrl})`);
      console.log(`   Branch: ${currentBranch}`);
      console.log(`   Local SHA: ${localSha.substring(0, 8)}`);
      console.log(`   Remote SHA: ${remoteSha.substring(0, 8)}`);
    }

    // Run the pre-push hook
    const { spawn } = require("child_process");

    return new Promise((resolve) => {
      const hookProcess = spawn(hookPath, ["origin", remoteUrl], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Git sets these environment variables when running hooks
          GIT_DIR: undefined, // Let git determine this
        },
      });

      let stdout = "";
      let stderr = "";

      hookProcess.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        stdout += output;
        if (verbose) {
          process.stdout.write(output);
        }
      });

      hookProcess.stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        stderr += output;
        if (verbose) {
          process.stderr.write(output);
        }
      });

      hookProcess.on("error", (error: Error) => {
        resolve({
          success: false,
          message: `Failed to run pre-push hook: ${error.message}`,
          hookError: error.message,
        });
      });

      hookProcess.on("close", (code: number | null) => {
        const fullOutput = [stdout, stderr].filter(Boolean).join("\n").trim();

        if (code === 0) {
          resolve({
            success: true,
            message: "Pre-push hook passed",
          });
        } else {
          resolve({
            success: false,
            message: `Pre-push hook failed with exit code ${code}`,
            hookError: fullOutput || `Hook exited with code ${code}`,
          });
        }
      });

      // Send the stdin content to the hook
      hookProcess.stdin.write(stdinContent);
      hookProcess.stdin.end();
    });
  } catch (error) {
    return {
      success: false,
      message: `Failed to run pre-push hook: ${(error as Error).message}`,
      hookError: (error as Error).message,
    };
  }
}

Object.assign(Utils, {
  runPrePushHookLocally,
});
