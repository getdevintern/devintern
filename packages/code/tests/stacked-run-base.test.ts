import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { defaultRunStackDeps, ensureStackBase } from "../src/lib/agent/stack-base-guard";
import type { StackGuardState } from "../src/lib/agent/stack-base-guard";
import { createGitHelpers, headAdvancedDuringRun } from "../src/lib/agent/run-harness-git";
import {
  commitImplementation,
  ensureStackBaseBeforeCommit,
} from "../src/lib/agent/run-harness-finalize";
import type { DeliveryState } from "../src/lib/agent/run-harness-finalize";
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

  /** Merge feature/a into main with a merge commit and delete its branch. */
  mergeAndDeleteA(): void {
    git(this.work, "checkout", "--quiet", "main");
    git(this.work, "merge", "--quiet", "--no-ff", "-m", "merge feature/a", "feature/a");
    git(this.work, "push", "--quiet", "origin", "main");
    git(this.work, "push", "--quiet", "origin", "--delete", "feature/a");
    git(this.run, "update-ref", "-d", "refs/remotes/origin/feature/a");
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

  test("a base merged with a merge commit is targeted without rebasing, even when main conflicts", async () => {
    fx.mergeAndDeleteA();
    // main gains a commit that conflicts with the run's committed b1, so a
    // rebase would stop; the PR's own conflict resolution handles it instead.
    fx.commit(fx.work, "b.txt", "from main\n", "m1");
    git(fx.work, "push", "--quiet", "origin", "main");
    const head = git(fx.run, "rev-parse", "HEAD");
    const state = guardState();

    expect(await ensureStackBase(state, deps(fx, basePr("merged", fx.aHead)))).toBeUndefined();

    expect(state.context.prTargetBranch).toBe("main");
    expect(state.prTargetBranch).toBe("main");
    expect(isStackBaseReleased()).toBe(true);
    // The branch and the uncommitted change are untouched, and the run's
    // diff against main is its own work only.
    expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);
    expect(git(fx.run, "status", "--porcelain")).toBe("M b.txt");
    expect(git(fx.run, "rev-list", "--count", "origin/main..HEAD")).toBe("1");
    expect(git(fx.run, "diff", "--name-only", "origin/main...HEAD")).toBe("b.txt");
  });

  test("a base merged with a merge commit after it gained commits still skips the rebase", async () => {
    // A moved on after the run was cut; the run's branch lacks the newer commit.
    const aFinal = fx.commit(fx.work, "a.txt", "a1\na2\na3\n", "a3");
    git(fx.work, "push", "--quiet", "origin", "feature/a");
    fx.mergeAndDeleteA();
    const head = git(fx.run, "rev-parse", "HEAD");
    const state = guardState();

    expect(await ensureStackBase(state, deps(fx, basePr("merged", aFinal)))).toBeUndefined();

    expect(state.context.prTargetBranch).toBe("main");
    expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);
    expect(git(fx.run, "rev-list", "--count", "origin/main..HEAD")).toBe("1");
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

describe("stacked run whose agent committed its own work before the base merged", () => {
  let fx: Fixture;
  const originals = {
    executeGitCommand: Utils.executeGitCommand,
    commitChanges: Utils.commitChanges,
    isProtectedBranch: Utils.isProtectedBranch,
  };
  const savedOptions = runContext.options;
  beforeEach(() => {
    fx = new Fixture();
    resetStackBaseRelease();
    // The delivery code runs git in process.cwd(); point it at the run clone.
    Utils.executeGitCommand = (args, options) =>
      originals.executeGitCommand(args, {
        ...options,
        cwd: options?.cwd ?? fx.run,
        env: { HOME: fx.run, ...GIT_ENV, ...options?.env },
      });
    Utils.commitChanges = (key, summary, options) =>
      originals.commitChanges(key, summary, { ...options, cwd: options?.cwd ?? fx.run });
    Utils.isProtectedBranch = async (branch?: string) => branch === "main";
    runContext.options = { verbose: false } as typeof runContext.options;
  });
  afterEach(() => {
    Object.assign(Utils, originals);
    runContext.options = savedOptions;
    fx.cleanup();
    resetStackBaseRelease();
  });

  function deliveryState(): DeliveryState {
    return {
      context: {
        stackBase: base,
        prTargetBranch: base.branch,
        enableGit: true,
        taskKey: "local-b",
        taskSummary: "b",
        hookRetries: 0,
        allowNoChanges: false,
        headBeforeRun: fx.aHead,
      },
      prTargetBranch: base.branch,
      output: "",
    } as unknown as DeliveryState;
  }

  test("a clean tree with agent commits is delivered after the pruned base merged", async () => {
    // The agent committed everything; the tree is clean.
    fx.commit(fx.run, "b.txt", "b1\nb2\n", "b2");
    fx.squashMergeAndDeleteA();

    // Without the guard, the commits-ahead count has no base ref to compare to.
    expect(await commitImplementation(deliveryState())).toBe(false);

    const state = deliveryState();
    expect(
      await ensureStackBaseBeforeCommit(state, deps(fx, basePr("merged", fx.aHead))),
    ).toBeUndefined();
    expect(state.context.prTargetBranch).toBe("main");
    // The agent moved HEAD, so the pre-run baseline is left alone.
    expect(state.context.headBeforeRun).toBe(fx.aHead);
    expect(await commitImplementation(state)).toBe(true);
    expect(state.committed).toBe(true);
    expect(git(fx.run, "rev-list", "--count", "origin/main..HEAD")).toBe("2");
    expect(git(fx.run, "diff", "--name-only", "origin/main...HEAD")).toBe("b.txt");
  });

  test("uncommitted work is committed on the merge target", async () => {
    fx.squashMergeAndDeleteA();
    const state = deliveryState();
    expect(
      await ensureStackBaseBeforeCommit(state, deps(fx, basePr("merged", fx.aHead))),
    ).toBeUndefined();
    expect(await commitImplementation(state)).toBe(true);
    expect(git(fx.run, "status", "--porcelain")).toBe("");
    expect(git(fx.run, "rev-list", "--count", "origin/main..HEAD")).toBe("2");
    expect(git(fx.run, "diff", "--name-only", "origin/main...HEAD")).toBe("b.txt");
  });

  test("a HEAD the agent never moved stays a no-HEAD-move run after the rebase", async () => {
    git(fx.run, "reset", "--quiet", "--hard", fx.aHead);
    fx.squashMergeAndDeleteA();
    const state = deliveryState();
    expect(
      await ensureStackBaseBeforeCommit(state, deps(fx, basePr("merged", fx.aHead))),
    ).toBeUndefined();
    expect(state.context.headBeforeRun).toBe(git(fx.run, "rev-parse", "origin/main"));
    expect(await headAdvancedDuringRun(state.context)).toBe(false);
  });
});

describe("stacked run whose branch is already on origin (resumed run)", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = new Fixture();
    resetStackBaseRelease();
    // A preserved WIP branch (or an earlier attempt) published feature/b.
    git(fx.run, "push", "--quiet", "origin", "feature/b");
  });
  afterEach(() => {
    fx.cleanup();
    resetStackBaseRelease();
  });

  test("the rebase is published with a lease, so publish's plain push succeeds", async () => {
    const published = git(fx.remote, "rev-parse", "refs/heads/feature/b");
    fx.squashMergeAndDeleteA();
    const state = guardState();

    expect(await ensureStackBase(state, deps(fx, basePr("merged", fx.aHead)))).toBeUndefined();
    expect(state.context.prTargetBranch).toBe("main");
    const head = git(fx.run, "rev-parse", "HEAD");
    expect(head).not.toBe(published);
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(head);
    expect(git(fx.run, "rev-parse", "refs/remotes/origin/feature/b")).toBe(head);
    expect(git(fx.run, "status", "--porcelain")).toBe("M b.txt");

    // Publish: commit the remaining change and push without force.
    git(fx.run, "commit", "--quiet", "-am", "b2");
    const push = await Utils.pushCurrentBranch({ cwd: fx.run });
    expect(push.message).not.toContain("diverged");
    expect(push.success).toBe(true);
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(
      git(fx.run, "rev-parse", "HEAD"),
    );
  });

  test("a remote branch with commits the run lacks blocks instead of rewriting it", async () => {
    git(fx.work, "fetch", "--quiet", "origin");
    git(fx.work, "checkout", "--quiet", "-b", "feature/b", "origin/feature/b");
    fx.commit(fx.work, "other.txt", "theirs\n", "theirs");
    git(fx.work, "push", "--quiet", "origin", "feature/b");
    const theirs = git(fx.remote, "rev-parse", "refs/heads/feature/b");
    fx.squashMergeAndDeleteA();
    const head = git(fx.run, "rev-parse", "HEAD");
    const state = guardState();

    const halt = await ensureStackBase(state, deps(fx, basePr("merged", fx.aHead)));
    expect(halt?.reason).toContain("has commits this run's checkout does not");
    expect(state.context.prTargetBranch).toBe("feature/a");
    expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(theirs);
  });
});

describe("stacked run whose rebase onto the merge target conflicts", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = new Fixture();
    resetStackBaseRelease();
  });
  afterEach(() => {
    fx.cleanup();
    resetStackBaseRelease();
  });

  /** Paths a merge of origin/main into HEAD would conflict on. */
  function mergeConflicts(): string[] {
    const result = Bun.spawnSync(
      ["git", "merge-tree", "--write-tree", "--name-only", "origin/main", "HEAD"],
      { cwd: fx.run, env: { ...process.env, ...GIT_ENV, HOME: fx.run }, stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    const lines = result.stdout.toString().trim().split("\n");
    return lines.slice(1, lines.indexOf(""));
  }

  test("a committed change that conflicts after a squash merge: the PR opens against main and keeps the branch", async () => {
    fx.squashMergeAndDeleteA();
    fx.commit(fx.work, "b.txt", "from main\n", "m1");
    git(fx.work, "push", "--quiet", "origin", "main");
    const head = git(fx.run, "rev-parse", "HEAD");
    const state = guardState();

    expect(await ensureStackBase(state, deps(fx, basePr("merged", fx.aHead)))).toBeUndefined();

    expect(state.context.prTargetBranch).toBe("main");
    expect(state.stackBlocked).toBeUndefined();
    expect(isStackBaseReleased()).toBe(true);
    expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);
    expect(git(fx.run, "status", "--porcelain")).toBe("M b.txt");
    // Conflict resolution merges main in: A's original commits settle against
    // their squash, so only the run's own file conflicts.
    expect(mergeConflicts()).toEqual(["b.txt"]);
  });

  test("uncommitted work that conflicts: HEAD and the change are restored, and the run still moves to main", async () => {
    fx.squashMergeAndDeleteA();
    // main changes README.md; the run has an uncommitted edit to the same line.
    fx.commit(fx.work, "README.md", "hello from main\n", "m1");
    git(fx.work, "push", "--quiet", "origin", "main");
    writeFileSync(join(fx.run, "README.md"), "hello from run\n");
    const head = git(fx.run, "rev-parse", "HEAD");
    const state = guardState();

    expect(await ensureStackBase(state, deps(fx, basePr("merged", fx.aHead)))).toBeUndefined();
    expect(state.context.prTargetBranch).toBe("main");
    expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);
    expect(git(fx.run, "diff", "--name-only", "--diff-filter=U")).toBe("");
    expect(git(fx.run, "diff", "--name-only")).toBe("README.md\nb.txt");
    expect(git(fx.run, "diff", "--cached", "--name-only")).toBe("");
    expect(git(fx.run, "show", ":README.md")).toBe("hello");
    expect(git(fx.run, "stash", "list")).toBe("");
  });

  test("an untracked file at a path main adds stays, and the run still moves to main", async () => {
    fx.squashMergeAndDeleteA();
    fx.commit(fx.work, "c.txt", "from main\n", "m1");
    git(fx.work, "push", "--quiet", "origin", "main");
    writeFileSync(join(fx.run, "c.txt"), "from run\n");
    const head = git(fx.run, "rev-parse", "HEAD");
    const state = guardState();

    expect(await ensureStackBase(state, deps(fx, basePr("merged", fx.aHead)))).toBeUndefined();
    expect(state.context.prTargetBranch).toBe("main");
    expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(fx.run, "c.txt"), "utf8")).toBe("from run\n");
    expect(git(fx.run, "diff", "--name-only")).toBe("b.txt");
    expect(git(fx.run, "stash", "list")).toBe("");
  });

  test("a conflict while the base's PR state is unknown escalates with the work preserved", async () => {
    // The stale tracking ref says where the run was cut, but nothing says the
    // base really merged, so the run does not open a PR on that guess.
    fx.squashMergeAndDeleteA({ pruneTrackingRef: false });
    fx.commit(fx.work, "b.txt", "from main\n", "m1");
    git(fx.work, "push", "--quiet", "origin", "main");
    const head = git(fx.run, "rev-parse", "HEAD");
    const state = guardState();

    const halt = await ensureStackBase(state, deps(fx, null));
    expect(halt?.reason).toContain("rebasing this run's branch onto 'main' conflicted");
    expect(state.context.prTargetBranch).toBe("feature/a");
    expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved.kind).toBe("pushed");
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
      changeRequestState: async () => "none",
    });
    expect(preserved.kind).toBe("kept");
    expect(preserved.note).toContain(fx.run);
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(theirs);
    expect(await worktreeKeepReason(fx.run)).toContain("push of 'feature/b' failed");
    // The WIP commit is still in the kept worktree.
    expect(git(fx.run, "status", "--porcelain")).toBe("");
  });

  test("a branch with an open PR (failure after publish) gets no WIP push", async () => {
    // Publish pushed the branch and opened a PR; a later step then failed.
    git(fx.run, "stash", "--quiet");
    git(fx.run, "push", "--quiet", "origin", "feature/b");
    git(fx.run, "stash", "pop", "--quiet");
    const published = git(fx.remote, "rev-parse", "refs/heads/feature/b");
    const asked: string[] = [];

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
      changeRequestState: async (branch) => {
        asked.push(branch);
        return "open";
      },
    });
    expect(asked).toEqual(["feature/b"]);
    expect(preserved.kind).toBe("kept");
    expect(preserved.note).toContain("has an open pull request");
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(published);
    // The WIP is committed locally in the kept worktree.
    expect(git(fx.run, "log", "-1", "--format=%s")).toStartWith("wip(local-b)");
    expect(await worktreeKeepReason(fx.run)).toContain("has an open pull request");
  });

  test("a branch on origin whose PR state is unknown gets no WIP push", async () => {
    git(fx.run, "stash", "--quiet");
    git(fx.run, "push", "--quiet", "origin", "feature/b");
    git(fx.run, "stash", "pop", "--quiet");
    const published = git(fx.remote, "rev-parse", "refs/heads/feature/b");

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
      changeRequestState: async () => {
        throw new Error("rate limited");
      },
    });
    expect(preserved.kind).toBe("kept");
    expect(preserved.note).toContain("could not confirm");
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(published);
  });

  test("a branch on origin with no open PR (resumed run) is pushed", async () => {
    git(fx.run, "stash", "--quiet");
    git(fx.run, "push", "--quiet", "origin", "feature/b");
    git(fx.run, "stash", "pop", "--quiet");

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
      changeRequestState: async () => "none",
    });
    expect(preserved.kind).toBe("pushed");
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(
      git(fx.run, "rev-parse", "HEAD"),
    );
  });

  test("secret-like files are never committed; the rest is pushed and listed", async () => {
    writeFileSync(join(fx.run, ".env.local"), "TOKEN=abc\n");
    writeFileSync(join(fx.run, ".env.example"), "TOKEN=\n");
    mkdirSync(join(fx.run, "certs"), { recursive: true });
    writeFileSync(join(fx.run, "certs", "server.pem"), "-----BEGIN-----\n");
    writeFileSync(join(fx.run, "new.txt"), "new\n");

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved).toMatchObject({ kind: "pushed", committed: true });
    const files = git(fx.remote, "ls-tree", "-r", "--name-only", "refs/heads/feature/b").split(
      "\n",
    );
    expect(files).toContain("new.txt");
    expect(files).toContain(".env.example");
    expect(files).not.toContain(".env.local");
    expect(files).not.toContain("certs/server.pem");
    expect(preserved.note).toContain("committed 3 files: .env.example, b.txt, new.txt");
    expect(preserved.note).toContain(
      "secret-like files not committed: .env.local, certs/server.pem",
    );
    // Still on disk, uncommitted, in a worktree the sweep will not remove.
    expect(git(fx.run, "status", "--porcelain")).toContain(".env.local");
    expect(await worktreeKeepReason(fx.run)).toContain(".env.local");
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

  test("sandbox placeholders alone are not work: nothing is committed or pushed", async () => {
    git(fx.run, "checkout", "--quiet", "--", "b.txt");
    git(fx.run, "push", "--quiet", "origin", "feature/b");
    const head = git(fx.run, "rev-parse", "HEAD");
    writeFileSync(join(fx.run, ".bashrc"), "");
    writeFileSync(join(fx.run, ".gitconfig"), "");
    mkdirSync(join(fx.run, ".claude"), { recursive: true });
    writeFileSync(join(fx.run, ".claude", "x"), "");

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved.kind).toBe("none");
    expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);
    expect(git(fx.remote, "rev-parse", "refs/heads/feature/b")).toBe(head);
  });

  test("real work next to sandbox placeholders is saved without them", async () => {
    writeFileSync(join(fx.run, ".bashrc"), "");
    mkdirSync(join(fx.run, ".claude"), { recursive: true });
    writeFileSync(join(fx.run, ".claude", "x"), "");
    writeFileSync(join(fx.run, "new.txt"), "new\n");

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved).toMatchObject({ kind: "pushed", committed: true });
    const files = git(fx.remote, "ls-tree", "-r", "--name-only", "refs/heads/feature/b").split(
      "\n",
    );
    expect(files).toContain("new.txt");
    expect(files).toContain("b.txt");
    expect(files).not.toContain(".bashrc");
    expect(files).not.toContain(".claude/x");
  });

  test("DEVINTERN_PUSH_UNFINISHED_WORK=0 keeps the worktree and publishes nothing", async () => {
    const previous = process.env.DEVINTERN_PUSH_UNFINISHED_WORK;
    process.env.DEVINTERN_PUSH_UNFINISHED_WORK = "0";
    try {
      const head = git(fx.run, "rev-parse", "HEAD");
      const preserved = await preserveUnfinishedWork({
        taskKey: "local-b",
        cwd: fx.run,
        git: boundGit(fx.run),
      });
      expect(preserved.kind).toBe("kept");
      expect(git(fx.run, "rev-parse", "HEAD")).toBe(head);
      expect(git(fx.run, "status", "--porcelain")).toContain("b.txt");
      expect(git(fx.remote, "for-each-ref", "refs/heads/feature/b")).toBe("");
      expect(await worktreeKeepReason(fx.run)).toContain("DEVINTERN_PUSH_UNFINISHED_WORK=0");
    } finally {
      if (previous === undefined) delete process.env.DEVINTERN_PUSH_UNFINISHED_WORK;
      else process.env.DEVINTERN_PUSH_UNFINISHED_WORK = previous;
    }
  });

  test("does not commit unresolved conflict markers; keeps the worktree", async () => {
    git(fx.run, "checkout", "--quiet", "--", "b.txt");
    git(fx.run, "checkout", "--quiet", "-b", "side", "HEAD~1");
    fx.commit(fx.run, "b.txt", "side\n", "side");
    git(fx.run, "checkout", "--quiet", "feature/b");
    Bun.spawnSync(["git", "merge", "side"], { cwd: fx.run, env: { ...process.env, ...GIT_ENV } });
    expect(git(fx.run, "diff", "--name-only", "--diff-filter=U")).toBe("b.txt");

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved.kind).toBe("kept");
    expect(preserved.note).toContain("unresolved conflicts in b.txt");
    expect(git(fx.remote, "for-each-ref", "refs/heads/feature/b")).toBe("");
  });

  test("a pre-commit hook rejecting the WIP commit keeps the worktree and pushes nothing", async () => {
    const hook = join(fx.run, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'secret detected' >&2\nexit 1\n", { mode: 0o755 });

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved.kind).toBe("kept");
    expect(preserved.note).toContain("secret detected");
    expect(git(fx.remote, "for-each-ref", "refs/heads/feature/b")).toBe("");
  });

  test("a pre-push hook rejecting the push keeps the worktree", async () => {
    const hook = join(fx.run, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\necho 'pre-push blocked' >&2\nexit 1\n", { mode: 0o755 });

    const preserved = await preserveUnfinishedWork({
      taskKey: "local-b",
      cwd: fx.run,
      git: boundGit(fx.run),
    });
    expect(preserved.kind).toBe("kept");
    expect(git(fx.remote, "for-each-ref", "refs/heads/feature/b")).toBe("");
  });
});
