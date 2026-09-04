import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isCommitAlreadyComplete,
  manualHookFixCommitArgs,
  MANUAL_HOOK_FIX_COMMIT_MESSAGE,
  verifyPushHookFix,
} from "../src/lib/git-hook-fixer";
import { Utils } from "../src/lib/utils";

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

  test("manualHookFixCommitArgs always includes -m so git never opens an editor", () => {
    const args = manualHookFixCommitArgs();
    expect(args).toEqual(["commit", "--no-verify", "-m", MANUAL_HOOK_FIX_COMMIT_MESSAGE]);
    expect(args.includes("-m")).toBe(true);
    expect(manualHookFixCommitArgs("custom msg")).toEqual([
      "commit",
      "--no-verify",
      "-m",
      "custom msg",
    ]);
  });

  test("manual fallback commit with -m succeeds without an editor", () => {
    writeFileSync(join(repoDir, "fix.txt"), "hook fix\n", "utf8");
    execSync("git add -A", { cwd: repoDir });
    // Simulate the hung path: GIT_EDITOR=nvim would block without -m.
    execSync(
      `git ${manualHookFixCommitArgs()
        .map((a) => JSON.stringify(a))
        .join(" ")}`,
      {
        cwd: repoDir,
        env: { ...process.env, GIT_EDITOR: "nvim", EDITOR: "nvim", VISUAL: "nvim" },
      },
    );
    const log = execSync("git log -1 --pretty=%s", { cwd: repoDir, encoding: "utf8" }).trim();
    expect(log).toBe(MANUAL_HOOK_FIX_COMMIT_MESSAGE);
  });
});

describe("verifyPushHookFix", () => {
  let testDir: string;
  let repoDir: string;
  let remoteDir: string;

  function git(cwd: string, command: string): string {
    return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
  }

  function installFailingPrePushHook(cwd: string): void {
    const hookPath = join(cwd, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      "#!/bin/sh\necho 'pre-push hook declined (intentional test failure)'\nexit 1\n",
      "utf8",
    );
    chmodSync(hookPath, 0o755);
  }

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `push-hook-verify-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    repoDir = join(testDir, "repo");
    remoteDir = join(testDir, "remote.git");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(remoteDir, { recursive: true });

    git(remoteDir, "init --bare");
    git(repoDir, "init");
    git(repoDir, "config user.email 'test@test.com'");
    git(repoDir, "config user.name 'Test User'");
    git(repoDir, "config commit.gpgsign false");
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    git(repoDir, "add .");
    git(repoDir, "commit -m 'Initial commit'");
    git(repoDir, "branch -M main");
    git(repoDir, `remote add origin ${remoteDir}`);
    git(repoDir, "checkout -b feature/dev-74");
    git(repoDir, "push -u origin feature/dev-74");
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

  test("succeeds without re-running hooks when HEAD is already on origin", async () => {
    installFailingPrePushHook(repoDir);

    const result = await verifyPushHookFix({ cwd: repoDir, expectedBranch: "feature/dev-74" });

    expect(result.success).toBe(true);
    expect(result.alreadyOnRemote).toBe(true);
    expect(result.amended).toBe(false);
    expect(result.message).toContain("skipping hook-rerunning dry-run");
  });

  test("reports the actual hook error when the commit is not on origin", async () => {
    git(repoDir, "commit --allow-empty -m 'local-only commit'");
    installFailingPrePushHook(repoDir);

    const result = await verifyPushHookFix({ cwd: repoDir, expectedBranch: "feature/dev-74" });

    expect(result.success).toBe(false);
    expect(result.alreadyOnRemote).toBe(false);
    expect(result.amended).toBe(false);
    expect(result.message.toLowerCase()).not.toContain("didn't amend");
    expect(result.message).toMatch(/pre-push|hook declined|failed to push/i);
  });

  test("amends leftover uncommitted changes before verifying", async () => {
    // Use an unpushed branch so amend + dry-run is a first push, not a
    // non-fast-forward rewrite of an already-published commit.
    git(repoDir, "checkout -b feature/unpushed");
    writeFileSync(join(repoDir, "fix.txt"), "hook fix leftover\n", "utf8");

    const result = await verifyPushHookFix({ cwd: repoDir, expectedBranch: "feature/unpushed" });

    expect(result.success).toBe(true);
    expect(result.amended).toBe(true);
    expect(result.alreadyOnRemote).toBe(false);
    expect(await Utils.hasUncommittedChanges(repoDir)).toBe(false);
    expect(existsSync(join(repoDir, "fix.txt"))).toBe(true);
    expect(git(repoDir, "log -1 --pretty=%s")).toBe("Initial commit");
  });

  test("pushCurrentBranch skips git push when origin already has HEAD", async () => {
    installFailingPrePushHook(repoDir);

    const result = await Utils.pushCurrentBranch({ cwd: repoDir });

    expect(result.success).toBe(true);
    expect(result.message).toContain("already on remote");
  });

  test("pushCurrentBranch reports the hook stdout in the failure message", async () => {
    // A failing pre-push hook prints its diagnostics to stdout while git
    // itself only adds one stderr line ("error: failed to push some refs").
    // The returned message must include both so failures are diagnosable.
    git(repoDir, "commit --allow-empty -m 'local-only commit'");
    installFailingPrePushHook(repoDir);

    const result = await Utils.pushCurrentBranch({ cwd: repoDir });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to push branch");
    expect(result.message).toContain("pre-push hook declined (intentional test failure)");
    expect(result.message).toContain("failed to push some refs");
    expect(result.hookError).toContain("pre-push hook declined (intentional test failure)");
  });

  test("pushCurrentBranch does not mistake simulated rejection text from a hook for divergence", async () => {
    git(repoDir, "commit --allow-empty -m 'local-only commit'");
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      [
        "#!/bin/sh",
        "echo '! [rejected] feature/dev-74 -> feature/dev-74 (non-fast-forward)' >&2",
        "echo 'Updates were rejected because the tip of your current branch is behind' >&2",
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(hookPath, 0o755);

    const result = await Utils.pushCurrentBranch({ cwd: repoDir });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to push branch");
    expect(result.message).not.toContain("branch diverged");
    expect(result.hookError).toContain("non-fast-forward");
    expect(result.hookError).toContain("Updates were rejected");
  });

  test("pushCurrentBranch still identifies a real non-fast-forward rejection", async () => {
    const competingRepoDir = join(testDir, "competing-repo");
    git(testDir, `clone ${remoteDir} ${competingRepoDir}`);
    git(competingRepoDir, "config user.email 'other@test.com'");
    git(competingRepoDir, "config user.name 'Other User'");
    git(competingRepoDir, "checkout feature/dev-74");
    git(competingRepoDir, "commit --allow-empty -m 'remote commit'");
    git(competingRepoDir, "push origin feature/dev-74");
    git(repoDir, "commit --allow-empty -m 'local commit'");

    const result = await Utils.pushCurrentBranch({ cwd: repoDir });

    expect(result.success).toBe(false);
    expect(result.message).toContain("branch diverged");
    expect(result.hookError).toBeUndefined();
  });

  test("remoteTrackingRefMatchesHead is false after a local-only commit", async () => {
    expect(await Utils.remoteTrackingRefMatchesHead("feature/dev-74", { cwd: repoDir })).toBe(true);

    git(repoDir, "commit --allow-empty -m 'not pushed'");

    expect(await Utils.remoteTrackingRefMatchesHead("feature/dev-74", { cwd: repoDir })).toBe(
      false,
    );
  });
});
