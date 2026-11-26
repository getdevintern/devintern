/**
 * Test suite for LockManager
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  LOCK_HEARTBEAT_RECLAIM_MS,
  LOCK_HEARTBEAT_STALE_MS,
  LockManager,
} from "../src/lib/lock-manager";

describe("LockManager", () => {
  let testDir: string;

  beforeEach(() => {
    // Create unique test directory for each test to enable parallel execution
    testDir = join(
      tmpdir(),
      `lock-manager-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory and any lock files
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  test("should acquire and release lock successfully", () => {
    const lock1 = new LockManager(testDir, ".pid.lock");
    const result1 = lock1.acquire();

    expect(result1.success).toBe(true);

    // Try to acquire with second instance - should fail
    const lock2 = new LockManager(testDir, ".pid.lock");
    const result2 = lock2.acquire();

    expect(result2.success).toBe(false);
    expect(result2.pid).toBe(process.pid);

    // Release first lock
    lock1.release();

    // Verify lock file is removed
    expect(existsSync(lock1.getLockFilePath())).toBe(false);

    // Now third instance should be able to acquire
    const lock3 = new LockManager(testDir, ".pid.lock");
    const result3 = lock3.acquire();

    expect(result3.success).toBe(true);
    lock3.release();
  });

  test("should detect and remove stale locks", () => {
    // Create a lock and release it to ensure we start clean
    const cleanLock = new LockManager(testDir, ".pid.lock");
    const cleanResult = cleanLock.acquire();
    if (cleanResult.success) {
      cleanLock.release();
    }

    // Manually create a stale lock file with non-existent PID
    const staleLockData = {
      pid: 999999, // Non-existent PID
      timestamp: new Date().toISOString(),
      workingDir: testDir,
    };

    const lockPath = cleanLock.getLockFilePath();
    writeFileSync(lockPath, JSON.stringify(staleLockData, null, 2), "utf8");

    // Try to acquire lock - should detect stale lock and proceed
    const lock = new LockManager(testDir, ".pid.lock");
    const result = lock.acquire();

    expect(result.success).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("should store lock file in correct location", () => {
    const lockDir = join(testDir, "locks", "nested");
    const lock = new LockManager(lockDir, ".pid.lock");
    const lockPath = lock.getLockFilePath();

    // The lock file sits directly in the given directory, which is created.
    expect(lockPath).toBe(join(lockDir, ".pid.lock"));
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(join(testDir, ".devintern-code"))).toBe(false);
    expect(existsSync(join(lockDir, ".devintern-code"))).toBe(false);

    const result = lock.acquire();
    expect(result.success).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    lock.release();
  });

  test("should handle multiple release calls gracefully (idempotence)", () => {
    const lock = new LockManager(testDir, ".pid.lock");
    const result = lock.acquire();

    expect(result.success).toBe(true);

    // Release multiple times - should not cause errors
    expect(() => {
      lock.release();
      lock.release();
      lock.release();
    }).not.toThrow();
  });

  test("should prevent multiple instances from acquiring lock", () => {
    const lock1 = new LockManager(testDir, ".pid.lock");
    const result1 = lock1.acquire();

    expect(result1.success).toBe(true);

    const lock2 = new LockManager(testDir, ".pid.lock");
    const result2 = lock2.acquire();

    expect(result2.success).toBe(false);
    expect(result2.message).toContain("already running");
    expect(result2.pid).toBeDefined();

    lock1.release();
  });

  test("should include process information in lock file", () => {
    const lock = new LockManager(testDir, ".pid.lock");
    const result = lock.acquire();

    expect(result.success).toBe(true);

    const lockPath = lock.getLockFilePath();
    const lockContent = readFileSync(lockPath, "utf8");
    const lockData = JSON.parse(lockContent);

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.timestamp).toBeDefined();
    expect(lockData.workingDir).toBe(process.cwd());

    lock.release();
  });
});

describe("LockManager custom lock file", () => {
  test("worker lock does not conflict with the CLI task lock", () => {
    const dir = join(
      tmpdir(),
      `lock-manager-custom-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(dir, { recursive: true });
    try {
      const taskLock = new LockManager(dir, ".pid.lock");
      const workerLock = new LockManager(dir, ".worker.lock");

      expect(taskLock.acquire().success).toBe(true);
      // A second task lock is blocked, but the worker lock is independent.
      expect(new LockManager(dir, ".pid.lock").acquire().success).toBe(false);
      expect(workerLock.acquire().success).toBe(true);
      expect(existsSync(join(dir, ".worker.lock"))).toBe(true);

      taskLock.release();
      workerLock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LockManager.readLockStatus", () => {
  test("reads a lock in the given directory and reports liveness, pid, and path", () => {
    const dir = join(
      tmpdir(),
      `lock-status-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(dir, { recursive: true });
    try {
      const lock = new LockManager(dir, ".worker.lock");
      expect(lock.acquire().success).toBe(true);
      expect(existsSync(join(dir, ".worker.lock"))).toBe(true);

      const status = LockManager.readLockStatus(dir, ".worker.lock");
      expect(status?.running).toBe(true);
      expect(status?.pid).toBe(process.pid);
      expect(status?.path).toBe(join(dir, ".worker.lock"));

      lock.release();
      expect(LockManager.readLockStatus(dir, ".worker.lock")).toBeNull();
      expect(existsSync(join(dir, ".devintern-code"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LockManager PID-namespace liveness", () => {
  let testDir: string;
  const OWN_NS = "pid:[4026531836]";
  const FOREIGN_NS = "pid:[4026533128]";
  const DEAD_PID = 424242;

  const errno = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };

  function writeLock(fields: Record<string, unknown>): string {
    const lockPath = join(testDir, ".worker.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, timestamp: new Date().toISOString(), ...fields }),
    );
    return lockPath;
  }

  function status(probes: { signalPid: (pid: number) => void; ns?: string }) {
    return LockManager.readLockStatus(testDir, ".worker.lock", {
      probes: { signalPid: probes.signalPid, readPidNamespace: () => probes.ns },
    });
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "lock-manager-ns-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("same namespace + ESRCH reports stopped", () => {
    writeLock({ pidNamespace: OWN_NS });
    const lock = status({ signalPid: errno("ESRCH"), ns: OWN_NS });
    expect(lock?.running).toBe(false);
    expect(lock?.pidNamespace).toBe(OWN_NS);
  });

  test("different namespace + ESRCH reports unknown", () => {
    writeLock({ pidNamespace: FOREIGN_NS });
    expect(status({ signalPid: errno("ESRCH"), ns: OWN_NS })?.running).toBe("unknown");
  });

  test("a recorded namespace the reader cannot compare reports unknown", () => {
    writeLock({ pidNamespace: FOREIGN_NS });
    expect(status({ signalPid: errno("ESRCH"), ns: undefined })?.running).toBe("unknown");
  });

  test("legacy lock without a namespace + ESRCH reports stopped", () => {
    writeLock({});
    expect(status({ signalPid: errno("ESRCH"), ns: OWN_NS })?.running).toBe(false);
  });

  test("EPERM reports running in the reader's own namespace", () => {
    writeLock({ pidNamespace: OWN_NS });
    expect(status({ signalPid: errno("EPERM"), ns: OWN_NS })?.running).toBe(true);
  });

  test("a successful probe reports running in the reader's own namespace", () => {
    writeLock({ pidNamespace: OWN_NS });
    expect(status({ signalPid: () => {}, ns: OWN_NS })?.running).toBe(true);
  });

  test("a foreign-namespace pid is never probed: a colliding live pid stays unknown while fresh", () => {
    writeLock({ pidNamespace: FOREIGN_NS });
    let probed = 0;
    const collide = () => {
      probed += 1;
    };
    expect(status({ signalPid: collide, ns: OWN_NS })?.running).toBe("unknown");
    expect(status({ signalPid: errno("EPERM"), ns: OWN_NS })?.running).toBe("unknown");
    expect(probed).toBe(0);
  });

  for (const [label, signalPid] of [
    ["succeeds", () => {}],
    ["throws EPERM", errno("EPERM")],
  ] as const) {
    test(`a dead sandboxed owner whose pid collides (probe ${label}) is stopped and reclaimable`, () => {
      const old = new Date(Date.now() - 60 * 60_000).toISOString();
      const lockPath = writeLock({
        pid: 2,
        pidNamespace: FOREIGN_NS,
        timestamp: old,
        heartbeatAt: old,
      });
      expect(status({ signalPid, ns: OWN_NS })?.running).toBe(false);
      const lock = new LockManager(testDir, ".worker.lock", {
        reclaimForeign: true,
        probes: { signalPid, readPidNamespace: () => OWN_NS },
      });
      expect(lock.acquire().success).toBe(true);
      expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
      lock.release();
    });
  }

  test("a crashed lock carrying our own pid from an old namespace is reclaimed", () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    writeLock({ pid: process.pid, pidNamespace: FOREIGN_NS, timestamp: old, heartbeatAt: old });
    const lock = new LockManager(testDir, ".worker.lock", {
      reclaimForeign: true,
      probes: { readPidNamespace: () => OWN_NS },
    });
    expect(lock.acquire().success).toBe(true);
    lock.release();
  });

  test("a same-namespace lock with our pid that this process does not hold is reclaimed", () => {
    writeLock({ pid: process.pid, pidNamespace: OWN_NS });
    const lock = new LockManager(testDir, ".worker.lock", {
      probes: { readPidNamespace: () => OWN_NS },
    });
    expect(lock.acquire().success).toBe(true);
    // ...but a second in-process acquire of a held lock is still refused.
    const again = new LockManager(testDir, ".worker.lock", {
      probes: { readPidNamespace: () => OWN_NS },
    });
    expect(again.acquire().success).toBe(false);
    lock.release();
  });

  test("acquire waits for the longer reclaim window, though status already reports stopped", () => {
    const between = new Date(
      Date.now() - (LOCK_HEARTBEAT_STALE_MS + LOCK_HEARTBEAT_RECLAIM_MS) / 2,
    ).toISOString();
    const lockPath = writeLock({
      pidNamespace: FOREIGN_NS,
      timestamp: between,
      heartbeatAt: between,
    });
    expect(status({ signalPid: errno("ESRCH"), ns: OWN_NS })?.running).toBe(false);
    const lock = new LockManager(testDir, ".worker.lock", {
      reclaimForeign: true,
      probes: { signalPid: errno("ESRCH"), readPidNamespace: () => OWN_NS },
    });
    const result = lock.acquire();
    expect(result.success).toBe(false);
    expect(result.message).toContain(`${LOCK_HEARTBEAT_RECLAIM_MS / 60_000} minutes`);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(DEAD_PID);
  });

  test("acquire records the owner's namespace, and omits it when unreadable", () => {
    const withNs = new LockManager(testDir, ".a.lock", {
      probes: { readPidNamespace: () => OWN_NS },
    });
    expect(withNs.acquire().success).toBe(true);
    expect(JSON.parse(readFileSync(withNs.getLockFilePath(), "utf8")).pidNamespace).toBe(OWN_NS);
    withNs.release();

    const withoutNs = new LockManager(testDir, ".b.lock", {
      probes: { readPidNamespace: () => undefined },
    });
    expect(withoutNs.acquire().success).toBe(true);
    expect(JSON.parse(readFileSync(withoutNs.getLockFilePath(), "utf8"))).not.toHaveProperty(
      "pidNamespace",
    );
    withoutNs.release();
  });

  test("acquire refuses to steal a lock it cannot verify", () => {
    const lockPath = writeLock({ pidNamespace: FOREIGN_NS });
    const lock = new LockManager(testDir, ".worker.lock", {
      probes: { signalPid: errno("ESRCH"), readPidNamespace: () => OWN_NS },
    });
    const result = lock.acquire();
    expect(result.success).toBe(false);
    expect(result.pid).toBe(DEAD_PID);
    expect(result.message).toContain(`PID: ${DEAD_PID}`);
    expect(result.message).toContain(FOREIGN_NS);
    expect(result.message).toContain(OWN_NS);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(DEAD_PID);
  });

  test("a foreign-namespace lock with a stale heartbeat reports stopped", () => {
    const old = new Date(Date.now() - LOCK_HEARTBEAT_STALE_MS - 1_000).toISOString();
    writeLock({ pidNamespace: FOREIGN_NS, timestamp: old, heartbeatAt: old });
    expect(status({ signalPid: errno("ESRCH"), ns: OWN_NS })?.running).toBe(false);
  });

  test("a fresh heartbeat keeps an old acquire timestamp unknown", () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    writeLock({
      pidNamespace: FOREIGN_NS,
      timestamp: old,
      heartbeatAt: new Date().toISOString(),
    });
    expect(status({ signalPid: errno("ESRCH"), ns: OWN_NS })?.running).toBe("unknown");
  });

  test("a restarted owner in a new namespace reclaims its crashed lock once the heartbeat is stale", () => {
    // Crashed worker from the previous container's namespace; last beat long ago.
    const old = new Date(Date.now() - LOCK_HEARTBEAT_RECLAIM_MS - 1_000).toISOString();
    const lockPath = writeLock({ pidNamespace: FOREIGN_NS, timestamp: old, heartbeatAt: old });
    const lock = new LockManager(testDir, ".worker.lock", {
      reclaimForeign: true,
      probes: { signalPid: errno("ESRCH"), readPidNamespace: () => OWN_NS },
    });
    expect(lock.acquire().success).toBe(true);
    const written = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(written.pid).toBe(process.pid);
    expect(written.pidNamespace).toBe(OWN_NS);
    expect(typeof written.heartbeatAt).toBe("string");
    lock.release();
  });

  test("a task lock (no reclaimForeign) never reclaims a foreign-namespace lock, however old", () => {
    const ancient = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const lockPath = writeLock({
      pidNamespace: FOREIGN_NS,
      timestamp: ancient,
      heartbeatAt: ancient,
    });
    const lock = new LockManager(testDir, ".worker.lock", {
      probes: { signalPid: errno("ESRCH"), readPidNamespace: () => OWN_NS },
    });
    const result = lock.acquire();
    expect(result.success).toBe(false);
    expect(result.message).not.toContain("reclaimed automatically");
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(DEAD_PID);
    // Without any heartbeat or timestamp it still refuses.
    writeLock({ pidNamespace: FOREIGN_NS, timestamp: undefined });
    expect(lock.acquire().success).toBe(false);
  });

  test("the default CLI task lock does not opt into reclaim; worker locks do", async () => {
    const { createWorkspaceLock, createRepoRunLock } = await import("../src/lib/workspace/state");
    const ancient = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const foreign = JSON.stringify({
      pid: DEAD_PID,
      pidNamespace: FOREIGN_NS,
      timestamp: ancient,
      heartbeatAt: ancient,
    });
    const taskLock = new LockManager(testDir, ".pid.lock");
    writeFileSync(taskLock.getLockFilePath(), foreign);
    const runLock = createRepoRunLock("repo", testDir);
    writeFileSync(runLock.getLockFilePath(), foreign);
    const workspaceLock = createWorkspaceLock(testDir);
    writeFileSync(workspaceLock.getLockFilePath(), foreign);
    const ns = (await import("../src/lib/lock-manager")).readOwnPidNamespace();
    if (ns === undefined || ns === FOREIGN_NS) return; // needs a readable, different namespace
    expect(taskLock.acquire().success).toBe(false);
    expect(runLock.acquire().success).toBe(false);
    expect(workspaceLock.acquire().success).toBe(true);
    workspaceLock.release();
  });

  test("refreshHeartbeat advances heartbeatAt and keeps a foreign reader at unknown", () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const owner = new LockManager(testDir, ".worker.lock", {
      probes: { readPidNamespace: () => FOREIGN_NS, now: () => clock },
    });
    expect(owner.acquire().success).toBe(true);
    const reader = (now: number) =>
      LockManager.readLockStatus(testDir, ".worker.lock", {
        probes: { signalPid: errno("ESRCH"), readPidNamespace: () => OWN_NS, now: () => now },
      })?.running;

    clock += LOCK_HEARTBEAT_STALE_MS + 1_000;
    // Without a refresh, the reader would consider the owner dead...
    expect(reader(clock)).toBe(false);
    owner.refreshHeartbeat();
    // ...but a refreshed heartbeat keeps it unverifiable-but-alive.
    expect(reader(clock)).toBe("unknown");
    expect(JSON.parse(readFileSync(owner.getLockFilePath(), "utf8")).heartbeatAt).toBe(
      new Date(clock).toISOString(),
    );
    owner.release();
    expect(existsSync(owner.getLockFilePath())).toBe(false);
  });

  test("refreshHeartbeat never rewrites a lock now owned by another pid", () => {
    const owner = new LockManager(testDir, ".worker.lock");
    expect(owner.acquire().success).toBe(true);
    const lockPath = owner.getLockFilePath();
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, timestamp: "x", heartbeatAt: "x" }));
    owner.refreshHeartbeat();
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({
      pid: DEAD_PID,
      timestamp: "x",
      heartbeatAt: "x",
    });
  });

  test("acquire still steals a truly stale same-namespace lock", () => {
    const lockPath = writeLock({ pidNamespace: OWN_NS });
    const lock = new LockManager(testDir, ".worker.lock", {
      probes: { signalPid: errno("ESRCH"), readPidNamespace: () => OWN_NS },
    });
    expect(lock.acquire().success).toBe(true);
    const written = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(written.pid).toBe(process.pid);
    expect(written.pidNamespace).toBe(OWN_NS);
    lock.release();
  });
});
