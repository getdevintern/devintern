import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  REPO_GIT_LOCK_FILE,
  REPO_GIT_LOCK_STALE_MS,
  REPO_GIT_LOCK_TIMEOUT_MS,
  RepoGitLockTimeoutError,
  repoGitLockPath,
  withRepoGitLock,
} from "../src/lib/utils/repo-git-lock";

/** A pid no process can have (above the kernel's pid_max). */
const DEAD_PID = 2_147_483_646;

describe("withRepoGitLock", () => {
  let gitDir: string;

  beforeEach(() => {
    gitDir = mkdtempSync(join(tmpdir(), "repo-git-lock-"));
  });

  afterEach(() => {
    rmSync(gitDir, { recursive: true, force: true });
  });

  test("uses the documented constants", () => {
    expect(REPO_GIT_LOCK_FILE).toBe("devintern-meta.lock");
    expect(REPO_GIT_LOCK_STALE_MS).toBe(120_000);
    expect(REPO_GIT_LOCK_TIMEOUT_MS).toBe(60_000);
  });

  test("holds the lock file only while the section runs", async () => {
    const lockPath = repoGitLockPath(gitDir);
    const seen = await withRepoGitLock(gitDir, async () => existsSync(lockPath));
    expect(seen).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("releases the lock when the section throws", async () => {
    await expect(
      withRepoGitLock(gitDir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(repoGitLockPath(gitDir))).toBe(false);
  });

  test("serializes overlapping sections in one process", async () => {
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withRepoGitLock(gitDir, async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active--;
        }),
      ),
    );
    expect(peak).toBe(1);
  });

  test("takes over a lock left by a dead process", async () => {
    writeFileSync(
      repoGitLockPath(gitDir),
      JSON.stringify({ pid: DEAD_PID, acquiredAt: Date.now(), token: "crashed" }),
    );
    const started = Date.now();
    await withRepoGitLock(gitDir, async () => undefined, { timeoutMs: 2_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("takes over a lock older than the stale window even when its pid is alive", async () => {
    writeFileSync(
      repoGitLockPath(gitDir),
      JSON.stringify({
        pid: process.ppid,
        acquiredAt: Date.now() - REPO_GIT_LOCK_STALE_MS - 1_000,
        token: "old",
      }),
    );
    await withRepoGitLock(gitDir, async () => undefined, { timeoutMs: 2_000 });
  });

  test("takes over an unreadable lock file once it is old", async () => {
    const lockPath = repoGitLockPath(gitDir);
    writeFileSync(lockPath, "");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    await withRepoGitLock(gitDir, async () => undefined, { timeoutMs: 2_000 });
  });

  test("times out with an error naming the lock path while a live holder keeps it", async () => {
    const lockPath = repoGitLockPath(gitDir);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.ppid, acquiredAt: Date.now(), token: "live" }),
    );
    const error = await withRepoGitLock(gitDir, async () => "ran", { timeoutMs: 200 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RepoGitLockTimeoutError);
    expect((error as RepoGitLockTimeoutError).lockPath).toBe(lockPath);
    expect((error as Error).message).toContain(lockPath);
    // The foreign holder's lock is left alone.
    expect(existsSync(lockPath)).toBe(true);
  });

  test("waits for a live holder in another process and then acquires", async () => {
    const lockPath = repoGitLockPath(gitDir);
    const script = join(gitDir, "holder.ts");
    writeFileSync(
      script,
      `import { withRepoGitLock } from ${JSON.stringify(join(import.meta.dir, "../src/lib/utils/repo-git-lock.ts"))};
await withRepoGitLock(process.argv[2]!, async () => {
  console.log("held");
  await Bun.sleep(300);
});
`,
    );
    const child = Bun.spawn(["bun", script, gitDir], { stdout: "pipe", stderr: "inherit" });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");
    expect(existsSync(lockPath)).toBe(true);
    const started = Date.now();
    await withRepoGitLock(gitDir, async () => undefined, { timeoutMs: 5_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(await child.exited).toBe(0);
  });
});
