/**
 * Feature branch creation must survive contention on the shared git config
 * lock. Fleet worktrees share one bare clone's `config`; git fails a config
 * write immediately when another process holds `config.lock`, which used to
 * abandon task starts with "feature branch creation failed".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Utils } from "../src/lib/utils";
import {
  describeConfigLockPlaceholder,
  executeGitCommandWithConfigLockRetry,
  setConfigLockRetryDelaysForTests,
} from "../src/lib/utils/git-exec";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/**
 * Make a never-clearing config lock fail at once. Git itself waits about a
 * second for a held config lock (`core.configLockTimeout`) on every attempt,
 * which only adds wall time when the lock is a permanent placeholder.
 */
const FAST_CONFIG_LOCK_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.configLockTimeout",
  GIT_CONFIG_VALUE_0: "0",
};

/** Tracking entries git recorded for `branch` in the shared config. */
function trackingConfig(commonDir: string, branch: string): string {
  try {
    return git(commonDir, "config", "--get-regexp", `^branch\\.${branch.replace(/\//g, "\\/")}\\.`);
  } catch {
    return "";
  }
}

describe("feature branch creation under config lock contention", () => {
  let root: string;
  let upstream: string;
  let bare: string;
  let worktree: string;
  let lockPath: string;
  let savedReviewWorktreeBase: string | undefined;
  let savedGitConfigEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "feature-branch-config-lock-"));
    // Review worktree prep sweeps every sibling of the base path; keep it
    // inside this test's root so it never touches a live worker's worktrees.
    savedReviewWorktreeBase = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    process.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(root, "review-worktree");
    upstream = join(root, "upstream");
    bare = join(root, "repo.git");
    worktree = join(root, "task-wt");
    lockPath = join(bare, "config.lock");

    git(root, "init", "-q", "-b", "main", upstream);
    git(upstream, "config", "user.email", "test@test.com");
    git(upstream, "config", "user.name", "Test User");
    writeFileSync(join(upstream, "README.md"), "# Test\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", "init");
    git(upstream, "branch", "existing-work");

    // Fleet layout: bare clone whose fetch writes only refs/remotes/origin/*,
    // a sibling worktree holding main (so the base is cut from origin/main),
    // and a detached task worktree.
    git(root, "clone", "-q", "--bare", upstream, bare);
    git(bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(bare, "fetch", "-q", "origin");
    git(bare, "worktree", "add", "-q", join(root, "main-wt"), "main");
    git(bare, "worktree", "add", "-q", "--detach", worktree, "origin/main");
    git(worktree, "config", "user.email", "test@test.com");
    git(worktree, "config", "user.name", "Test User");
  });

  afterEach(() => {
    if (savedReviewWorktreeBase === undefined) delete process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    else process.env.DEVINTERN_REVIEW_WORKTREE_PATH = savedReviewWorktreeBase;
    setConfigLockRetryDelaysForTests();
    for (const [key, value] of Object.entries(savedGitConfigEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedGitConfigEnv = {};
    rmSync(lockPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("creates the branch from origin/<target> while config.lock is held", async () => {
    writeFileSync(lockPath, "");

    const result = await Utils.createFeatureBranch("LOCK-1", "main", { cwd: worktree });

    expect(result.success).toBe(true);
    expect(result.branchName).toBe("feature/lock-1");
    expect(await Utils.getCurrentBranch(worktree)).toBe("feature/lock-1");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(git(bare, "rev-parse", "origin/main"));
    expect(existsSync(lockPath)).toBe(true);
  });

  test("writes no tracking entry for the base branch", async () => {
    const result = await Utils.createFeatureBranch("LOCK-2", "main", { cwd: worktree });

    expect(result.success).toBe(true);
    expect(trackingConfig(bare, "feature/lock-2")).toBe("");
  });

  test("recovers a branch a failed checkout -b created but did not switch to", async () => {
    const original = Utils.executeGitCommand;
    let injected = false;
    Utils.executeGitCommand = async (args, options) => {
      if (!injected && args[0] === "checkout" && args.includes("-b")) {
        injected = true;
        // What git does on a lost lock: the ref exists, HEAD stays detached.
        const start = args.at(-1) ?? "HEAD";
        await original(["branch", "--no-track", "feature/lock-3", start], options);
        return {
          success: false,
          output: "",
          error:
            "error: could not lock config file config: File exists\n" +
            "error: unable to write upstream branch configuration",
        };
      }
      return original(args, options);
    };

    try {
      const result = await Utils.createFeatureBranch("LOCK-3", "main", { cwd: worktree });

      expect(injected).toBe(true);
      expect(result.success).toBe(true);
      expect(result.branchName).toBe("feature/lock-3");
      expect(await Utils.getCurrentBranch(worktree)).toBe("feature/lock-3");
    } finally {
      Utils.executeGitCommand = original;
    }
  });

  test("resumes a remote-only branch without tracking config while locked", async () => {
    writeFileSync(lockPath, "");

    const result = await Utils.continueFeatureBranch("existing-work", { cwd: worktree });

    expect(result.success).toBe(true);
    expect(await Utils.getCurrentBranch(worktree)).toBe("existing-work");
    expect(trackingConfig(bare, "existing-work")).toBe("");
  });

  test("retries a config write while the lock is held briefly", async () => {
    writeFileSync(lockPath, "");
    const release = setTimeout(() => rmSync(lockPath, { force: true }), 150);

    try {
      const result = await executeGitCommandWithConfigLockRetry(
        ["config", "--file", join(bare, "config"), "devintern.test", "value"],
        { cwd: worktree },
      );

      expect(result.success).toBe(true);
      expect(git(bare, "config", "--get", "devintern.test")).toBe("value");
    } finally {
      clearTimeout(release);
    }
  });

  test("checks out a remote-only base with tracking once a brief lock is released", async () => {
    git(bare, "branch", "-D", "existing-work");
    writeFileSync(lockPath, "");
    const release = setTimeout(() => rmSync(lockPath, { force: true }), 150);

    try {
      const result = await Utils.checkoutBranch("existing-work", { cwd: worktree });

      expect(result.success).toBe(true);
      expect(await Utils.getCurrentBranch(worktree)).toBe("existing-work");
      expect(git(bare, "config", "--get", "branch.existing-work.merge")).toBe(
        "refs/heads/existing-work",
      );
    } finally {
      clearTimeout(release);
    }
  });

  test("first push restores the upstream lost to a briefly held lock", async () => {
    const created = await Utils.createFeatureBranch("LOCK-4", "main", { cwd: worktree });
    expect(created.success).toBe(true);
    writeFileSync(join(worktree, "change.txt"), "change\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "change");

    const original = Utils.executeGitCommand;
    Utils.executeGitCommand = async (args, options) => {
      if (args[0] === "push" && args.includes("-u")) {
        // Hold the lock across the push so git cannot record the upstream,
        // then release it shortly after, as a concurrent writer would.
        writeFileSync(lockPath, "");
        const result = await original(args, options);
        setTimeout(() => rmSync(lockPath, { force: true }), 100);
        return result;
      }
      return original(args, options);
    };

    try {
      const pushed = await Utils.pushCurrentBranch({ cwd: worktree });

      expect(pushed.success).toBe(true);
      expect(git(upstream, "rev-parse", "feature/lock-4")).toBe(git(worktree, "rev-parse", "HEAD"));
      expect(git(bare, "config", "--get", "branch.feature/lock-4.merge")).toBe(
        "refs/heads/feature/lock-4",
      );
    } finally {
      Utils.executeGitCommand = original;
    }
  });

  function useFastPermanentLock(): void {
    setConfigLockRetryDelaysForTests([1, 1, 1, 1, 1, 1]);
    savedGitConfigEnv = Object.fromEntries(
      Object.keys(FAST_CONFIG_LOCK_ENV).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, FAST_CONFIG_LOCK_ENV);
  }

  test("prepares a review worktree while a sandbox placeholder holds config.lock", async () => {
    // The placeholder never clears, so waiting out the backoff only adds wall time.
    useFastPermanentLock();
    // What a bubblewrap sandbox leaves as the mount point for masking config.lock.
    writeFileSync(lockPath, "");
    chmodSync(lockPath, 0o444);
    const branch = `review-lock-${process.pid}-${Date.now()}`;
    git(upstream, "branch", branch);
    let worktreePath: string | undefined;

    try {
      const result = await Utils.prepareReviewWorktree(branch, {
        cwd: bare,
        installDependencies: false,
      });
      worktreePath = result.path;

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(await Utils.getCurrentBranch(worktreePath)).toBe(branch);
      expect(git(worktreePath ?? "", "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", branch));
      expect(existsSync(lockPath)).toBe(true);

      // A second review of the same branch reuses (re-checks out) the worktree.
      const reused = await Utils.prepareReviewWorktree(branch, {
        cwd: bare,
        installDependencies: false,
      });
      expect(reused.error).toBeUndefined();
      expect(reused.success).toBe(true);
      expect(reused.path).toBe(worktreePath);
      expect(await Utils.getCurrentBranch(worktreePath)).toBe(branch);
    } finally {
      if (worktreePath) rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test("names a sandbox placeholder lock in the failure", async () => {
    useFastPermanentLock();
    writeFileSync(lockPath, "");
    chmodSync(lockPath, 0o444);

    const result = await executeGitCommandWithConfigLockRetry(
      ["config", "--file", join(bare, "config"), "devintern.test", "value"],
      { cwd: worktree },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(`${lockPath} is an empty read-only file`);
  });

  test("does not mistake an ordinary held lock for a sandbox placeholder", () => {
    writeFileSync(lockPath, "");
    const failure = {
      error: `error: could not lock config file ${join(bare, "config")}: File exists`,
    };

    expect(describeConfigLockPlaceholder(failure)).toBeUndefined();
    chmodSync(lockPath, 0o444);
    expect(describeConfigLockPlaceholder(failure)).toContain("empty read-only file");
    rmSync(lockPath, { force: true });
    expect(describeConfigLockPlaceholder(failure)).toBeUndefined();
  });
});
