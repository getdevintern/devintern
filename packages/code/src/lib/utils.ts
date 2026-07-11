import { fetchWithRetry as sharedFetchWithRetry } from "@devintern/utils";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { basename, dirname, join } from "path";

export class Utils {
  /**
   * Ensure a directory exists, creating it recursively when missing.
   *
   * @param dirPath - Directory path to create
   */
  static ensureDirectoryExists(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Format an ISO date string for display.
   *
   * @param dateString - Input date string
   * @returns Locale-formatted date/time, or the original string on parse failure
   */
  static formatDate(dateString: string): string {
    try {
      const date = new Date(dateString);
      return date.toLocaleString();
    } catch (error) {
      return dateString;
    }
  }

  /**
   * Sanitize a filename by replacing invalid path characters.
   *
   * @param filename - Original filename
   */
  static sanitizeFilename(filename: string): string {
    return filename.replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, "_");
  }

  /**
   * Extract the hostname from a URL string.
   *
   * @param url - URL to parse
   */
  static extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (error) {
      return url;
    }
  }

  /**
   * Truncate text to a maximum length with ellipsis.
   *
   * @param text - Input text
   * @param maxLength - Maximum length including ellipsis
   */
  static truncateText(text: string, maxLength = 100): string {
    if (!text || text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + "...";
  }

  /**
   * Test whether a string is a valid absolute URL.
   *
   * @param string - Candidate URL string
   */
  static isValidUrl(string: string): boolean {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Convert bytes to a human-readable size string.
   *
   * @param bytes - Byte count
   * @param decimals - Decimal places to show
   */
  static formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Number.parseFloat((bytes / k ** i).toFixed(dm)) + " " + sizes[i];
  }

  /**
   * Pause execution for a duration.
   *
   * @param ms - Sleep duration in milliseconds
   */
  static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Retry an async function with exponential backoff.
   *
   * @param fn - Function to retry
   * @param maxRetries - Maximum attempts
   * @param baseDelay - Initial delay in milliseconds
   * @throws The last error when all retries are exhausted
   */
  static async retry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        if (attempt === maxRetries) {
          throw lastError;
        }

        const delay = baseDelay * 2 ** (attempt - 1);
        console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
        await Utils.sleep(delay);
      }
    }

    throw lastError!;
  }

  /** @see {@link sharedFetchWithRetry} from `@devintern/utils` */
  static fetchWithRetry = sharedFetchWithRetry;

  /**
   * Parse a JIRA issue key into project prefix and numeric suffix.
   *
   * @param taskKey - Issue key (e.g. `PROJ-123`)
   * @throws When the key format is invalid
   */
  static parseTaskKey(taskKey: string): {
    project: string;
    number: number;
    key: string;
  } {
    const match = taskKey.match(/^([A-Z]+)-(\d+)$/);
    if (!match) {
      throw new Error(`Invalid JIRA task key format: ${taskKey}`);
    }

    return {
      project: match[1],
      number: Number.parseInt(match[2], 10),
      key: taskKey,
    };
  }

  /**
   * Extract an optional target branch name from task description markdown.
   *
   * @param description - Task description text
   * @returns Branch name, or `null` when not specified
   */
  static extractTargetBranch(description: string | undefined): string | null {
    if (!description) {
      return null;
    }

    // Support multiple patterns with flexible markdown formatting:
    // - "Target branch: branch-name"
    // - "**Target branch**: branch-name"
    // - "*Target branch*: branch-name"
    // - "## Target branch: branch-name"
    // - "_Base branch_: branch-name"
    // - "***PR target***: branch-name"
    // The regex handles:
    // - Optional leading # characters (headings)
    // - Optional * or _ for bold/italic (0-3 occurrences before and after keyword)
    // - The keyword (target branch, base branch, pr target)
    // - REQUIRED colon (with optional table separator |)
    // - The branch name (capturing group) - allows -, _, /, ., alphanumeric
    // - Must end at whitespace, newline, or markdown formatting
    const patterns = [
      /#{0,6}\s*[*_]{0,3}target\s+branch[*_]{0,3}\s*:\s*\|?\s*[*_]{0,3}([a-zA-Z0-9][a-zA-Z0-9._/-]*)(?=\s|[*_,]|\n|$)/i,
      /#{0,6}\s*[*_]{0,3}base\s+branch[*_]{0,3}\s*:\s*\|?\s*[*_]{0,3}([a-zA-Z0-9][a-zA-Z0-9._/-]*)(?=\s|[*_,]|\n|$)/i,
      /#{0,6}\s*[*_]{0,3}pr\s+target[*_]{0,3}\s*:\s*\|?\s*[*_]{0,3}([a-zA-Z0-9][a-zA-Z0-9._/-]*)(?=\s|[*_,]|\n|$)/i,
    ];

    for (const pattern of patterns) {
      const match = description.match(pattern);
      if (match && match[1]) {
        let branchName = match[1].trim();

        // Clean up any remaining markdown artifacts (but preserve underscores in branch name)
        // Only remove leading/trailing * and _ that are markdown formatting
        branchName = branchName.replace(/^[*_]+/, "").replace(/[*_]+$/, "");

        // Validate branch name (basic check)
        if (branchName && branchName.length > 0 && !branchName.includes(" ")) {
          return branchName;
        }
      }
    }

    return null;
  }

  /**
   * Generate a unique task output filename with timestamp.
   *
   * @param taskKey - JIRA issue key
   * @param extension - File extension without dot
   */
  static generateTaskFilename(taskKey: string, extension = "md"): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sanitizedKey = Utils.sanitizeFilename(taskKey);
    return `task-${sanitizedKey}-${timestamp}.${extension}`;
  }

  /**
   * Execute a git subprocess and capture stdout/stderr.
   *
   * @param args - Git CLI arguments (without `git` prefix)
   * @param options - Verbose logging and working directory
   */
  static async executeGitCommand(
    args: string[],
    options?: { verbose?: boolean; cwd?: string },
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const verbose = options?.verbose ?? false;
    const cwd = options?.cwd;

    if (verbose) {
      console.log(`🔧 Executing: git ${args.join(" ")}${cwd ? ` (in ${cwd})` : ""}`);
    }

    return new Promise((resolve) => {
      const git = spawn("git", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: cwd || process.cwd(),
      });

      let output = "";
      let error = "";

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

      git.on("close", (code) => {
        const result = {
          success: code === 0,
          output: output.trim(),
          error: error.trim(),
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
      });
    });
  }

  /** @returns `true` when the current directory is inside a git repository */
  static async isGitRepository(cwd?: string): Promise<boolean> {
    const result = await Utils.executeGitCommand(["rev-parse", "--git-dir"], { cwd });
    return result.success;
  }

  /**
   * Get the current checked-out branch name.
   *
   * @param cwd - Optional git working directory
   */
  static async getCurrentBranch(cwd?: string): Promise<string | null> {
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
  static async hasUncommittedChanges(cwd?: string): Promise<boolean> {
    const result = await Utils.executeGitCommand(["status", "--porcelain"], {
      cwd,
    });
    return result.success && result.output.length > 0;
  }

  /**
   * Stage all changes and create an implementation commit.
   *
   * @param taskKey - JIRA issue key for the commit message
   * @param taskSummary - Issue summary for the commit message
   * @param options - Verbose logging, author override, and cwd
   */
  static async commitChanges(
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
   * Fetch a branch from `origin` so `refs/remotes/origin/<branch>` exists locally.
   *
   * @param branch - Remote branch name
   * @param options - Verbose logging and working directory
   */
  static async fetchRemoteBranch(
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
   * Fetches the branch from `origin` when it is not available locally before checkout.
   *
   * @param branch - Branch to update
   * @param options - Verbose logging
   */
  static async pullLatestChanges(
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
          message: "There are uncommitted changes. Please commit or stash them before pulling.",
        };
      }

      const currentBranch = await Utils.getCurrentBranch(cwd);

      // Switch to target branch if not already on it
      if (currentBranch !== branch) {
        if (verbose) {
          console.log(`📥 Switching to branch '${branch}'...`);
        }
        let targetBranch = branch;
        let switchResult = await Utils.checkoutBranch(targetBranch, { verbose, cwd });

        if (!switchResult.success) {
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
              console.log(
                `⚠️  Branch '${targetBranch}' not found, trying '${alternativeBranch}'...`,
              );
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

  /**
   * Test whether a git ref exists locally.
   *
   * @param ref - Full ref name (e.g. `refs/heads/main`)
   * @param options - Optional working directory
   */
  static async gitRefExists(ref: string, options?: { cwd?: string }): Promise<boolean> {
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
  static async remoteBranchExists(
    branch: string,
    options?: { verbose?: boolean; cwd?: string },
  ): Promise<boolean> {
    const result = await Utils.executeGitCommand(
      ["ls-remote", "--heads", "origin", branch],
      options,
    );
    return result.success && result.output.trim().length > 0;
  }

  /**
   * Check out a branch, creating a tracking branch from origin when needed.
   *
   * @param branch - Branch name to check out
   * @param options - Verbose logging and working directory
   */
  static async checkoutBranch(
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
   * Resolve the repository default branch, honoring a preferred name when present.
   *
   * @param preferredBranch - Optional branch to prefer when it exists
   * @param options - Optional working directory
   */
  static async resolveDefaultBranch(
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
    }

    return Utils.getMainBranchName(options);
  }

  /**
   * Detect the repository default branch (`main`, `master`, or origin HEAD).
   *
   * @param options - Optional working directory
   */
  static async getMainBranchName(options?: { cwd?: string }): Promise<string> {
    const gitOptions = options?.cwd ? { cwd: options.cwd } : undefined;

    // Prefer the remote's default branch when origin is configured
    const defaultBranch = await Utils.executeGitCommand(
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      gitOptions,
    );
    if (defaultBranch.success) {
      const branchName = defaultBranch.output.replace("refs/remotes/origin/", "").trim();
      if (branchName) {
        return branchName;
      }
    }

    const remoteShow = await Utils.executeGitCommand(["remote", "show", "origin"], gitOptions);
    if (remoteShow.success) {
      const match = remoteShow.output.match(/HEAD branch:\s*(.+)/);
      const branchName = match?.[1]?.trim();
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
   * Push the current branch to `origin`, setting upstream on first push.
   *
   * @param options - Verbose logging and working directory
   */
  static async pushCurrentBranch(options?: {
    verbose?: boolean;
    cwd?: string;
    expectedBranch?: string;
  }): Promise<{
    success: boolean;
    message: string;
    hookError?: string;
  }> {
    const verbose = options?.verbose ?? false;
    const cwd = options?.cwd;
    const expectedBranch = options?.expectedBranch;

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

      if (verbose) {
        console.log(`📤 Pushing branch '${currentBranch}' to remote...`);
      }

      // Check if remote branch exists
      const remoteBranchExists = await Utils.executeGitCommand(
        ["ls-remote", "--heads", "origin", currentBranch],
        { verbose, cwd },
      );

      let pushResult;
      if (remoteBranchExists.success && remoteBranchExists.output.trim()) {
        // Remote branch exists, just push
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

      const isNonFastForward =
        fullError.includes("[rejected]") && fullError.includes("non-fast-forward");
      const isFetchFirst =
        fullError.includes("fetch first") || fullError.includes("Updates were rejected");

      // Non-fast-forward and similar errors are not fixable by @devintern/code
      // They require manual intervention (pull, rebase, or force push)
      if (isNonFastForward || isFetchFirst) {
        return {
          success: false,
          message: `Push rejected - branch diverged from remote. Run 'git pull --rebase' or 'git push --force' (dangerous): ${pushResult.error}`,
          // Don't mark as hookError since this is not fixable by @devintern/code
        };
      }

      // Treat other push failures as potential hook/fixable errors
      // The full error context (stdout + stderr) will be passed to Agent
      return {
        success: false,
        message: `Failed to push branch: ${pushResult.error}`,
        hookError: fullError || pushResult.error,
      };
    } catch (error) {
      return {
        success: false,
        message: `Git push failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Run the local `pre-push` hook without pushing (dry validation).
   *
   * @param options - Verbose logging and working directory
   */
  static async runPrePushHookLocally(options?: { verbose?: boolean; cwd?: string }): Promise<{
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
      const hooksPathResult = await Utils.executeGitCommand(["config", "--get", "core.hooksPath"], {
        verbose: false,
        cwd,
      });

      let hookDir: string;
      if (hooksPathResult.success && hooksPathResult.output?.trim()) {
        hookDir = hooksPathResult.output.trim();
        // If it's a relative path, resolve it from the repo root
        if (!hookDir.startsWith("/")) {
          const repoRootResult = await Utils.executeGitCommand(["rev-parse", "--show-toplevel"], {
            verbose: false,
            cwd,
          });
          if (repoRootResult.success && repoRootResult.output?.trim()) {
            const { join } = require("path");
            hookDir = join(repoRootResult.output.trim(), hookDir);
          }
        }
      } else {
        // Default to .git/hooks
        // Use --git-common-dir to find hooks in worktrees (hooks are shared)
        const gitDirResult = await Utils.executeGitCommand(["rev-parse", "--git-common-dir"], {
          verbose: false,
          cwd,
        });
        if (!gitDirResult.success || !gitDirResult.output?.trim()) {
          return {
            success: false,
            message: "Could not determine .git directory",
          };
        }
        const { join } = require("path");
        const gitDir = gitDirResult.output.trim();
        // Handle both absolute and relative git dir paths
        hookDir = gitDir.startsWith("/") ? join(gitDir, "hooks") : join(cwd, gitDir, "hooks");
      }

      const { join } = require("path");
      const hookPath = join(hookDir, "pre-push");

      // Check if hook exists
      const { existsSync, statSync } = require("fs");
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

  /**
   * Test whether a branch name is a protected integration branch.
   *
   * @param branch - Branch name (defaults to current branch)
   */
  static async isProtectedBranch(branch?: string, cwd?: string): Promise<boolean> {
    try {
      const currentBranch = branch || (await Utils.getCurrentBranch(cwd));
      if (!currentBranch) {
        return false;
      }

      const protectedBranches = [
        "main",
        "master",
        "develop",
        "development",
        "staging",
        "production",
      ];
      return protectedBranches.includes(currentBranch.toLowerCase());
    } catch (error) {
      return false;
    }
  }

  /**
   * Create and check out a `feature/{task-key}` branch from the default base.
   *
   * @param taskKey - JIRA issue key used in the branch name
   * @param baseBranch - Optional explicit base branch
   */
  static async createFeatureBranch(
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

      // Reset any staged or modified files
      const resetResult = await Utils.executeGitCommand(["reset", "--hard", "HEAD"], gitOpts);
      if (!resetResult.success) {
        console.warn(`⚠️  Failed to reset changes: ${resetResult.error}`);
      }

      // Remove untracked files and directories
      const cleanResult = await Utils.executeGitCommand(["clean", "-fd"], gitOpts);
      if (!cleanResult.success) {
        console.warn(`⚠️  Failed to clean untracked files: ${cleanResult.error}`);
      }

      console.log("✅ Working directory cleaned");

      // Switch to target branch first (or main/master if not specified)
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
            success: false,
            branchName,
            message: `Failed to switch to ${targetBranch} branch: ${switchResult.error}`,
          };
        }
      }

      // Fetch and update target branch
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
      } else {
        // Ensure target branch is up to date with remote
        console.log(`📥 Pulling latest changes for target branch '${targetBranch}'...`);
        const pullResult = await Utils.executeGitCommand(["pull", "origin", targetBranch], gitOpts);

        if (!pullResult.success) {
          console.log(
            `⚠️  Failed to pull latest changes for '${targetBranch}': ${pullResult.error}`,
          );
          console.log("   Continuing with local version of the branch...");
        }
      }

      // Find an available branch name by checking for existing branches
      while (true) {
        const branchExists = await Utils.executeGitCommand(
          ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
          gitOpts,
        );

        if (!branchExists.success) {
          // Branch doesn't exist, we can use this name
          break;
        }

        // Branch exists, try next attempt
        attemptCounter++;
        branchName = `${baseBranchName}-attempt-${attemptCounter}`;
      }

      // Check if the branch is being used by a worktree and clean it up if needed
      const worktreeListResult = await Utils.executeGitCommand(
        ["worktree", "list", "--porcelain"],
        gitOpts,
      );

      if (
        worktreeListResult.success &&
        worktreeListResult.output.includes(`branch refs/heads/${branchName}`)
      ) {
        console.log(`⚠️  Branch '${branchName}' is checked out in a worktree, cleaning up...`);

        // Find the worktree path for this branch
        const lines = worktreeListResult.output.split("\n");
        let worktreeToRemove: string | null = null;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("worktree ")) {
            const path = lines[i].substring("worktree ".length);
            // Check if this worktree has our branch
            for (let j = i + 1; j < lines.length && !lines[j].startsWith("worktree "); j++) {
              if (lines[j] === `branch refs/heads/${branchName}`) {
                worktreeToRemove = path;
                break;
              }
            }
            if (worktreeToRemove) break;
          }
        }

        if (worktreeToRemove) {
          // Remove the worktree
          const removeResult = await Utils.executeGitCommand(
            ["worktree", "remove", worktreeToRemove, "--force"],
            gitOpts,
          );

          if (!removeResult.success) {
            // Try to forcibly delete the worktree directory and prune
            try {
              rmSync(worktreeToRemove, { recursive: true, force: true });
            } catch (e) {
              // Ignore deletion errors
            }
            await Utils.executeGitCommand(["worktree", "prune"], gitOpts);
          }
          console.log(`✅ Cleaned up worktree at ${worktreeToRemove}`);
        }

        // Delete the branch if it still exists (it might after worktree removal)
        await Utils.executeGitCommand(["branch", "-D", branchName], gitOpts);
      }

      // Create and checkout new branch from target branch
      // When createFromRemote is true, we couldn't checkout targetBranch (worktree conflict),
      // so create from the remote or local reference instead
      const createFromRef = createFromRemote ? `origin/${targetBranch}` : undefined; // undefined means create from HEAD (current branch)

      let createResult = await Utils.executeGitCommand(
        createFromRef
          ? ["checkout", "-b", branchName, createFromRef]
          : ["checkout", "-b", branchName],
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
          } catch (e) {
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
   * Remove a git worktree directory and unregister it from git.
   *
   * @param worktreePath - Absolute worktree path
   * @param options - Verbose logging
   */
  static async removeReviewWorktree(
    worktreePath: string,
    options?: { verbose?: boolean },
  ): Promise<{ success: boolean; error?: string }> {
    const verbose = options?.verbose ?? false;

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
        { verbose },
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
  static async prepareReviewWorktree(
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

      if (verbose) {
        console.log(`\n📂 Preparing review worktree for branch: ${branch}`);
        console.log(`   Worktree path: ${worktreePath}`);
      }

      // Fetch latest from origin (shallow fetch to minimize data transfer)
      if (verbose) {
        console.log(`   Fetching branch ${branch} from origin (shallow)...`);
      }

      const fetchResult = await Utils.executeGitCommand(
        ["fetch", "origin", branch, "--depth=1"],
        repoOpts,
      );

      if (verbose) {
        console.log(`   ✓ Fetch completed (success: ${fetchResult.success})`);
      }

      if (!fetchResult.success) {
        console.warn(`⚠️  Fetch failed: ${fetchResult.error || fetchResult.output}`);
        console.warn(`   Continuing anyway - worktree may have cached version...`);
      }

      // Check if worktree directory exists on filesystem
      const worktreeExists = existsSync(worktreePath);

      if (verbose) {
        console.log(`   Worktree directory exists: ${worktreeExists}`);
      }

      if (worktreeExists) {
        // Check if it's a valid git worktree by testing if .git exists and is valid
        const gitFileExists = existsSync(join(worktreePath, ".git"));

        if (gitFileExists) {
          // Try to verify it's a valid worktree
          const statusCheck = await Utils.executeGitCommand(["status", "--porcelain"], {
            verbose: false,
            cwd: worktreePath,
          });

          if (statusCheck.success) {
            // Valid worktree - switch branch
            if (verbose) {
              console.log(`   Switching to branch ${branch}...`);
            }

            // Check if origin remote exists
            const originCheck = await Utils.executeGitCommand(["remote", "get-url", "origin"], {
              verbose: false,
              cwd: worktreePath,
            });
            const hasOrigin = originCheck.success;

            // Discard any leftover changes from previous reviews before switching
            await Utils.executeGitCommand(["reset", "--hard"], {
              verbose: false,
              cwd: worktreePath,
            });
            await Utils.executeGitCommand(["clean", "-fd"], {
              verbose: false,
              cwd: worktreePath,
            });

            let switchResult;
            if (hasOrigin) {
              // Try checkout with -B to force create/reset branch tracking origin
              switchResult = await Utils.executeGitCommand(
                ["checkout", "-B", branch, "--track", `origin/${branch}`],
                { verbose, cwd: worktreePath },
              );
            } else {
              // No origin - just checkout the local branch
              switchResult = await Utils.executeGitCommand(["checkout", branch], {
                verbose,
                cwd: worktreePath,
              });
            }

            if (switchResult.success) {
              // Pull latest changes if origin exists
              if (hasOrigin) {
                if (verbose) {
                  console.log(`   Pulling latest changes...`);
                }
                await Utils.executeGitCommand(["pull", "origin", branch, "--ff-only"], {
                  verbose,
                  cwd: worktreePath,
                });
              }

              // Clean again after checkout to remove any untracked files from the new branch state
              await Utils.executeGitCommand(["clean", "-fd"], {
                verbose: false,
                cwd: worktreePath,
              });

              if (verbose) {
                console.log(`✅ Switched to branch ${branch}`);
              }

              // Install dependencies
              if (verbose) {
                console.log(`📦 Installing dependencies...`);
              }
              const installResult = await Utils.installDependencies(worktreePath, { verbose });

              if (!installResult.success) {
                console.warn(`⚠️  Failed to install dependencies: ${installResult.error}`);
                console.warn(`   Agent may not be able to run tests or build commands`);
              }

              return { success: true, path: worktreePath };
            }
          }
        }

        // Worktree is corrupted or invalid - clean it up
        if (verbose) {
          console.log(`   Worktree is invalid/corrupted, cleaning up...`);
        }

        // Remove from git's worktree registry (ignore errors)
        await Utils.executeGitCommand(
          ["worktree", "remove", worktreePath, "--force"],
          repoOptsQuiet,
        );

        // Remove directory itself (ignore errors)
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch (e) {
          // Ignore
        }

        // Prune any stale worktree registrations
        await Utils.executeGitCommand(["worktree", "prune"], repoOptsQuiet);
      }

      // Create new worktree
      if (verbose) {
        console.log(`   Creating worktree at ${worktreePath}...`);
      }

      // Check if the branch exists locally
      const localBranchCheck = await Utils.executeGitCommand(
        ["show-ref", "--verify", `refs/heads/${branch}`],
        repoOptsQuiet,
      );

      // Check if origin remote exists
      const originCheck = await Utils.executeGitCommand(
        ["remote", "get-url", "origin"],
        repoOptsQuiet,
      );
      const hasOrigin = originCheck.success;

      let createResult;

      if (hasOrigin) {
        // With origin - try to create worktree tracking origin branch
        let branchExistsLocally = localBranchCheck.success;

        if (branchExistsLocally) {
          // Local branch exists - try to delete it to avoid conflicts with -b flag
          const deleteResult = await Utils.executeGitCommand(
            ["branch", "-D", branch],
            repoOptsQuiet,
          );
          if (deleteResult.success) {
            branchExistsLocally = false;
          } else if (verbose) {
            console.log(
              `   Branch ${branch} could not be deleted (likely checked out elsewhere), will reuse it`,
            );
          }
        }

        if (branchExistsLocally) {
          // Branch exists and can't be deleted (e.g. checked out in main worktree)
          // Use --force to allow checkout even if branch is checked out elsewhere
          createResult = await Utils.executeGitCommand(
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
            await Utils.executeGitCommand(
              ["branch", `--set-upstream-to=origin/${branch}`, branch],
              { verbose: false, cwd: worktreePath },
            );
          }
        } else {
          createResult = await Utils.executeGitCommand(
            ["worktree", "add", "--track", "-b", branch, worktreePath, `origin/${branch}`],
            repoOpts,
          );
        }
      } else {
        // No origin - use local branch
        createResult = await Utils.executeGitCommand(
          ["worktree", "add", worktreePath, branch],
          repoOpts,
        );
      }

      if (!createResult.success) {
        // If creation failed, it might be due to stale registrations - clean up
        const errorMsg = (createResult.error || "") + (createResult.output || "");

        if (errorMsg.includes("already registered") || errorMsg.includes("missing but")) {
          if (verbose) {
            console.log(`   Cleaning up stale worktree registrations...`);
          }

          // Prune stale worktrees silently
          await Utils.executeGitCommand(["worktree", "prune"], repoOptsQuiet);

          // Delete the local branch if it exists (may have been created by the failed first attempt)
          await Utils.executeGitCommand(["branch", "-D", branch], repoOptsQuiet);

          // Try again after pruning
          if (hasOrigin) {
            createResult = await Utils.executeGitCommand(
              ["worktree", "add", "--track", "-b", branch, worktreePath, `origin/${branch}`],
              repoOpts,
            );
          } else {
            createResult = await Utils.executeGitCommand(
              ["worktree", "add", worktreePath, branch],
              repoOpts,
            );
          }
        } else if (
          errorMsg.includes("already exists") ||
          errorMsg.includes("already checked out") ||
          errorMsg.includes("already used by worktree")
        ) {
          // Branch exists locally and couldn't be deleted (checked out or used by another worktree)
          // Use --force to allow checkout even if branch is in use elsewhere
          if (verbose) {
            console.log(
              `   Branch already exists or checked out elsewhere, creating worktree with --force...`,
            );
          }

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
            await Utils.executeGitCommand(
              ["branch", `--set-upstream-to=origin/${branch}`, branch],
              { verbose: false, cwd: worktreePath },
            );
          }
        }

        if (!createResult.success) {
          return {
            success: false,
            error: `Failed to create worktree: ${createResult.error || createResult.output}`,
          };
        }
      }

      if (verbose) {
        console.log(`✅ Worktree ready at ${worktreePath}`);
      }

      // Install dependencies to ensure Agent has everything needed
      if (verbose) {
        console.log(`📦 Installing dependencies...`);
      }
      const installResult = await Utils.installDependencies(worktreePath, {
        verbose,
      });

      if (verbose) {
        console.log(`   ✓ Dependency installation completed (success: ${installResult.success})`);
      }

      if (!installResult.success) {
        // Log warning but don't fail - Agent can still work without dependencies in some cases
        console.warn(`⚠️  Failed to install dependencies: ${installResult.error}`);
        console.warn(`   Agent may not be able to run tests or build commands`);
      }

      if (verbose) {
        console.log(`✅ Worktree preparation complete!`);
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
  static getReviewWorktreePath(branch?: string): string {
    const base = process.env.DEVINTERN_REVIEW_WORKTREE_PATH || "/tmp/devintern-review-worktree";
    if (!branch) {
      return base;
    }
    return `${base}-${Utils.sanitizeBranchForPath(branch)}`;
  }

  /**
   * Convert a git branch name into a filesystem-safe path segment.
   *
   * Collapses any run of characters outside `[a-zA-Z0-9._-]` (notably the `/`
   * in `feature/dev-16`) to a single `-`, then trims leading/trailing dashes.
   *
   * @param branch - Git branch name
   */
  private static sanitizeBranchForPath(branch: string): string {
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
  static async cleanupStaleReviewWorktrees(
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

  /**
   * Auto-detect package managers and install project dependencies in a worktree.
   *
   * @param workingDir - Repository root to inspect
   * @param options - Verbose logging
   */
  static async installDependencies(
    workingDir: string,
    options?: { verbose?: boolean },
  ): Promise<{ success: boolean; packageManager?: string; error?: string }> {
    const verbose = options?.verbose ?? false;

    // Define package managers for each language/ecosystem
    const packageManagers = [
      // JavaScript/TypeScript (only with lock files)
      {
        name: "bun",
        manifestFile: "package.json",
        lockFile: "bun.lockb",
        command: "bun",
        args: ["install"],
      },
      {
        name: "pnpm",
        manifestFile: "package.json",
        lockFile: "pnpm-lock.yaml",
        command: "pnpm",
        args: ["install", "--frozen-lockfile"],
      },
      {
        name: "yarn",
        manifestFile: "package.json",
        lockFile: "yarn.lock",
        command: "yarn",
        args: ["install", "--frozen-lockfile"],
      },
      {
        name: "npm",
        manifestFile: "package.json",
        lockFile: "package-lock.json",
        command: "npm",
        args: ["ci"],
      },

      // Python
      {
        name: "uv",
        manifestFile: "pyproject.toml",
        lockFile: "uv.lock",
        command: "uv",
        args: ["sync"],
      },
      {
        name: "poetry",
        manifestFile: "pyproject.toml",
        lockFile: "poetry.lock",
        command: "poetry",
        args: ["install", "--no-root"],
      },
      {
        name: "pip",
        manifestFile: "requirements.txt",
        lockFile: null,
        command: "pip",
        args: ["install", "-r", "requirements.txt"],
      },
      {
        name: "pipenv",
        manifestFile: "Pipfile",
        lockFile: "Pipfile.lock",
        command: "pipenv",
        args: ["install", "--deploy"],
      },

      // Ruby
      {
        name: "bundle",
        manifestFile: "Gemfile",
        lockFile: "Gemfile.lock",
        command: "bundle",
        args: ["install"],
      },

      // Go
      {
        name: "go",
        manifestFile: "go.mod",
        lockFile: "go.sum",
        command: "go",
        args: ["mod", "download"],
      },

      // Rust
      {
        name: "cargo",
        manifestFile: "Cargo.toml",
        lockFile: "Cargo.lock",
        command: "cargo",
        args: ["fetch"],
      },

      // PHP
      {
        name: "composer",
        manifestFile: "composer.json",
        lockFile: "composer.lock",
        command: "composer",
        args: ["install", "--no-interaction"],
      },

      // Java (no lock files, so only install if we find these files)
      {
        name: "maven",
        manifestFile: "pom.xml",
        lockFile: null,
        command: "mvn",
        args: ["dependency:resolve"],
      },
      {
        name: "gradle",
        manifestFile: "build.gradle",
        lockFile: null,
        command: "gradle",
        args: ["dependencies", "--quiet"],
      },
      {
        name: "gradle",
        manifestFile: "build.gradle.kts",
        lockFile: null,
        command: "gradle",
        args: ["dependencies", "--quiet"],
      },
    ];

    // Find all applicable package managers for this project
    // Prioritize those with lock files, only use manifest-only as fallback
    const pmsWithLock = packageManagers.filter((pm) => {
      const manifestExists = existsSync(join(workingDir, pm.manifestFile));
      if (!manifestExists) return false;

      if (pm.lockFile) {
        return existsSync(join(workingDir, pm.lockFile));
      }

      return false;
    });

    const pmsWithoutLock = packageManagers.filter((pm) => {
      const manifestExists = existsSync(join(workingDir, pm.manifestFile));
      if (!manifestExists) return false;

      // Only include if no lock file is required
      return pm.lockFile === null;
    });

    // Prefer package managers with lock files, otherwise use manifest-only ones
    const applicablePMs = pmsWithLock.length > 0 ? pmsWithLock : pmsWithoutLock;

    if (applicablePMs.length === 0) {
      // No package manager files found - nothing to install
      return { success: true };
    }

    // Install dependencies for each detected package manager
    const results: Array<{
      success: boolean;
      packageManager: string;
      error?: string;
    }> = [];

    for (const pm of applicablePMs) {
      if (verbose) {
        console.log(`   Installing ${pm.name} dependencies...`);
      }

      const result = await new Promise<{
        success: boolean;
        packageManager: string;
        error?: string;
      }>((resolve) => {
        const proc = spawn(pm.command, pm.args, {
          cwd: workingDir,
          stdio: verbose ? "inherit" : "pipe",
        });

        let errorOutput = "";

        if (!verbose) {
          // Must consume both stdout and stderr to prevent pipe buffer deadlock
          // When the buffer fills up (typically 64KB), the process blocks
          if (proc.stdout) {
            proc.stdout.on("data", () => {
              // Discard stdout when not verbose, just keep draining the buffer
            });
          }
          if (proc.stderr) {
            proc.stderr.on("data", (data: Buffer) => {
              errorOutput += data.toString();
            });
          }
        }

        proc.on("error", (error: NodeJS.ErrnoException) => {
          resolve({
            success: false,
            packageManager: pm.name,
            error: `Failed to run ${pm.name}: ${error.message}`,
          });
        });

        proc.on("close", (code: number | null) => {
          if (code === 0) {
            if (verbose) {
              console.log(`   ✅ ${pm.name} dependencies installed`);
            }
            resolve({
              success: true,
              packageManager: pm.name,
            });
          } else {
            resolve({
              success: false,
              packageManager: pm.name,
              error: `${pm.name} exited with code ${code}${errorOutput ? `\n${errorOutput}` : ""}`,
            });
          }
        });
      });

      results.push(result);
    }

    // Consider overall success if at least one package manager succeeded
    const anySuccess = results.some((r) => r.success);
    const allErrors = results
      .filter((r) => !r.success)
      .map((r) => r.error)
      .join("; ");

    if (anySuccess) {
      return {
        success: true,
        packageManager: results
          .filter((r) => r.success)
          .map((r) => r.packageManager)
          .join(", "),
      };
    } else {
      return {
        success: false,
        packageManager: results.map((r) => r.packageManager).join(", "),
        error: allErrors,
      };
    }
  }
}
