import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  WORKTREE_ISOLATION_DISABLE_ENV,
  WORKTREE_ISOLATION_DIR_ENV,
  WORKTREE_ISOLATION_MARKER_ENV,
  WORKTREE_PATCH_FILE_NAME,
  cleanupActiveWorktreeIsolation,
  enterTaskWorktreeIsolation,
  hasActiveWorktreeIsolation,
  isPidAlive,
  isWorktreeIsolationDisabled,
  parseWorktreeName,
  sanitizeTaskKeyForPath,
  sweepOrphanedTaskWorktrees,
} from "../src/lib/worktree-isolation";
import type { WorktreeIsolationDeps } from "../src/lib/worktree-isolation";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

/** Like {@link git} but returns null instead of throwing on non-zero exit. */
function gitOk(cwd: string, command: string): string | null {
  try {
    return execSync(`git ${command}`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

describe("worktree isolation", () => {
  let rootDir: string;
  let originDir: string;
  let repoDir: string;
  let patchDir: string;
  let worktreeRoot: string;

  // Environment is process-global; save and restore around every test.
  const savedEnv: Record<string, string | undefined> = {};

  const chdirs: string[] = [];
  const deps: WorktreeIsolationDeps = {
    chdir: (directory: string) => {
      chdirs.push(directory);
    },
    cwd: () => repoDir,
  };

  beforeEach(() => {
    rootDir = join(tmpdir(), `wt-iso-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    originDir = join(rootDir, "origin");
    repoDir = join(rootDir, "repo");
    patchDir = join(rootDir, "output", "dev-90");
    worktreeRoot = join(rootDir, "worktrees");
    mkdirSync(originDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    chdirs.length = 0;

    git(originDir, "init -b main");
    git(originDir, 'config user.name "Fixture User"');
    git(originDir, 'config user.email "fixture@example.com"');
    writeFileSync(join(originDir, "README.md"), "# Fixture\n");
    git(originDir, "add .");
    git(originDir, 'commit -m "Initial commit"');

    git(repoDir, `clone file://${originDir} .`);
    git(repoDir, 'config user.name "Local User"');
    git(repoDir, 'config user.email "local@example.com"');

    for (const key of [
      WORKTREE_ISOLATION_DIR_ENV,
      WORKTREE_ISOLATION_DISABLE_ENV,
      WORKTREE_ISOLATION_MARKER_ENV,
      "WEBHOOK_QUEUE_DB",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env[WORKTREE_ISOLATION_DIR_ENV] = worktreeRoot;
    delete process.env[WORKTREE_ISOLATION_DISABLE_ENV];
    delete process.env[WORKTREE_ISOLATION_MARKER_ENV];
    delete process.env.WEBHOOK_QUEUE_DB;
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function dirtyUserTree(): void {
    writeFileSync(join(repoDir, "README.md"), "# Locally modified\n");
    writeFileSync(join(repoDir, "staged.txt"), "staged by user\n");
    writeFileSync(join(repoDir, "untracked.txt"), "untracked user file\n");
    git(repoDir, "add staged.txt");
  }

  function snapshotUserTree(): { branch: string; head: string; status: string } {
    return {
      branch: git(repoDir, "branch --show-current"),
      head: git(repoDir, "rev-parse HEAD"),
      status: git(repoDir, "status --porcelain"),
    };
  }

  test("unit helpers: sanitize, parse, pid liveness", () => {
    expect(sanitizeTaskKeyForPath("DEV-90")).toBe("dev-90");
    expect(sanitizeTaskKeyForPath("Feature/Big Thing!")).toBe("feature-big-thing");
    expect(sanitizeTaskKeyForPath("///")).toBe("task");

    const parsed = parseWorktreeName(`devintern-task-dev-90-4242-${Date.now()}`);
    expect(parsed?.pid).toBe(4242);
    expect(parseWorktreeName("some-other-dir")).toBeNull();
    expect(parseWorktreeName("devintern-task-dev-90-notanumber")).toBeNull();

    expect(isPidAlive(process.pid)).toBe(true);
    const exited = Bun.spawnSync(["true"]);
    expect(isPidAlive(exited.pid)).toBe(false);
  });

  test("isWorktreeIsolationDisabled honors the opt-out env var", () => {
    expect(isWorktreeIsolationDisabled()).toBe(false);
    process.env[WORKTREE_ISOLATION_DISABLE_ENV] = "1";
    expect(isWorktreeIsolationDisabled()).toBe(true);
  });

  test("enter creates a detached worktree and leaves the user's tree untouched", async () => {
    dirtyUserTree();
    const before = snapshotUserTree();

    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );

    expect(handle).not.toBeNull();
    const worktreePath = handle!.worktreePath;
    expect(worktreePath.startsWith(worktreeRoot)).toBe(true);
    expect(existsSync(join(worktreePath, ".git"))).toBe(true);

    // Detached at the fetched base ref, not the user's (dirty) state.
    expect(git(worktreePath, "rev-parse HEAD")).toBe(git(repoDir, "rev-parse origin/main"));
    expect(gitOk(worktreePath, "symbolic-ref -q HEAD")).toBeNull();

    // The user's checkout: same branch, same HEAD, identical status.
    expect(snapshotUserTree()).toEqual(before);

    // The pipeline cwd was moved into the worktree via the injected seam.
    expect(chdirs).toEqual([worktreePath]);
    expect(process.env[WORKTREE_ISOLATION_MARKER_ENV]).toBe(worktreePath);
    expect(hasActiveWorktreeIsolation()).toBe(true);

    handle!.finish("completed");
  });

  test("shared config dir is reachable inside the worktree", async () => {
    mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(repoDir, ".devintern-code", "settings.json"),
      JSON.stringify({ jira: { projects: { DEV: {} } } }),
    );

    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    const linkPath = join(handle!.worktreePath, ".devintern-code");

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linkPath, "settings.json"), "utf8")).toContain("DEV");
    // Durable state must never resolve inside the disposable worktree.
    expect(process.env.WEBHOOK_QUEUE_DB).toBe(join(repoDir, ".devintern-code", "queue.db"));

    handle!.finish("completed");
  });

  test("finish(completed) commits pending changes to the feature branch and removes the worktree", async () => {
    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    const worktreePath = handle!.worktreePath;

    // Simulate what the pipeline does inside the worktree.
    git(worktreePath, "checkout -b feature/dev-90");
    writeFileSync(join(worktreePath, "feature.txt"), "implemented\n");

    handle!.finish("completed");

    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoDir, "worktree list")).not.toContain(worktreePath);
    expect(git(repoDir, "rev-parse --verify refs/heads/feature/dev-90")).toBeTruthy();
    expect(git(repoDir, "show --name-only --format= refs/heads/feature/dev-90")).toContain(
      "feature.txt",
    );
    expect(git(repoDir, "log -1 --format=%s refs/heads/feature/dev-90")).toBe(
      "feat: implement DEV-90",
    );

    // cwd restored through the injected seam; marker cleared.
    expect(chdirs[chdirs.length - 1]).toBe(repoDir);
    expect(process.env[WORKTREE_ISOLATION_MARKER_ENV]).toBeUndefined();
    expect(hasActiveWorktreeIsolation()).toBe(false);
  });

  test("finish(failed) preserves WIP with a no-verify commit and removes the worktree", async () => {
    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    const worktreePath = handle!.worktreePath;

    git(worktreePath, "checkout -b feature/dev-90");
    writeFileSync(join(worktreePath, "partial.txt"), "half done\n");

    handle!.finish("failed");

    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoDir, "log -1 --format=%s refs/heads/feature/dev-90")).toBe(
      "wip(devintern): preserve incomplete work on DEV-90",
    );
    expect(git(repoDir, "show --name-only --format= refs/heads/feature/dev-90")).toContain(
      "partial.txt",
    );
  });

  test("autoCommit=false preserves uncommitted work as a patch instead of committing", async () => {
    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: false, patchDir },
      deps,
    );
    const worktreePath = handle!.worktreePath;

    git(worktreePath, "checkout -b feature/dev-90");
    const baseSha = git(worktreePath, "rev-parse HEAD");
    writeFileSync(join(worktreePath, "manual.txt"), "user wants manual control\n");

    handle!.finish("completed");

    expect(existsSync(worktreePath)).toBe(false);
    // No automatic commit: branch tip unchanged...
    expect(git(repoDir, "rev-parse refs/heads/feature/dev-90")).toBe(baseSha);
    // ...but the work is recoverable from the patch file.
    const patchPath = join(patchDir, WORKTREE_PATCH_FILE_NAME);
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toContain("diff --git");
    expect(readFileSync(patchPath, "utf8")).toContain("manual.txt");
  });

  test("interrupted runs clean up synchronously and finish stays idempotent", async () => {
    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    const worktreePath = handle!.worktreePath;
    writeFileSync(join(worktreePath, "torn.txt"), "mid-write when Ctrl+C landed\n");

    cleanupActiveWorktreeIsolation();

    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoDir, "worktree list")).not.toContain(worktreePath);
    expect(hasActiveWorktreeIsolation()).toBe(false);

    // A late finish (e.g. a finally block after the signal handler) is a no-op.
    expect(() => handle!.finish("completed")).not.toThrow();
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("sweepOrphanedTaskWorktrees removes crashed-run entries but never live ones", () => {
    const exited = Bun.spawnSync(["true"]);
    const orphan = join(worktreeRoot, `devintern-task-dev-90-${exited.pid}-${Date.now()}`);
    const live = join(worktreeRoot, `devintern-task-dev-91-${process.pid}-${Date.now()}`);
    const stranger = join(worktreeRoot, "my-own-notes");
    mkdirSync(orphan, { recursive: true });
    mkdirSync(live, { recursive: true });
    mkdirSync(stranger, { recursive: true });
    writeFileSync(join(orphan, "leftover.txt"), "from a killed run\n");

    const removed = sweepOrphanedTaskWorktrees(worktreeRoot, repoDir);

    expect(removed).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(stranger)).toBe(true);
  });

  test("sequential task runs get distinct worktrees", async () => {
    const first = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    first!.finish("completed");

    const second = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    second!.finish("completed");

    expect(first!.worktreePath).not.toBe(second!.worktreePath);
    expect(existsSync(first!.worktreePath)).toBe(false);
    expect(existsSync(second!.worktreePath)).toBe(false);
  });

  test("non-git directories fall back gracefully to an in-place run", async () => {
    const plainDir = join(rootDir, "plain");
    mkdirSync(plainDir, { recursive: true });
    deps.cwd = () => plainDir;
    try {
      const consoleLogs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        consoleLogs.push(args.join(" "));
        return;
      };
      try {
        const handle = await enterTaskWorktreeIsolation(
          { taskKey: "DEV-90", autoCommit: true, patchDir },
          deps,
        );
        expect(handle).toBeNull();
        expect(consoleLogs.some((line) => line.includes("not a git repository"))).toBe(true);
      } finally {
        console.log = originalLog;
      }
      expect(existsSync(worktreeRoot)).toBe(false);
      expect(chdirs).toEqual([]);
    } finally {
      deps.cwd = () => repoDir;
    }
  });

  test("opted-out runs skip isolation entirely", async () => {
    process.env[WORKTREE_ISOLATION_DISABLE_ENV] = "1";
    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    expect(handle).toBeNull();
    expect(chdirs).toEqual([]);
    expect(existsSync(worktreeRoot)).toBe(false);
  });
});
