import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Utils } from "../src/lib/utils";

describe("Default branch detection", () => {
  let repoDir: string;
  const remoteDirs: string[] = [];

  function configureOrigin(defaultBranch: string): string {
    execSync(`git branch -M ${defaultBranch}`, { cwd: repoDir });

    const remoteDir = join(
      tmpdir(),
      `default-branch-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    remoteDirs.push(remoteDir);
    mkdirSync(remoteDir, { recursive: true });
    execSync("git init --bare", { cwd: remoteDir });
    execSync(`git symbolic-ref HEAD refs/heads/${defaultBranch}`, { cwd: remoteDir });
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync(`git push -u origin ${defaultBranch}`, { cwd: repoDir });
    return remoteDir;
  }

  beforeEach(() => {
    repoDir = join(
      tmpdir(),
      `default-branch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(repoDir, { recursive: true });

    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    for (const remoteDir of remoteDirs.splice(0)) {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  test("should detect master when main does not exist", async () => {
    execSync("git branch -M master", { cwd: repoDir });

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("master");
    await expect(Utils.resolveDefaultBranch("main", { cwd: repoDir })).resolves.toBe("master");
  });

  test("should detect main when master does not exist", async () => {
    execSync("git branch -M main", { cwd: repoDir });

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("main");
    await expect(Utils.resolveDefaultBranch("master", { cwd: repoDir })).resolves.toBe("main");
  });

  test("uses main immediately when remote metadata identifies main", async () => {
    configureOrigin("main");
    execSync("git checkout -b feature/test", { cwd: repoDir });

    const gitCommands = spyOn(Utils, "executeGitCommand");
    try {
      const branch = await Utils.getMainBranchName({ cwd: repoDir });
      const result = await Utils.pullLatestChanges(branch, { cwd: repoDir });

      expect(branch).toBe("main");
      expect(result.success).toBe(true);
      expect(await Utils.getCurrentBranch(repoDir)).toBe("main");
      expect(gitCommands.mock.calls.map(([args]) => args).flat()).not.toContain("master");
    } finally {
      gitCommands.mockRestore();
    }
  });

  test("uses master when remote metadata identifies master", async () => {
    configureOrigin("master");

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("master");
  });

  test("supports a custom default branch from remote metadata", async () => {
    configureOrigin("develop");

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("develop");
  });

  test("prefers authoritative remote metadata over a stale cached origin HEAD", async () => {
    const remoteDir = configureOrigin("main");
    execSync("git branch master", { cwd: repoDir });
    execSync("git push origin master", { cwd: repoDir });
    execSync("git remote set-head origin master", { cwd: repoDir });
    execSync("git symbolic-ref HEAD refs/heads/main", { cwd: remoteDir });

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("main");
  });

  test("should fall back to master when pullLatestChanges is asked for main", async () => {
    execSync("git branch -M master", { cwd: repoDir });

    const result = await Utils.pullLatestChanges("main", { cwd: repoDir });

    expect(await Utils.getCurrentBranch(repoDir)).toBe("master");
    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to pull");
  });

  test("remoteBranchExists reports presence of a branch on origin", async () => {
    execSync("git branch -M master", { cwd: repoDir });

    const remoteDir = join(
      tmpdir(),
      `default-branch-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    remoteDirs.push(remoteDir);
    mkdirSync(remoteDir, { recursive: true });
    execSync("git init --bare", { cwd: remoteDir });
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push origin master", { cwd: repoDir });

    await expect(Utils.remoteBranchExists("master", { cwd: repoDir })).resolves.toBe(true);
    await expect(Utils.remoteBranchExists("main", { cwd: repoDir })).resolves.toBe(false);
  });
});
