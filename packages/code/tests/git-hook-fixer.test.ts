import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isCommitAlreadyComplete } from "../src/lib/git-hook-fixer";

describe("git-hook-fixer", () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `git-hook-fixer-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    repoDir = join(testDir, "test-repo");
    mkdirSync(repoDir, { recursive: true });

    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });

    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });
    execSync("git branch -M main", { cwd: repoDir });
  });

  afterEach(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  test("isCommitAlreadyComplete returns true when working tree is clean", async () => {
    expect(await isCommitAlreadyComplete(repoDir)).toBe(true);
  });

  test("isCommitAlreadyComplete returns false when there are uncommitted changes", async () => {
    writeFileSync(join(repoDir, "change.txt"), "pending change\n", "utf8");
    expect(await isCommitAlreadyComplete(repoDir)).toBe(false);
  });
});
