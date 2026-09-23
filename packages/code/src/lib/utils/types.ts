import type { fetchWithRetry as sharedFetchWithRetry } from "@devintern/utils";

/** Options accepted by {@link UtilsSurface.executeGitCommand}. */
export type GitOptions =
  | {
      verbose?: boolean;
      cwd?: string;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    }
  | undefined;

/** Result returned by {@link UtilsSurface.executeGitCommand}. */
export interface GitCommandResult {
  success: boolean;
  output: string;
  error?: string;
}

/** Public surface registered onto the shared `Utils` object by the domain modules. */
export interface UtilsSurface {
  ensureDirectoryExists(dirPath: string): void;
  formatDate(dateString: string): string;
  sanitizeFilename(filename: string): string;
  extractDomain(url: string): string;
  truncateText(text: string, maxLength: any): string;
  isValidUrl(string: string): boolean;
  formatBytes(bytes: number, decimals: any): string;
  sleep(ms: number): Promise<void>;
  retry<T>(fn: () => Promise<T>, maxRetries: any, baseDelay: any): Promise<T>;
  parseTaskKey(taskKey: string): {
    project: string;
    number: number;
    key: string;
  };
  extractTargetBranch(description: string | undefined): string | null;
  generateTaskFilename(taskKey: string, extension: any): string;
  executeGitCommand(
    args: string[],
    options?: {
      verbose?: boolean;
      cwd?: string;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ success: boolean; output: string; error?: string }>;
  isGitRepository(cwd?: string): Promise<boolean>;
  getCurrentBranch(cwd?: string): Promise<string | null>;
  hasUncommittedChanges(cwd?: string): Promise<boolean>;
  stashWorkingDirectory(label: string, options?: { cwd?: string }): Promise<boolean>;
  commitChanges(
    taskKey: string,
    taskSummary: string,
    options?: {
      verbose?: boolean;
      author?: { name: string; email: string };
      cwd?: string;
    },
  ): Promise<{ success: boolean; message: string; hookError?: string }>;
  fetchRemoteBranch(
    branch: string,
    options?: { verbose?: boolean; cwd?: string },
  ): Promise<{ success: boolean; error?: string }>;
  pullLatestChanges(
    branch: string,
    options?: {
      verbose?: boolean;
      cwd?: string;
    },
  ): Promise<{ success: boolean; message: string }>;
  gitRefExists(ref: string, options?: { cwd?: string }): Promise<boolean>;
  remoteBranchExists(
    branch: string,
    options?: {
      verbose?: boolean;
      cwd?: string;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<boolean>;
  checkoutBranch(
    branch: string,
    options?: { verbose?: boolean; cwd?: string },
  ): Promise<{ success: boolean; error?: string }>;
  resolveDefaultBranch(preferredBranch?: string, options?: { cwd?: string }): Promise<string>;
  getMainBranchName(options?: { cwd?: string }): Promise<string>;
  remoteTrackingRefMatchesHead(branch: string, options?: { cwd?: string }): Promise<boolean>;
  pushCurrentBranch(options?: {
    verbose?: boolean;
    cwd?: string;
    expectedBranch?: string;
    expectedRemoteSha?: string;
  }): Promise<{
    success: boolean;
    message: string;
    hookError?: string;
  }>;
  runPrePushHookLocally(options?: { verbose?: boolean; cwd?: string }): Promise<{
    success: boolean;
    message: string;
    hookError?: string;
  }>;
  isProtectedBranch(branch?: string, cwd?: string): Promise<boolean>;
  createFeatureBranch(
    taskKey: string,
    baseBranch?: string,
    options?: { cwd?: string },
  ): Promise<{ success: boolean; branchName: string; message: string }>;
  removeReviewWorktree(
    worktreePath: string,
    options?: { verbose?: boolean; cwd?: string },
  ): Promise<{ success: boolean; error?: string }>;
  pullReviewWorktreeBranch(worktreePath: string, branch: string, verbose: boolean): Promise<void>;
  prepareReviewWorktree(
    branch: string,
    options?: { verbose?: boolean; cwd?: string },
  ): Promise<{ success: boolean; path?: string; error?: string }>;
  getReviewWorktreePath(branch?: string): string;
  cleanupStaleReviewWorktrees(
    keepPath: string,
    options?: { verbose?: boolean; cwd?: string },
  ): Promise<void>;
  isolateWorktreeHooks(worktreePath: string, options?: { verbose?: boolean }): Promise<void>;
  enableWorktreeConfig(cwd: string): Promise<{ success: boolean; output: string; error?: string }>;
  prepareWorktreeForAgent(
    worktreePath: string,
    options?: { verbose?: boolean },
  ): Promise<{ success: boolean; packageManager?: string; error?: string }>;
  installDependencies(
    workingDir: string,
    options?: { verbose?: boolean },
  ): Promise<{ success: boolean; packageManager?: string; error?: string }>;
  fetchWithRetry: typeof sharedFetchWithRetry;
}
