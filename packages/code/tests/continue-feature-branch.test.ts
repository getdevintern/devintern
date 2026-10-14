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
