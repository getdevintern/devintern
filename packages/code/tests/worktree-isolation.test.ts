import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
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
  isWorktreeIsolationActive,
  isWorktreeIsolationDisabled,
  parseWorktreeName,
  sanitizeTaskKeyForPath,
  sweepOrphanedTaskWorktrees,
} from "../src/lib/worktree-isolation";
import type { WorktreeIsolationDeps } from "../src/lib/worktree-isolation";
import { prepareQueueDbDirectory } from "../src/lib/webhook-queue";
import { Utils } from "../src/lib/utils";

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

  test("isWorktreeIsolationActive gates on git, opt-out env values, and nesting", async () => {
    const originalIsGitRepository = Utils.isGitRepository;
    try {
      // Git disabled wins over everything, even inside a repository.
      Utils.isGitRepository = async () => true;
      expect(await isWorktreeIsolationActive(false)).toBe(false);

      // Enabled git + repository + no opt-out: isolation will engage.
      expect(await isWorktreeIsolationActive(true)).toBe(true);

      // Opt-out env values are case-insensitive.
      for (const value of ["1", "true", "yes", "on", "TRUE", "Yes", "ON", "oN"]) {
        process.env[WORKTREE_ISOLATION_DISABLE_ENV] = value;
        expect(await isWorktreeIsolationActive(true)).toBe(false);
      }
      delete process.env[WORKTREE_ISOLATION_DISABLE_ENV];

      // Anything else is not an opt-out and falls through to the repo check.
      for (const value of ["0", "false", "no", "off", "", "enabled"]) {
        process.env[WORKTREE_ISOLATION_DISABLE_ENV] = value;
        expect(await isWorktreeIsolationActive(true)).toBe(true);
      }
      delete process.env[WORKTREE_ISOLATION_DISABLE_ENV];

      // A nested isolated run never reports isolation as active again.
      process.env[WORKTREE_ISOLATION_MARKER_ENV] = join(rootDir, "nested");
      expect(await isWorktreeIsolationActive(true)).toBe(false);
      delete process.env[WORKTREE_ISOLATION_MARKER_ENV];

      // Outside a repository there is nothing to isolate.
      Utils.isGitRepository = async () => false;
      expect(await isWorktreeIsolationActive(true)).toBe(false);
    } finally {
      Utils.isGitRepository = originalIsGitRepository;
    }
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

  test("settings-copy fallback engages when symlink creation fails", async () => {
    mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(repoDir, ".devintern-code", "settings.json"),
      JSON.stringify({ jira: { projects: { DEV: {} } } }),
    );

    const failingSymlinkDeps: WorktreeIsolationDeps = {
      ...deps,
      symlink: () => {
        throw new Error("simulated: symlinks unavailable");
      },
    };

    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      failingSymlinkDeps,
    );
    const linkPath = join(handle!.worktreePath, ".devintern-code");

    // A real directory holding a copied settings file, not a link.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(linkPath).isDirectory()).toBe(true);
    expect(readFileSync(join(linkPath, "settings.json"), "utf8")).toContain("DEV");
    // Durable state stays pinned outside the disposable directory regardless.
    expect(process.env.WEBHOOK_QUEUE_DB).toBe(join(repoDir, ".devintern-code", "queue.db"));

    handle!.finish("completed");

    // Teardown removes the copied-settings directory safely.
    expect(existsSync(handle!.worktreePath)).toBe(false);
    expect(git(repoDir, "worktree list")).not.toContain(handle!.worktreePath);
  });

  test("first run pins WEBHOOK_QUEUE_DB even when the shared state dir does not exist yet", async () => {
    // No .devintern-code in the repo: a genuinely first run. The pin must
    // engage before the shared-dir existence check, or lazy queue.db
    // initialization would create the database inside the disposable
    // worktree and teardown would destroy it.
    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-FIRST", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    expect(handle).not.toBeNull();
    const worktreePath = handle!.worktreePath;

    expect(process.env.WEBHOOK_QUEUE_DB).toBe(join(repoDir, ".devintern-code", "queue.db"));

    // A lazy durable-state writer resolves through the pinned env and creates
    // missing parent directories under the repo — never inside the worktree.
    prepareQueueDbDirectory(process.env.WEBHOOK_QUEUE_DB!);
    expect(existsSync(join(repoDir, ".devintern-code"))).toBe(true);
    expect(existsSync(join(worktreePath, ".devintern-code"))).toBe(false);

    handle!.finish("completed");
  });

  test(".devintern-code is registered in .git/info/exclude exactly once across repeated enters", async () => {
    const first = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-EXCL-A", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    first!.finish("completed");

    const second = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-EXCL-B", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    second!.finish("completed");

    const exclude = readFileSync(join(repoDir, ".git", "info", "exclude"), "utf8");
    const entries = exclude.split("\n").filter((line) => line.trim() === ".devintern-code");
    expect(entries).toHaveLength(1);
    expect(exclude).toContain("# @devintern/code local state (not committed)");
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

  test("commit-hook refusal falls back to a --no-verify preservation commit", async () => {
    mkdirSync(join(repoDir, ".git", "hooks"), { recursive: true });
    const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho 'hook refuses' >&2\nexit 1\n");
    chmodSync(hookPath, 0o755);

    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    const worktreePath = handle!.worktreePath;

    git(worktreePath, "checkout -b feature/dev-90");
    writeFileSync(join(worktreePath, "hooked.txt"), "implemented despite hooks\n");

    handle!.finish("completed");

    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoDir, "log -1 --format=%s refs/heads/feature/dev-90")).toBe(
      "feat: implement DEV-90",
    );
    expect(git(repoDir, "show --name-only --format= refs/heads/feature/dev-90")).toContain(
      "hooked.txt",
    );
  });

  test("detached-head teardown patches instead of committing (mayCommit=false)", async () => {
    const headsBefore = git(repoDir, 'for-each-ref refs/heads --format="%(refname)"');

    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    const worktreePath = handle!.worktreePath;

    // Interrupt landed before the pipeline created the feature branch.
    expect(gitOk(worktreePath, "symbolic-ref -q HEAD")).toBeNull();
    writeFileSync(join(worktreePath, "stranded.txt"), "never got a branch\n");

    handle!.finish("completed");

    expect(existsSync(worktreePath)).toBe(false);
    // Nowhere durable to receive a commit: branch list unchanged...
    expect(git(repoDir, 'for-each-ref refs/heads --format="%(refname)"')).toBe(headsBefore);
    // ...and the stranded work is recoverable from the patch instead.
    const patchPath = join(patchDir, WORKTREE_PATCH_FILE_NAME);
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toContain("stranded.txt");
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

  test("preserved commits and patches never include the .devintern-code link", async () => {
    // The shared-state dir must exist so the worktree gets the symlink; the
    // link is dropped before preservation inspects the tree, and the
    // .git/info/exclude registration is the second layer that also keeps the
    // worktrees themselves out of status/add.
    mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
    writeFileSync(join(repoDir, ".devintern-code", "settings.json"), "{}");

    const committed = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-LINK-A", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    git(committed!.worktreePath, "checkout -b feature/dev-link-a");
    writeFileSync(join(committed!.worktreePath, "code-a.txt"), "x\n");
    committed!.finish("completed");

    const names = git(repoDir, "show --name-only --format= refs/heads/feature/dev-link-a");
    expect(names).toContain("code-a.txt");
    expect(names).not.toContain(".devintern-code");

    const patched = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-LINK-B", targetBranch: "main", autoCommit: false, patchDir },
      deps,
    );
    writeFileSync(join(patched!.worktreePath, "code-b.txt"), "y\n");
    patched!.finish("completed");

    const patch = readFileSync(join(patchDir, WORKTREE_PATCH_FILE_NAME), "utf8");
    expect(patch).toContain("code-b.txt");
    expect(patch).not.toContain(".devintern-code");
  });

  test("a failed exclude registration never stages or commits the state link", async () => {
    // The shared-state dir must exist so the worktree gets the symlink; a
    // read-only info/exclude makes ensureStateDirIgnored fail silently, so
    // git sees the link as untracked unless finish() removes it up front.
    mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
    writeFileSync(join(repoDir, ".devintern-code", "settings.json"), "{}");

    const excludePath = join(repoDir, ".git", "info", "exclude");
    mkdirSync(join(repoDir, ".git", "info"), { recursive: true });
    writeFileSync(excludePath, "# user patterns\n");
    chmodSync(excludePath, 0o444);

    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-NOEXCL", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    expect(handle).not.toBeNull();
    const worktreePath = handle!.worktreePath;
    expect(lstatSync(join(worktreePath, ".devintern-code")).isSymbolicLink()).toBe(true);

    git(worktreePath, "checkout -b feature/dev-noexcl");
    writeFileSync(join(worktreePath, "work.txt"), "real work\n");

    handle!.finish("completed");

    // Normal preservation flow — no phantom dirtiness, no salvage detour.
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoDir, "log -1 --format=%s refs/heads/feature/dev-noexcl")).toBe(
      "feat: implement DEV-NOEXCL",
    );
    const names = git(repoDir, "show --name-only --format= refs/heads/feature/dev-noexcl");
    expect(names).toContain("work.txt");
    expect(names).not.toContain(".devintern-code");
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

  test("sweep reaps ancient entries even when their embedded pid is still alive", () => {
    // pid reuse can make a crashed run's entry look live; entries older than
    // the orphan-age backstop are swept regardless. Backdate past the
    // 7-day ORPHAN_MAX_AGE_MS via mtimes.
    const ancient = join(worktreeRoot, `devintern-task-dev-92-${process.pid}-${Date.now()}`);
    mkdirSync(ancient, { recursive: true });
    writeFileSync(join(ancient, "leftover.txt"), "older than any legitimate run\n");
    const longGone = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(ancient, longGone, longGone);

    const freshLive = join(worktreeRoot, `devintern-task-dev-93-${process.pid}-${Date.now()}`);
    mkdirSync(freshLive, { recursive: true });

    const removed = sweepOrphanedTaskWorktrees(worktreeRoot, repoDir);

    expect(removed).toEqual([ancient]);
    expect(existsSync(ancient)).toBe(false);
    expect(existsSync(freshLive)).toBe(true);
  });

  test("sweep keeps dirty crashed-run worktrees as .unsaved instead of destroying them", () => {
    // A real linked worktree left behind by a SIGKILLed run, holding
    // uncommitted agent work: the sweep must salvage it, not tear it down.
    const exited = Bun.spawnSync(["true"]);
    mkdirSync(worktreeRoot, { recursive: true });
    const orphan = join(worktreeRoot, `devintern-task-dev-94-${exited.pid}-${Date.now()}`);
    git(repoDir, `worktree add --detach ${orphan} main`);
    writeFileSync(join(orphan, "hours-of-work.txt"), "uncommitted\n");

    const removed = sweepOrphanedTaskWorktrees(worktreeRoot, repoDir);

    const salvagedPath = `${orphan}.unsaved`;
    expect(removed).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(salvagedPath)).toBe(true);
    expect(readFileSync(join(salvagedPath, "hours-of-work.txt"), "utf8")).toBe("uncommitted\n");
    // The suffix escapes the name-pattern check: future sweeps cannot reap it.
    expect(parseWorktreeName(basename(salvagedPath))).toBeNull();
    // Only the stale registration was dropped.
    expect(git(repoDir, "worktree list")).not.toContain(orphan);

    rmSync(salvagedPath, { recursive: true, force: true });
  });

  test("sweep still tears down clean crashed-run worktrees", () => {
    const exited = Bun.spawnSync(["true"]);
    mkdirSync(worktreeRoot, { recursive: true });
    const orphan = join(worktreeRoot, `devintern-task-dev-95-${exited.pid}-${Date.now()}`);
    git(repoDir, `worktree add --detach ${orphan} main`);

    const removed = sweepOrphanedTaskWorktrees(worktreeRoot, repoDir);

    expect(removed).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(`${orphan}.unsaved`)).toBe(false);
    expect(git(repoDir, "worktree list")).not.toContain(orphan);
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

  test("base ref resolution falls back to the local branch, then HEAD", async () => {
    // A branch that origin has never seen: the fetch is a silent no-op and
    // resolution must land on refs/heads/topic.
    git(repoDir, "checkout -b topic");
    writeFileSync(join(repoDir, "topic-only.txt"), "local ahead\n");
    git(repoDir, "add .");
    git(repoDir, "commit -m local-only-topic");
    git(repoDir, "checkout main");
    const topicSha = git(repoDir, "rev-parse refs/heads/topic");

    const localFallback = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-FALLBACK", targetBranch: "topic", autoCommit: true, patchDir },
      deps,
    );
    expect(localFallback).not.toBeNull();
    expect(git(localFallback!.worktreePath, "rev-parse HEAD")).toBe(topicSha);
    localFallback!.finish("completed");

    // Neither origin nor the local repo has this branch: fall back to HEAD.
    const headSha = git(repoDir, "rev-parse HEAD");
    const ghostFallback = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-GHOST", targetBranch: "ghost", autoCommit: true, patchDir },
      deps,
    );
    expect(ghostFallback).not.toBeNull();
    expect(git(ghostFallback!.worktreePath, "rev-parse HEAD")).toBe(headSha);
    ghostFallback!.finish("completed");
  });

  test("consecutive batch entries share one base-ref resolution (single fetch)", async () => {
    const originalExecute = Utils.executeGitCommand;
    let fetchCount = 0;
    Utils.executeGitCommand = async (args, options) => {
      if (args[0] === "fetch") {
        fetchCount++;
      }
      return originalExecute(args, options);
    };

    try {
      const first = await enterTaskWorktreeIsolation(
        { taskKey: "DEV-CACHE-A", targetBranch: "main", autoCommit: true, patchDir },
        deps,
      );
      first!.finish("completed");

      const second = await enterTaskWorktreeIsolation(
        { taskKey: "DEV-CACHE-B", targetBranch: "main", autoCommit: true, patchDir },
        deps,
      );
      second!.finish("completed");

      // Same repo root + branch: the second entry reuses the cached
      // resolution instead of paying another network round-trip.
      expect(fetchCount).toBe(1);
      expect(first!.worktreePath).not.toBe(second!.worktreePath);
    } finally {
      Utils.executeGitCommand = originalExecute;
    }
  });

  test("a rejected base-ref resolution evicts the cache so the next entry retries", async () => {
    const originalExecute = Utils.executeGitCommand;
    let fetchAttempts = 0;
    Utils.executeGitCommand = async (args, options) => {
      if (args[0] === "fetch") {
        fetchAttempts++;
        if (fetchAttempts === 1) {
          throw new Error("simulated network outage");
        }
      }
      return originalExecute(args, options);
    };

    try {
      await expect(
        enterTaskWorktreeIsolation(
          { taskKey: "DEV-EVICT-A", targetBranch: "main", autoCommit: true, patchDir },
          deps,
        ),
      ).rejects.toThrow("simulated network outage");
      expect(hasActiveWorktreeIsolation()).toBe(false);

      // The failed promise was evicted: this entry resolves afresh and succeeds.
      const retried = await enterTaskWorktreeIsolation(
        { taskKey: "DEV-EVICT-B", targetBranch: "main", autoCommit: true, patchDir },
        deps,
      );
      expect(retried).not.toBeNull();
      expect(fetchAttempts).toBe(2);
      retried!.finish("completed");
    } finally {
      Utils.executeGitCommand = originalExecute;
    }
  });

  test("unsalvageable dirty trees warn loudly and keep the directory for manual recovery", async () => {
    // autoCommit=false skips commits; a regular file where the patch
    // directory belongs makes every patch write fail too.
    mkdirSync(join(rootDir, "output"), { recursive: true });
    writeFileSync(patchDir, "blocks mkdirSync\n");

    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: false, patchDir },
      deps,
    );
    const worktreePath = handle!.worktreePath;
    writeFileSync(join(worktreePath, "doomed.txt"), "cannot be saved\n");

    const logs: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    console.warn = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      handle!.finish("completed");
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    // Nothing is destroyed: the tree is moved aside under a name the orphan
    // sweep cannot match, its registration pruned, contents intact.
    const salvagedPath = `${worktreePath}.unsaved`;
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(salvagedPath)).toBe(true);
    expect(readFileSync(join(salvagedPath, "doomed.txt"), "utf8")).toBe("cannot be saved\n");
    expect(git(repoDir, "worktree list")).not.toContain(worktreePath);
    expect(parseWorktreeName(basename(salvagedPath))).toBeNull();

    const output = logs.join("\n");
    expect(output).toContain("could NOT be saved");
    expect(output).toContain(worktreePath);
    expect(output).toContain(salvagedPath);
    expect(output).not.toContain("Your working directory was not modified");
  });

  test("a failed git status is treated as dirty: uncommitted work is never destroyed", async () => {
    const handle = await enterTaskWorktreeIsolation(
      { taskKey: "DEV-90", targetBranch: "main", autoCommit: true, patchDir },
      deps,
    );
    const worktreePath = handle!.worktreePath;

    git(worktreePath, "checkout -b feature/dev-90");
    writeFileSync(join(worktreePath, "precious.txt"), "must survive\n");

    // Corrupt the linked worktree's index so `git status --porcelain` fails
    // (models transient index.lock / fs contention): unknown state must route
    // into the salvage path, never a clean-tree teardown.
    const gitdir = readFileSync(join(worktreePath, ".git"), "utf8")
      .trim()
      .replace(/^gitdir:\s*/, "");
    writeFileSync(join(gitdir, "index"), Buffer.from("not a real index file"));

    const logs: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    console.warn = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      handle!.finish("completed");
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    // Commit and patch both fail against the corrupt index, so the raw tree
    // is kept for manual recovery — nothing is deleted.
    expect(existsSync(`${worktreePath}.unsaved`)).toBe(true);
    expect(readFileSync(join(`${worktreePath}.unsaved`, "precious.txt"), "utf8")).toBe(
      "must survive\n",
    );
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoDir, "worktree list")).not.toContain(worktreePath);
    expect(logs.join("\n")).toContain("could NOT be saved");
  });

  test("process.exit mid-run triggers synchronous teardown via the exit guard", async () => {
    const childWorktreeRoot = join(rootDir, "child-worktrees");
    const childPatchDir = join(rootDir, "child-output", "dev-exit");
    const scriptPath = join(rootDir, "exit-guard-child.ts");
    const modulePath = join(import.meta.dir, "..", "src", "lib", "worktree-isolation.ts");
    writeFileSync(
      scriptPath,
      [
        `import { execSync } from "child_process";`,
        `import { mkdirSync, writeFileSync } from "fs";`,
        `import { join } from "path";`,
        `import { enterTaskWorktreeIsolation } from ${JSON.stringify(modulePath)};`,
        ``,
        `const [childWorktreeRoot, childPatchDir] = process.argv.slice(2);`,
        `process.env.DEVINTERN_TASK_WORKTREE_DIR = childWorktreeRoot;`,
        `const handle = await enterTaskWorktreeIsolation(`,
        `  { taskKey: "DEV-EXIT", targetBranch: "main", autoCommit: true, patchDir: childPatchDir },`,
        `  { chdir: (directory: string) => process.chdir(directory), cwd: () => process.cwd() },`,
        `);`,
        `if (!handle) {`,
        `  throw new Error("isolation did not engage");`,
        `}`,
        `mkdirSync(childPatchDir, { recursive: true });`,
        `writeFileSync(join(childPatchDir, "child-worktree-path.txt"), handle.worktreePath);`,
        `execSync("git checkout -b feature/dev-exit", {`,
        `  cwd: handle.worktreePath,`,
        `  stdio: "ignore",`,
        `});`,
        `writeFileSync(join(handle.worktreePath, "exit-guard.txt"), "survives\\n");`,
        `process.exit(0);`,
        ``,
      ].join("\n"),
    );

    const proc = Bun.spawnSync([process.execPath, scriptPath, childWorktreeRoot, childPatchDir], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      console.error(proc.stderr.toString());
    }
    expect(proc.exitCode).toBe(0);

    const worktreePath = readFileSync(
      join(childPatchDir, "child-worktree-path.txt"),
      "utf8",
    ).trim();
    expect(parseWorktreeName(basename(worktreePath))).not.toBeNull();

    // Exit handlers run synchronously before the process dies: no finish()
    // call in the child, yet the tree is gone, the registration pruned, and
    // the WIP committed.
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoDir, "worktree list")).not.toContain(worktreePath);
    expect(git(repoDir, "log -1 --format=%s refs/heads/feature/dev-exit")).toBe(
      "wip(devintern): preserve incomplete work on DEV-EXIT",
    );
    expect(git(repoDir, "show --name-only --format= refs/heads/feature/dev-exit")).toContain(
      "exit-guard.txt",
    );
  }, 30_000);

  // End-to-end wiring of the startup sync decision (index.ts): when
  // isWorktreeIsolationActive() says a run will be isolated, the user's
  // checkout must only ever be fetched — never pulled. Tracker I/O is aimed
  // at a closed port with retries disabled so each run fails fast right
  // after the sync step under assertion.
  const CLI_PATH = join(import.meta.dir, "..", "src", "index.ts");

  /** Process env for the CLI child: tracker stubs, plus explicit isolation vars. */
  function cliChildEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of [
      WORKTREE_ISOLATION_DIR_ENV,
      WORKTREE_ISOLATION_DISABLE_ENV,
      WORKTREE_ISOLATION_MARKER_ENV,
      "WEBHOOK_QUEUE_DB",
    ]) {
      delete env[key];
    }
    return {
      ...env,
      JIRA_BASE_URL: "http://127.0.0.1:1",
      JIRA_EMAIL: "test@example.com",
      JIRA_API_TOKEN: "test-token",
      DEVINTERN_FETCH_MAX_RETRIES: "0",
      DEVINTERN_SKIP_LICENSE_CHECK: "1",
      DEVINTERN_NO_UPDATE: "1",
      DEVINTERN_TELEMETRY_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...extra,
    };
  }

  async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const signal = AbortSignal.timeout(30_000);
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_PATH, ...args],
      cwd: repoDir,
      env: cliChildEnv(extraEnv),
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited.then((code) => code ?? 0),
    ]);
    return { stdout, stderr, exitCode, timedOut: signal.aborted };
  }

  test("CLI startup fetches instead of pulling when isolation will engage", async () => {
    const result = await runCli(["TEST-123"]);
    expect(result.timedOut).toBe(false);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Fetching latest changes from remote");
    expect(output).not.toContain("Pulling latest changes");
  }, 30_000);

  test("--no-worktree-isolation routes CLI startup back to the pull path", async () => {
    const result = await runCli(["TEST-123", "--no-worktree-isolation"]);
    expect(result.timedOut).toBe(false);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Pulling latest changes from remote");
    expect(output).not.toContain("Fetching latest changes");
  }, 30_000);

  test("DEVINTERN_NO_WORKTREE_ISOLATION routes CLI startup back to the pull path", async () => {
    const result = await runCli(["TEST-123"], { [WORKTREE_ISOLATION_DISABLE_ENV]: "1" });
    expect(result.timedOut).toBe(false);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Pulling latest changes from remote");
    expect(output).not.toContain("Fetching latest changes");
  }, 30_000);
});
