import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Utils } from "../src/lib/utils";

describe("pullLatestChanges", () => {
  let repoDir: string;
  let remoteDir: string;

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    repoDir = join(tmpdir(), `pull-latest-test-${suffix}`);
    remoteDir = join(tmpdir(), `pull-latest-remote-${suffix}`);
    mkdirSync(repoDir, { recursive: true });
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });
    execSync("git branch -M master", { cwd: repoDir });

    execSync(`git init --bare "${remoteDir}"`, { cwd: repoDir });
    execSync(`git remote add origin "${remoteDir}"`, { cwd: repoDir });
    execSync("git push -u origin master", { cwd: repoDir });

    execSync("git checkout -b feature/task-trackers", { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature work\n", "utf8");
    execSync("git add feature.txt", { cwd: repoDir });
    execSync("git commit -m 'Feature commit'", { cwd: repoDir });
    execSync("git push -u origin feature/task-trackers", { cwd: repoDir });

    execSync("git checkout master", { cwd: repoDir });
    execSync("git branch -D feature/task-trackers", { cwd: repoDir });
    execSync("git clean -fd", { cwd: repoDir });
    execSync("git update-ref -d refs/remotes/origin/feature/task-trackers", { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  });

  test("fetches and checks out a branch that only exists on origin", async () => {
    const result = await Utils.pullLatestChanges("feature/task-trackers", {
      verbose: false,
      cwd: repoDir,
    });

    expect(result.success).toBe(true);
    expect(await Utils.getCurrentBranch(repoDir)).toBe("feature/task-trackers");
    expect(
      await Utils.gitRefExists("refs/remotes/origin/feature/task-trackers", { cwd: repoDir }),
    ).toBe(true);
  });
});
