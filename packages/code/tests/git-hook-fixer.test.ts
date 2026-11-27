import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildGitHookFixPrompt,
  isCommitAlreadyComplete,
  verifyPushHookFix,
} from "../src/lib/agent/git-hook-fixer";
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

  test("isCommitAlreadyComplete ignores untracked sandbox placeholders", async () => {
    execSync("mkfifo .gitconfig", { cwd: repoDir });
    writeFileSync(join(repoDir, ".bashrc"), "");
    expect(await isCommitAlreadyComplete(repoDir)).toBe(true);
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

  test("amends leftover changes without staging sandbox placeholders", async () => {
    git(repoDir, "checkout -b feature/unpushed");
    execSync("mkfifo .gitconfig", { cwd: repoDir });
    writeFileSync(join(repoDir, ".bashrc"), "");
    writeFileSync(join(repoDir, "fix.txt"), "hook fix leftover\n", "utf8");

    const result = await verifyPushHookFix({ cwd: repoDir, expectedBranch: "feature/unpushed" });

    expect(result.success).toBe(true);
    expect(result.amended).toBe(true);
    expect(git(repoDir, "show --name-only --format= HEAD").split("\n").sort()).toEqual([
      "README.md",
      "fix.txt",
    ]);
  });

  test("does not amend when only sandbox placeholders are present", async () => {
    git(repoDir, "checkout -b feature/unpushed");
    execSync("mkfifo .gitconfig", { cwd: repoDir });
    writeFileSync(join(repoDir, ".bashrc"), "");
    const head = git(repoDir, "rev-parse HEAD");

    const result = await verifyPushHookFix({ cwd: repoDir, expectedBranch: "feature/unpushed" });

    expect(result.amended).toBe(false);
    expect(git(repoDir, "rev-parse HEAD")).toBe(head);
  });

  test("verifies a hook fix with the lease after the agent rewrote the resumed branch", async () => {
    // The run resumed an already-published branch and the agent amended it, so
    // HEAD no longer contains the published commit. Publish rewrites that
    // branch under an explicit lease; the verification dry-run must probe the
    // same way instead of being rejected as non-fast-forward.
    const publishedSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, "commit --amend -m 'amended by the resumed run'");

    const result = await verifyPushHookFix({
      cwd: repoDir,
      expectedBranch: "feature/dev-74",
      lease: { branch: "feature/dev-74", sha: publishedSha },
    });

    expect(result.success).toBe(true);
    expect(result.alreadyOnRemote).toBe(false);
    // A dry-run never updates origin.
    expect(git(remoteDir, "rev-parse feature/dev-74")).toBe(publishedSha);
  });

  test("retries a one-time hook failure on a rewritten resumed branch", async () => {
    // Integration-style flow: the resumed run amended the published branch and
    // its push hit a pre-push hook that fails once. The agent then only amends
    // the commit; the retried verification must accept the rewritten branch
    // under the recorded lease.
    const publishedSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, "commit --amend -m 'amended by the resumed run'");

    const sentinel = join(testDir, "hook-failed-once");
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      [
        "#!/bin/sh",
        `if [ ! -f '${sentinel}' ]; then`,
        `  : > '${sentinel}'`,
        "  echo 'pre-push hook declined (first attempt)'",
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(hookPath, 0o755);

    const lease = { branch: "feature/dev-74", sha: publishedSha };
    const push = await Utils.pushCurrentBranch({
      cwd: repoDir,
      expectedBranch: "feature/dev-74",
      lease,
    });
    expect(push.success).toBe(false);
    expect(push.hookError).toContain("pre-push hook declined");

    // The hook-fixer agent only amends the existing commit.
    git(repoDir, "commit --amend -m 'amended by the hook fixer'");

    const second = await verifyPushHookFix({
      cwd: repoDir,
      expectedBranch: "feature/dev-74",
      lease,
    });
    expect(second.success).toBe(true);
    expect(git(remoteDir, "rev-parse feature/dev-74")).toBe(publishedSha);
  });

  test("refuses a lease dry-run that would only delete published commits", async () => {
    const baseSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, "commit --allow-empty -m 'published commit'");
    git(repoDir, "push origin feature/dev-74");
    const publishedSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, `reset --hard ${baseSha}`);

    // The agent rewound HEAD to an earlier commit; a force-with-lease dry-run
    // would succeed and green-light deleting the published commit.
    const result = await verifyPushHookFix({
      cwd: repoDir,
      expectedBranch: "feature/dev-74",
      lease: { branch: "feature/dev-74", sha: publishedSha },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain(publishedSha.slice(0, 7));
    expect(git(remoteDir, "rev-parse feature/dev-74")).toBe(publishedSha);
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

describe("buildGitHookFixPrompt", () => {
  const BULK_STAGE = /git add (\.|-A|--all)/;

  for (const hookType of ["commit", "push"] as const) {
    test(`${hookType} prompt stages only real work, never the whole tree`, () => {
      const prompt = buildGitHookFixPrompt(hookType, "/out/*/git-hook-errors.log");

      expect(prompt).toContain("git add -u");
      expect(prompt).toContain("git add <path>   # for each new file you intentionally created");
      expect(prompt).toContain("Never stage the whole tree or");
      expect(prompt).not.toMatch(BULK_STAGE);
    });
  }

  test("commit prompt keeps the explicit -m retry step", () => {
    const prompt = buildGitHookFixPrompt("commit", "/out/*/git-hook-errors.log");

    expect(prompt).toContain('git commit -m "fix: resolve pre-commit hook failures"');
    expect(prompt).toContain("tail -n 100 /out/*/git-hook-errors.log");
  });

  test("push prompt keeps the amend and verify steps", () => {
    const prompt = buildGitHookFixPrompt("push", "/out/*/git-hook-errors.log");

    expect(prompt).toContain("git push origin HEAD");
    expect(prompt).toContain("git commit --amend --no-edit");
    expect(prompt).toContain("**Verify the fix**");
  });

  test("lease push prompt verifies under the lease and forbids a plain push", () => {
    const prompt = buildGitHookFixPrompt("push", "/out/*/git-hook-errors.log", {
      branch: "feature/dev-74",
      sha: "abc123",
    });

    const leasedPush =
      "git push --force-with-lease=refs/heads/feature/dev-74:abc123 origin HEAD:refs/heads/feature/dev-74 --dry-run";
    expect(prompt).toContain(leasedPush);
    expect(prompt).not.toContain("git push origin HEAD");
    expect(prompt).not.toContain("git push --force ");
    expect(prompt).toContain("**Verify the fix** with the lease (dry run — do not publish)");
    expect(prompt).toContain("Do not run `git push --force` or a plain `git push`");
    expect(prompt).toContain(
      "- Do not push: the runner publishes this rewritten branch under `--force-with-lease` after verification",
    );
  });
});
