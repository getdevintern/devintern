/**
 * Parallel PR jobs: review worktree leases, the idle-worktree cap, and
 * concurrent worktree setup against one shared bare repository.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
  acquireReviewWorktreeLease,
  isReviewWorktreeLeased,
  readReviewWorktreeLease,
  releaseReviewWorktreeLease,
  reviewWorktreeLeasePath,
} from "../src/lib/utils/review-worktree-lease";
import { repoGitLockPath } from "../src/lib/utils/repo-git-lock";
import {
  restoreWorktreeGitIdentity,
  setWorktreeGitIdentity,
} from "../src/lib/utils/worktree-setup";
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

  test("reusing a worktree runs no network git command under the repo git lock", async () => {
    const path = await prepareIdle("feature/a");

    // The PR branch moves on upstream between two jobs.
    const seed = join(testDir, "seed");
    git(seed, "checkout", "feature/a");
    writeFileSync(join(seed, "next.txt"), "next\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "next");
    git(seed, "push", "origin", "feature/a");
    const upstreamHead = git(seed, "rev-parse", "HEAD").trim();

    const lockPath = repoGitLockPath(bare);
    const network: string[] = [];
    const realExecute = Utils.executeGitCommand.bind(Utils);
    const spy = spyOn(Utils, "executeGitCommand").mockImplementation(async (args, options) => {
      if (["fetch", "pull", "push", "ls-remote"].includes(args[0]!)) {
        network.push(`${args[0]} lockHeld=${existsSync(lockPath)}`);
      }
      return realExecute(args, options);
    });
    try {
      const result = await Utils.prepareReviewWorktree("feature/a", {
        cwd: base,
        installDependencies: false,
      });
      expect(result).toMatchObject({ success: true, path });
    } finally {
      spy.mockRestore();
    }
    expect(network).toEqual(["fetch lockHeld=false"]);
    // The reused worktree still lands on the freshly fetched PR head.
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(upstreamHead);
    expect(existsSync(join(path, "next.txt"))).toBe(true);
  });

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
    const path = Utils.getReviewWorktreePath("feature/a", bare);
    writeLease(path, liveForeignPid());
    const result = await Utils.prepareReviewWorktree("feature/a", {
      cwd: base,
      installDependencies: false,
    });
    expect(result.success).toBe(false);
    expect(result.inUse).toBe(true);
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
      `import { existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { Utils } from ${JSON.stringify(join(import.meta.dir, "../src/lib/utils"))};
const [branch, cwd, out, barrierDir, jobCount] = process.argv.slice(2) as [string, string, string, string, string];
const result = await Utils.prepareReviewWorktree(branch, { cwd });
if (!result.success || !result.path) {
  console.error(result.error);
  process.exit(1);
}
const startedAt = Date.now();
// Hold the worktree until every job has prepared its own, so the holds
// overlap regardless of how slowly the serialized setup steps run.
writeFileSync(join(barrierDir, \`ready-\${branch.replaceAll("/", "_")}\`), "");
const readyCount = () => readdirSync(barrierDir).filter((name) => name.startsWith("ready-")).length;
const deadline = Date.now() + 20_000;
let present = existsSync(join(result.path, "README.md"));
while (readyCount() < Number(jobCount)) {
  if (Date.now() > deadline) {
    console.error("timed out waiting for the other jobs to prepare their worktrees");
    process.exit(1);
  }
  await Bun.sleep(25);
  present &&= existsSync(join(result.path, "README.md"));
}
// Keep holding briefly past the barrier, so every hold ends after the last one began.
await Bun.sleep(100);
present &&= existsSync(join(result.path, "README.md"));
Utils.releaseReviewWorktree(result.path);
writeFileSync(out, JSON.stringify({ startedAt, finishedAt: Date.now(), present, path: result.path }));
`,
    );

    // Three PR jobs in CLI subprocesses plus two task worktrees from the
    // worker's RepoManager, all touching web.git at the same time.
    const prBranches = BRANCHES.slice(0, 3);
    const barrierDir = join(testDir, "barrier");
    mkdirSync(barrierDir);
    const jobs = prBranches.map((branch, index) => {
      const outFile = join(testDir, `job-${index}.json`);
      const args = [script, branch, base, outFile, barrierDir, String(prBranches.length)];
      const child = Bun.spawn(["bun", ...args], {
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
  test("of several processes racing for one lease, exactly one acquires it", async () => {
    const path = Utils.getReviewWorktreePath("feature/shared");
    const script = join(testDir, "acquire.ts");
    writeFileSync(
      script,
      `import { acquireReviewWorktreeLease } from ${JSON.stringify(join(import.meta.dir, "../src/lib/utils/review-worktree-lease.ts"))};
const [path, goAt] = process.argv.slice(2) as [string, string];
while (Date.now() < Number(goAt)) {}
try {
  acquireReviewWorktreeLease(path);
  console.log("ACQUIRED " + process.pid);
  await Bun.sleep(1500);
} catch (error) {
  console.log("REFUSED " + (error as Error).message);
}
`,
    );
    const goAt = String(Date.now() + 1500);
    const children = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", script, path, goAt], { env: process.env, stdout: "pipe", stderr: "pipe" }),
    );
    const outputs = await Promise.all(children.map((child) => new Response(child.stdout).text()));
    const acquired = outputs.filter((out) => out.startsWith("ACQUIRED"));
    const refused = outputs.filter((out) => out.includes("in use by another job"));
    expect(acquired).toHaveLength(1);
    expect(refused).toHaveLength(children.length - 1);
  }, 20_000);

  test("a lease left by a dead process is taken over atomically", () => {
    const path = Utils.getReviewWorktreePath("feature/a");
    writeLease(path, DEAD_PID);
    acquireReviewWorktreeLease(path);
    expect(readReviewWorktreeLease(path)?.pid).toBe(process.pid);
    expect(isReviewWorktreeLeased(path)).toBe(true);
    releaseReviewWorktreeLease(path);
    expect(existsSync(reviewWorktreeLeasePath(path))).toBe(false);
  });

  test("the repository fetch does not wait for the git metadata lock", async () => {
    // A live process holds web.git's metadata lock (e.g. a long worktree add).
    writeFileSync(
      repoGitLockPath(bare),
      JSON.stringify({
        pid: liveForeignPid(),
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
        token: "foreign",
      }),
    );
    const repoManager = new RepoManager(workspaceDir);
    const started = Date.now();
    await repoManager.fetch("web", { timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(repoGitLockPath(bare))).toBe(true);
  });

  test("review worktree setup fetches before taking the metadata lock", async () => {
    // Push a new commit to feature/a; prepare must fetch it even though the
    // fetch is now outside the locked section.
    const seed = join(testDir, "seed");
    git(seed, "checkout", "feature/a");
    writeFileSync(join(seed, "new.txt"), "new");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "new");
    git(seed, "push", "origin", "feature/a");
    const head = git(seed, "rev-parse", "HEAD").trim();
    const result = await Utils.prepareReviewWorktree("feature/a", {
      cwd: base,
      installDependencies: false,
    });
    expect(result.success).toBe(true);
    expect(git(result.path!, "rev-parse", "HEAD").trim()).toBe(head);
    Utils.releaseReviewWorktree(result.path!);
  });

  test("gives each repository its own worktree for a shared branch name", async () => {
    // Repo "api" has its own feature/a, the same branch name as web's.
    const apiOrigin = join(testDir, "api-origin.git");
    git(testDir, "init", "--bare", "--initial-branch=main", apiOrigin);
    const apiSeed = join(testDir, "api-seed");
    git(testDir, "clone", apiOrigin, apiSeed);
    git(apiSeed, "config", "user.email", "t@t.dev");
    git(apiSeed, "config", "user.name", "T");
    writeFileSync(join(apiSeed, "API.md"), "# api\n");
    git(apiSeed, "add", ".");
    git(apiSeed, "commit", "-m", "init");
    git(apiSeed, "checkout", "-b", "feature/a");
    git(apiSeed, "push", "origin", "HEAD:main", "feature/a");
    const apiHead = git(apiSeed, "rev-parse", "HEAD").trim();
    const apiBare = join(workspaceDir, "repos", "api.git");
    git(testDir, "clone", "--bare", apiOrigin, apiBare);
    git(apiBare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(apiBare, "fetch", "origin");
    const apiBase = join(workspaceDir, "worktrees", "api", "base");
    git(apiBare, "worktree", "add", "--detach", apiBase, "origin/main");

    // web's job holds its feature/a worktree while api's job runs.
    const web = await Utils.prepareReviewWorktree("feature/a", {
      cwd: base,
      installDependencies: false,
    });
    expect(web.success).toBe(true);
    const webHead = git(bare, "rev-parse", "refs/heads/feature/a").trim();

    const api = await Utils.prepareReviewWorktree("feature/a", {
      cwd: apiBase,
      installDependencies: false,
    });
    expect(api.success).toBe(true);
    expect(api.path).not.toBe(web.path!);
    // api's checkout is api's commit and files.
    expect(git(api.path!, "rev-parse", "HEAD").trim()).toBe(apiHead);
    expect(existsSync(join(api.path!, "API.md"))).toBe(true);
    expect(existsSync(join(api.path!, "feature-a.txt"))).toBe(false);
    expect(git(api.path!, "rev-parse", "--git-common-dir").trim()).toBe(apiBare);
    // web's worktree and branch are untouched.
    expect(git(web.path!, "rev-parse", "--git-common-dir").trim()).toBe(bare);
    expect(existsSync(join(web.path!, "feature-a.txt"))).toBe(true);
    expect(git(bare, "rev-parse", "refs/heads/feature/a").trim()).toBe(webHead);
    expect(git(bare, "worktree", "list")).not.toContain(api.path!);
    Utils.releaseReviewWorktree(web.path!);
    Utils.releaseReviewWorktree(api.path!);
  });

  describe("bot git identity", () => {
    const bot = { name: "bot[bot]", email: "bot@users.noreply.github.com" };

    test("goes to the worktree scope and the restore unsets only that scope", async () => {
      const path = await prepareIdle("feature/a");
      git(bare, "config", "user.name", "Shared User");
      const restore = await setWorktreeGitIdentity(path, bot);
      expect(restore.scope).toBe("worktree");
      expect(git(path, "config", "user.name").trim()).toBe(bot.name);
      expect(git(bare, "config", "--local", "user.name").trim()).toBe("Shared User");
      await restoreWorktreeGitIdentity(path, restore);
      expect(git(path, "config", "user.name").trim()).toBe("Shared User");
    });

    test("falls back to the local config and puts the user's values back", async () => {
      const path = await prepareIdle("feature/a");
      git(path, "config", "--local", "user.name", "Real User");
      git(path, "config", "--local", "user.email", "real@example.com");
      const original = Utils.enableWorktreeConfig;
      Utils.enableWorktreeConfig = async () => ({ success: false, output: "", error: "denied" });
      let restore;
      try {
        restore = await setWorktreeGitIdentity(path, bot);
      } finally {
        Utils.enableWorktreeConfig = original;
      }
      expect(restore.scope).toBe("local");
      expect(git(path, "config", "--local", "user.name").trim()).toBe(bot.name);
      // The restore enables worktree config itself no longer; it uses the
      // scope the set call chose, so the shared values come back.
      await restoreWorktreeGitIdentity(path, restore);
      expect(git(path, "config", "--local", "user.name").trim()).toBe("Real User");
      expect(git(path, "config", "--local", "user.email").trim()).toBe("real@example.com");
    });
  });
});
