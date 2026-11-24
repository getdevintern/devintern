/**
 * Test to verify branch creation cleanup works correctly
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Utils } from "../src/lib/utils";

describe("Branch Creation Cleanup", () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    // Create temporary test directory
    testDir = join(
      require("os").tmpdir(),
      `branch-cleanup-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    repoDir = join(testDir, "test-repo");
    mkdirSync(repoDir, { recursive: true });

    // Initialize git repo
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });

    // Create initial commit on main
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });

    // Rename to main if needed
    try {
      execSync("git branch -M main", { cwd: repoDir });
    } catch {
      // Already on main
    }
  });

  afterEach(() => {
    // Clean up test directory
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  test("should clean up uncommitted changes before creating branch", async () => {
    // Make some uncommitted changes
    writeFileSync(join(repoDir, "uncommitted.txt"), "uncommitted content\n", "utf8");
    writeFileSync(join(repoDir, "README.md"), "# Modified README\n", "utf8");

    // Stage one file
    execSync("git add uncommitted.txt", { cwd: repoDir });

    // Verify there are uncommitted changes
    let hasChanges = await Utils.hasUncommittedChanges(repoDir);
    expect(hasChanges).toBe(true);

    // Create feature branch - should clean up automatically
    const result = await Utils.createFeatureBranch("TEST-123", undefined, { cwd: repoDir });

    expect(result.success).toBe(true);
    expect(result.branchName).toBe("feature/test-123");

    // Verify we're on the new branch
    const currentBranch = await Utils.getCurrentBranch(repoDir);
    expect(currentBranch).toBe("feature/test-123");

    // Verify no uncommitted changes remain
    hasChanges = await Utils.hasUncommittedChanges(repoDir);
    expect(hasChanges).toBe(false);

    // Verify uncommitted file was removed
    expect(existsSync(join(repoDir, "uncommitted.txt"))).toBe(false);

    // Verify modified file was reset
    const readmeContent = require("fs").readFileSync(join(repoDir, "README.md"), "utf8");
    expect(readmeContent).toBe("# Test Repo\n");
  });

  test("should clean up untracked files before creating branch", async () => {
    // Create untracked files
    writeFileSync(join(repoDir, "untracked1.txt"), "untracked 1\n", "utf8");
    writeFileSync(join(repoDir, "untracked2.txt"), "untracked 2\n", "utf8");

    // Create untracked directory
    mkdirSync(join(repoDir, "temp-dir"), { recursive: true });
    writeFileSync(join(repoDir, "temp-dir", "file.txt"), "temp file\n", "utf8");

    // Verify files exist
    expect(existsSync(join(repoDir, "untracked1.txt"))).toBe(true);
    expect(existsSync(join(repoDir, "untracked2.txt"))).toBe(true);
    expect(existsSync(join(repoDir, "temp-dir"))).toBe(true);

    // Create feature branch - should clean up untracked files
    const result = await Utils.createFeatureBranch("TEST-456", undefined, { cwd: repoDir });

    expect(result.success).toBe(true);

    // Verify untracked files were removed
    expect(existsSync(join(repoDir, "untracked1.txt"))).toBe(false);
    expect(existsSync(join(repoDir, "untracked2.txt"))).toBe(false);
    expect(existsSync(join(repoDir, "temp-dir"))).toBe(false);
  });

  test("should clean up staged changes before creating branch", async () => {
    // Make and stage changes
    writeFileSync(join(repoDir, "new-file.txt"), "new content\n", "utf8");
    execSync("git add new-file.txt", { cwd: repoDir });

    // Verify file is staged
    const statusOutput = execSync("git status --porcelain", { cwd: repoDir }).toString();
    expect(statusOutput).toContain("new-file.txt");

    // Create feature branch - should clean up
    const result = await Utils.createFeatureBranch("TEST-789", undefined, { cwd: repoDir });

    expect(result.success).toBe(true);

    // Verify no staged or uncommitted changes
    const hasChanges = await Utils.hasUncommittedChanges(repoDir);
    expect(hasChanges).toBe(false);

    // Verify file was removed
    expect(existsSync(join(repoDir, "new-file.txt"))).toBe(false);
  });

  test("should succeed even with mixed changes", async () => {
    // Mix of staged, modified, and untracked files
    writeFileSync(join(repoDir, "staged.txt"), "staged\n", "utf8");
    execSync("git add staged.txt", { cwd: repoDir });

    writeFileSync(join(repoDir, "README.md"), "# Modified\n", "utf8");

    writeFileSync(join(repoDir, "untracked.txt"), "untracked\n", "utf8");

    // Create feature branch - should handle all types of changes
    const result = await Utils.createFeatureBranch("TEST-MIX", undefined, { cwd: repoDir });

    expect(result.success).toBe(true);

    // Verify clean state
    const hasChanges = await Utils.hasUncommittedChanges(repoDir);
    expect(hasChanges).toBe(false);

    // Verify all files cleaned up
    expect(existsSync(join(repoDir, "staged.txt"))).toBe(false);
    expect(existsSync(join(repoDir, "untracked.txt"))).toBe(false);

    // Verify README reset to original
    const readmeContent = require("fs").readFileSync(join(repoDir, "README.md"), "utf8");
    expect(readmeContent).toBe("# Test Repo\n");
  });

  test("suffixes attempt-2 when the branch exists locally", async () => {
    execSync("git branch feature/test-456", { cwd: repoDir });

    const result = await Utils.createFeatureBranch("TEST-456", undefined, { cwd: repoDir });

    expect(result.success).toBe(true);
    expect(result.branchName).toBe("feature/test-456-attempt-2");
  });

  test("backs up discarded work to a DevIntern ref, off the shared stash stack", async () => {
    writeFileSync(join(repoDir, "README.md"), "# Modified README\n", "utf8");
    writeFileSync(join(repoDir, "untracked.txt"), "untracked\n", "utf8");

    const result = await Utils.createFeatureBranch("TEST-STASH", undefined, { cwd: repoDir });

    expect(result.success).toBe(true);
    expect(await Utils.hasUncommittedChanges(repoDir)).toBe(false);

    // `refs/stash` is shared by sibling worktrees, so the backup must not stay there.
    expect(execSync("git stash list", { cwd: repoDir }).toString().trim()).toBe("");

    const refs = execSync(
      "git for-each-ref --format='%(refname) %(objectname)' refs/devintern/backups/",
      { cwd: repoDir },
    )
      .toString()
      .trim()
      .split("\n");
    expect(refs).toHaveLength(1);
    const [refName, sha] = refs[0].split(" ");
    expect(refName).toMatch(/^refs\/devintern\/backups\/TEST-STASH-\d{8}T\d{6}Z$/);
    expect(execSync(`git log -1 --format=%s ${sha}`, { cwd: repoDir }).toString()).toContain(
      "devintern-code: pre-branch backup for TEST-STASH",
    );

    // The SHA restores both the modified and the untracked file.
    execSync(`git stash apply ${sha}`, { cwd: repoDir });
    expect(readFileSync(join(repoDir, "README.md"), "utf8")).toBe("# Modified README\n");
    expect(existsSync(join(repoDir, "untracked.txt"))).toBe(true);
  });

  test("leaves a pre-existing user stash entry untouched", async () => {
    writeFileSync(join(repoDir, "README.md"), "# User work\n", "utf8");
    execSync("git stash push -m 'user stash'", { cwd: repoDir });
    const userSha = execSync("git rev-parse stash@{0}", { cwd: repoDir }).toString().trim();

    writeFileSync(join(repoDir, "untracked.txt"), "untracked\n", "utf8");
    const result = await Utils.createFeatureBranch("TEST-USER", undefined, { cwd: repoDir });

    expect(result.success).toBe(true);
    const list = execSync("git stash list --format=%H", { cwd: repoDir }).toString().trim();
    expect(list).toBe(userSha);
  });

  test("keeps the stash entry and warns when the backup ref cannot be written", async () => {
    // A file where the ref directory should be makes `git update-ref` fail.
    writeFileSync(join(repoDir, ".git", "refs", "devintern"), "not a directory\n", "utf8");
    writeFileSync(join(repoDir, "untracked.txt"), "untracked\n", "utf8");

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(" "));
    });
    try {
      const result = await Utils.createFeatureBranch("TEST-FAIL", undefined, { cwd: repoDir });
      expect(result.success).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    expect(warnings.some((w) => w.includes("Could not move the backup"))).toBe(true);
    const stashList = execSync("git stash list", { cwd: repoDir }).toString();
    expect(stashList).toContain("devintern-code: pre-branch backup for TEST-FAIL");
  });

  test("restores a sibling stash dropped when the stack shifts before the drop", async () => {
    writeFileSync(join(repoDir, "untracked.txt"), "untracked\n", "utf8");

    // Push a sibling entry between the SHA re-check and `stash drop`, so the
    // index-based drop removes the sibling entry instead of ours.
    const siblingDir = join(testDir, "sibling");
    execSync(`git worktree add -q --detach ${siblingDir}`, { cwd: repoDir });
    let siblingSha = "";
    const executeGitCommand = Utils.executeGitCommand;
    const gitCommands = spyOn(Utils, "executeGitCommand").mockImplementation((args, options) => {
      if (args[0] === "stash" && args[1] === "drop" && !siblingSha) {
        writeFileSync(join(siblingDir, "sibling.txt"), "sibling\n", "utf8");
        execSync("git stash push -u -q -m 'sibling work'", { cwd: siblingDir });
        siblingSha = execSync("git rev-parse stash@{0}", { cwd: siblingDir }).toString().trim();
      }
      return executeGitCommand(args, options);
    });
    try {
      const result = await Utils.createFeatureBranch("TEST-RACE", undefined, { cwd: repoDir });
      expect(result.success).toBe(true);
    } finally {
      gitCommands.mockRestore();
    }

    expect(siblingSha).not.toBe("");
    const list = execSync("git stash list --format=%H%x09%gs", { cwd: repoDir }).toString();
    expect(list).toContain(`${siblingSha}\t`);
    expect(list).toContain("sibling work");
    expect(list).not.toContain("pre-branch backup for TEST-RACE");
  });

  test("warns and keeps every entry when a sibling push races each drop", async () => {
    writeFileSync(join(repoDir, "untracked.txt"), "untracked\n", "utf8");

    const siblingDir = join(testDir, "sibling");
    execSync(`git worktree add -q --detach ${siblingDir}`, { cwd: repoDir });
    let pushes = 0;
    const executeGitCommand = Utils.executeGitCommand;
    const gitCommands = spyOn(Utils, "executeGitCommand").mockImplementation((args, options) => {
      if (args[0] === "stash" && args[1] === "drop") {
        pushes++;
        writeFileSync(join(siblingDir, "sibling.txt"), `sibling ${pushes}\n`, "utf8");
        execSync(`git stash push -u -q -m 'sibling work ${pushes}'`, { cwd: siblingDir });
      }
      return executeGitCommand(args, options);
    });
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(" "));
    });
    try {
      const result = await Utils.createFeatureBranch("TEST-RACE2", undefined, { cwd: repoDir });
      expect(result.success).toBe(true);
    } finally {
      gitCommands.mockRestore();
      warnSpy.mockRestore();
    }

    expect(pushes).toBe(3);
    expect(warnings.some((w) => w.includes("remains on the git stash stack"))).toBe(true);
    const list = execSync("git stash list --format=%gs", { cwd: repoDir }).toString();
    for (let i = 1; i <= pushes; i++) expect(list).toContain(`sibling work ${i}`);
    expect(list).toContain("pre-branch backup for TEST-RACE2");
  });

  test("prunes backup refs older than 30 days and keeps newer ones", async () => {
    const makeBackupCommit = (date: string): string => {
      writeFileSync(join(repoDir, "scratch.txt"), `${date}\n`, "utf8");
      execSync("git stash push -u -q -m scratch", {
        cwd: repoDir,
        env: { ...process.env, GIT_COMMITTER_DATE: date },
      });
      const sha = execSync("git rev-parse stash@{0}", { cwd: repoDir }).toString().trim();
      execSync("git stash drop -q", { cwd: repoDir });
      return sha;
    };
    const day = 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    const oldSha = makeBackupCommit(`@${now - 31 * day} +0000`);
    const recentSha = makeBackupCommit(`@${now - 29 * day} +0000`);
    execSync(`git update-ref refs/devintern/backups/old-x ${oldSha}`, { cwd: repoDir });
    execSync(`git update-ref refs/devintern/backups/recent-x ${recentSha}`, { cwd: repoDir });
    // Same old commit outside the backup namespace must survive pruning.
    execSync(`git update-ref refs/devintern/other/old-x ${oldSha}`, { cwd: repoDir });

    writeFileSync(join(repoDir, "untracked.txt"), "untracked\n", "utf8");
    const result = await Utils.createFeatureBranch("TEST-PRUNE", undefined, { cwd: repoDir });
    expect(result.success).toBe(true);

    const refs = execSync("git for-each-ref --format='%(refname)' refs/devintern/", {
      cwd: repoDir,
    })
      .toString()
      .trim()
      .split("\n");
    expect(refs).not.toContain("refs/devintern/backups/old-x");
    expect(refs).toContain("refs/devintern/backups/recent-x");
    expect(refs).toContain("refs/devintern/other/old-x");
    expect(refs.some((r) => r.startsWith("refs/devintern/backups/TEST-PRUNE-"))).toBe(true);
  });

  test("suffixes attempt-2 when the branch exists only on the remote", async () => {
    // Simulate a fresh clone where a previous attempt's branch lives only as
    // a remote-tracking ref.
    execSync("git update-ref refs/remotes/origin/feature/test-789 HEAD", { cwd: repoDir });

    const result = await Utils.createFeatureBranch("TEST-789", undefined, { cwd: repoDir });

    expect(result.success).toBe(true);
    expect(result.branchName).toBe("feature/test-789-attempt-2");
  });
});
