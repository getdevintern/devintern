import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { defaultRunStackDeps, ensureStackBase } from "../src/lib/agent/stack-base-guard";
import type { StackGuardState } from "../src/lib/agent/stack-base-guard";
import { createGitHelpers } from "../src/lib/agent/run-harness-git";
import { runContext } from "../src/lib/cli/context";
import type { FinalizeContext } from "../src/lib/agent/run-harness-git";
import { stackedOnFromDescription } from "../src/lib/code-host/pr-body";
import { PRManager } from "../src/lib/code-host/manager";
import type { StackBase } from "../src/lib/dependencies/gate";
import type { StackPrSnapshot } from "../src/lib/dependencies/stack-maintainer";
import type { RunStackDeps } from "../src/lib/dependencies/stack-run";
import {
  STACKED_ON_ENV,
  encodeStackBaseEnv,
  isStackBaseReleased,
  renderStackedOnSection,
  resetStackBaseRelease,
} from "../src/lib/dependencies/stacked-base";
import { RunStore } from "../src/lib/state/run-recorder";
import { resolveSessionPickup } from "../src/lib/state/session-pickup";
import { preserveUnfinishedWork } from "../src/lib/task/preserve-work";
import type { Git } from "../src/lib/dependencies/stack-git";
import { Utils } from "../src/lib/utils";
import { worktreeKeepReason } from "../src/lib/utils/worktree-keep";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV, HOME: cwd },
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/** Git bound to `cwd` the way the run's helpers call it, with a test identity. */
function boundGit(cwd: string): Git {
  return (args, env) =>
    Utils.executeGitCommand(args, {
      cwd,
      env: { GIT_EDITOR: "true", HOME: cwd, ...GIT_ENV, ...env },
    });
}

/**
 * A bare remote; a work clone that plays the base task and the code host; a
 * run clone that plays the stacked run's worktree (feature/b, cut from
 * feature/a, with committed and uncommitted work).
 */
class Fixture {
  readonly root = mkdtempSync(join(tmpdir(), "stacked-run-base-"));
  readonly remote = join(this.root, "remote.git");
  readonly work = join(this.root, "work");
  readonly run = join(this.root, "run");
  aHead = "";

  constructor() {
    mkdirSync(this.remote);
    git(this.remote, "init", "--bare", "--initial-branch=main");
    git(this.root, "clone", "--quiet", this.remote, this.work);
    git(this.work, "checkout", "-b", "main");
    this.commit(this.work, "README.md", "hello\n", "m0");
    git(this.work, "push", "--quiet", "origin", "main");
    git(this.work, "checkout", "-b", "feature/a");
    this.commit(this.work, "a.txt", "a1\n", "a1");
    this.aHead = this.commit(this.work, "a.txt", "a1\na2\n", "a2");
    git(this.work, "push", "--quiet", "origin", "feature/a");

    git(this.root, "clone", "--quiet", this.remote, this.run);
    git(this.run, "checkout", "-b", "feature/b", "origin/feature/a");
    this.commit(this.run, "b.txt", "b1\n", "b1");
    writeFileSync(join(this.run, "b.txt"), "b1\nb2 (uncommitted)\n");
  }

  commit(cwd: string, file: string, content: string, message: string): string {
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", file);
    git(cwd, "commit", "--quiet", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  }

  /** Squash-merge feature/a into main and delete its branch, like GitHub. */
  squashMergeAndDeleteA(options: { pruneTrackingRef?: boolean } = {}): void {
    git(this.work, "checkout", "--quiet", "main");
    git(this.work, "merge", "--squash", "feature/a");
    git(this.work, "commit", "--quiet", "-m", "squash feature/a");
    git(this.work, "push", "--quiet", "origin", "main");
    git(this.work, "push", "--quiet", "origin", "--delete", "feature/a");
    // As in the incident, the run's own tracking ref of the base is gone too.
    if (options.pruneTrackingRef !== false) {
      git(this.run, "update-ref", "-d", "refs/remotes/origin/feature/a");
    }
  }

  closeAWithoutMerging(): void {
    git(this.work, "push", "--quiet", "origin", "--delete", "feature/a");
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

const base: StackBase = {
  taskKey: "local-a",
  branch: "feature/a",
  prNumber: 601,
  prUrl: "https://github.com/acme/app/pull/601",
};

function basePr(state: StackPrSnapshot["state"], headSha: string): StackPrSnapshot {
  return {
    number: 601,
    state,
    headRef: "feature/a",
    headSha,
    baseRef: "main",
    url: base.prUrl,
  };
}

function guardState(): StackGuardState & { context: FinalizeContext } {
  return {
    context: {
      stackBase: base,
      prTargetBranch: base.branch,
      enableGit: true,
    } as FinalizeContext,
    prTargetBranch: base.branch,
  };
}

function deps(fx: Fixture, pr: StackPrSnapshot | null): RunStackDeps {
  return {
    ...defaultRunStackDeps(fx.run),
    git: boundGit(fx.run),
    getBasePr: async () => pr,
    defaultBranch: async () => "main",
    log: () => {},
    warn: () => {},
  };
}

describe("stacked run whose base moves mid-run", () => {
  let fx: Fixture;
  const savedEnv = process.env[STACKED_ON_ENV];
  beforeEach(() => {
    fx = new Fixture();
    resetStackBaseRelease();
  });
  afterEach(() => {
    fx.cleanup();
    resetStackBaseRelease();
    if (savedEnv === undefined) delete process.env[STACKED_ON_ENV];
    else process.env[STACKED_ON_ENV] = savedEnv;
  });

  test("an open base keeps the stacked target", async () => {
    const state = guardState();
    expect(await ensureStackBase(state, deps(fx, basePr("open", fx.aHead)))).toBeUndefined();
    expect(state.context.prTargetBranch).toBe("feature/a");
    expect(isStackBaseReleased()).toBe(false);
  });

  test("a merged and deleted base: verify diffs against the merge target and the PR opens against it", async () => {
    fx.squashMergeAndDeleteA();
    process.env[STACKED_ON_ENV] = encodeStackBaseEnv(base);
    const state = guardState();

    expect(await ensureStackBase(state, deps(fx, basePr("merged", fx.aHead)))).toBeUndefined();

    // The run now targets main, and its branch sits on main without A's
    // original commits; the uncommitted change survived the rebase.
    expect(state.context.prTargetBranch).toBe("main");
    expect(state.prTargetBranch).toBe("main");
    expect(git(fx.run, "merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe("");
    expect(git(fx.run, "rev-list", "--count", "origin/main..HEAD")).toBe("1");
    expect(git(fx.run, "diff", "--name-only", "origin/main...HEAD")).toBe("b.txt");
    expect(git(fx.run, "status", "--porcelain")).toBe("M b.txt");

    // The PR body stops claiming the stack.
    expect(isStackBaseReleased()).toBe(true);
    expect(process.env[STACKED_ON_ENV]).toBeUndefined();
    expect(stackedOnFromDescription(`Task\n\n${renderStackedOnSection(base)}`)).toBeUndefined();

    // PR creation reads the switched target.
    const originals = {
      getCurrentBranch: Utils.getCurrentBranch,
      isProtectedBranch: Utils.isProtectedBranch,
      remoteBranchExists: Utils.remoteBranchExists,
      createPullRequest: PRManager.prototype.createPullRequest,
    };
    let prBase: string | undefined;
    const savedOptions = runContext.options;
    runContext.options = { verbose: false } as typeof runContext.options;
    try {
      Utils.getCurrentBranch = async () => "feature/b";
      Utils.isProtectedBranch = async () => false;
      Utils.remoteBranchExists = async (branch: string) => branch === "main";
      PRManager.prototype.createPullRequest = async function (_task, _head, target) {
        prBase = target;
        return { success: false, message: "stubbed", unsupportedPlatform: true };
      };
      await createGitHelpers({
        ...state.context,
        task: { key: "local-b", summary: "b" },
        skipComments: true,
      } as FinalizeContext).createPrAndTransition("output");
    } finally {
      Object.assign(Utils, {
        getCurrentBranch: originals.getCurrentBranch,
        isProtectedBranch: originals.isProtectedBranch,
        remoteBranchExists: originals.remoteBranchExists,
      });
      PRManager.prototype.createPullRequest = originals.createPullRequest;
      runContext.options = savedOptions;
    }
    expect(prBase).toBe("main");

    // A later step does not re-check a base the run already left.
    expect(await ensureStackBase(state, deps(fx, null))).toBeUndefined();
  });

  test("a vanished base with unknown PR state falls back to the default branch", async () => {
    // The stale tracking ref still marks where the run's branch was cut.
    fx.squashMergeAndDeleteA({ pruneTrackingRef: false });
    const state = guardState();
    expect(await ensureStackBase(state, deps(fx, null))).toBeUndefined();
    expect(state.context.prTargetBranch).toBe("main");
    expect(git(fx.run, "diff", "--name-only", "origin/main...HEAD")).toBe("b.txt");
  });

  test("a vanished base with no trace of its commits escalates instead of guessing", async () => {
    fx.squashMergeAndDeleteA();
    const head = git(fx.run, "rev-parse", "HEAD");
    const state = guardState();
    const halt = await ensureStackBase(state, deps(fx, null));
    expect(halt?.reason).toContain("conflicted");
    expect(state.context.prTargetBranch).toBe("feature/a");
    // The aborted rebase left the branch and the uncommitted change alone.
    expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);
    expect(git(fx.run, "status", "--porcelain")).toBe("M b.txt");
  });

  test("a base closed unmerged escalates with actions, and the work is preserved", async () => {
    fx.closeAWithoutMerging();
    const state = guardState();

    const halt = await ensureStackBase(state, deps(fx, basePr("closed", fx.aHead)));
    expect(halt?.kind).toBe("halt");
    expect(halt?.reason).toContain("local-a PR #601");
    expect(halt?.reason).toContain("closed without merging");
    expect(halt?.reason).toContain("devintern worker add --resume local-a");
    expect(state.stackBlocked).toBe(halt?.reason);
    expect(state.context.prTargetBranch).toBe("feature/a");
    // Every later guarded step halts the same way.
    expect((await ensureStackBase(state, deps(fx, null)))?.reason).toBe(halt?.reason);

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      runId: 953,
      resumable: true,
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved.kind).toBe("pushed");
    expect(preserved.note).toContain("feature/b");
    expect(git(fx.remote, "show", "refs/heads/feature/b:b.txt")).toBe("b1\nb2 (uncommitted)");
  });
});

describe("preserveUnfinishedWork", () => {
  let fx: Fixture;
  let dbPath: string;
  beforeEach(() => {
    fx = new Fixture();
    dbPath = join(fx.root, "runs.db");
  });
  afterEach(() => fx.cleanup());

  test("commits and pushes unfinished work so a resumed run picks the branch up", async () => {
    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      runId: 953,
      resumable: true,
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved).toMatchObject({ kind: "pushed", branch: "feature/b", committed: true });
    expect(preserved.note).toContain("devintern worker add --resume local-b");
    expect(git(fx.run, "status", "--porcelain")).toBe("");
    expect(git(fx.run, "log", "-1", "--format=%s")).toBe(
      "wip(local-b): preserve unfinished work from run #953",
    );
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(
      git(fx.run, "rev-parse", "HEAD"),
    );
    expect(await worktreeKeepReason(fx.run)).toBeUndefined();

    // A re-run in a fresh checkout resumes the escalated run's branch.
    const fresh = join(fx.root, "fresh");
    git(fx.root, "clone", "--quiet", fx.remote, fresh);
    const store = new RunStore(dbPath);
    try {
      const runId = store.createRun({ origin: "local", taskKey: "local-b", branch: "feature/b" });
      store.addStage(runId, "implementation", "failed", "incomplete", "{}");
      store.finishRun(
        runId,
        "escalated",
        `implementation incomplete; handed back to a human; ${preserved.note}`,
      );
      const pickup = await resolveSessionPickup({
        runStore: store,
        taskKey: "local-b",
        scope: { origin: "local" },
        runId,
        branchExists: async (branch) =>
          (await boundGit(fresh)(["rev-parse", "--verify", `refs/remotes/origin/${branch}`]))
            .success,
        hasLandedCommits: async ({ branch }) =>
          (
            await boundGit(fresh)(["rev-list", "--count", `origin/feature/a..origin/${branch}`])
          ).output.trim() !== "0",
      });
      expect(pickup.kind).toBe("resume");
      expect(pickup.kind === "resume" ? pickup.session.branch : undefined).toBe("feature/b");
    } finally {
      store.close();
    }
  });

  test("keeps the worktree instead of force-pushing over a branch someone else moved", async () => {
    // Someone else pushed feature/b meanwhile.
    git(fx.work, "checkout", "--quiet", "-b", "feature/b", "origin/feature/a");
    fx.commit(fx.work, "other.txt", "theirs\n", "theirs");
    git(fx.work, "push", "--quiet", "origin", "feature/b");
    const theirs = git(fx.remote, "rev-parse", "refs/heads/feature/b");

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved.kind).toBe("kept");
    expect(preserved.note).toContain(fx.run);
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(theirs);
    expect(await worktreeKeepReason(fx.run)).toContain("push of 'feature/b' failed");
    // The WIP commit is still in the kept worktree.
    expect(git(fx.run, "status", "--porcelain")).toBe("");
  });

  test("does nothing when everything is already on the remote", async () => {
    git(fx.run, "checkout", "--quiet", "--", "b.txt");
    git(fx.run, "push", "--quiet", "origin", "feature/b");
    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved.kind).toBe("none");
    expect(existsSync(fx.run)).toBe(true);
  });
});
