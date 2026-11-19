import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { createGitStack } from "../src/lib/dependencies/stack-git";
import type { StackGit } from "../src/lib/dependencies/stack-maintainer";

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

/** A bare "remote", a working clone to author commits, and restack checkouts. */
class GitFixture {
  readonly root = mkdtempSync(join(tmpdir(), "stacked-prs-git-"));
  readonly remote = join(this.root, "remote.git");
  readonly work = join(this.root, "work");
  private checkouts = 0;

  constructor() {
    mkdirSync(this.remote);
    git(this.remote, "init", "--bare", "--initial-branch=main");
    git(this.root, "clone", this.remote, this.work);
    git(this.work, "checkout", "-b", "main");
    this.commit("README.md", "hello\n", "m0");
    git(this.work, "push", "origin", "main");
  }

  commit(file: string, content: string, message: string): string {
    writeFileSync(join(this.work, file), content);
    git(this.work, "add", file);
    git(this.work, "commit", "-m", message);
    return git(this.work, "rev-parse", "HEAD");
  }

  branch(name: string, from: string): void {
    git(this.work, "checkout", "-B", name, from);
  }

  push(branch: string): void {
    git(this.work, "push", "--force", "origin", `${branch}:${branch}`);
  }

  remoteHead(branch: string): string {
    return git(this.remote, "rev-parse", `refs/heads/${branch}`);
  }

  /** Squash-merge `branch` into main on the remote, the way GitHub does. */
  squashMerge(branch: string): void {
    git(this.work, "fetch", "origin");
    git(this.work, "checkout", "-B", "main", "origin/main");
    git(this.work, "merge", "--squash", `origin/${branch}`);
    git(this.work, "commit", "-m", `squash ${branch}`);
    this.push("main");
  }

  /** Files changed between two remote refs. */
  diffNames(from: string, to: string): string[] {
    const out = git(this.remote, "diff", "--name-only", `${from}...${to}`);
    return out === "" ? [] : out.split("\n");
  }

  commitCount(from: string, to: string): number {
    return Number(git(this.remote, "rev-list", "--count", `${from}..${to}`));
  }

  stack(options: { env?: NodeJS.ProcessEnv; prepare?: (cwd: string) => void } = {}): StackGit {
    return createGitStack({
      env: options.env ?? GIT_ENV,
      checkout: async () => {
        const cwd = join(this.root, `checkout-${++this.checkouts}`);
        git(this.root, "clone", "--quiet", this.remote, cwd);
        options.prepare?.(cwd);
        return { cwd, release: async () => rmSync(cwd, { recursive: true, force: true }) };
      },
    });
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe("deterministic restack (git)", () => {
  let fx: GitFixture;
  beforeEach(() => {
    fx = new GitFixture();
  });
  afterEach(() => fx.cleanup());

  /** main ← A (a.txt, two commits) ← B (b.txt). */
  function stackAB(): { aHead: string; bHead: string } {
    fx.branch("feature/a", "main");
    fx.commit("a.txt", "a1\n", "a1");
    const aHead = fx.commit("a.txt", "a1\na2\n", "a2");
    fx.push("feature/a");
    fx.branch("feature/b", "feature/a");
    const bHead = fx.commit("b.txt", "b1\n", "b1");
    fx.push("feature/b");
    return { aHead, bHead };
  }

  test("after a squash merge only the stacked commits remain in the diff", async () => {
    const { aHead, bHead } = stackAB();
    fx.squashMerge("feature/a");
    // Before the restack, B against main still carries A's original commits.
    expect(fx.commitCount("main", "feature/b")).toBe(3);

    const result = await fx.stack().restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: bHead,
      onto: "main",
      oldBaseCandidates: [aHead],
    });

    expect(result.kind).toBe("restacked");
    const head = fx.remoteHead("feature/b");
    expect(result).toEqual({ kind: "restacked", headSha: head, baseSha: fx.remoteHead("main") });
    expect(fx.commitCount("main", "feature/b")).toBe(1);
    expect(fx.diffNames("main", "feature/b")).toEqual(["b.txt"]);
  });

  test("a host with no git identity restacks as the branch tip's committer", async () => {
    const { aHead, bHead } = stackAB();
    fx.squashMerge("feature/a");
    const emptyGlobal = join(fx.root, "empty-gitconfig");
    writeFileSync(emptyGlobal, "");
    // No identity anywhere, and git may not guess one from the hostname.
    const env = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: emptyGlobal,
      HOME: fx.root,
      GIT_AUTHOR_NAME: "",
      GIT_AUTHOR_EMAIL: "",
      GIT_COMMITTER_NAME: "",
      GIT_COMMITTER_EMAIL: "",
      EMAIL: "",
    };
    const prepare = (cwd: string): void => {
      git(cwd, "config", "user.useConfigOnly", "true");
      // Precondition: a plain commit in this checkout is refused.
      const probe = Bun.spawnSync(["git", "var", "GIT_COMMITTER_IDENT"], {
        cwd,
        env: { ...process.env, ...env },
        stderr: "pipe",
      });
      expect(probe.exitCode).not.toBe(0);
    };

    const result = await fx.stack({ env, prepare }).restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: bHead,
      onto: "main",
      oldBaseCandidates: [aHead],
    });

    expect(result.kind).toBe("restacked");
    expect(git(fx.remote, "log", "-1", "--format=%cn <%ce>", "feature/b")).toBe(
      "Test <test@example.com>",
    );
    expect(fx.diffNames("main", "feature/b")).toEqual(["b.txt"]);
  });

  test("a conflicting restack is aborted and pushes nothing", async () => {
    const { aHead, bHead } = stackAB();
    fx.squashMerge("feature/a");
    // Someone else changes b.txt on main.
    fx.branch("main", "origin/main");
    fx.commit("b.txt", "other\n", "conflicting");
    fx.push("main");

    const result = await fx.stack().restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: bHead,
      onto: "main",
      oldBaseCandidates: [aHead],
    });

    expect(result.kind).toBe("conflict");
    expect(fx.remoteHead("feature/b")).toBe(bHead);
  });

  test("chain A → B → C: B follows A's review fix, then C follows B's new head", async () => {
    const { aHead, bHead } = stackAB();
    fx.branch("feature/c", "feature/b");
    const cHead = fx.commit("c.txt", "c1\n", "c1");
    fx.push("feature/c");
    // A gets a review fix.
    fx.branch("feature/a", "origin/feature/a");
    fx.commit("a.txt", "a1\na2\nfix\n", "review fix");
    fx.push("feature/a");
    const stack = fx.stack();

    const b = await stack.restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: bHead,
      onto: "feature/a",
      oldBaseCandidates: [aHead],
    });
    expect(b.kind).toBe("restacked");
    expect(fx.commitCount("feature/a", "feature/b")).toBe(1);

    const c = await stack.restack({
      repo: "backend",
      branch: "feature/c",
      expectedHeadSha: cHead,
      onto: "feature/b",
      oldBaseCandidates: [bHead],
    });
    expect(c.kind).toBe("restacked");
    expect(fx.commitCount("feature/b", "feature/c")).toBe(1);
    expect(fx.diffNames("feature/b", "feature/c")).toEqual(["c.txt"]);
    expect(fx.commitCount("main", "feature/c")).toBe(5);
  });

  test("base amended and force-pushed: the recorded base head strips A's old commits", async () => {
    const { aHead, bHead } = stackAB();
    // A's review fix is folded in by amending, then force-pushed.
    fx.branch("feature/a", "origin/feature/a");
    git(fx.work, "reset", "--hard", "HEAD~1");
    writeFileSync(join(fx.work, "a.txt"), "a1\na2-fixed\n");
    git(fx.work, "commit", "-am", "a2 (amended)");
    fx.push("feature/a");

    // The plain merge-base fallback (no recorded head) replays A's old a2 onto
    // the rewritten A: it conflicts on a.txt.
    const fallback = await fx.stack().restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: bHead,
      onto: "feature/a",
      oldBaseCandidates: [],
    });
    expect(fallback.kind).toBe("conflict");
    expect(fx.remoteHead("feature/b")).toBe(bHead);

    // With the base head recorded when B's run started, only B's commit moves.
    const result = await fx.stack().restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: bHead,
      onto: "feature/a",
      oldBaseCandidates: [aHead],
    });
    expect(result.kind).toBe("restacked");
    expect(fx.commitCount("feature/a", "feature/b")).toBe(1);
    expect(fx.diffNames("feature/a", "feature/b")).toEqual(["b.txt"]);
  });

  test("a push the remote's pre-receive hook declines is push-rejected, not stale", async () => {
    const { aHead, bHead } = stackAB();
    fx.squashMerge("feature/a");
    const hook = join(fx.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'protected branch hook declined' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = await fx.stack().restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: bHead,
      onto: "main",
      oldBaseCandidates: [aHead],
    });

    expect(result.kind).toBe("push-rejected");
    expect(fx.remoteHead("feature/b")).toBe(bHead);
  });

  test("a branch pushed between fetch and push fails the lease as stale", async () => {
    const { aHead, bHead } = stackAB();
    fx.squashMerge("feature/a");
    let moved = "";
    const stack = fx.stack({
      // The checkout has fetched bHead; someone pushes B right after.
      prepare: () => {
        fx.branch("feature/b", bHead);
        moved = fx.commit("b2.txt", "b2\n", "b2");
        fx.push("feature/b");
      },
    });

    const result = await stack.restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: bHead,
      onto: "main",
      oldBaseCandidates: [aHead],
    });

    expect(result).toMatchObject({ kind: "stale", detail: expect.stringContaining("stale info") });
    expect(fx.remoteHead("feature/b")).toBe(moved);
  });

  test("a branch already on its base is up to date; a moved branch is stale", async () => {
    const { bHead } = stackAB();
    const stack = fx.stack();
    const upToDate = await stack.restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: bHead,
      onto: "feature/a",
      oldBaseCandidates: [],
    });
    expect(upToDate).toEqual({ kind: "up-to-date", baseSha: fx.remoteHead("feature/a") });

    const stale = await stack.restack({
      repo: "backend",
      branch: "feature/b",
      expectedHeadSha: "0".repeat(40),
      onto: "main",
      oldBaseCandidates: [],
    });
    expect(stale.kind).toBe("stale");
    expect(fx.remoteHead("feature/b")).toBe(bHead);
  });
});
