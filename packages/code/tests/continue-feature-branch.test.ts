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

  test("never removes the primary checkout or its shared git database", async () => {
    execSync("git checkout -b feature/primary", { cwd: repoDir });
    const retry = join(testDir, "retry");
    execSync(`git worktree add --detach "${retry}" main`, { cwd: repoDir });
    writeFileSync(join(repoDir, "wip.txt"), "keep primary work\n");
    const result = await Utils.continueFeatureBranch("feature/primary", {
      cwd: retry,
      ownedWorktreeRoot: testDir,
    });
    expect(result.success).toBe(false);
    expect(existsSync(join(repoDir, ".git"))).toBe(true);
    expect(existsSync(join(repoDir, "wip.txt"))).toBe(true);
    expect(await Utils.getCurrentBranch(repoDir)).toBe("feature/primary");
  });

  test("leaves user-owned linked worktrees untouched", async () => {
    const holder = join(testDir, "user-checkout");
    execSync(`git worktree add -b feature/user "${holder}" main`, { cwd: repoDir });
    writeFileSync(join(holder, "wip.txt"), "keep user work\n");
    const result = await Utils.continueFeatureBranch("feature/user", { cwd: repoDir });
    expect(result.success).toBe(false);
    expect(existsSync(join(holder, "wip.txt"))).toBe(true);
  });

  test("respects Git's refusal to remove a locked owned worktree", async () => {
    const holder = join(testDir, "locked");
    execSync(`git worktree add -b feature/locked "${holder}" main`, { cwd: repoDir });
    execSync(`git worktree lock "${holder}"`, { cwd: repoDir });
    const result = await Utils.continueFeatureBranch("feature/locked", {
      cwd: repoDir,
      ownedWorktreeRoot: testDir,
    });
    expect(result.success).toBe(false);
    expect(existsSync(holder)).toBe(true);
    expect(await Utils.getCurrentBranch(holder)).toBe("feature/locked");
  });

  test("frees a branch held by another worktree and resumes it", async () => {
    // Mirrors a fleet run interrupted by a crash: it keeps its worktree for
    // debugging, and that worktree still holds the recorded branch. A plain
    // checkout is refused; resume must free the holder (keeping the branch's
    // commits) and check the branch out.
    execSync("git checkout -b feature/proj-9", { cwd: repoDir });
    writeFileSync(join(repoDir, "partial.txt"), "partial\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'partial work'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    const holder = join(testDir, "holder");
    execSync(`git worktree add "${holder}" feature/proj-9`, { cwd: repoDir });

    const result = await Utils.continueFeatureBranch("feature/proj-9", {
      cwd: repoDir,
      ownedWorktreeRoot: testDir,
    });

    expect(result.success).toBe(true);
    expect(await Utils.getCurrentBranch(repoDir)).toBe("feature/proj-9");
    // The holding worktree was freed; the branch and its work survived.
    expect(existsSync(holder)).toBe(false);
    expect(existsSync(join(repoDir, "partial.txt"))).toBe(true);
  });

  test("preserves uncommitted work held by a worktree before resuming", async () => {
    execSync("git checkout -b feature/proj-10", { cwd: repoDir });
    writeFileSync(join(repoDir, "committed.txt"), "committed\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'committed work'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    const holder = join(testDir, "holder-wip");
    execSync(`git worktree add "${holder}" feature/proj-10`, { cwd: repoDir });
    // The interrupted attempt left an edit it never committed.
    writeFileSync(join(holder, "wip.txt"), "uncommitted wip\n", "utf8");

    // Pickup must describe the uncommitted work, not just committed state.
    const landed = await Utils.collectLandedWork("feature/proj-10", "main", { cwd: repoDir });
    expect(landed).toContain("wip.txt");

    const result = await Utils.continueFeatureBranch("feature/proj-10", {
      cwd: repoDir,
      ownedWorktreeRoot: testDir,
    });

    expect(result.success).toBe(true);
    expect(await Utils.getCurrentBranch(repoDir)).toBe("feature/proj-10");
    expect(existsSync(holder)).toBe(false);
    // The uncommitted edit was preserved and restored onto the resumed branch.
    expect(existsSync(join(repoDir, "wip.txt"))).toBe(true);
  });

  test("leaves a dirty worktree in place when its uncommitted work cannot be stashed", async () => {
    execSync("git checkout -b feature/proj-11", { cwd: repoDir });
    writeFileSync(join(repoDir, "committed.txt"), "committed\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'committed work'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    const holder = join(testDir, "holder-unpreservable");
    execSync(`git worktree add "${holder}" feature/proj-11`, { cwd: repoDir });
    // The interrupted attempt left an edit it never committed.
    writeFileSync(join(holder, "wip.txt"), "uncommitted wip\n", "utf8");

    const original = Utils.executeGitCommand;
    Utils.executeGitCommand = async (args, options) => {
      if (args[0] === "stash" && args[1] === "push") {
        return { success: false, output: "", error: "stash failed" };
      }
      return original(args, options);
    };

    try {
      const result = await Utils.continueFeatureBranch("feature/proj-11", {
        cwd: repoDir,
        ownedWorktreeRoot: testDir,
      });

      expect(result.success).toBe(false);
      // Force-removing the worktree would discard the edits pickup exists to
      // protect, so it is left in place instead.
      expect(existsSync(holder)).toBe(true);
      expect(existsSync(join(holder, "wip.txt"))).toBe(true);
    } finally {
      Utils.executeGitCommand = original;
    }
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

describe("hasCommitsAhead", () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `commits-ahead-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  test("is true when the branch has commits ahead of the base", async () => {
    execSync("git checkout -b feature/proj-20", { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "new feature\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'add feature file'", { cwd: repoDir });

    expect(await Utils.hasCommitsAhead("feature/proj-20", "main", { cwd: repoDir })).toBe(true);
  });

  test("is false for a branch with no commits ahead", async () => {
    execSync("git checkout -b feature/proj-21", { cwd: repoDir });

    expect(await Utils.hasCommitsAhead("feature/proj-21", "main", { cwd: repoDir })).toBe(false);
  });

  test("is false when either ref is missing", async () => {
    expect(await Utils.hasCommitsAhead("feature/missing", "main", { cwd: repoDir })).toBe(false);
    expect(await Utils.hasCommitsAhead("main", "missing", { cwd: repoDir })).toBe(false);
  });

  test("is true for a branch that only exists as an origin remote ref", async () => {
    execSync("git checkout -b feature/remote-only", { cwd: repoDir });
    writeFileSync(join(repoDir, "remote.txt"), "remote work\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'remote-only work'", { cwd: repoDir });
    const sha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
    execSync(`git update-ref refs/remotes/origin/feature/remote-only ${sha}`, { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });
    execSync("git branch -D feature/remote-only", { cwd: repoDir });

    expect(await Utils.hasCommitsAhead("feature/remote-only", "main", { cwd: repoDir })).toBe(true);
  });

  test("accepts an origin/-prefixed base branch", async () => {
    execSync("git checkout -b feature/prefixed-base", { cwd: repoDir });
    writeFileSync(join(repoDir, "prefixed.txt"), "prefixed work\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'prefixed-base work'", { cwd: repoDir });
    const mainSha = execSync("git rev-parse main", { cwd: repoDir, encoding: "utf8" }).trim();
    execSync(`git update-ref refs/remotes/origin/main ${mainSha}`, { cwd: repoDir });
    // Drop the local base ref so the probe must resolve `origin/main`.
    execSync("git branch -D main", { cwd: repoDir });

    expect(
      await Utils.hasCommitsAhead("feature/prefixed-base", "origin/main", { cwd: repoDir }),
    ).toBe(true);
  });

  test("returns false for an origin/-prefixed base that has no remote ref", async () => {
    execSync("git checkout -b feature/prefixed-missing", { cwd: repoDir });
    writeFileSync(join(repoDir, "prefixed.txt"), "prefixed work\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'prefixed work'", { cwd: repoDir });
    // Local `main` exists and the branch is ahead of it, so a fallback to
    // `refs/heads/main` would report true. An explicit origin/ prefix must not
    // silently compare against that unrelated local ref.
    execSync("git rev-parse --verify refs/heads/main", { cwd: repoDir });
    expect(() =>
      execSync("git rev-parse --verify refs/remotes/origin/main", { cwd: repoDir }),
    ).toThrow();

    expect(
      await Utils.hasCommitsAhead("feature/prefixed-missing", "origin/main", { cwd: repoDir }),
    ).toBe(false);
    expect(
      await Utils.collectLandedWork("feature/prefixed-missing", "origin/main", { cwd: repoDir }),
    ).toBeUndefined();
  });

  test("is false when only the stale local base lags the feature branch", async () => {
    // Fleet bare clones never advance refs/heads/* (the fetch refspec writes
    // only refs/remotes/origin/*). Model that: local main stays at the clone
    // commit while origin/main moves on, and the feature branch starts from the
    // current origin/main.
    execSync("git checkout -b feature/proj-22", { cwd: repoDir });
    writeFileSync(join(repoDir, "upstream.txt"), "upstream work\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'upstream work'", { cwd: repoDir });
    const upstreamSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
    execSync(`git update-ref refs/remotes/origin/main ${upstreamSha}`, { cwd: repoDir });
    execSync("git checkout -b feature/proj-23", { cwd: repoDir });
    // Local refs/heads/main is still the initial commit, so main..feature moves.
    expect(
      execSync("git rev-list --count refs/heads/main..feature/proj-23", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim(),
    ).toBe("1");
    expect(
      execSync("git rev-list --count refs/remotes/origin/main..feature/proj-23", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim(),
    ).toBe("0");

    expect(await Utils.hasCommitsAhead("feature/proj-23", "main", { cwd: repoDir })).toBe(false);
    expect(await Utils.hasCommitsAhead("feature/proj-23", "origin/main", { cwd: repoDir })).toBe(
      false,
    );
  });

  test("collects no landed work when the branch only contains upstream commits", async () => {
    execSync("git checkout -b feature/proj-24", { cwd: repoDir });
    writeFileSync(join(repoDir, "upstream.txt"), "upstream work\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'upstream work'", { cwd: repoDir });
    const upstreamSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
    execSync(`git update-ref refs/remotes/origin/main ${upstreamSha}`, { cwd: repoDir });

    expect(
      await Utils.collectLandedWork("feature/proj-24", "main", { cwd: repoDir }),
    ).toBeUndefined();
  });

  test("local-first compares a CLI branch against the base it was cut from", async () => {
    // Normal CLI checkout: origin/main is still at the initial commit, local
    // main gains an unpushed commit, and the feature branch is cut from local
    // main with no work of its own. Remote-first sees that local-only commit as
    // landed work; local-first correctly reports an empty branch.
    const initial = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
    execSync(`git update-ref refs/remotes/origin/main ${initial}`, { cwd: repoDir });
    writeFileSync(join(repoDir, "local-only.txt"), "local-only main work\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'local-only main commit'", { cwd: repoDir });
    execSync("git checkout -b feature/empty", { cwd: repoDir });

    expect(
      await Utils.hasCommitsAhead("feature/empty", "main", {
        cwd: repoDir,
        basePreference: "remote-first",
      }),
    ).toBe(true);
    expect(
      await Utils.hasCommitsAhead("feature/empty", "main", {
        cwd: repoDir,
        basePreference: "local-first",
      }),
    ).toBe(false);

    const remoteFirst = await Utils.collectLandedWork("feature/empty", "main", {
      cwd: repoDir,
      basePreference: "remote-first",
    });
    expect(remoteFirst).toContain("local-only main commit");
    expect(
      await Utils.collectLandedWork("feature/empty", "main", {
        cwd: repoDir,
        basePreference: "local-first",
      }),
    ).toBeUndefined();
  });

  test("is false when git rev-list fails", async () => {
    execSync("git checkout -b feature/rev-list-failure", { cwd: repoDir });
    writeFileSync(join(repoDir, "failure.txt"), "work\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'work before failure'", { cwd: repoDir });

    const original = Utils.executeGitCommand;
    Utils.executeGitCommand = async (args, options) =>
      args[0] === "rev-list"
        ? { success: false, output: "", error: "simulated git failure" }
        : original(args, options);
    try {
      expect(
        await Utils.hasCommitsAhead("feature/rev-list-failure", "main", { cwd: repoDir }),
      ).toBe(false);
    } finally {
      Utils.executeGitCommand = original;
    }
  });
});
