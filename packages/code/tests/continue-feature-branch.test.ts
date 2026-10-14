/**
 * Session pickup git helpers: resume an existing branch and describe already
 * landed work.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { Utils } from "../src/lib/utils";

describe("continueFeatureBranch", () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `continue-branch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    repoDir = join(testDir, "test-repo");
    mkdirSync(repoDir, { recursive: true });
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });
    try {
      execSync("git branch -M main", { cwd: repoDir });
    } catch {
      // Already on main.
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("checks out an existing branch without discarding its work", async () => {
    execSync("git checkout -b feature/proj-1", { cwd: repoDir });
    writeFileSync(join(repoDir, "work.txt"), "in progress\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'partial work'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    const result = await Utils.continueFeatureBranch("feature/proj-1", { cwd: repoDir });

    expect(result.success).toBe(true);
    expect(await Utils.getCurrentBranch(repoDir)).toBe("feature/proj-1");
    expect(existsSync(join(repoDir, "work.txt"))).toBe(true);
  });

  test("fails gracefully when the branch does not exist", async () => {
    const result = await Utils.continueFeatureBranch("feature/missing", { cwd: repoDir });

    expect(result.success).toBe(false);
    expect(result.message).toContain("feature/missing");
  });

  test("frees a branch held by another worktree and resumes it", async () => {
    // Mirrors a fleet run interrupted by a crash: it keeps its worktree for
    // debugging, and that worktree still holds the recorded branch. A plain
    // checkout is refused; resume must free the holder (keeping the branch's
    // commits) and check the branch out.
    execSync("git checkout -b feature/proj-9", { cwd: repoDir });
    writeFileSync(join(repoDir, "partial.txt"), "partial\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'partial work'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    const holder = join(testDir, "holder");
    execSync(`git worktree add "${holder}" feature/proj-9`, { cwd: repoDir });

    const result = await Utils.continueFeatureBranch("feature/proj-9", { cwd: repoDir });

    expect(result.success).toBe(true);
    expect(await Utils.getCurrentBranch(repoDir)).toBe("feature/proj-9");
    // The holding worktree was freed; the branch and its work survived.
    expect(existsSync(holder)).toBe(false);
    expect(existsSync(join(repoDir, "partial.txt"))).toBe(true);
  });

  test("preserves uncommitted work held by a worktree before resuming", async () => {
    execSync("git checkout -b feature/proj-10", { cwd: repoDir });
    writeFileSync(join(repoDir, "committed.txt"), "committed\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'committed work'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    const holder = join(testDir, "holder-wip");
    execSync(`git worktree add "${holder}" feature/proj-10`, { cwd: repoDir });
    // The interrupted attempt left an edit it never committed.
    writeFileSync(join(holder, "wip.txt"), "uncommitted wip\n", "utf8");

    // Pickup must describe the uncommitted work, not just committed state.
    const landed = await Utils.collectLandedWork("feature/proj-10", "main", { cwd: repoDir });
    expect(landed).toContain("wip.txt");

    const result = await Utils.continueFeatureBranch("feature/proj-10", { cwd: repoDir });

    expect(result.success).toBe(true);
    expect(await Utils.getCurrentBranch(repoDir)).toBe("feature/proj-10");
    expect(existsSync(holder)).toBe(false);
    // The uncommitted edit was preserved and restored onto the resumed branch.
    expect(existsSync(join(repoDir, "wip.txt"))).toBe(true);
  });

  test("leaves a dirty worktree in place when its uncommitted work cannot be stashed", async () => {
    execSync("git checkout -b feature/proj-11", { cwd: repoDir });
    writeFileSync(join(repoDir, "committed.txt"), "committed\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'committed work'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    const holder = join(testDir, "holder-unpreservable");
    execSync(`git worktree add "${holder}" feature/proj-11`, { cwd: repoDir });
    // The interrupted attempt left an edit it never committed.
    writeFileSync(join(holder, "wip.txt"), "uncommitted wip\n", "utf8");

    const original = Utils.executeGitCommand;
    Utils.executeGitCommand = async (args, options) => {
      if (args[0] === "stash" && args[1] === "push") {
        return { success: false, output: "", error: "stash failed" };
      }
      return original(args, options);
    };

    try {
      const result = await Utils.continueFeatureBranch("feature/proj-11", { cwd: repoDir });

      expect(result.success).toBe(false);
      // Force-removing the worktree would discard the edits pickup exists to
      // protect, so it is left in place instead.
      expect(existsSync(holder)).toBe(true);
      expect(existsSync(join(holder, "wip.txt"))).toBe(true);
    } finally {
      Utils.executeGitCommand = original;
    }
  });
});

describe("collectLandedWork", () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `landed-work-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repoDir = join(testDir, "test-repo");
    mkdirSync(repoDir, { recursive: true });
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });
    try {
      execSync("git branch -M main", { cwd: repoDir });
    } catch {
      // Already on main.
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("summarizes commits and changes relative to the base", async () => {
    execSync("git checkout -b feature/proj-2", { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "new feature\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'add feature file'", { cwd: repoDir });

    const landed = await Utils.collectLandedWork("feature/proj-2", "main", { cwd: repoDir });

    expect(landed).toBeString();
    expect(landed).toContain("add feature file");
    expect(landed).toContain("feature.txt");
  });

  test("returns undefined when the refs cannot be compared", async () => {
    const landed = await Utils.collectLandedWork("feature/missing", "main", { cwd: repoDir });
    expect(landed).toBeUndefined();
  });
});
