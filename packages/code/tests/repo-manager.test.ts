import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { RepoConfig } from "../src/lib/workspace/config";
import { RepoManager } from "../src/lib/workspace/repo-manager";
import { Utils } from "../src/lib/utils";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

/**
 * Minimal text lockfile in the format Bun writes since 1.2. Contents don't
 * matter for the fixtures (no dependencies); `bun install` succeeds offline
 * and runs the root `postinstall` script.
 */
const BUN_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "backend",
      "dependencies": {},
      "devDependencies": {},
    },
  },
  "packages": {},
}
`;

/** Commit fixture files into the origin repo on `main`. */
function commitFiles(originDir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(originDir, name), content);
  }
  git(originDir, "add .");
  git(originDir, 'commit -m "Fixture files"');
}

describe("RepoManager", () => {
  let rootDir: string;
  let originDir: string;
  let workspaceDir: string;
  let manager: RepoManager;
  let repo: RepoConfig;

  beforeEach(() => {
    rootDir = join(tmpdir(), `repo-mgr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    originDir = join(rootDir, "origin");
    workspaceDir = join(rootDir, "workspace");
    mkdirSync(originDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    git(originDir, "init -b main");
    git(originDir, 'config user.name "Fixture User"');
    git(originDir, 'config user.email "fixture@example.com"');
    writeFileSync(join(originDir, "README.md"), "# Fixture\n");
    git(originDir, "add .");
    git(originDir, 'commit -m "Initial commit"');

    manager = new RepoManager(workspaceDir);
    repo = {
      name: "backend",
      remote: `file://${originDir}`,
      defaultBranch: "main",
      env: {},
    };
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("ensureBareClone creates a fetch-ready bare clone", async () => {
    const clonePath = await manager.ensureBareClone(repo);

    expect(clonePath).toBe(join(workspaceDir, "repos", "backend.git"));
    expect(git(clonePath, "rev-parse --is-bare-repository")).toBe("true");
    // The fetch refspec must exist, or `git fetch` never updates origin/*.
    expect(git(clonePath, "config remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
    expect(git(clonePath, "rev-parse origin/main")).toBe(git(originDir, "rev-parse main"));

    // Idempotent.
    expect(await manager.ensureBareClone(repo)).toBe(clonePath);
  });

  test("fetch updates refs/remotes/origin/* after new upstream commits", async () => {
    const clonePath = await manager.ensureBareClone(repo);
    writeFileSync(join(originDir, "new.txt"), "new content\n");
    git(originDir, "add .");
    git(originDir, 'commit -m "Second commit"');

    await manager.fetch(repo.name);

    expect(git(clonePath, "rev-parse origin/main")).toBe(git(originDir, "rev-parse main"));
  });

  test("ensureBareClone applies a changed remote URL to an existing clone", async () => {
    const clonePath = await manager.ensureBareClone(repo);
    const nextOrigin = join(rootDir, "next-origin");
    mkdirSync(nextOrigin);
    git(nextOrigin, "init -b main");

    await manager.ensureBareClone({ ...repo, remote: `file://${nextOrigin}` });

    expect(git(clonePath, "remote get-url origin")).toBe(`file://${nextOrigin}`);
  });

  test("task worktrees are detached at origin/<branch> and see the origin remote", async () => {
    await manager.ensureBareClone(repo);
    const worktree = await manager.createTaskWorktree(repo, "BACK-42");

    expect(worktree).toContain(join(workspaceDir, "worktrees", "backend"));
    expect(existsSync(join(worktree, "README.md"))).toBe(true);
    expect(git(worktree, "rev-parse HEAD")).toBe(git(originDir, "rev-parse main"));
    // detectRepository contract: the worktree resolves the origin remote URL.
    expect(git(worktree, "remote get-url origin")).toBe(`file://${originDir}`);

    // Two runs for the same task never collide.
    const second = await manager.createTaskWorktree(repo, "BACK-42");
    expect(second).not.toBe(worktree);

    await manager.removeTaskWorktree(repo.name, worktree);
    await manager.removeTaskWorktree(repo.name, second);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  test("createTaskWorktree isolates hooks and installs dependencies before the agent starts", async () => {
    commitFiles(originDir, {
      "package.json": JSON.stringify(
        {
          name: "backend",
          version: "1.0.0",
          dependencies: {},
          scripts: {
            // Stands in for a lefthook-style postinstall: resolves where git
            // runs hooks from at install time and drops a marker there.
            postinstall:
              'mkdir -p "$(git rev-parse --git-path hooks)" && touch "$(git rev-parse --git-path hooks)/postinstall-hook" && touch postinstall-marker',
          },
        },
        null,
        2,
      ),
      "bun.lock": BUN_LOCK,
    });
    const clonePath = await manager.ensureBareClone(repo);

    const worktree = await manager.createTaskWorktree(repo, "BACK-50");

    // The install ran inside this worktree...
    expect(existsSync(join(worktree, "node_modules"))).toBe(true);
    expect(existsSync(join(worktree, "postinstall-marker"))).toBe(true);
    // ...after hook isolation: the postinstall's hook rewrite landed in the
    // worktree's private hooks dir, not in the shared bare-clone `.git/hooks`.
    const worktreeGitDir = git(worktree, "rev-parse --absolute-git-dir");
    expect(git(worktree, "config core.hooksPath")).toBe(join(worktreeGitDir, "hooks"));
    expect(existsSync(join(worktreeGitDir, "hooks", "postinstall-hook"))).toBe(true);
    expect(existsSync(join(clonePath, "hooks", "postinstall-hook"))).toBe(false);

    await manager.removeTaskWorktree(repo.name, worktree);
  });

  test("createTaskWorktree still succeeds when dependency install fails", async () => {
    // `npm ci` rejects an out-of-sync lockfile before touching the network,
    // so the install fails deterministically (as does a missing npm).
    commitFiles(originDir, {
      "package.json": JSON.stringify({
        name: "backend",
        version: "1.0.0",
        dependencies: { left: "^1.3.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "backend",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "backend", version: "1.0.0" } },
      }),
    });
    await manager.ensureBareClone(repo);

    const warnSpy = spyOn(console, "warn");
    let worktree: string;
    let warned: string[];
    try {
      worktree = await manager.createTaskWorktree(repo, "BACK-51");
      warned = warnSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      warnSpy.mockRestore();
    }

    // The worktree exists and is usable; the failed install only warned.
    expect(existsSync(join(worktree, "README.md"))).toBe(true);
    expect(git(worktree, "rev-parse HEAD")).toBe(git(originDir, "rev-parse main"));
    expect(warned.some((message) => message.includes("Failed to install dependencies"))).toBe(true);

    await manager.removeTaskWorktree(repo.name, worktree);
  });

  test("ensureBaseWorktree installs dependencies on first create but not on reuse", async () => {
    commitFiles(originDir, {
      "package.json": JSON.stringify({
        name: "backend",
        version: "1.0.0",
        dependencies: {},
        scripts: { postinstall: "touch postinstall-marker" },
      }),
      "bun.lock": BUN_LOCK,
    });
    await manager.ensureBareClone(repo);

    const base = await manager.ensureBaseWorktree(repo);
    const marker = join(base, "postinstall-marker");
    expect(existsSync(marker)).toBe(true);

    // Reuse returns the existing checkout without reinstalling: age the
    // marker and confirm a second call leaves it aged.
    const aged = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(marker, aged, aged);

    expect(await manager.ensureBaseWorktree(repo)).toBe(base);
    expect(statSync(marker).mtimeMs).toBe(aged.getTime());
  });

  test("per-worktree config keeps worktrees from a bare clone non-bare", async () => {
    const clonePath = await manager.ensureBareClone(repo);
    const worktree = await manager.createTaskWorktree(repo, "BACK-43");

    await Utils.isolateWorktreeHooks(worktree);

    expect(git(clonePath, "rev-parse --is-bare-repository")).toBe("true");
    expect(git(worktree, "rev-parse --is-bare-repository")).toBe("false");
    expect(git(worktree, "rev-parse --is-inside-work-tree")).toBe("true");
    expect(git(worktree, "config --show-origin --get core.hooksPath")).toContain("config.worktree");
  });

  test("ensureBareClone repairs an existing unsafe worktree-config layout", async () => {
    const clonePath = await manager.ensureBareClone(repo);
    const worktree = await manager.createTaskWorktree(repo, "BACK-44");
    const sharedConfig = join(clonePath, "config");

    git(clonePath, `config --file ${sharedConfig} core.bare true`);
    git(clonePath, `config --file ${sharedConfig} extensions.worktreeConfig true`);
    expect(git(worktree, "rev-parse --is-bare-repository")).toBe("true");

    await manager.ensureBareClone(repo);

    expect(git(clonePath, "rev-parse --is-bare-repository")).toBe("true");
    expect(git(worktree, "rev-parse --is-bare-repository")).toBe("false");
    expect(git(worktree, "rev-parse --is-inside-work-tree")).toBe("true");
  });

  test("resolveDefaultBranch falls back to origin/HEAD when unset in config", async () => {
    await manager.ensureBareClone(repo);
    const noBranchConfigured: RepoConfig = { ...repo, defaultBranch: undefined };
    expect(await manager.resolveDefaultBranch(noBranchConfigured)).toBe("main");
  });

  test("ensureBaseWorktree creates one persistent checkout and reuses it", async () => {
    await manager.ensureBareClone(repo);
    const base = await manager.ensureBaseWorktree(repo);
    expect(base).toBe(join(workspaceDir, "worktrees", "backend", "base"));
    expect(existsSync(join(base, "README.md"))).toBe(true);
    expect(await manager.ensureBaseWorktree(repo)).toBe(base);
  });

  test("sweepStaleWorktrees removes old task worktrees but never the base", async () => {
    await manager.ensureBareClone(repo);
    const base = await manager.ensureBaseWorktree(repo);
    const stale = await manager.createTaskWorktree(repo, "OLD-1");
    const fresh = await manager.createTaskWorktree(repo, "NEW-1");

    // Age the stale worktree past the TTL.
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(stale, oldTime, oldTime);
    utimesSync(base, oldTime, oldTime);

    const removed = await manager.sweepStaleWorktrees(repo.name, 7);

    expect(removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(base)).toBe(true);
  });
});
