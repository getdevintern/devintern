/**
 * Worker-managed repositories: bare clones + per-task worktrees.
 *
 * Fleet mode never runs the pipeline in a user checkout. Each configured
 * repo gets one bare clone under `<workspace>/repos/<name>.git`, and every
 * task run gets a disposable worktree under `<workspace>/worktrees/<name>/`.
 * The pipeline's tree-mutating steps (`createFeatureBranch` does
 * `git reset --hard` + `git clean -fd`) are safe there because the tree is
 * throwaway: removed after a successful run, kept for debugging on failure,
 * and swept by TTL on worker start. Git hooks are isolated as soon as each
 * worktree is created so later package installs cannot clobber the shared
 * `.git/hooks`. Task dependencies are installed by the task subprocess only
 * after it has checked out its final feature branch.
 *
 * Bare-clone gotcha: `git clone --bare` records `remote.origin.url` but NOT
 * a fetch refspec, so `git fetch origin` would never update
 * `refs/remotes/origin/*`. `ensureBareClone` writes the standard refspec and
 * points `origin/HEAD` (used by `Utils.getMainBranchName`) so worktrees and
 * default-branch resolution behave like a normal clone.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

import { Utils } from "../utils";
import { excludeWorkerRuntimeFiles } from "../utils/git-exclude";
import { withRepoGitLock } from "../utils/repo-git-lock";
import type { RepoConfig } from "./config";
import { reposDir, resolveWorkspaceDir, worktreesDir } from "./paths";

/** Name of the persistent per-repo worktree used for review/mention runs. */
export const BASE_WORKTREE_NAME = "base";

/**
 * Name of the persistent per-repo checkout PR jobs start from. Separate from
 * the base checkout, which an automation may hold on its own branch.
 */
export const PR_JOB_WORKTREE_NAME = "pr-jobs";

/** Fetch attempts when another process's fetch holds a ref lock. */
const FETCH_LOCK_ATTEMPTS = 3;
const FETCH_LOCK_RETRY_MS = 500;

/** Git's lock-contention failures (another fetch is updating the same refs). */
function isRefLockError(message: string | undefined): boolean {
  return /cannot lock ref|unable to (create|lock)|\.lock'?: File exists/i.test(message ?? "");
}

export class RepoManager {
  private workspaceDir: string;
  private readonly adminTails = new Map<string, Promise<void>>();

  constructor(workspaceDir: string = resolveWorkspaceDir()) {
    this.workspaceDir = workspaceDir;
  }

  /** Absolute path of a repo's bare clone. */
  bareClonePath(repoName: string): string {
    return join(reposDir(this.workspaceDir), `${repoName}.git`);
  }

  /** Directory holding a repo's worktrees. */
  repoWorktreesDir(repoName: string): string {
    return join(worktreesDir(this.workspaceDir), repoName);
  }

  /** Absolute path of a repo's persistent base worktree. */
  baseWorktreePath(repoName: string): string {
    return join(this.repoWorktreesDir(repoName), BASE_WORKTREE_NAME);
  }

  /** Absolute path of a repo's persistent PR-job checkout. */
  prJobWorktreePath(repoName: string): string {
    return join(this.repoWorktreesDir(repoName), PR_JOB_WORKTREE_NAME);
  }

  /**
   * Ensure the bare clone for a repo exists and is fetch-ready.
   *
   * Clones on first use, then fixes the missing fetch refspec and resolves
   * `origin/HEAD`. Idempotent; cheap when the clone already exists.
   *
   * @throws When cloning or configuring the repository fails.
   */
  async ensureBareClone(repo: RepoConfig): Promise<string> {
    return this.withAdminLock(repo.name, () => this.ensureBareCloneUnlocked(repo));
  }

  private async ensureBareCloneUnlocked(repo: RepoConfig): Promise<string> {
    const clonePath = this.bareClonePath(repo.name);
    if (existsSync(clonePath)) {
      const currentRemote = await Utils.executeGitCommand(["remote", "get-url", "origin"], {
        cwd: clonePath,
      });
      if (!currentRemote.success) {
        throw new Error(
          `Failed to read origin for repo "${repo.name}": ${currentRemote.error || currentRemote.output}`,
        );
      }
      if (currentRemote.output.trim() !== repo.remote) {
        const updateRemote = await Utils.executeGitCommand(
          ["remote", "set-url", "origin", repo.remote],
          { cwd: clonePath },
        );
        if (!updateRemote.success) {
          throw new Error(
            `Failed to update origin for repo "${repo.name}": ${updateRemote.error || updateRemote.output}`,
          );
        }
        console.log(`🔄 [config] updated origin for repo ${repo.name}`);
      }
      const worktreeConfig = await Utils.enableWorktreeConfig(clonePath);
      if (!worktreeConfig.success) {
        throw new Error(
          `Failed to configure worktrees for repo "${repo.name}": ${worktreeConfig.error}`,
        );
      }
      return clonePath;
    }

    const parent = reposDir(this.workspaceDir);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }

    const clone = await Utils.executeGitCommand(["clone", "--bare", repo.remote, clonePath], {
      cwd: parent,
    });
    if (!clone.success) {
      throw new Error(`Failed to clone ${repo.remote} for repo "${repo.name}": ${clone.error}`);
    }

    const refspec = await Utils.executeGitCommand(
      ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      { cwd: clonePath },
    );
    if (!refspec.success) {
      throw new Error(`Failed to set fetch refspec for repo "${repo.name}": ${refspec.error}`);
    }

    const worktreeConfig = await Utils.enableWorktreeConfig(clonePath);
    if (!worktreeConfig.success) {
      throw new Error(
        `Failed to configure worktrees for repo "${repo.name}": ${worktreeConfig.error}`,
      );
    }

    await this.fetchUnlocked(repo.name);

    // origin/HEAD backs Utils.getMainBranchName; ignore failure (repos with
    // an explicit default_branch never consult it).
    await Utils.executeGitCommand(["remote", "set-head", "origin", "-a"], { cwd: clonePath });

    return clonePath;
  }

  /**
   * Update `refs/remotes/origin/*` from the remote.
   *
   * Queued behind this process's other admin operations on the repo, but
   * never under the cross-process git metadata lock: a fetch is network-bound
   * and can take minutes, and PR job subprocesses must not time out waiting
   * on it. Git locks each ref it updates itself; a fetch that loses a ref
   * lock to a concurrent fetch in another process is retried.
   *
   * @param repoName - Configured repository name
   * @param options.timeoutMs - Bound the network operation (startup probes
   *   that must not block on an unreachable remote, and PR jobs)
   * @throws When the fetch fails (network, auth, missing clone, timeout).
   */
  async fetch(repoName: string, options?: { timeoutMs?: number }): Promise<void> {
    await this.withAdminLock(repoName, () => this.fetchUnlocked(repoName, options), {
      crossProcess: false,
    });
  }

  private async fetchUnlocked(repoName: string, options?: { timeoutMs?: number }): Promise<void> {
    const gitOptions = options?.timeoutMs
      ? { cwd: this.bareClonePath(repoName), timeoutMs: options.timeoutMs }
      : { cwd: this.bareClonePath(repoName) };
    for (let attempt = 1; ; attempt++) {
      const result = await Utils.executeGitCommand(["fetch", "--prune", "origin"], gitOptions);
      if (result.success) return;
      const message = result.error || result.output;
      if (attempt >= FETCH_LOCK_ATTEMPTS || !isRefLockError(message)) {
        throw new Error(`Failed to fetch repo "${repoName}": ${result.error}`);
      }
      await Bun.sleep(FETCH_LOCK_RETRY_MS * attempt);
    }
  }

  /**
   * Resolve the branch task worktrees start from.
   *
   * Config wins; otherwise `origin/HEAD` (set during `ensureBareClone`).
   */
  async resolveDefaultBranch(repo: RepoConfig): Promise<string> {
    if (repo.defaultBranch) {
      return repo.defaultBranch;
    }
    return Utils.getMainBranchName({ cwd: this.bareClonePath(repo.name) });
  }

  /**
   * Ensure the persistent base worktree (default branch) exists and is current.
   *
   * Review and mention runs need a normal checkout to operate from; task
   * runs use disposable worktrees instead. Hooks are isolated on first
   * creation; task subprocesses install dependencies after preparing their
   * final branch, including every reuse by an automation.
   *
   * A reused checkout is reset to the fetched default branch. A previous
   * automation can leave it on its own feature branch at an old commit;
   * without the reset the next automation would start from that stale head
   * instead of the default branch.
   */
  async ensureBaseWorktree(repo: RepoConfig): Promise<string> {
    return this.withAdminLock(repo.name, async () => {
      const path = this.baseWorktreePath(repo.name);
      const branch = await this.resolveDefaultBranch(repo);
      if (!existsSync(path)) {
        await this.addWorktreeUnlocked(repo.name, path, `origin/${branch}`);
        return path;
      }
      await this.syncBaseWorktreeUnlocked(path, branch);
      return path;
    });
  }

  /**
   * Ensure the persistent PR-job checkout exists, detached at the fetched
   * default branch.
   *
   * PR jobs (reviews, CI fixes, base syncs) run their CLI subprocess from
   * here: it reads the project's tracked `.devintern-code/settings.json` from
   * its cwd, so that must be the default branch, not whatever an automation
   * left in the base checkout. The agents themselves work in branch-scoped
   * PR worktrees. Several PR jobs share this checkout, so it is only moved
   * when it lags `origin/<branch>`, and a failed move (another job's git
   * command holding its index) keeps the previous default-branch commit
   * instead of failing the job.
   */
  async ensurePrJobWorktree(repo: RepoConfig): Promise<string> {
    return this.withAdminLock(repo.name, async () => {
      const path = this.prJobWorktreePath(repo.name);
      const branch = await this.resolveDefaultBranch(repo);
      if (!existsSync(path)) {
        await this.addWorktreeUnlocked(repo.name, path, `origin/${branch}`);
        return path;
      }
      const [head, target] = await Promise.all([
        Utils.executeGitCommand(["rev-parse", "HEAD"], { cwd: path }),
        Utils.executeGitCommand(["rev-parse", `origin/${branch}`], { cwd: path }),
      ]);
      if (head.success && target.success && head.output.trim() === target.output.trim()) {
        return path;
      }
      try {
        await this.syncBaseWorktreeUnlocked(path, branch);
      } catch (error) {
        console.warn(`⚠️  [fleet] ${(error as Error).message}; using the checkout as is`);
      }
      return path;
    });
  }

  /**
   * Detach a reused base worktree at `origin/<branch>`, discarding tracked
   * changes left by an interrupted run without moving the branch the previous
   * run created. Untracked files are kept (they include installed
   * dependencies); `--force` replaces any that would block the checkout.
   */
  private async syncBaseWorktreeUnlocked(path: string, branch: string): Promise<void> {
    const result = await Utils.executeGitCommand(
      ["checkout", "--force", "--detach", `origin/${branch}`],
      { cwd: path },
    );
    if (!result.success) {
      throw new Error(
        `Failed to sync base worktree at ${path} to origin/${branch}: ${result.error}`,
      );
    }
  }

  /**
   * Create a disposable, detached worktree for one task run.
   *
   * Git hooks are isolated before the worktree is returned. The task
   * subprocess installs dependencies after preparing its final branch, when
   * the workspace's layered environment is active.
   *
   * @param repo - Workspace repo the task routed to
   * @param taskKey - Task key; used in the directory name for debuggability
   * @returns Absolute worktree path (unique per call).
   */
  async createTaskWorktree(repo: RepoConfig, taskKey: string): Promise<string> {
    return this.withAdminLock(repo.name, async () => {
      const branch = await this.resolveDefaultBranch(repo);
      const safeKey = taskKey.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
      const path = join(
        this.repoWorktreesDir(repo.name),
        `${safeKey}-${Date.now()}-${randomUUID()}`,
      );
      await this.addWorktreeUnlocked(repo.name, path, `origin/${branch}`);
      return path;
    });
  }

  /**
   * Remove a task worktree (after a successful run).
   *
   * Failed runs keep their worktree for debugging; the TTL sweep collects
   * them later.
   */
  async removeTaskWorktree(repoName: string, worktreePath: string): Promise<void> {
    await this.withAdminLock(repoName, () =>
      this.removeTaskWorktreeUnlocked(repoName, worktreePath),
    );
  }

  private async removeTaskWorktreeUnlocked(repoName: string, worktreePath: string): Promise<void> {
    const cwd = this.bareClonePath(repoName);
    await Utils.executeGitCommand(["worktree", "remove", "--force", worktreePath], { cwd });
    await Utils.executeGitCommand(["worktree", "prune"], { cwd });
  }

  /**
   * Remove leftover task worktrees older than the TTL.
   *
   * Runs on worker start. The base and PR-job worktrees are never swept.
   *
   * @returns Paths that were removed.
   */
  async sweepStaleWorktrees(repoName: string, ttlDays: number): Promise<string[]> {
    const dir = this.repoWorktreesDir(repoName);
    if (!existsSync(dir)) {
      return [];
    }
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    const removed: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === BASE_WORKTREE_NAME || entry === PR_JOB_WORKTREE_NAME) {
        continue;
      }
      const path = join(dir, entry);
      try {
        if (statSync(path).mtimeMs >= cutoff) {
          continue;
        }
      } catch {
        continue;
      }
      await this.removeTaskWorktree(repoName, path);
      if (!existsSync(path)) {
        removed.push(path);
      }
    }
    return removed;
  }

  /**
   * Add a worktree at `path` and isolate its git hooks.
   *
   * This must happen before the task subprocess installs packages: postinstall
   * tools such as lefthook would otherwise rewrite the shared bare-clone
   * `.git/hooks`. Isolation is best-effort, matching review worktrees.
   */
  private async addWorktreeUnlocked(repoName: string, path: string, ref: string): Promise<void> {
    const parent = this.repoWorktreesDir(repoName);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    const result = await Utils.executeGitCommand(["worktree", "add", "--detach", path, ref], {
      cwd: this.bareClonePath(repoName),
    });
    if (!result.success) {
      throw new Error(`Failed to add worktree at ${path} (${ref}): ${result.error}`);
    }
    await Utils.isolateWorktreeHooks(path);
    // Exclude only runtime artifacts: new settings.json and .env.example
    // must remain eligible for a worker-generated PR.
    excludeWorkerRuntimeFiles(path);
  }

  /**
   * Serialize compound Git administration without nesting public locks.
   *
   * Within this process the calls queue per repo; across processes (PR job
   * CLI subprocesses preparing review worktrees from the same bare clone)
   * the repository's git metadata lock is held around the operation, unless
   * `crossProcess` is false (network fetches). The first clone runs without
   * it: the bare clone directory, which holds the lock file, does not exist
   * yet.
   */
  private async withAdminLock<T>(
    repoName: string,
    operation: () => Promise<T>,
    options: { crossProcess?: boolean } = {},
  ): Promise<T> {
    const previous = this.adminTails.get(repoName) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.adminTails.set(repoName, tail);
    await previous;
    try {
      const clonePath = this.bareClonePath(repoName);
      return options.crossProcess !== false && existsSync(clonePath)
        ? await withRepoGitLock(clonePath, operation)
        : await operation();
    } finally {
      release();
      if (this.adminTails.get(repoName) === tail) {
        this.adminTails.delete(repoName);
      }
    }
  }
}
