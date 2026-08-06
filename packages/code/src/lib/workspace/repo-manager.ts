/**
 * Worker-managed repositories: bare clones + per-task worktrees.
 *
 * Fleet mode never runs the pipeline in a user checkout. Each configured
 * repo gets one bare clone under `<workspace>/repos/<name>.git`, and every
 * task run gets a disposable worktree under `<workspace>/worktrees/<name>/`.
 * The pipeline's tree-mutating steps (`createFeatureBranch` does
 * `git reset --hard` + `git clean -fd`) are safe there because the tree is
 * throwaway: removed after a successful run, kept for debugging on failure,
 * and swept by TTL on worker start.
 *
 * Bare-clone gotcha: `git clone --bare` records `remote.origin.url` but NOT
 * a fetch refspec, so `git fetch origin` would never update
 * `refs/remotes/origin/*`. `ensureBareClone` writes the standard refspec and
 * points `origin/HEAD` (used by `Utils.getMainBranchName`) so worktrees and
 * default-branch resolution behave like a normal clone.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { Utils } from "../utils";
import type { RepoConfig } from "./config";
import { reposDir, resolveWorkspaceDir, worktreesDir } from "./paths";

/** Name of the persistent per-repo worktree used for review/mention runs. */
export const BASE_WORKTREE_NAME = "base";

export class RepoManager {
  private workspaceDir: string;

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

  /**
   * Ensure the bare clone for a repo exists and is fetch-ready.
   *
   * Clones on first use, then fixes the missing fetch refspec and resolves
   * `origin/HEAD`. Idempotent; cheap when the clone already exists.
   *
   * @throws When cloning or configuring the repository fails.
   */
  async ensureBareClone(repo: RepoConfig): Promise<string> {
    const clonePath = this.bareClonePath(repo.name);
    if (existsSync(clonePath)) {
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

    await this.fetch(repo.name);

    // origin/HEAD backs Utils.getMainBranchName; ignore failure (repos with
    // an explicit default_branch never consult it).
    await Utils.executeGitCommand(["remote", "set-head", "origin", "-a"], { cwd: clonePath });

    return clonePath;
  }

  /**
   * Update `refs/remotes/origin/*` from the remote.
   *
   * @throws When the fetch fails (network, auth, missing clone).
   */
  async fetch(repoName: string): Promise<void> {
    const result = await Utils.executeGitCommand(["fetch", "--prune", "origin"], {
      cwd: this.bareClonePath(repoName),
    });
    if (!result.success) {
      throw new Error(`Failed to fetch repo "${repoName}": ${result.error}`);
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
   * Ensure the persistent base worktree (default branch) exists.
   *
   * Review and mention runs need a normal checkout to operate from; task
   * runs use disposable worktrees instead.
   */
  async ensureBaseWorktree(repo: RepoConfig): Promise<string> {
    const path = this.baseWorktreePath(repo.name);
    if (existsSync(path)) {
      return path;
    }
    const branch = await this.resolveDefaultBranch(repo);
    await this.addWorktree(repo.name, path, `origin/${branch}`);
    return path;
  }

  /**
   * Create a disposable, detached worktree for one task run.
   *
   * @param repo - Workspace repo the task routed to
   * @param taskKey - Task key; used in the directory name for debuggability
   * @returns Absolute worktree path (unique per call).
   */
  async createTaskWorktree(repo: RepoConfig, taskKey: string): Promise<string> {
    const branch = await this.resolveDefaultBranch(repo);
    const safeKey = taskKey.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const path = join(this.repoWorktreesDir(repo.name), `${safeKey}-${Date.now()}`);
    await this.addWorktree(repo.name, path, `origin/${branch}`);
    return path;
  }

  /**
   * Remove a task worktree (after a successful run).
   *
   * Failed runs keep their worktree for debugging; the TTL sweep collects
   * them later.
   */
  async removeTaskWorktree(repoName: string, worktreePath: string): Promise<void> {
    const cwd = this.bareClonePath(repoName);
    await Utils.executeGitCommand(["worktree", "remove", "--force", worktreePath], { cwd });
    await Utils.executeGitCommand(["worktree", "prune"], { cwd });
  }

  /**
   * Remove leftover task worktrees older than the TTL.
   *
   * Runs on worker start. The base worktree is never swept.
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
      if (entry === BASE_WORKTREE_NAME) {
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

  private async addWorktree(repoName: string, path: string, ref: string): Promise<void> {
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
  }
}
