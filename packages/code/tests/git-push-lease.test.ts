import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readPublishedBranchSha } from "../src/lib/agent/run-harness-git";
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
      leaseRemoteSha: publishedSha,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("Rewrote");
    expect(result.message).toContain(publishedSha.slice(0, 7));
    expect(result.message).toContain(rewrittenSha.slice(0, 7));
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(rewrittenSha);
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
      leaseRemoteSha: publishedSha,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("branch diverged");
    expect(result.hookError).toBeUndefined();
    expect(git(remoteDir, "rev-parse feature/dev-1")).toBe(movedSha);
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
      leaseRemoteSha: publishedSha,
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
      leaseRemoteSha: publishedSha,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("branch diverged");
    expect(git(remoteDir, "rev-parse hotfix/dev-1")).toBe(publishedSha);
  });

  test("records the published commit at run start", async () => {
    expect(await readPublishedBranchSha({ cwd: repoDir })).toBe(git(repoDir, "rev-parse HEAD"));
  });

  test("does not record a published commit the run's HEAD does not contain", async () => {
    const competingRepo = join(testDir, "ahead");
    git(testDir, `clone ${remoteDir} ${competingRepo}`);
    configureRepo(competingRepo);
    git(competingRepo, "checkout feature/dev-1");
    git(competingRepo, "commit --allow-empty -m 'origin moved ahead'");
    git(competingRepo, "push origin feature/dev-1");

    expect(await readPublishedBranchSha({ cwd: repoDir })).toBeUndefined();
  });
});
