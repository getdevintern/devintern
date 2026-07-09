/**
 * Test suite for git worktree utilities
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Utils } from "../src/lib/utils";
import { execSync } from "child_process";

describe("Git Worktree Utilities - Single Reusable Worktree", () => {
  let testDir: string;
  let repoDir: string;
  let originalWorktreeEnv: string | undefined;

  beforeEach(async () => {
    // Create unique test directory for each test to enable parallel execution
    testDir = join(
      tmpdir(),
      `worktree-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(testDir, { recursive: true });

    // Isolate the shared review worktree path to this test directory. Without
    // this, prepareReviewWorktree would remove/prune the production worktree
    // at /tmp/devintern-review-worktree — which is fatal when these tests run
    // under the pre-push hook inside that very worktree.
    originalWorktreeEnv = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    process.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(testDir, "review-worktree");

    // Create a test git repository
    repoDir = join(testDir, "test-repo");
    mkdirSync(repoDir, { recursive: true });

    // Initialize git repo
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });

    // Create initial commit
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });

    // Create a feature branch
    execSync("git checkout -b feature/test-branch", { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "Feature content\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Add feature'", { cwd: repoDir });
    execSync("git checkout main || git checkout master", { cwd: repoDir });

    // Create another branch
    execSync("git checkout -b feature/another-branch", { cwd: repoDir });
    writeFileSync(join(repoDir, "another.txt"), "Another content\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Add another'", { cwd: repoDir });
    execSync("git checkout main || git checkout master", { cwd: repoDir });

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

  test("should prepare review worktree for first branch", async () => {
    const result = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBeDefined();
    expect(existsSync(result.path!)).toBe(true);

    // Verify worktree contains the feature file
    const featureFile = join(result.path!, "feature.txt");
    expect(existsSync(featureFile)).toBe(true);

    // Verify path is the branch-scoped worktree path
    expect(result.path).toBe(Utils.getReviewWorktreePath("feature/test-branch"));
  });

  test("should use a separate worktree per branch and prune the old one", async () => {
    // Prepare worktree for first branch
    const result1 = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });

    expect(result1.success).toBe(true);
    const path1 = result1.path!;
    expect(existsSync(join(path1, "feature.txt"))).toBe(true);

    // Now prepare a different branch - gets its own branch-scoped worktree
    const result2 = await Utils.prepareReviewWorktree("feature/another-branch", {
      verbose: false,
      cwd: repoDir,
    });

    expect(result2.success).toBe(true);
    // Different branch -> different path
    expect(result2.path).not.toBe(path1);
    // New worktree has the other branch's file
    expect(existsSync(join(result2.path!, "another.txt"))).toBe(true);
    // The previous branch's worktree was pruned to bound disk usage
    expect(existsSync(path1)).toBe(false);
  });

  test("should reuse the same worktree for the same branch", async () => {
    const result1 = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result1.success).toBe(true);

    const result2 = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result2.success).toBe(true);

    // Same branch -> same path, reused (deps stay cached)
    expect(result2.path).toBe(result1.path);
    expect(existsSync(join(result2.path!, "feature.txt"))).toBe(true);
  });

  test("should get worktree path", () => {
    const path = Utils.getReviewWorktreePath();
    expect(path).toContain("review-worktree");
    expect(path).not.toContain("review-worktrees"); // singular, not plural
  });

  test("should scope worktree path by branch", () => {
    const base = Utils.getReviewWorktreePath();
    const scoped = Utils.getReviewWorktreePath("feature/dev-16");
    expect(scoped).toBe(`${base}-feature-dev-16`);
    expect(scoped).not.toBe(base);
  });

  test("should default to /tmp path without override", () => {
    const saved = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    delete process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    try {
      expect(Utils.getReviewWorktreePath()).toBe("/tmp/devintern-review-worktree");
    } finally {
      if (saved !== undefined) process.env.DEVINTERN_REVIEW_WORKTREE_PATH = saved;
    }
  });

  test("should handle non-existent branch gracefully", async () => {
    const result = await Utils.prepareReviewWorktree("non-existent-branch", {
      verbose: false,
      cwd: repoDir,
    });

    // Should fail gracefully
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("should execute git commands with custom cwd in worktree", async () => {
    const result = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });

    expect(result.success).toBe(true);
    const worktreePath = result.path!;

    // Execute git command in worktree
    const branchResult = await Utils.executeGitCommand(["branch", "--show-current"], {
      verbose: false,
      cwd: worktreePath,
    });

    expect(branchResult.success).toBe(true);
    expect(branchResult.output).toContain("feature/test-branch");
  });

  test("should switch back and forth between branches", async () => {
    const branch1 = "feature/test-branch";
    const branch2 = "feature/another-branch";

    // Switch to branch1
    const result1 = await Utils.prepareReviewWorktree(branch1, { verbose: false, cwd: repoDir });
    expect(result1.success).toBe(true);
    const path1 = result1.path!;

    // Verify branch1 content
    const branch1Result = await Utils.executeGitCommand(["branch", "--show-current"], {
      verbose: false,
      cwd: path1,
    });
    expect(branch1Result.output).toContain(branch1);

    // Switch to branch2 - its own branch-scoped worktree
    const result2 = await Utils.prepareReviewWorktree(branch2, { verbose: false, cwd: repoDir });
    expect(result2.success).toBe(true);
    expect(result2.path).toBe(Utils.getReviewWorktreePath(branch2));
    expect(result2.path).not.toBe(path1);

    // Verify branch2 content
    const branch2Result = await Utils.executeGitCommand(["branch", "--show-current"], {
      verbose: false,
      cwd: result2.path!,
    });
    expect(branch2Result.output).toContain(branch2);

    // Switch back to branch1 - same branch-scoped path as before
    const result3 = await Utils.prepareReviewWorktree(branch1, { verbose: false, cwd: repoDir });
    expect(result3.success).toBe(true);
    expect(result3.path).toBe(path1);

    // Verify back on branch1
    const branch1Result2 = await Utils.executeGitCommand(["branch", "--show-current"], {
      verbose: false,
      cwd: result3.path!,
    });
    expect(branch1Result2.output).toContain(branch1);
  });
});

describe("Git Worktree with Origin Remote", () => {
  let testDir: string;
  let repoDir: string;
  let bareDir: string;
  let originalWorktreeEnv: string | undefined;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `worktree-origin-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(testDir, { recursive: true });

    // Isolate the shared review worktree path so this suite's worktree
    // remove/prune in afterEach never touches the production worktree.
    originalWorktreeEnv = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    process.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(testDir, "review-worktree");

    // Create bare repo to serve as origin
    bareDir = join(testDir, "bare-origin");
    mkdirSync(bareDir, { recursive: true });
    execSync("git init --bare", { cwd: bareDir });

    // Create test repo
    repoDir = join(testDir, "test-repo");
    mkdirSync(repoDir, { recursive: true });

    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });

    // Create initial commit and push to origin
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });
    execSync(`git remote add origin ${bareDir}`, { cwd: repoDir });
    execSync("git push -u origin master", { cwd: repoDir });

    // Create feature branch and push
    execSync("git checkout -b feature/test-branch", { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "Feature content\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Add feature'", { cwd: repoDir });
    execSync("git push -u origin feature/test-branch", { cwd: repoDir });

    // Create another feature branch and push
    execSync("git checkout master", { cwd: repoDir });
    execSync("git checkout -b feature/another-branch", { cwd: repoDir });
    writeFileSync(join(repoDir, "another.txt"), "Another content\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Add another'", { cwd: repoDir });
    execSync("git push -u origin feature/another-branch", { cwd: repoDir });

    // Return to master
    execSync("git checkout master", { cwd: repoDir });
  });

  afterEach(() => {
    // Clean up the branch-scoped worktrees this suite may have created
    for (const branch of ["feature/test-branch", "feature/another-branch"]) {
      const worktreePath = Utils.getReviewWorktreePath(branch);
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, {
          cwd: repoDir,
          stdio: "ignore",
        });
      } catch {}
      try {
        if (existsSync(worktreePath)) {
          rmSync(worktreePath, { recursive: true, force: true });
        }
      } catch {}
    }
    try {
      execSync("git worktree prune", { cwd: repoDir });
    } catch {}

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
    } catch {}
  });

  test("should create worktree tracking origin branch", async () => {
    const result = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBeDefined();
    expect(existsSync(result.path!)).toBe(true);
    expect(existsSync(join(result.path!, "feature.txt"))).toBe(true);

    // Verify the branch tracks origin
    const trackResult = await Utils.executeGitCommand(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { verbose: false, cwd: result.path! },
    );
    expect(trackResult.success).toBe(true);
    expect(trackResult.output).toContain("origin/feature/test-branch");
  });

  test("should create worktree when branch is checked out in main (with origin)", async () => {
    // Check out the feature branch in main repo (simulates running task)
    execSync("git checkout feature/test-branch", { cwd: repoDir });

    // Try to create worktree for the same branch
    const result = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });

    // Should succeed via --force fallback
    expect(result.success).toBe(true);
    expect(result.path).toBeDefined();
    expect(existsSync(result.path!)).toBe(true);
    expect(existsSync(join(result.path!, "feature.txt"))).toBe(true);
  });

  test("should reset worktree to latest origin when branch existed locally", async () => {
    // Make a local-only commit on the feature branch
    execSync("git checkout feature/test-branch", { cwd: repoDir });
    writeFileSync(join(repoDir, "local-only.txt"), "Not pushed\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Local only commit'", { cwd: repoDir });
    execSync("git checkout master", { cwd: repoDir });

    // Create worktree - should get origin version (without local-only commit)
    const result = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });

    expect(result.success).toBe(true);
    expect(existsSync(join(result.path!, "feature.txt"))).toBe(true);
    // The local-only file should NOT be present since we reset to origin
    expect(existsSync(join(result.path!, "local-only.txt"))).toBe(false);
  });

  test("should recover from externally removed worktree (with origin)", async () => {
    // Create worktree
    const result1 = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result1.success).toBe(true);

    // Simulate external removal of the branch-scoped worktree
    rmSync(result1.path!, { recursive: true, force: true });

    // Should recover
    const result2 = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });

    expect(result2.success).toBe(true);
    expect(result2.path).toBe(result1.path);
    expect(existsSync(result2.path!)).toBe(true);
    expect(existsSync(join(result2.path!, "feature.txt"))).toBe(true);
  });

  test("should switch branches in worktree with origin", async () => {
    // Create worktree for first branch
    const result1 = await Utils.prepareReviewWorktree("feature/test-branch", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result1.success).toBe(true);
    expect(existsSync(join(result1.path!, "feature.txt"))).toBe(true);

    // Switch to another branch - its own branch-scoped worktree
    const result2 = await Utils.prepareReviewWorktree("feature/another-branch", {
      verbose: false,
      cwd: repoDir,
    });
    expect(result2.success).toBe(true);
    expect(result2.path).not.toBe(result1.path);
    expect(existsSync(join(result2.path!, "another.txt"))).toBe(true);
    expect(existsSync(join(result2.path!, "feature.txt"))).toBe(false);
    // The first branch's worktree was pruned
    expect(existsSync(result1.path!)).toBe(false);
  });
});
