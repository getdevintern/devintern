import { describe, expect, test } from "bun:test";
import { resolveCurrentBranch, syncProjectFromRemote } from "./git-sync.ts";
import type { GitExec } from "./git-sync.ts";

type Handler = (args: readonly string[]) => { code: number; stdout?: string; stderr?: string };

function mockGit(handlers: Handler[]): GitExec {
  let i = 0;
  return async (_cwd, args) => {
    const handler = handlers[i++];
    if (!handler) {
      throw new Error(`Unexpected git call #${i}: git ${args.join(" ")}`);
    }
    const result = handler(args);
    return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function expectArgs(args: readonly string[], expected: string[]): boolean {
  return args.length === expected.length && expected.every((part, idx) => args[idx] === part);
}

/**
 * Shared prefix: toplevel + branch + status + upstream + fetch + upstream + ahead/behind.
 */
function behindFetchHandlers(
  statusStdout: string,
  behindCount: number,
  options?: {
    gitRoot?: string;
    aheadCount?: number;
    branch?: string;
  },
): Handler[] {
  const gitRoot = options?.gitRoot ?? "/repo";
  const ahead = options?.aheadCount ?? 0;
  const branch = options?.branch ?? "main";
  return [
    () => ({ code: 0, stdout: `${gitRoot}\n` }),
    (args) =>
      expectArgs(args, ["rev-parse", "--abbrev-ref", "HEAD"])
        ? { code: 0, stdout: `${branch}\n` }
        : { code: 1, stderr: `unexpected: git ${args.join(" ")}` },
    (args) =>
      expectArgs(args, ["status", "--porcelain"])
        ? { code: 0, stdout: statusStdout }
        : { code: 1, stderr: `unexpected: git ${args.join(" ")}` },
    () => ({ code: 0, stdout: "origin/main\n" }),
    (args) => (expectArgs(args, ["fetch", "origin"]) ? { code: 0 } : { code: 1 }),
    () => ({ code: 0, stdout: "origin/main\n" }),
    () => ({ code: 0, stdout: `${ahead}\t${behindCount}\n` }),
  ];
}

describe("resolveCurrentBranch", () => {
  test("returns the branch name", async () => {
    const git = mockGit([
      (args) =>
        expectArgs(args, ["rev-parse", "--abbrev-ref", "HEAD"])
          ? { code: 0, stdout: "feature/demo\n" }
          : { code: 1, stderr: `unexpected: git ${args.join(" ")}` },
    ]);
    expect(await resolveCurrentBranch("/repo", git)).toBe("feature/demo");
  });

  test("falls back to short SHA when detached", async () => {
    const git = mockGit([
      (args) =>
        expectArgs(args, ["rev-parse", "--abbrev-ref", "HEAD"])
          ? { code: 0, stdout: "HEAD\n" }
          : { code: 1, stderr: `unexpected: git ${args.join(" ")}` },
      (args) =>
        expectArgs(args, ["rev-parse", "--short", "HEAD"])
          ? { code: 0, stdout: "abc1234\n" }
          : { code: 1, stderr: `unexpected: git ${args.join(" ")}` },
    ]);
    expect(await resolveCurrentBranch("/repo", git)).toBe("abc1234");
  });
});

describe("syncProjectFromRemote", () => {
  test("returns no_remote when upstream is missing", async () => {
    const git = mockGit([
      () => ({ code: 0, stdout: "/repo\n" }),
      () => ({ code: 0, stdout: "feature/demo\n" }),
      () => ({ code: 0, stdout: " M .gitignore\n" }),
      () => ({ code: 128, stderr: "no upstream\n" }),
    ]);

    const status = await syncProjectFromRemote("/repo", git);
    expect(status.kind).toBe("no_remote");
    expect(status.branch).toBe("feature/demo");
    expect(status.softDirty).toBe(true);
    expect(status.message).toContain("isn't linked");
    expect(status.message).not.toContain("setup file");
  });

  test("skips pull when hard-dirty even if behind", async () => {
    const git = mockGit(behindFetchHandlers(" M src/app.ts\n", 3));

    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("skipped_dirty");
    expect(status.softDirty).toBe(false);
    expect(status.behind).toBe(3);
    expect(status.message).toContain("unsaved local edits");
    expect(status.message).toContain("3 updates");
  });

  test("unparseable porcelain fails closed as hard-dirty (no merge)", async () => {
    const git = mockGit(behindFetchHandlers("XY\n", 2));

    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("skipped_dirty");
    expect(status.softDirty).toBe(false);
    expect(status.behind).toBe(2);
  });

  test("ignored .devintern-pm secrets alone are clean (not soft-dirty)", async () => {
    // Plain status --porcelain does not list !! ignored files.
    const git = mockGit(behindFetchHandlers("", 1));

    const status = await syncProjectFromRemote("/repo", git, { pull: false });
    expect(status.kind).toBe("behind");
    expect(status.softDirty).toBe(false);
    expect(status.behind).toBe(1);
  });

  test("pull:false soft-dirty behind reports behind for Update UI", async () => {
    const git = mockGit(behindFetchHandlers(" M .gitignore\n", 2));

    const status = await syncProjectFromRemote("/repo", git, { pull: false });
    expect(status.kind).toBe("behind");
    expect(status.softDirty).toBe(true);
    expect(status.behind).toBe(2);
    expect(status.message).toContain("2 updates available");
  });

  test("post-init .gitignore + untracked .devintern-pm still allows ff-only update", async () => {
    // Real managed-clone leftover after Connect + markdown task create:
    //   M .gitignore
    //  ?? .devintern-pm/   (tasks; .env is ignored so may not appear)
    const git = mockGit([
      ...behindFetchHandlers(" M .gitignore\n?? .devintern-pm/\n", 1),
      () => ({ code: 0, stdout: "Updating\n" }),
    ]);

    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("ok");
    expect(status.softDirty).toBe(true);
    expect(status.updated).toBe(true);
    expect(status.message).toContain("Got latest changes");
  });

  test("default sync soft-dirty uses merge --ff-only (rebase-safe) when behind", async () => {
    const calls: string[][] = [];
    const git = mockGit([
      ...behindFetchHandlers(" M .gitignore\n", 2),
      (args) => {
        calls.push([...args]);
        // pull --ff-only would fail under pull.rebase=true with soft-dirty
        // .gitignore ("cannot pull with rebase"); merge --ff-only succeeds.
        if (expectArgs(args, ["pull", "--ff-only"])) {
          return {
            code: 1,
            stderr: "error: cannot pull with rebase: You have unstaged changes.\n",
          };
        }
        return expectArgs(args, ["merge", "--ff-only", "origin/main"])
          ? { code: 0, stdout: "Updating\n" }
          : { code: 1, stderr: `unexpected: git ${args.join(" ")}` };
      },
    ]);

    const status = await syncProjectFromRemote("/repo", git);
    expect(status.kind).toBe("ok");
    expect(status.softDirty).toBe(true);
    expect(status.updated).toBe(true);
    expect(status.behind).toBe(0);
    expect(status.message).toContain("Got latest changes");
    expect(status.message).not.toContain("setup file");
    expect(calls.some((c) => c[0] === "merge" && c[1] === "--ff-only")).toBe(true);
    expect(calls.some((c) => c[0] === "pull")).toBe(false);
  });

  test("reports ok without pull when already up to date", async () => {
    const git = mockGit(behindFetchHandlers("", 0));

    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("ok");
    expect(status.updated).toBe(false);
    expect(status.message).toContain("up to date");
  });

  test("errors when post-fetch rev-list ahead/behind fails", async () => {
    const git = mockGit([
      () => ({ code: 0, stdout: "/repo\n" }),
      () => ({ code: 0, stdout: "main\n" }),
      () => ({ code: 0, stdout: "" }),
      () => ({ code: 0, stdout: "origin/main\n" }),
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: "origin/main\n" }),
      () => ({ code: 128, stderr: "fatal: ambiguous argument\n" }),
    ]);

    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("error");
    expect(status.message).toContain("Couldn't check for updates");
    expect(status.message).not.toContain("up to date");
  });

  test("errors when post-fetch rev-list output is unparsable", async () => {
    const git = mockGit([
      ...behindFetchHandlers("", 0).slice(0, -1),
      () => ({ code: 0, stdout: "not-a-count\n" }),
    ]);

    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("error");
    expect(status.message).toContain("Couldn't check for updates");
  });

  test("reports diverged when ff-only merge fails", async () => {
    const git = mockGit([
      ...behindFetchHandlers("", 2),
      () => ({
        code: 1,
        stderr: "fatal: Not possible to fast-forward, aborting.\n",
      }),
    ]);

    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("diverged");
    expect(status.behind).toBe(2);
    expect(status.message).toContain("Can't get updates yet");
  });

  test("soft-dirty overwrite-by-merge asks the team to fix the setup file", async () => {
    const git = mockGit([
      ...behindFetchHandlers(" M .gitignore\n", 1),
      () => ({
        code: 1,
        stderr:
          "error: Your local changes to the following files would be overwritten by merge:\n\t.gitignore\nPlease commit your changes or stash them before you merge.\nAborting\n",
      }),
    ]);

    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("error");
    expect(status.softDirty).toBe(true);
    expect(status.behind).toBe(1);
    expect(status.message).toContain("would be overwritten");
    expect(status.message).toContain("setup file");
    expect(status.message).toContain("team");
  });

  test("skipped_dirty when hard-dirty and not behind", async () => {
    const git = mockGit(behindFetchHandlers(" M README.md\n", 0));

    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("skipped_dirty");
    expect(status.softDirty).toBe(false);
  });

  test("open path skips fetch when hard-dirty (no behind counts)", async () => {
    const git = mockGit([
      () => ({ code: 0, stdout: "/repo\n" }),
      (args) =>
        expectArgs(args, ["rev-parse", "--abbrev-ref", "HEAD"])
          ? { code: 0, stdout: "main\n" }
          : { code: 1, stderr: `unexpected: git ${args.join(" ")}` },
      (args) =>
        expectArgs(args, ["status", "--porcelain"])
          ? { code: 0, stdout: " M src/app.ts\n" }
          : { code: 1, stderr: `unexpected: git ${args.join(" ")}` },
      () => ({ code: 0, stdout: "origin/main\n" }),
    ]);

    const status = await syncProjectFromRemote("/repo", git, {
      pull: true,
      fetchHardDirty: false,
    });
    expect(status.kind).toBe("skipped_dirty");
    expect(status.softDirty).toBe(false);
    expect(status.behind).toBeUndefined();
    expect(status.ahead).toBeUndefined();
    expect(status.fetched).toBeUndefined();
    expect(status.message).toContain("unsaved local edits");
  });

  test("post-fetch skipped_dirty sets fetched", async () => {
    const git = mockGit(behindFetchHandlers(" M README.md\n", 0));
    const status = await syncProjectFromRemote("/repo", git, { pull: true });
    expect(status.kind).toBe("skipped_dirty");
    expect(status.fetched).toBe(true);
  });
});
