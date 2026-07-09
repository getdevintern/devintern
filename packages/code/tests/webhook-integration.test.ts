/**
 * Integration test suite for webhook server with queue and worktree
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Utils } from "../src/lib/utils";
import { execSync } from "child_process";

describe("Webhook Integration - Sequential Processing with Branch-Scoped Worktrees", () => {
  let testDir: string;
  let repoDir: string;
  let originalWorktreeEnv: string | undefined;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(
      tmpdir(),
      `webhook-integration-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(testDir, { recursive: true });

    // Isolate the shared review worktree path so these tests never remove or
    // prune the production worktree at /tmp/devintern-review-worktree.
    originalWorktreeEnv = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    process.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(testDir, "review-worktree");

    // Create a test git repository
    repoDir = join(testDir, "test-repo");
    mkdirSync(repoDir, { recursive: true });

    // Initialize git repo
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });

    // Create initial commit on main branch
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });

    // Create multiple PR branches
    for (let i = 1; i <= 3; i++) {
      execSync(`git checkout -b pr-${i}`, { cwd: repoDir });
      writeFileSync(join(repoDir, `pr${i}.txt`), `PR ${i} content\n`, "utf8");
      execSync("git add .", { cwd: repoDir });
      execSync(`git commit -m 'Add PR ${i} changes'`, { cwd: repoDir });
      execSync("git checkout main || git checkout master", { cwd: repoDir });
    }

    // Create .devintern-code directory
    mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
  });

  afterEach(() => {
    // Restore the review worktree path override
    if (originalWorktreeEnv === undefined) {
      delete process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    } else {
      process.env.DEVINTERN_REVIEW_WORKTREE_PATH = originalWorktreeEnv;
    }

    // Clean up test directory
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test("should use a distinct branch-scoped worktree for each PR", async () => {
    const branches = ["pr-1", "pr-2", "pr-3"];
    const results: Array<{
      branch: string;
      path: string;
      fileExists: boolean;
    }> = [];

    // Simulate sequential processing of multiple PRs
    for (const branch of branches) {
      const result = await Utils.prepareReviewWorktree(branch, {
        verbose: false,
        cwd: repoDir,
      });

      expect(result.success).toBe(true);
      expect(result.path).toBe(Utils.getReviewWorktreePath(branch)); // Branch-scoped path

      // Verify we're on the correct branch
      const branchCheck = await Utils.executeGitCommand(["branch", "--show-current"], {
        verbose: false,
        cwd: result.path!,
      });
      expect(branchCheck.output).toContain(branch);

      // Verify the correct file exists for this PR
      const expectedFile = join(result.path!, `${branch.replace("-", "")}.txt`);
      const fileExists = existsSync(expectedFile);

      results.push({
        branch,
        path: result.path!,
        fileExists,
      });

      // Simulate some work (like Agent processing)
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Verify all results
    expect(results.length).toBe(3);

    // Each branch should get its own distinct worktree path
    const uniquePaths = new Set(results.map((r) => r.path));
    expect(uniquePaths.size).toBe(3);

    // All should have found their respective files
    expect(results.every((r) => r.fileExists)).toBe(true);
  });

  test("should isolate files between sequential PR reviews", async () => {
    // Process first PR
    const result1 = await Utils.prepareReviewWorktree("pr-1", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result1.success).toBe(true);
    const path1 = result1.path!;

    // Verify pr-1 files exist
    expect(existsSync(join(path1, "pr1.txt"))).toBe(true);
    expect(existsSync(join(path1, "pr2.txt"))).toBe(false);

    // Get the current branch
    const branch1Check = await Utils.executeGitCommand(["branch", "--show-current"], {
      verbose: false,
      cwd: path1,
    });
    expect(branch1Check.output).toContain("pr-1");

    // Switch to second PR - gets its own worktree
    const result2 = await Utils.prepareReviewWorktree("pr-2", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result2.success).toBe(true);
    expect(result2.path).not.toBe(path1); // Different branch -> different path

    // pr-2 worktree has only pr-2's file
    expect(existsSync(join(result2.path!, "pr2.txt"))).toBe(true);
    expect(existsSync(join(result2.path!, "pr1.txt"))).toBe(false);

    // pr-1's worktree was pruned to bound disk usage
    expect(existsSync(path1)).toBe(false);

    // Verify we're on pr-2 branch
    const branch2Check = await Utils.executeGitCommand(["branch", "--show-current"], {
      verbose: false,
      cwd: result2.path!,
    });
    expect(branch2Check.output).toContain("pr-2");
  });

  test("should handle rapid sequential PR reviews without conflicts", async () => {
    const branches = ["pr-1", "pr-2", "pr-3", "pr-1", "pr-2"]; // Including repeats

    for (const branch of branches) {
      const result = await Utils.prepareReviewWorktree(branch, {
        verbose: false,
        cwd: repoDir,
      });

      expect(result.success).toBe(true);
      expect(result.path).toBe(Utils.getReviewWorktreePath(branch));

      // Verify correct branch
      const branchCheck = await Utils.executeGitCommand(["branch", "--show-current"], {
        verbose: false,
        cwd: result.path!,
      });
      expect(branchCheck.output).toContain(branch);
    }
  });

  test("should keep only the active branch's worktree on disk", async () => {
    // Process first PR
    const result1 = await Utils.prepareReviewWorktree("pr-1", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result1.success).toBe(true);
    expect(existsSync(result1.path!)).toBe(true);

    // Process second PR - first is pruned
    const result2 = await Utils.prepareReviewWorktree("pr-2", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result2.success).toBe(true);
    expect(existsSync(result2.path!)).toBe(true);
    expect(existsSync(result1.path!)).toBe(false);

    // Process third PR - second is pruned
    const result3 = await Utils.prepareReviewWorktree("pr-3", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result3.success).toBe(true);
    expect(existsSync(result3.path!)).toBe(true);
    expect(existsSync(result2.path!)).toBe(false);
  });

  test("should reuse the same worktree path when switching back to a branch", async () => {
    const branch = "pr-1";

    // First preparation
    const result1 = await Utils.prepareReviewWorktree(branch, {
      verbose: false,
      cwd: repoDir,
    });
    expect(result1.success).toBe(true);
    const expectedPath = Utils.getReviewWorktreePath(branch);
    expect(result1.path).toBe(expectedPath);

    // Switch to another branch (prunes pr-1's worktree)
    await Utils.prepareReviewWorktree("pr-2", { verbose: false, cwd: repoDir });

    // Switch back to pr-1 - same branch-scoped path, recreated
    const result2 = await Utils.prepareReviewWorktree(branch, {
      verbose: false,
      cwd: repoDir,
    });
    expect(result2.success).toBe(true);
    expect(result2.path).toBe(expectedPath);

    // Verify we're back on pr-1
    const check2 = await Utils.executeGitCommand(["branch", "--show-current"], {
      verbose: false,
      cwd: result2.path!,
    });
    expect(check2.output).toContain(branch);
  });

  test("should process PRs sequentially as the queue does", async () => {
    const branches = ["pr-1", "pr-2", "pr-3"];

    // Process sequentially (as the queue does in the webhook server)
    for (const branch of branches) {
      const result = await Utils.prepareReviewWorktree(branch, {
        verbose: false,
        cwd: repoDir,
      });
      expect(result.success).toBe(true);
      expect(result.path).toBe(Utils.getReviewWorktreePath(branch));
    }

    // The final state should be pr-3 (the last one processed) in its own worktree
    const finalPath = Utils.getReviewWorktreePath("pr-3");
    expect(existsSync(finalPath)).toBe(true);

    const finalBranch = await Utils.executeGitCommand(["branch", "--show-current"], {
      verbose: false,
      cwd: finalPath,
    });
    expect(finalBranch.output).toContain("pr-3");
  });

  test("should correctly handle branches with different file sets", async () => {
    // Create a branch with many files
    execSync("git checkout -b pr-large", { cwd: repoDir });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(repoDir, `file${i}.txt`), `Content ${i}`, "utf8");
    }
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Add many files'", { cwd: repoDir });
    execSync("git checkout main || git checkout master", { cwd: repoDir });

    // Prepare worktree for pr-large
    const result1 = await Utils.prepareReviewWorktree("pr-large", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result1.success).toBe(true);
    const largePath = result1.path!;

    // Verify all files exist
    for (let i = 0; i < 5; i++) {
      expect(existsSync(join(largePath, `file${i}.txt`))).toBe(true);
    }

    // Switch to pr-1 (its own worktree; pr-large is pruned)
    const result2 = await Utils.prepareReviewWorktree("pr-1", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result2.success).toBe(true);
    expect(result2.path).not.toBe(largePath);

    // The large branch's worktree (and its files) are gone
    expect(existsSync(largePath)).toBe(false);

    // pr-1 worktree has only pr-1's file
    expect(existsSync(join(result2.path!, "pr1.txt"))).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(existsSync(join(result2.path!, `file${i}.txt`))).toBe(false);
    }
  });
});
