import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildConflictPrompt, resolveConflictsOnPr } from "../src/lib/conflict-resolver";
import type { PullRequestInfo } from "../src/lib/github-reviews";

const PR_URL = "https://github.com/acme/widgets/pull/7";

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8" });
}

describe("buildConflictPrompt", () => {
  test("lists conflicted files and forbids pushing", () => {
    const prompt = buildConflictPrompt({
      baseRef: "main",
      branch: "feature/x",
      conflictedFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- src/b.ts");
    expect(prompt).toContain("origin/main");
    expect(prompt).toContain("Do NOT push");
  });
});

describe("resolveConflictsOnPr", () => {
  let testDir: string;
  let originDir: string;
  let repoDir: string;
  const savedWorktreeBase = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;

  function prInfo(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
    return {
      number: 7,
      title: "Test PR",
      body: null,
      state: "open",
      head: { ref: "feature/change", sha: "unused", repo: { full_name: "acme/widgets" } },
      base: { ref: "main", sha: "base-sha" },
      html_url: PR_URL,
      ...overrides,
    };
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "devintern-conflict-"));
    process.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(testDir, "review-worktree");

    // Bare origin with main + a conflicting feature branch.
    originDir = join(testDir, "origin.git");
    execSync(`git init --bare ${originDir}`);

    const seedDir = join(testDir, "seed");
    execSync(`git clone ${originDir} ${seedDir}`, { stdio: "ignore" });
    git(seedDir, "config user.email test@test.com");
    git(seedDir, "config user.name Test");
    writeFileSync(join(seedDir, "greeting.txt"), "hello\n");
    git(seedDir, "add .");
    git(seedDir, 'commit -m "init"');
    git(seedDir, "branch -M main");
    git(seedDir, "push -u origin main");

    // Feature branch edits the same line one way...
    git(seedDir, "checkout -b feature/change");
    writeFileSync(join(seedDir, "greeting.txt"), "hello from the branch\n");
    git(seedDir, "add .");
    git(seedDir, 'commit -m "branch change"');
    git(seedDir, "push -u origin feature/change");

    // ...and main moves the other way.
    git(seedDir, "checkout main");
    writeFileSync(join(seedDir, "greeting.txt"), "hello from main\n");
    git(seedDir, "add .");
    git(seedDir, 'commit -m "main change"');
    git(seedDir, "push origin main");

    // The worker's source checkout (what cwd points at).
    repoDir = join(testDir, "checkout");
    execSync(`git clone ${originDir} ${repoDir}`, { stdio: "ignore" });
    git(repoDir, "config user.email worker@test.com");
    git(repoDir, "config user.name Worker");
  });

  afterEach(() => {
    if (savedWorktreeBase === undefined) delete process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    else process.env.DEVINTERN_REVIEW_WORKTREE_PATH = savedWorktreeBase;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("resolves a conflicted merge via the agent and pushes", async () => {
    const prompts: string[] = [];
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () => prInfo(),
      agentRunner: async (prompt, workDir) => {
        prompts.push(prompt);
        // Resolve like a competent agent: merge both intents, finish the merge.
        writeFileSync(join(workDir, "greeting.txt"), "hello from main and the branch\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(prompts[0]).toContain("greeting.txt");

    // The merge landed on origin's feature branch.
    const shipped = mkdtempSync(join(tmpdir(), "devintern-conflict-verify-"));
    execSync(`git clone -b feature/change ${originDir} ${shipped}/clone`, { stdio: "ignore" });
    expect(readFileSync(join(shipped, "clone", "greeting.txt"), "utf8")).toBe(
      "hello from main and the branch\n",
    );
    rmSync(shipped, { recursive: true, force: true });
  });

  test("commits for the agent when it resolves but forgets to commit", async () => {
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () => prInfo(),
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        return { success: true, output: "done" };
      },
    });
    expect(result.outcome).toBe("resolved");
  });

  test("aborts the merge when the agent leaves conflicts unresolved", async () => {
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () => prInfo(),
      agentRunner: async () => ({ success: true, output: "claimed done, did nothing" }),
    });

    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("unresolved conflicts");

    // Origin's feature branch is untouched.
    const check = mkdtempSync(join(tmpdir(), "devintern-conflict-check-"));
    execSync(`git clone -b feature/change ${originDir} ${check}/clone`, { stdio: "ignore" });
    expect(readFileSync(join(check, "clone", "greeting.txt"), "utf8")).toBe(
      "hello from the branch\n",
    );
    rmSync(check, { recursive: true, force: true });
  });

  test("pushes a clean merge without invoking the agent", async () => {
    // Make the branch non-conflicting: reset origin's feature branch to touch
    // a different file instead.
    const fix = join(testDir, "fix");
    execSync(`git clone ${originDir} ${fix}`, { stdio: "ignore" });
    git(fix, "config user.email t@t.co");
    git(fix, "config user.name T");
    git(fix, "checkout feature/change");
    git(fix, "reset --hard origin/main~1");
    writeFileSync(join(fix, "other.txt"), "separate change\n");
    git(fix, "add .");
    git(fix, 'commit -m "non-conflicting"');
    git(fix, "push --force origin feature/change");

    let agentCalled = false;
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () => prInfo(),
      agentRunner: async () => {
        agentCalled = true;
        return { success: true, output: "" };
      },
    });

    expect(result.outcome).toBe("clean");
    expect(agentCalled).toBe(false);
  });

  test("skips closed and fork PRs", async () => {
    const closed = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () => prInfo({ state: "closed" }),
    });
    expect(closed.outcome).toBe("skipped");

    const fork = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () =>
        prInfo({
          head: { ref: "feature/change", sha: "x", repo: { full_name: "outsider/widgets" } },
        }),
    });
    expect(fork.outcome).toBe("skipped");
    expect(fork.message).toContain("fork");
  });

  test("defers before touching git when expected head or base changed", async () => {
    const headChanged = await resolveConflictsOnPr(PR_URL, {
      fetchPr: async () => prInfo(),
      expectedHeadSha: "stale-head",
      noComment: true,
    });
    expect(headChanged).toEqual({
      outcome: "deferred",
      message: "PR head changed before execution",
    });

    const baseChanged = await resolveConflictsOnPr(PR_URL, {
      fetchPr: async () => prInfo(),
      expectedHeadSha: "unused",
      expectedBaseSha: "stale-base",
      noComment: true,
    });
    expect(baseChanged).toEqual({
      outcome: "deferred",
      message: "PR base changed before execution",
    });
  });
});
