import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readPublishedBranch } from "../src/lib/agent/run-harness-git";
import { Utils } from "../src/lib/utils";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

/**
 * Publish rewrites a resumed run's branch with a lease only when origin still
 * points at the commit the run started from. These tests cover the lease path
 * and every behavior that must stay unchanged around it (origin moved, plain
 * conflict-resolution pushes, fast-forwards, and first pushes).
 */
describe("pushCurrentBranch lease rewrite", () => {
  let testDir: string;
  let repoDir: string;
  let remoteDir: string;

  function configureRepo(cwd: string): void {
    git(cwd, "config user.email 'test@test.com'");
    git(cwd, "config user.name 'Test User'");
    git(cwd, "config commit.gpgsign false");
  }

  /** Amend the published commit with a real change so HEAD loses its history. */
  function amendPublishedCommit(): void {
    writeFileSync(join(repoDir, "amended.txt"), "amended by the resumed run\n", "utf8");
    git(repoDir, "add amended.txt");
    git(repoDir, "commit --amend --no-edit");
  }

  /** Run `command` from the consumer's pre-push hook. */
  function installPrePushHook(command: string, exitCode: number): void {
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(hookPath, ["#!/bin/sh", command, `exit ${exitCode}`, ""].join("\n"), "utf8");
    chmodSync(hookPath, 0o755);
  }

  beforeEach(() => {
    testDir = join(tmpdir(), `push-lease-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    repoDir = join(testDir, "repo");
    remoteDir = join(testDir, "remote.git");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(remoteDir, { recursive: true });

    git(remoteDir, "init --bare");
    git(repoDir, "init");
    configureRepo(repoDir);
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    git(repoDir, "add .");
    git(repoDir, "commit -m 'Initial commit'");
    git(repoDir, "branch -M main");
    git(repoDir, `remote add origin ${remoteDir}`);
    git(repoDir, "checkout -b feature/dev-1");
    git(repoDir, "push -u origin feature/dev-1");
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

  test("rewrites the published commit with a lease when the resumed run amended it", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    amendPublishedCommit();
    const rewrittenSha = git(repoDir, "rev-parse HEAD");

    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      lease: { branch: "feature/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("Rewrote");
    expect(result.message).toContain(publishedSha.slice(0, 7));
    expect(result.message).toContain(rewrittenSha.slice(0, 7));
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(rewrittenSha);
  });

  test("refuses a lease rewrite that only deletes published commits", async () => {
    const baseSha = git(repoDir, "rev-parse HEAD");
    writeFileSync(join(repoDir, "published.txt"), "published work\n", "utf8");
    git(repoDir, "add published.txt");
    git(repoDir, "commit -m 'published commit'");
    const publishedSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, "push origin feature/dev-1");

    // The agent reset to the commit before the published one. HEAD is still
    // ahead of the PR base, so the rest of the run accepts the branch; only the
    // lease push can tell this apart from an amend/rebase. Before the lease the
    // plain push was rejected as non-fast-forward and kept the published commit.
    git(repoDir, `reset --hard ${baseSha}`);

    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      expectedBranch: "feature/dev-1",
      lease: { branch: "feature/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("branch diverged");
    expect(result.message).toContain(publishedSha.slice(0, 7));
    expect(result.hookError).toBeUndefined();
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(publishedSha);
  });

  test("keeps the divergence failure when origin moved after the run started", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    amendPublishedCommit();

    const competingRepo = join(testDir, "competing");
    git(testDir, `clone ${remoteDir} ${competingRepo}`);
    configureRepo(competingRepo);
    git(competingRepo, "checkout feature/dev-1");
    git(competingRepo, "commit --allow-empty -m 'someone else pushed'");
    git(competingRepo, "push origin feature/dev-1");
    const movedSha = git(remoteDir, "rev-parse feature/dev-1");

    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      lease: { branch: "feature/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("branch diverged");
    expect(result.hookError).toBeUndefined();
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(movedSha);
  });

  test("does not rewrite a different feature branch that shares the lease commit", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, "branch feature/dev-2");
    git(repoDir, "push origin feature/dev-2");
    git(repoDir, "checkout feature/dev-2");
    amendPublishedCommit();

    // The run started on feature/dev-1. feature/dev-2 happens to point at the
    // same commit, but it is not this run's branch, so the lease must not
    // touch it.
    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      lease: { branch: "feature/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("branch diverged");
    expect(git(remoteDir, "rev-parse feature/dev-2")).toBe(publishedSha);
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(publishedSha);
  });

  test("refuses to publish a branch other than the one the lease was recorded from", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, "branch feature/dev-2");
    git(repoDir, "push origin feature/dev-2");
    git(repoDir, "checkout feature/dev-2");
    amendPublishedCommit();

    // publish passes the resumed run's branch as `expectedBranch`; a switch to
    // another branch must fail loudly before any push.
    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      expectedBranch: "feature/dev-1",
      lease: { branch: "feature/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain(
      "worktree HEAD is on 'feature/dev-2' but expected 'feature/dev-1'",
    );
    expect(git(remoteDir, "rev-parse feature/dev-2")).toBe(publishedSha);
  });

  test("refuses a stray branch even when no lease was recorded", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, "branch feature/dev-2");
    git(repoDir, "push origin feature/dev-2");
    git(repoDir, "checkout feature/dev-2");
    amendPublishedCommit();

    // The remote probe can fail or origin can move, leaving the lease unknown.
    // The branch guard must still refuse the stray branch on its own.
    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      expectedBranch: "feature/dev-1",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain(
      "worktree HEAD is on 'feature/dev-2' but expected 'feature/dev-1'",
    );
    expect(git(remoteDir, "rev-parse feature/dev-2")).toBe(publishedSha);
  });

  test("keeps conflict-resolution's plain-push refusal for rewritten history", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    amendPublishedCommit();

    // Conflict resolution passes the remote tip as `expectedRemoteSha` and no
    // lease, so a rewritten HEAD is still refused rather than force-pushed.
    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      expectedRemoteSha: publishedSha,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("HEAD is not descended from expected remote commit");
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(publishedSha);
  });

  test("fast-forwards with a plain push when HEAD still contains the recorded commit", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    writeFileSync(join(repoDir, "next.txt"), "new commit\n", "utf8");
    git(repoDir, "add next.txt");
    git(repoDir, "commit -m 'next commit'");
    const headSha = git(repoDir, "rev-parse HEAD");

    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      lease: { branch: "feature/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("Successfully pushed");
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(headSha);
  });

  test("first push still creates the remote branch and sets upstream", async () => {
    git(repoDir, "checkout -b feature/fresh");
    writeFileSync(join(repoDir, "fresh.txt"), "fresh work\n", "utf8");
    git(repoDir, "add fresh.txt");
    git(repoDir, "commit -m 'fresh commit'");
    const headSha = git(repoDir, "rev-parse HEAD");

    const result = await Utils.pushCurrentBranch({ cwd: repoDir });

    expect(result.success).toBe(true);
    expect(result.message).toContain("set upstream");
    expect(git(remoteDir, "rev-parse feature/fresh")).toBe(headSha);
  });

  test("does not lease a branch that is not a DevIntern feature branch", async () => {
    git(repoDir, "checkout -b hotfix/dev-1");
    git(repoDir, "push -u origin hotfix/dev-1");
    const publishedSha = git(repoDir, "rev-parse HEAD");
    writeFileSync(join(repoDir, "hotfix.txt"), "hotfix\n", "utf8");
    git(repoDir, "add hotfix.txt");
    git(repoDir, "commit --amend --no-edit");

    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      lease: { branch: "hotfix/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("branch diverged");
    expect(git(remoteDir, "rev-parse hotfix/dev-1")).toBe(publishedSha);
  });

  test("returns hookError when a failing pre-push hook leaves origin unchanged", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    amendPublishedCommit();
    installPrePushHook("echo 'pre-push hook declined (intentional test failure)'", 1);

    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      lease: { branch: "feature/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to push branch");
    expect(result.hookError).toContain("pre-push hook declined (intentional test failure)");
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(publishedSha);
  });

  test("preserves a competing commit pushed between the lease check and the force push", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    amendPublishedCommit();

    const competingRepo = join(testDir, "racing");
    git(testDir, `clone ${remoteDir} ${competingRepo}`);
    configureRepo(competingRepo);
    git(competingRepo, "checkout feature/dev-1");
    git(competingRepo, "commit --allow-empty -m 'raced in before the lease push'");
    const racedSha = git(competingRepo, "rev-parse HEAD");

    // Move origin after pushCurrentBranch read the remote tip but before its
    // force push lands.
    installPrePushHook(`git -C '${competingRepo}' push origin feature/dev-1`, 0);

    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      lease: { branch: "feature/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("branch diverged");
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(racedSha);
  });

  test("ignores a longer branch name that shares the probed suffix", async () => {
    const leaseSha = git(repoDir, "rev-parse HEAD");
    writeFileSync(join(repoDir, "moved.txt"), "moved by someone else\n", "utf8");
    git(repoDir, "add moved.txt");
    git(repoDir, "commit -m 'origin moved'");
    const movedSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, "push origin feature/dev-1");

    // `git ls-remote --heads origin feature/dev-1` matches ref tails, so this
    // branch (which sorts first) would shadow the real branch's tip. It points
    // at the lease commit, which would make a stale lease look unchanged and
    // misreport the rejection as a fixable hook error.
    git(repoDir, `branch a/feature/dev-1 ${leaseSha}`);
    git(repoDir, "push origin a/feature/dev-1");

    git(repoDir, `reset --hard ${leaseSha}`);
    writeFileSync(join(repoDir, "rewritten.txt"), "rewritten\n", "utf8");
    git(repoDir, "add rewritten.txt");
    git(repoDir, "commit --amend --no-edit");

    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      lease: { branch: "feature/dev-1", sha: leaseSha },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("branch diverged");
    expect(result.hookError).toBeUndefined();
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(movedSha);
    expect(git(remoteDir, "rev-parse a/feature/dev-1")).toBe(leaseSha);
  });

  test("reports a server-side rejection as non-fixable instead of a hook error", async () => {
    const publishedSha = git(repoDir, "rev-parse HEAD");
    amendPublishedCommit();

    // Branch protection or a pre-receive hook refuses the force push. The
    // hook-fixer's verification dry-run never invokes the server, so retrying
    // would spend agent runs on an answer the agent cannot change.
    const hookPath = join(remoteDir, "hooks", "pre-receive");
    writeFileSync(
      hookPath,
      "#!/bin/sh\necho 'GH006: Protected branch update failed' >&2\nexit 1\n",
      "utf8",
    );
    chmodSync(hookPath, 0o755);

    const result = await Utils.pushCurrentBranch({
      cwd: repoDir,
      lease: { branch: "feature/dev-1", sha: publishedSha },
    });

    expect(result.success).toBe(false);
    expect(result.hookError).toBeUndefined();
    expect(result.message).toContain("Push rejected by the remote");
    expect(result.message).toContain("GH006");
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(publishedSha);
  });

  test("records the published branch and commit at run start", async () => {
    expect(await readPublishedBranch({ cwd: repoDir })).toEqual({
      branch: "feature/dev-1",
      sha: git(repoDir, "rev-parse HEAD"),
    });
  });

  test("records the real branch tip when a longer ref name sorts first", async () => {
    const leaseSha = git(repoDir, "rev-parse HEAD");
    writeFileSync(join(repoDir, "moved.txt"), "moved by someone else\n", "utf8");
    git(repoDir, "add moved.txt");
    git(repoDir, "commit -m 'origin moved'");
    const movedSha = git(repoDir, "rev-parse HEAD");
    git(repoDir, "push origin feature/dev-1");

    // `git ls-remote --heads origin refs/heads/feature/dev-1` matches ref
    // tails, and this ref sorts before the real branch. It points at a commit
    // HEAD still contains, so a first-line read would record the shadow SHA as
    // the lease and later open the lease against the wrong commit.
    git(repoDir, `branch aaa/refs/heads/feature/dev-1 ${leaseSha}`);
    git(repoDir, "push origin aaa/refs/heads/feature/dev-1");

    expect(await readPublishedBranch({ cwd: repoDir })).toEqual({
      branch: "feature/dev-1",
      sha: movedSha,
    });
  });

  test("does not record a fresh branch that has no remote-tracking ref", async () => {
    git(repoDir, "checkout -b feature/fresh-read");

    expect(await readPublishedBranch({ cwd: repoDir })).toBeUndefined();
  });

  test("does not record a published branch the lease can never use", async () => {
    git(repoDir, "checkout -b hotfix/no-lease");
    git(repoDir, "push -u origin hotfix/no-lease");

    expect(await readPublishedBranch({ cwd: repoDir })).toBeUndefined();
  });

  test("does not record a published commit the run's HEAD does not contain", async () => {
    const competingRepo = join(testDir, "ahead");
    git(testDir, `clone ${remoteDir} ${competingRepo}`);
    configureRepo(competingRepo);
    git(competingRepo, "checkout feature/dev-1");
    git(competingRepo, "commit --allow-empty -m 'origin moved ahead'");
    git(competingRepo, "push origin feature/dev-1");

    expect(await readPublishedBranch({ cwd: repoDir })).toBeUndefined();
  });
});
