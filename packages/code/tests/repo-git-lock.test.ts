import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  REPO_GIT_LOCK_FILE,
  REPO_GIT_LOCK_STALE_MS,
  REPO_GIT_LOCK_TIMEOUT_MS,
  RepoGitLockTimeoutError,
  repoGitLockPath,
  takeOverStaleFile,
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
    expect(REPO_GIT_LOCK_TIMEOUT_MS).toBe(180_000);
    expect(REPO_GIT_LOCK_TIMEOUT_MS).toBeGreaterThan(REPO_GIT_LOCK_STALE_MS);
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
  test("a live holder's heartbeat keeps a slow section from being taken over", async () => {
    const script = join(gitDir, "slow-holder.ts");
    writeFileSync(
      script,
      `import { withRepoGitLock } from ${JSON.stringify(join(import.meta.dir, "../src/lib/utils/repo-git-lock.ts"))};
await withRepoGitLock(process.argv[2]!, async () => {
  console.log("held");
  await Bun.sleep(1500);
  console.log("out " + Date.now());
}, { staleMs: 500 });
`,
    );
    const child = Bun.spawn(["bun", script, gitDir], { stdout: "pipe", stderr: "inherit" });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");
    // Same short stale window as the holder: without a heartbeat the lock
    // (acquired > 500 ms ago) would be taken over while the holder is inside.
    let enteredAt = 0;
    await withRepoGitLock(
      gitDir,
      async () => {
        enteredAt = Date.now();
      },
      { staleMs: 500, timeoutMs: 10_000 },
    );
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    const outAt = Number(/out (\d+)/.exec(rest)?.[1]);
    expect(outAt).toBeGreaterThan(0);
    expect(enteredAt).toBeGreaterThanOrEqual(outAt);
    expect(await child.exited).toBe(0);
  });

  test("a late stale takeover never removes a fresh lock created after the stale one", () => {
    // Reviewer's interleaving: B judged the dead lock stale, A removed it and
    // created a fresh lock, then B's takeover runs (and C tries to create).
    const lockPath = repoGitLockPath(gitDir);
    const staleRaw = JSON.stringify({ pid: DEAD_PID, acquiredAt: 1, heartbeatAt: 1, token: "x" });
    writeFileSync(lockPath, staleRaw);
    takeOverStaleFile(lockPath, staleRaw); // A removes the stale lock
    expect(existsSync(lockPath)).toBe(false);
    const freshRaw = JSON.stringify({
      pid: process.ppid,
      acquiredAt: 2,
      heartbeatAt: 2,
      token: "a",
    });
    writeFileSync(lockPath, freshRaw); // A's fresh lock
    takeOverStaleFile(lockPath, staleRaw); // B, late
    // A's lock was never moved aside, so there was no window for C.
    expect(readFileSync(lockPath, "utf8")).toBe(freshRaw);
    expect(readdirSync(gitDir)).toEqual([REPO_GIT_LOCK_FILE]);
  });

  test("a takeover in progress elsewhere makes others wait instead of removing the lock", async () => {
    const lockPath = repoGitLockPath(gitDir);
    const staleRaw = JSON.stringify({ pid: DEAD_PID, acquiredAt: 1, heartbeatAt: 1, token: "x" });
    writeFileSync(lockPath, staleRaw);
    // A live contender (the parent process) holds the guard for this content.
    const { createHash } = await import("crypto");
    const digest = createHash("sha256").update(staleRaw).digest("hex").slice(0, 16);
    const guardPath = `${lockPath}.takeover-${digest}`;
    const guardRaw = JSON.stringify({
      pid: process.ppid,
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
      token: "g",
    });
    writeFileSync(guardPath, guardRaw);
    takeOverStaleFile(lockPath, staleRaw);
    expect(readFileSync(lockPath, "utf8")).toBe(staleRaw);
    expect(readFileSync(guardPath, "utf8")).toBe(guardRaw);
  });

  test("many processes taking over one dead lock: never two holders at once", async () => {
    const lockPath = repoGitLockPath(gitDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: DEAD_PID,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
        token: "dead",
      }),
    );
    const marker = join(gitDir, "inside");
    const script = join(gitDir, "contender.ts");
    writeFileSync(
      script,
      `import { appendFileSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { withRepoGitLock } from ${JSON.stringify(join(import.meta.dir, "../src/lib/utils/repo-git-lock.ts"))};
const [dir, marker, goAt] = process.argv.slice(2) as [string, string, string];
while (Date.now() < Number(goAt)) {}
for (let i = 0; i < 5; i++) {
  await withRepoGitLock(dir, async () => {
    if (existsSync(marker)) { console.log("OVERLAP"); process.exit(1); }
    writeFileSync(marker, String(process.pid));
    await Bun.sleep(5);
    unlinkSync(marker);
  }, { timeoutMs: 20_000 });
}
console.log("OK");
`,
    );
    const goAt = String(Date.now() + 1500);
    const children = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", script, gitDir, marker, goAt], { stdout: "pipe", stderr: "inherit" }),
    );
    const outputs = await Promise.all(children.map((child) => new Response(child.stdout).text()));
    for (const out of outputs) expect(out.trim()).toBe("OK");
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(gitDir).filter((name) => name.startsWith(REPO_GIT_LOCK_FILE))).toEqual([]);
  }, 30_000);

  test("a guard abandoned by a crashed contender does not block takeover forever", async () => {
    const lockPath = repoGitLockPath(gitDir);
    const staleRaw = JSON.stringify({ pid: DEAD_PID, acquiredAt: 1, heartbeatAt: 1, token: "x" });
    writeFileSync(lockPath, staleRaw);
    // First takeover crashes after creating its guard: simulate by writing
    // a guard owned by a dead pid next to the lock.
    const { createHash } = await import("crypto");
    const digest = createHash("sha256").update(staleRaw).digest("hex").slice(0, 16);
    writeFileSync(
      `${lockPath}.takeover-${digest}`,
      JSON.stringify({
        pid: DEAD_PID,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
        token: "g",
      }),
    );
    await withRepoGitLock(gitDir, async () => undefined, { timeoutMs: 2_000 });
    expect(readdirSync(gitDir)).toEqual([]);
  });
});
