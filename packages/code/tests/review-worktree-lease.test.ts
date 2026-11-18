/**
 * Parallel PR jobs: review worktree leases, the idle-worktree cap, and
 * concurrent worktree setup against one shared bare repository.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { Utils } from "../src/lib/utils";
import {
  REVIEW_WORKTREE_IDLE_MAX_AGE_MS,
  REVIEW_WORKTREE_MIN_IDLE_CAP,
  reviewWorktreeIdleCap,
} from "../src/lib/utils/review-worktree";
import {
  isReviewWorktreeLeased,
  reviewWorktreeLeasePath,
} from "../src/lib/utils/review-worktree-lease";
import { RepoManager } from "../src/lib/workspace/repo-manager";
import type { RepoConfig } from "../src/lib/workspace/config";

/** A pid no process can have (above the kernel's pid_max). */
const DEAD_PID = 2_147_483_646;
const BRANCHES = ["feature/a", "feature/b", "feature/c", "feature/d", "feature/e"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeLease(worktreePath: string, pid: number, heartbeatAt = Date.now()): void {
  const path = reviewWorktreeLeasePath(worktreePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, startedAt: heartbeatAt, heartbeatAt }));
}

function setMtime(path: string, ms: number): void {
  const at = new Date(ms);
  utimesSync(path, at, at);
}

describe("review worktree leases and parallel setup", () => {
  let testDir: string;
  let workspaceDir: string;
  let bare: string;
  let base: string;
  let originalWorktreeEnv: string | undefined;
  let originalCapEnv: string | undefined;
  const children: Array<{ kill: () => void }> = [];

  /** A live process other than this one, to hold leases. */
  function liveForeignPid(): number {
    const child = Bun.spawn(["sleep", "30"]);
    children.push(child);
    return child.pid;
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "review-lease-"));
    originalWorktreeEnv = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    originalCapEnv = process.env.DEVINTERN_MAX_CONCURRENCY_PER_REPO;
    process.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(testDir, "review-worktree");
    delete process.env.DEVINTERN_MAX_CONCURRENCY_PER_REPO;

    // origin (bare) with one branch per PR
    const origin = join(testDir, "origin.git");
    git(testDir, "init", "--bare", "--initial-branch=main", origin);
    const seed = join(testDir, "seed");
    git(testDir, "clone", origin, seed);
    git(seed, "config", "user.email", "t@t.dev");
    git(seed, "config", "user.name", "T");
    writeFileSync(join(seed, "README.md"), "# repo\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "init");
    git(seed, "push", "origin", "HEAD:main");
    for (const branch of BRANCHES) {
      git(seed, "checkout", "-b", branch, "main");
      writeFileSync(join(seed, `${branch.replace("/", "-")}.txt`), branch);
      git(seed, "add", ".");
      git(seed, "commit", "-m", branch);
      git(seed, "push", "origin", branch);
    }

    // The worker layout: <workspace>/repos/web.git + its base worktree.
    workspaceDir = join(testDir, "workspace");
    bare = join(workspaceDir, "repos", "web.git");
    mkdirSync(join(workspaceDir, "repos"), { recursive: true });
    git(testDir, "clone", "--bare", origin, bare);
    git(bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(bare, "fetch", "origin");
    base = join(workspaceDir, "worktrees", "web", "base");
    git(bare, "worktree", "add", "--detach", base, "origin/main");
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    if (originalWorktreeEnv === undefined) delete process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    else process.env.DEVINTERN_REVIEW_WORKTREE_PATH = originalWorktreeEnv;
    if (originalCapEnv === undefined) delete process.env.DEVINTERN_MAX_CONCURRENCY_PER_REPO;
    else process.env.DEVINTERN_MAX_CONCURRENCY_PER_REPO = originalCapEnv;
    rmSync(testDir, { recursive: true, force: true });
  });

  async function prepareIdle(branch: string): Promise<string> {
    const result = await Utils.prepareReviewWorktree(branch, {
      cwd: base,
      installDependencies: false,
    });
    expect(result.success).toBe(true);
    Utils.releaseReviewWorktree(result.path!);
    return result.path!;
  }

  function registered(path: string): boolean {
    return git(bare, "worktree", "list", "--porcelain").includes(`worktree ${path}\n`);
  }

  test("idle cap constants", () => {
    expect(REVIEW_WORKTREE_MIN_IDLE_CAP).toBe(2);
    expect(REVIEW_WORKTREE_IDLE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(reviewWorktreeIdleCap(1)).toBe(2);
    expect(reviewWorktreeIdleCap(5)).toBe(5);
    expect(reviewWorktreeIdleCap()).toBe(2);
    process.env.DEVINTERN_MAX_CONCURRENCY_PER_REPO = "4";
    expect(reviewWorktreeIdleCap()).toBe(4);
  });

  test("prepare writes a lease that release and removal clear", async () => {
    const result = await Utils.prepareReviewWorktree("feature/a", {
      cwd: base,
      installDependencies: false,
    });
    expect(result.success).toBe(true);
    const lease = JSON.parse(readFileSync(reviewWorktreeLeasePath(result.path!), "utf8"));
    expect(lease).toMatchObject({ pid: process.pid });
    expect(typeof lease.startedAt).toBe("number");
    expect(typeof lease.heartbeatAt).toBe("number");
    expect(isReviewWorktreeLeased(result.path!)).toBe(true);

    Utils.releaseReviewWorktree(result.path!);
    expect(existsSync(reviewWorktreeLeasePath(result.path!))).toBe(false);
    expect(existsSync(result.path!)).toBe(true);

    await Utils.prepareReviewWorktree("feature/a", { cwd: base, installDependencies: false });
    expect(existsSync(reviewWorktreeLeasePath(result.path!))).toBe(true);
    await Utils.removeReviewWorktree(result.path!, { cwd: base });
    expect(existsSync(result.path!)).toBe(false);
    expect(existsSync(reviewWorktreeLeasePath(result.path!))).toBe(false);
  });

  test("cleanup for branch B keeps worktree A while a live process leases it", async () => {
    const pathA = await prepareIdle("feature/a");
    writeLease(pathA, liveForeignPid());
    // Even an aggressive cap must not remove a leased worktree.
    process.env.DEVINTERN_MAX_CONCURRENCY_PER_REPO = "1";
    const pathB = Utils.getReviewWorktreePath("feature/b");
    await Utils.cleanupStaleReviewWorktrees(pathB, { cwd: base, idleCap: 0 });
    expect(existsSync(pathA)).toBe(true);
    expect(registered(pathA)).toBe(true);

    const result = await Utils.prepareReviewWorktree("feature/b", {
      cwd: base,
      installDependencies: false,
    });
    expect(result.success).toBe(true);
    expect(existsSync(pathA)).toBe(true);
    expect(registered(pathA)).toBe(true);
  });

  test("a lease whose pid is dead counts as idle", async () => {
    const pathA = await prepareIdle("feature/a");
    writeLease(pathA, DEAD_PID);
    expect(isReviewWorktreeLeased(pathA)).toBe(false);
    await Utils.cleanupStaleReviewWorktrees(Utils.getReviewWorktreePath("feature/b"), {
      cwd: base,
      idleCap: 0,
    });
    expect(existsSync(pathA)).toBe(false);
    expect(registered(pathA)).toBe(false);
    expect(existsSync(reviewWorktreeLeasePath(pathA))).toBe(false);
  });

  test("a second job cannot take a worktree another live process leases", async () => {
    const path = Utils.getReviewWorktreePath("feature/a");
    writeLease(path, liveForeignPid());
    const result = await Utils.prepareReviewWorktree("feature/a", {
      cwd: base,
      installDependencies: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("in use by another job");
  });

  test("idle worktrees are removed oldest-first down to the cap, never leased ones", async () => {
    // Room for all four while seeding them; the cleanup below passes its cap.
    process.env.DEVINTERN_MAX_CONCURRENCY_PER_REPO = "10";
    const now = Date.now();
    const [a, b, c, d] = [
      await prepareIdle("feature/a"),
      await prepareIdle("feature/b"),
      await prepareIdle("feature/c"),
      await prepareIdle("feature/d"),
    ];
    // a is the oldest but leased; b, c, d are idle, oldest first.
    setMtime(a!, now - 50_000);
    writeLease(a!, liveForeignPid());
    setMtime(b!, now - 40_000);
    setMtime(c!, now - 30_000);
    setMtime(d!, now - 20_000);

    await Utils.cleanupStaleReviewWorktrees(Utils.getReviewWorktreePath("feature/e"), {
      cwd: base,
      idleCap: 2,
      now,
    });
    expect(existsSync(a!)).toBe(true);
    expect(existsSync(b!)).toBe(false);
    expect(registered(b!)).toBe(false);
    expect(existsSync(c!)).toBe(true);
    expect(existsSync(d!)).toBe(true);
  });

  test("idle worktrees unused for over 24 h are removed even under the cap", async () => {
    const now = Date.now();
    const old = await prepareIdle("feature/a");
    const recent = await prepareIdle("feature/b");
    setMtime(old, now - REVIEW_WORKTREE_IDLE_MAX_AGE_MS - 60_000);
    await Utils.cleanupStaleReviewWorktrees(Utils.getReviewWorktreePath("feature/c"), {
      cwd: base,
      idleCap: 5,
      now,
    });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  test("the bare base review worktree path is never removed", async () => {
    const basePath = Utils.getReviewWorktreePath();
    mkdirSync(basePath, { recursive: true });
    setMtime(basePath, Date.now() - REVIEW_WORKTREE_IDLE_MAX_AGE_MS * 3);
    await Utils.cleanupStaleReviewWorktrees(Utils.getReviewWorktreePath("feature/a"), {
      cwd: base,
      idleCap: 0,
    });
    expect(existsSync(basePath)).toBe(true);
  });

  test("review and task worktree setup both wait for the repository's git metadata lock", async () => {
    const holder = join(testDir, "holder.ts");
    writeFileSync(
      holder,
      `import { withRepoGitLock } from ${JSON.stringify(join(import.meta.dir, "../src/lib/utils/repo-git-lock.ts"))};
await withRepoGitLock(process.argv[2]!, async () => {
  console.log("held");
  await Bun.sleep(600);
});
`,
    );
    const child = Bun.spawn(["bun", holder, bare], { stdout: "pipe", stderr: "inherit" });
    const { value } = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(value)).toContain("held");

    const reviewPath = Utils.getReviewWorktreePath("feature/a");
    const review = Utils.prepareReviewWorktree("feature/a", {
      cwd: base,
      installDependencies: false,
    });
    const repo = { name: "web", remote: join(testDir, "origin.git"), env: {} } as RepoConfig;
    const task = new RepoManager(workspaceDir).createTaskWorktree(repo, "TASK-9");
    await Bun.sleep(300);
    // Another process holds the lock: neither setup has touched web.git yet.
    expect(existsSync(reviewPath)).toBe(false);
    expect(git(bare, "worktree", "list")).not.toContain("task-9");

    expect(await child.exited).toBe(0);
    expect((await review).success).toBe(true);
    expect(existsSync(join(await task, "README.md"))).toBe(true);
  });

  test("five worktrees set up at once against one bare repo all succeed, without lock errors", async () => {
    const script = join(testDir, "pr-job.ts");
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { Utils } from ${JSON.stringify(join(import.meta.dir, "../src/lib/utils"))};
const [branch, cwd, out] = process.argv.slice(2) as [string, string, string];
const result = await Utils.prepareReviewWorktree(branch, { cwd });
if (!result.success || !result.path) {
  console.error(result.error);
  process.exit(1);
}
const startedAt = Date.now();
let present = true;
for (let i = 0; i < 8; i++) {
  await Bun.sleep(50);
  present &&= existsSync(join(result.path, "README.md"));
}
Utils.releaseReviewWorktree(result.path);
writeFileSync(out, JSON.stringify({ startedAt, finishedAt: Date.now(), present, path: result.path }));
`,
    );

    // Three PR jobs in CLI subprocesses plus two task worktrees from the
    // worker's RepoManager, all touching web.git at the same time.
    const prBranches = BRANCHES.slice(0, 3);
    const jobs = prBranches.map((branch, index) => {
      const child = Bun.spawn(["bun", script, branch, base, join(testDir, `job-${index}.json`)], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return Promise.all([child.exited, new Response(child.stderr).text()]);
    });
    const repoManager = new RepoManager(workspaceDir);
    const repo = { name: "web", remote: join(testDir, "origin.git"), env: {} } as RepoConfig;
    const tasks = [
      repoManager.createTaskWorktree(repo, "TASK-1"),
      repoManager.createTaskWorktree(repo, "TASK-2"),
    ];

    const results = await Promise.all(jobs);
    const taskPaths = await Promise.all(tasks);
    for (const [exitCode, stderr] of results) {
      expect(stderr).not.toContain("could not lock config file");
      expect(stderr).not.toContain("index.lock");
      expect(exitCode).toBe(0);
    }
    for (const path of taskPaths) expect(existsSync(join(path, "README.md"))).toBe(true);

    const runs = prBranches.map((_branch, index) =>
      JSON.parse(readFileSync(join(testDir, `job-${index}.json`), "utf8")),
    );
    for (const run of runs) expect(run.present).toBe(true);
    // The jobs' run intervals overlap: they ran at the same time.
    const latestStart = Math.max(...runs.map((run) => run.startedAt));
    const earliestFinish = Math.min(...runs.map((run) => run.finishedAt));
    expect(latestStart).toBeLessThan(earliestFinish);
    expect(existsSync(join(bare, "devintern-meta.lock"))).toBe(false);
  });
});
