import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildConflictPrompt,
  buildHookFixPrompt,
  resolveConflictsOnPr,
  sanitizeErrorForPublicComment,
} from "../src/lib/conflict-resolver";
import { Utils } from "../src/lib/utils";
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

describe("sanitizeErrorForPublicComment", () => {
  test("redacts URL credentials", () => {
    const sanitized = sanitizeErrorForPublicComment(
      "fatal: unable to access 'https://ci-bot:ghs_secret123@github.com/acme/widgets.git/': 403",
    );
    expect(sanitized).not.toContain("ghs_secret123");
    expect(sanitized).toContain("https://***@github.com/acme/widgets.git/");
  });

  test("redacts bare user:token@ pairs without a scheme", () => {
    const sanitized = sanitizeErrorForPublicComment("auth failed for ci-bot:ghp_abc@github.com");
    expect(sanitized).not.toContain("ghp_abc");
    expect(sanitized).toContain("ci-bot:***@github.com");
  });

  test("strips absolute local paths but keeps relative refs and URLs", () => {
    const sanitized = sanitizeErrorForPublicComment(
      "could not lock /home/dev/repo/.git/config; merging origin/main from https://github.com/acme/widgets/pull/7",
    );
    expect(sanitized).not.toContain("/home/dev");
    expect(sanitized).toContain("[path]; merging");
    expect(sanitized).toContain("origin/main");
    expect(sanitized).toContain("https://github.com/acme/widgets/pull/7");
  });

  test("strips windows drive-letter paths", () => {
    const sanitized = sanitizeErrorForPublicComment(
      `worktree at C:\\Users\\dev\\repo\\.git broken`,
    );
    expect(sanitized).not.toContain("Users");
    expect(sanitized).toContain("[path]");
  });

  test("collapses whitespace and truncates to a bounded length", () => {
    const long = `push failed:\n${"x".repeat(1000)}`;
    const sanitized = sanitizeErrorForPublicComment(long);
    expect(sanitized).toHaveLength(301); // bound + ellipsis
    expect(sanitized.endsWith("…")).toBe(true);
    expect(sanitized).not.toContain("\n");
  });
});

describe("resolveConflictsOnPr", () => {
  let testDir: string;
  let originDir: string;
  let repoDir: string;
  let seedDir: string;
  const savedWorktreeBase = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
  const savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

  function prInfo(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
    return {
      number: 7,
      title: "Test PR",
      body: null,
      state: "open",
      // Default to live origin state (read straight from the bare repo so
      // pushes made from the review worktree are visible) for post-push
      // verification, which re-fetches the PR; individual tests override.
      head: {
        ref: "feature/change",
        sha: git(testDir, `--git-dir=${originDir} rev-parse refs/heads/feature/change`).trim(),
        repo: { full_name: "acme/widgets" },
      },
      base: { ref: "main", sha: "base-sha" },
      html_url: PR_URL,
      mergeable_state: "clean",
      ...overrides,
    };
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "devintern-conflict-"));
    process.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(testDir, "review-worktree");
    // Ignore the developer's global git config (rerere, hooks, aliases):
    // retry behavior must not depend on whether rerere auto-resolves a
    // repeated conflict. The dedicated rerere path has its own test.
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";

    // Bare origin with main + a conflicting feature branch, plus the worker's
    // source checkout. One shell call keeps per-test git spawn overhead low.
    const script = [
      "set -e",
      "git init --bare origin.git",
      "git clone -q origin.git seed",
      "cd seed",
      "git config user.email test@test.com",
      "git config user.name Test",
      "printf 'hello\\n' > greeting.txt",
      "git add .",
      "git commit -qm init",
      "git branch -M main",
      "git push -qu origin main",
      // Feature branch edits the same line one way...
      "git checkout -qb feature/change",
      "printf 'hello from the branch\\n' > greeting.txt",
      "git add .",
      "git commit -qm 'branch change'",
      "git push -qu origin feature/change",
      // ...and main moves the other way.
      "git checkout -q main",
      "printf 'hello from main\\n' > greeting.txt",
      "git add .",
      "git commit -qm 'main change'",
      "git push -q origin main",
      // The worker's source checkout (what cwd points at).
      "cd ..",
      "git clone -q origin.git checkout",
      "git -C checkout config user.email worker@test.com",
      "git -C checkout config user.name Worker",
    ].join("\n");
    execSync(script, { cwd: testDir, encoding: "utf8", stdio: "ignore" });

    originDir = join(testDir, "origin.git");
    repoDir = join(testDir, "checkout");
    seedDir = join(testDir, "seed");
  });

  afterEach(() => {
    if (savedWorktreeBase === undefined) delete process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    else process.env.DEVINTERN_REVIEW_WORKTREE_PATH = savedWorktreeBase;
    if (savedGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
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

  test("removes the review worktree after a successful run", async () => {
    let usedWorkDir: string | undefined;
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () => prInfo(),
      agentRunner: async (_prompt, workDir) => {
        usedWorkDir = workDir;
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });
    expect(result.outcome).toBe("resolved");
    expect(usedWorkDir).toBeDefined();
    expect(existsSync(usedWorkDir!)).toBe(false);
  });

  test("removes the review worktree after a failed run", async () => {
    let usedWorkDir: string | undefined;
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () => prInfo(),
      agentRunner: async (_prompt, workDir) => {
        usedWorkDir = workDir;
        // Leave conflicts unresolved: the merge must abort.
        return { success: false, output: "agent gave up" };
      },
    });
    expect(result.outcome).toBe("failed");
    expect(usedWorkDir).toBeDefined();
    expect(existsSync(usedWorkDir!)).toBe(false);
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
    const currentHead = git(seedDir, "rev-parse origin/feature/change").trim();
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
      expectedHeadSha: currentHead,
      expectedBaseSha: "stale-base",
      noComment: true,
    });
    expect(baseChanged).toEqual({
      outcome: "deferred",
      message: "PR base changed before execution",
    });
  });

  test("defers when the remote head changes during worktree preparation", async () => {
    const expectedHeadSha = git(seedDir, "rev-parse origin/feature/change").trim();
    const expectedBaseSha = git(seedDir, "rev-parse origin/main").trim();
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      expectedHeadSha,
      expectedBaseSha,
      fetchPr: async () => {
        git(seedDir, "checkout feature/change");
        writeFileSync(join(seedDir, "head-race.txt"), "moved\n");
        git(seedDir, "add .");
        git(seedDir, 'commit -m "concurrent head push"');
        git(seedDir, "push origin feature/change");
        return prInfo({
          head: {
            ref: "feature/change",
            sha: expectedHeadSha,
            repo: { full_name: "acme/widgets" },
          },
          base: { ref: "main", sha: expectedBaseSha },
        });
      },
    });

    expect(result).toEqual({
      outcome: "deferred",
      message: "PR head changed during worktree preparation",
    });
  });

  test("merges the actual fetched base tip when the reported base sha is stale", async () => {
    // GitHub can report a stale `base.sha` long after the branch advanced.
    // The resolver must sync to the real origin/main tip, not defer forever
    // against the reported SHA.
    const expectedHeadSha = git(seedDir, "rev-parse origin/feature/change").trim();
    const staleBaseSha = git(seedDir, "rev-parse origin/main").trim();
    let fetches = 0;
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      verifyAttempts: 1,
      expectedHeadSha,
      expectedBaseSha: staleBaseSha,
      fetchPr: async () => {
        // Only the first fetch (eligibility) races the base forward; later
        // fetches model GitHub's post-push view of the PR.
        if (fetches++ === 0) {
          git(seedDir, "checkout main");
          writeFileSync(join(seedDir, "base-race.txt"), "moved\n");
          git(seedDir, "add .");
          git(seedDir, 'commit -m "concurrent base push"');
          git(seedDir, "push origin main");
        }
        return prInfo({
          head: {
            ref: "feature/change",
            sha:
              fetches === 1
                ? expectedHeadSha
                : git(testDir, `--git-dir=${originDir} rev-parse refs/heads/feature/change`).trim(),
            repo: { full_name: "acme/widgets" },
          },
          base: { ref: "main", sha: staleBaseSha },
        });
      },
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("resolved");

    // The pushed branch contains the new base commit (base-race.txt), i.e. it
    // caught up with the actual tip rather than the stale reported sha.
    const shipped = mkdtempSync(join(tmpdir(), "devintern-conflict-verify-"));
    execSync(`git clone -b feature/change ${originDir} ${shipped}/clone`, { stdio: "ignore" });
    expect(existsSync(join(shipped, "clone", "base-race.txt"))).toBe(true);
    rmSync(shipped, { recursive: true, force: true });
  });

  test("defers when the remote head changes after preparation but before push", async () => {
    const expectedHeadSha = git(seedDir, "rev-parse origin/feature/change").trim();
    const expectedBaseSha = git(seedDir, "rev-parse origin/main").trim();
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      expectedHeadSha,
      expectedBaseSha,
      fetchPr: async () =>
        prInfo({
          head: {
            ref: "feature/change",
            sha: expectedHeadSha,
            repo: { full_name: "acme/widgets" },
          },
          base: { ref: "main", sha: expectedBaseSha },
        }),
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved locally\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");

        git(seedDir, "checkout feature/change");
        writeFileSync(join(seedDir, "concurrent.txt"), "human push\n");
        git(seedDir, "add .");
        git(seedDir, 'commit -m "concurrent push during resolution"');
        git(seedDir, "push origin feature/change");
        return { success: true, output: "done" };
      },
    });

    expect(result).toEqual({ outcome: "deferred", message: "PR head changed before push" });
    expect(git(seedDir, "rev-parse origin/feature/change").trim()).not.toBe(expectedHeadSha);
  });

  test("defers when the remote head resets after the final fetch but before push", async () => {
    const expectedHeadSha = git(seedDir, "rev-parse origin/feature/change").trim();
    const expectedBaseSha = git(seedDir, "rev-parse origin/main").trim();
    const ancestorSha = git(seedDir, `rev-parse ${expectedHeadSha}^`).trim();
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      `#!/bin/sh\ngit --git-dir="${originDir}" update-ref refs/heads/feature/change "${ancestorSha}"\n`,
      { mode: 0o755 },
    );

    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      expectedHeadSha,
      expectedBaseSha,
      fetchPr: async () =>
        prInfo({
          head: {
            ref: "feature/change",
            sha: expectedHeadSha,
            repo: { full_name: "acme/widgets" },
          },
          base: { ref: "main", sha: expectedBaseSha },
        }),
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved locally\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result).toEqual({ outcome: "deferred", message: "PR head changed during push" });
    expect(git(testDir, `--git-dir=${originDir} rev-parse refs/heads/feature/change`).trim()).toBe(
      ancestorSha,
    );
  });

  test("posts a failure comment on the PR when the push fails", async () => {
    const untouchedHead = git(seedDir, "rev-parse origin/feature/change").trim();
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(hookPath, "#!/bin/sh\necho 'hook exploded' >&2\nexit 1\n", { mode: 0o755 });

    const comments: string[] = [];
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      verifyAttempts: 1,
      prCommenter: async (body) => {
        comments.push(body);
      },
      fetchPr: async () => prInfo(),
      agentRunner: async (prompt, workDir) => {
        if (prompt.includes("Fix Pre-Push Hook Failures")) {
          // The hook is permanently broken here; the agent cannot fix it.
          return { success: true, output: "cannot fix" };
        }
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("push");
    // The failure is announced on the PR itself, not just in the terminal.
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("could not publish the merge");
    expect(comments[0]).toContain("manual action needed");

    // Origin's feature branch never received the merge.
    expect(git(seedDir, "rev-parse origin/feature/change").trim()).toBe(untouchedHead);
  });

  test("redacts credentials and local paths from the public failure comment", async () => {
    const untouchedHead = git(seedDir, "rev-parse origin/feature/change").trim();
    const leakyPath = join(testDir, "leaky-worktree");
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      `#!/bin/sh
echo "fatal: unable to access 'https://ci-bot:ghs_supersecret@github.com/acme/widgets.git/': 403" >&2
echo "hint: check the worktree at ${leakyPath}/.git" >&2
exit 1
`,
      { mode: 0o755 },
    );

    const comments: string[] = [];
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      verifyAttempts: 1,
      prCommenter: async (body) => {
        comments.push(body);
      },
      fetchPr: async () => prInfo(),
      agentRunner: async (prompt, workDir) => {
        if (prompt.includes("Fix Pre-Push Hook Failures")) {
          // The hook always leaks and always fails; nothing to fix.
          return { success: true, output: "cannot fix" };
        }
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("failed");
    expect(comments).toHaveLength(1);
    // Nothing sensitive reaches the public PR comment...
    expect(comments[0]).not.toContain("ghs_supersecret");
    expect(comments[0]).not.toContain(leakyPath);
    expect(comments[0]).toContain("***@");
    expect(comments[0]).toContain("[path]");
    expect(comments[0]).toContain("manual action needed");
    // ...while the full detail stays available locally.
    expect(result.message).toContain("ghs_supersecret");
    expect(result.message).toContain(leakyPath);

    // Origin's feature branch never received the merge.
    expect(git(seedDir, "rev-parse origin/feature/change").trim()).toBe(untouchedHead);
  });

  test("retries the whole merge when a transient push rejection clears", async () => {
    const marker = join(testDir, "rejected-once");
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      `#!/bin/sh
if [ -f "${marker}" ]; then exit 0; fi
touch "${marker}"
echo "! [rejected]        feature/change -> feature/change (non-fast-forward)" >&2
echo "error: failed to push some refs to 'origin'" >&2
exit 1
`,
      { mode: 0o755 },
    );

    let agentRuns = 0;
    const comments: string[] = [];
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      verifyAttempts: 1,
      prCommenter: async (body) => {
        comments.push(body);
      },
      fetchPr: async () => prInfo(),
      agentRunner: async (_prompt, workDir) => {
        agentRuns++;
        writeFileSync(join(workDir, "greeting.txt"), `resolved run ${agentRuns}\n`);
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("resolved");
    // The merge+push cycle restarted and the agent resolved again.
    expect(agentRuns).toBe(2);
    expect(comments).toEqual([
      expect.stringContaining("devintern resolved them and pushed the merge"),
    ]);

    const shipped = mkdtempSync(join(tmpdir(), "devintern-conflict-retry-"));
    execSync(`git clone -b feature/change ${originDir} ${shipped}/clone`, { stdio: "ignore" });
    expect(readFileSync(join(shipped, "clone", "greeting.txt"), "utf8")).toBe("resolved run 2\n");
    rmSync(shipped, { recursive: true, force: true });
  });

  test("incorporates a human push that lands mid-resolution and still lands the fix", async () => {
    const expectedHeadSha = git(seedDir, "rev-parse origin/feature/change").trim();

    // Stage a human commit on top of the current branch tip in origin without
    // moving the branch yet: push it to a throwaway ref (transferring the
    // object), delete the ref, and record the SHA for the hook to publish.
    execSync(
      [
        "set -e",
        `cd ${seedDir}`,
        "git checkout -q -B stage-human origin/feature/change",
        "printf 'human change\\n' > human.txt",
        "git add .",
        'git commit -qm "human lands mid-resolution"',
        "git push -q origin HEAD:refs/heads/_staged_human",
        "git push -q origin :refs/heads/_staged_human",
      ].join("\n"),
      { stdio: "ignore" },
    );
    const humanSha = git(seedDir, "rev-parse HEAD").trim();
    expect(humanSha).not.toBe(expectedHeadSha);

    const movedMarker = join(testDir, "moved-once");
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      `#!/bin/sh
if [ -f "${movedMarker}" ]; then exit 0; fi
touch "${movedMarker}"
# A human pushed to the branch while the agent was resolving.
git --git-dir="${originDir}" update-ref refs/heads/feature/change "${humanSha}"
echo "! [rejected]        feature/change -> feature/change (stale info)" >&2
exit 1
`,
      { mode: 0o755 },
    );

    let agentRuns = 0;
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      verifyAttempts: 1,
      expectedHeadSha,
      fetchPr: async () =>
        prInfo({
          head: {
            ref: "feature/change",
            sha:
              agentRuns === 0
                ? expectedHeadSha
                : git(testDir, `--git-dir=${originDir} rev-parse refs/heads/feature/change`).trim(),
            repo: { full_name: "acme/widgets" },
          },
        }),
      agentRunner: async (_prompt, workDir) => {
        agentRuns++;
        writeFileSync(join(workDir, "greeting.txt"), `resolved after move ${agentRuns}\n`);
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(agentRuns).toBe(2);

    // The published branch contains both the human's commits and the merge.
    const shipped = mkdtempSync(join(tmpdir(), "devintern-conflict-forward-"));
    execSync(`git clone -b feature/change ${originDir} ${shipped}/clone`, { stdio: "ignore" });
    expect(existsSync(join(shipped, "clone", "human.txt"))).toBe(true);
    expect(readFileSync(join(shipped, "clone", "greeting.txt"), "utf8")).toBe(
      "resolved after move 2\n",
    );
    rmSync(shipped, { recursive: true, force: true });
  });

  test("fails instead of claiming success when GitHub still reports conflicts after the push", async () => {
    let fetches = 0;
    const comments: string[] = [];
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      verifyAttempts: 2,
      verifyDelayMs: 0,
      prCommenter: async (body) => {
        comments.push(body);
      },
      fetchPr: async () => {
        fetches++;
        if (fetches === 1) return prInfo({ mergeable_state: "dirty" });
        // Post-push: our commit is on the PR but GitHub insists it conflicts.
        return prInfo({ mergeable_state: "dirty" });
      },
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("still reports merge conflicts");
    expect(fetches).toBe(3); // initial + 2 verification polls
    expect(comments).toHaveLength(1);
    // The push landed; the comment must not claim nothing was published.
    expect(comments[0]).toContain("pushed a merge");
    expect(comments[0]).not.toContain("No changes landed");
  });

  test("reports success with a caveat when GitHub keeps recomputing mergeability", async () => {
    let fetches = 0;
    const comments: string[] = [];
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      verifyAttempts: 2,
      verifyDelayMs: 0,
      prCommenter: async (body) => {
        comments.push(body);
      },
      fetchPr: async () => {
        fetches++;
        if (fetches === 1) return prInfo({ mergeable_state: "unknown" });
        return prInfo({ mergeable_state: "unknown" });
      },
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    // The push landed; unconfirmed mergeability must not fail the command...
    expect(result.outcome).toBe("resolved");
    expect(result.message).toContain("has not confirmed mergeability yet");
    // ...and the usual success comment is still posted.
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("devintern resolved them and pushed the merge");
  });

  test("fails when the PR head does not include the pushed merge commit", async () => {
    const comments: string[] = [];
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      verifyAttempts: 1,
      prCommenter: async (body) => {
        comments.push(body);
      },
      fetchPr: async () =>
        prInfo({
          head: {
            ref: "feature/change",
            sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            repo: { full_name: "acme/widgets" },
          },
        }),
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("does not include the pushed merge commit");
    // The push landed; the comment must not claim nothing was published.
    expect(comments[0]).toContain("pushed a merge");
    expect(comments[0]).not.toContain("No changes landed");
  });

  test("completes a rerere-auto-resolved retry without re-running the agent", async () => {
    // Environments with `git rerere` + autoUpdate record attempt one's
    // resolution; on a retry the merge auto-stages it and exits non-zero
    // with no unmerged paths. The resolver must finish that merge instead
    // of aborting.
    git(repoDir, "config rerere.enabled true");
    git(repoDir, "config rerere.autoUpdate true");

    const marker = join(testDir, "rejected-once-rerere");
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      `#!/bin/sh
if [ -f "${marker}" ]; then exit 0; fi
touch "${marker}"
echo "! [rejected]        feature/change -> feature/change (non-fast-forward)" >&2
exit 1
`,
      { mode: 0o755 },
    );

    let agentRuns = 0;
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      verifyAttempts: 1,
      fetchPr: async () => prInfo(),
      agentRunner: async (_prompt, workDir) => {
        agentRuns++;
        writeFileSync(join(workDir, "greeting.txt"), "rerere resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(agentRuns).toBe(1);

    const shipped = mkdtempSync(join(tmpdir(), "devintern-conflict-rerere-"));
    execSync(`git clone -b feature/change ${originDir} ${shipped}/clone`, { stdio: "ignore" });
    expect(readFileSync(join(shipped, "clone", "greeting.txt"), "utf8")).toBe("rerere resolved\n");
    rmSync(shipped, { recursive: true, force: true });
  });

  test("verification tolerates a lagging PR read before confirming success", async () => {
    let fetches = 0;
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      verifyAttempts: 3,
      verifyDelayMs: 0,
      fetchPr: async () => {
        fetches++;
        // The initial pre-run fetch consumes the first call; the three
        // verification polls then see a stale conflict, a lagging head
        // while GitHub recomputes, and finally the healthy PR.
        if (fetches === 2) return prInfo({ mergeable_state: "dirty" });
        if (fetches === 3) {
          return prInfo({
            head: {
              ref: "feature/change",
              sha: "0000000000000000000000000000000000000000",
              repo: { full_name: "acme/widgets" },
            },
            mergeable_state: "unknown",
          });
        }
        if (fetches >= 5) throw new Error("unexpected extra fetch");
        return prInfo({ mergeable_state: "clean" });
      },
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.message).toContain("verified conflict-free");
    // initial fetch + two lagging verification polls + the confirming one
    expect(fetches).toBe(4);
  });

  test("verification treats transient PR fetch errors as unverified, not failure", async () => {
    let fetches = 0;
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      verifyAttempts: 2,
      verifyDelayMs: 0,
      fetchPr: async () => {
        fetches++;
        if (fetches >= 2) throw new Error("API rate limit exceeded");
        return prInfo();
      },
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    // A landed push must not be reported as failed because of rate limits.
    expect(result.outcome).toBe("resolved");
    expect(result.message).toContain("has not confirmed mergeability yet");
  });

  test("reports success when reading the pushed SHA fails after an accepted push", async () => {
    // Simulate a local `rev-parse HEAD` failure after the push was accepted:
    // a pre-push hook arms a marker, then the reference-transaction hook that
    // fires for the push's remote-tracking ref update corrupts the worktree
    // git-dir HEAD. The old sentinel behavior compared GitHub's head against
    // "" and deterministically reported head-moved even though the merge
    // landed.
    const marker = join(testDir, "push-started");
    writeFileSync(join(repoDir, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch "${marker}"\n`, {
      mode: 0o755,
    });
    const refTxHook = [
      "#!/bin/sh",
      "while read -r _old _new ref; do",
      '  case "$ref" in refs/remotes/origin/feature/change)',
      '    [ "$1" = "committed" ] && [ -f "' + marker + '" ] || exit 0',
      '    git_dir="$(git rev-parse --absolute-git-dir)"',
      "    printf 'corrupted\\n' > \"$git_dir/HEAD\"",
      "    ;;",
      "esac",
      "done",
      "exit 0",
    ].join("\n");
    writeFileSync(join(repoDir, ".git", "hooks", "reference-transaction"), refTxHook, {
      mode: 0o755,
    });

    const comments: string[] = [];
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      verifyAttempts: 1,
      prCommenter: async (body) => {
        comments.push(body);
      },
      fetchPr: async () => prInfo(),
      agentRunner: async (_prompt, workDir) => {
        writeFileSync(join(workDir, "greeting.txt"), "resolved\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    // The push landed; an unreadable local SHA must degrade to unverified,
    // never claim the pushed merge commit is missing.
    expect(result.outcome).toBe("resolved");
    expect(result.message).toContain("has not confirmed mergeability yet");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("devintern resolved them and pushed the merge");

    // And the merge genuinely is on origin's feature branch.
    const shipped = mkdtempSync(join(tmpdir(), "devintern-conflict-sha-"));
    execSync(`git clone -b feature/change ${originDir} ${shipped}/clone`, { stdio: "ignore" });
    expect(readFileSync(join(shipped, "clone", "greeting.txt"), "utf8")).toBe("resolved\n");
    rmSync(shipped, { recursive: true, force: true });
  });

  test("hands a failed pre-push hook to the agent and pushes once fixed", async () => {
    const untouchedHead = git(seedDir, "rev-parse origin/feature/change").trim();
    const marker = join(testDir, "hook-fixed");
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      `#!/bin/sh\nif [ ! -f "${marker}" ]; then echo 'typecheck failed' >&2; exit 1; fi\n`,
      { mode: 0o755 },
    );

    const prompts: string[] = [];
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () => prInfo(),
      agentRunner: async (prompt, workDir) => {
        prompts.push(prompt);
        if (prompt.includes("Fix Pre-Push Hook Failures")) {
          // Simulate the agent fixing the underlying hook failure.
          writeFileSync(marker, "ok\n");
          return { success: true, output: "fixed" };
        }
        writeFileSync(join(workDir, "greeting.txt"), "hello from main and the branch\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("Fix Pre-Push Hook Failures");
    expect(prompts[1]).toContain("typecheck failed");
    expect(prompts[1]).toContain("--amend");

    // The merge landed on origin's feature branch once the hook passed.
    expect(
      git(testDir, `--git-dir=${originDir} rev-parse refs/heads/feature/change`).trim(),
    ).not.toBe(untouchedHead);
  });

  test("folds hook-fix changes into the merge commit before retrying the push", async () => {
    // The hook fails exactly once, so the retry (after the amend) can land.
    const marker = join(testDir, "hook-failed-once");
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    writeFileSync(
      hookPath,
      `#!/bin/sh\nif [ ! -f "${marker}" ]; then touch "${marker}"; echo 'formatting drifted' >&2; exit 1; fi\n`,
      { mode: 0o755 },
    );

    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      noComment: true,
      fetchPr: async () => prInfo(),
      agentRunner: async (prompt, workDir) => {
        if (prompt.includes("Fix Pre-Push Hook Failures")) {
          // The agent fixed the code but forgot to amend; the resolver must
          // fold the change into the merge commit itself.
          writeFileSync(join(workDir, "hook-fix.txt"), "formatted\n");
          return { success: true, output: "fixed" };
        }
        writeFileSync(join(workDir, "greeting.txt"), "hello from main and the branch\n");
        git(workDir, "add -A");
        git(workDir, "commit --no-edit");
        return { success: true, output: "done" };
      },
    });

    expect(result.outcome).toBe("resolved");

    // The amend happened: the pushed merge commit carries the hook fix.
    const shipped = mkdtempSync(join(tmpdir(), "devintern-conflict-amend-"));
    execSync(`git clone -b feature/change ${originDir} ${shipped}/clone`, { stdio: "ignore" });
    expect(existsSync(join(shipped, "clone", "hook-fix.txt"))).toBe(true);
    rmSync(shipped, { recursive: true, force: true });
  });

  test("an already-up-to-date branch stays quiet and posts nothing", async () => {
    // Make the branch genuinely contain main: a real (resolved) merge commit.
    const fix = join(testDir, "uptodate");
    execSync(`git clone ${originDir} ${fix}`, { stdio: "ignore" });
    git(fix, "config user.email t@t.co");
    git(fix, "config user.name T");
    git(fix, "checkout feature/change");
    try {
      git(fix, "merge origin/main"); // conflicts; resolved below
    } catch {
      // execSync throws on git's non-zero conflict exit.
    }
    writeFileSync(join(fix, "greeting.txt"), "both\n");
    git(fix, "add -A");
    git(fix, "commit --no-edit");
    git(fix, "push origin HEAD:refs/heads/feature/change");

    const comments: string[] = [];
    let agentCalled = false;
    const result = await resolveConflictsOnPr(PR_URL, {
      cwd: repoDir,
      verifyAttempts: 1,
      prCommenter: async (body) => {
        comments.push(body);
      },
      fetchPr: async () => prInfo(),
      agentRunner: async () => {
        agentCalled = true;
        return { success: true, output: "" };
      },
    });

    expect(result.outcome).toBe("skipped");
    expect(agentCalled).toBe(false);
    expect(comments).toEqual([]);
  });
});

describe("isolateWorktreeHooks", () => {
  let testDir: string;
  let repoDir: string;
  let sharedHookPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "devintern-hooks-"));
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    execSync(
      [
        "set -e",
        "git init -q bare-origin",
        "git clone -q bare-origin repo",
        "cd repo",
        "git config user.email t@t.co",
        "git config user.name T",
        "printf 'x\\n' > f.txt",
        "git add .",
        "git commit -qm init",
        "git push -qu origin HEAD:main",
      ].join("\n"),
      { cwd: testDir, encoding: "utf8", stdio: "ignore" },
    );
    repoDir = join(testDir, "repo");
    sharedHookPath = join(repoDir, ".git", "hooks", "pre-push");
  });

  afterEach(() => {
    if (process.env.GIT_CONFIG_GLOBAL === "/dev/null") delete process.env.GIT_CONFIG_GLOBAL;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("redirects core.hooksPath into the worktree admin dir and copies shared hooks", async () => {
    writeFileSync(sharedHookPath, "#!/bin/sh\necho shared-hook\n", { mode: 0o755 });
    const worktreePath = join(testDir, "hooks-worktree");
    execSync(`git worktree add -q -b hooks-branch ${worktreePath} origin/main`, {
      cwd: repoDir,
      stdio: "ignore",
    });

    await Utils.isolateWorktreeHooks(worktreePath);

    // `core.hooksPath` resolves (per-worktree) into the worktree's own git
    // admin area, not the shared `.git/hooks`.
    const hooksPath = git(worktreePath, "config core.hooksPath").trim();
    expect(hooksPath).toContain(join(".git", "worktrees"));
    expect(hooksPath).not.toBe(join(repoDir, ".git", "hooks"));
    // The main checkout's config is untouched (`git config` exits 1 and prints
    // nothing when the key is unset in the shared config).
    expect(
      execSync("git config core.hooksPath || true", { cwd: repoDir, encoding: "utf8" }).trim(),
    ).toBe("");

    // Shared hooks were copied into the isolated directory.
    expect(readFileSync(join(hooksPath, "pre-push"), "utf8")).toContain("shared-hook");
  });

  test("shields the shared hooks from postinstall-style rewrites", async () => {
    writeFileSync(sharedHookPath, "#!/bin/sh\necho shared-hook\n", { mode: 0o755 });
    const worktreePath = join(testDir, "hooks-worktree");
    execSync(`git worktree add -q -b hooks-branch ${worktreePath} origin/main`, {
      cwd: repoDir,
      stdio: "ignore",
    });

    await Utils.isolateWorktreeHooks(worktreePath);

    // Simulate what lefthook's postinstall does: rewrite the hooks it finds
    // via `git config core.hooksPath` (which now points inside the worktree).
    const hooksPath = git(worktreePath, "config core.hooksPath").trim();
    writeFileSync(join(hooksPath, "pre-push"), "#!/bin/sh\necho rewritten\n", { mode: 0o755 });

    expect(readFileSync(sharedHookPath, "utf8")).toContain("shared-hook");
    expect(readFileSync(join(hooksPath, "pre-push"), "utf8")).toContain("rewritten");
  });

  test("runs the isolated hook (not the shared one) on push from the worktree", async () => {
    const isolatedStamp = join(testDir, "isolated-hook-ran");
    const sharedStamp = join(testDir, "shared-hook-ran");
    writeFileSync(sharedHookPath, `#!/bin/sh\necho ran > "${sharedStamp}"\n`, { mode: 0o755 });
    const worktreePath = join(testDir, "hooks-worktree");
    execSync(`git worktree add -q -b hooks-branch ${worktreePath} origin/main`, {
      cwd: repoDir,
      stdio: "ignore",
    });

    await Utils.isolateWorktreeHooks(worktreePath);

    // After isolation, the hook copied into the isolated dir writes elsewhere.
    const hooksPath = git(worktreePath, "config core.hooksPath").trim();
    writeFileSync(join(hooksPath, "pre-push"), `#!/bin/sh\necho ran > "${isolatedStamp}"\n`, {
      mode: 0o755,
    });

    writeFileSync(join(worktreePath, "new.txt"), "new\n");
    git(worktreePath, "add -A");
    git(worktreePath, "commit -qm new");
    git(worktreePath, "push -q origin hooks-branch");

    expect(existsSync(isolatedStamp)).toBe(true);
    expect(existsSync(sharedStamp)).toBe(false);
  });
});
