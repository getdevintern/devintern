/**
 * Test suite for LockManager
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LockManager } from "../src/lib/lock-manager";

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
    const lock1 = new LockManager(testDir);
    const result1 = lock1.acquire();

    expect(result1.success).toBe(true);

    // Try to acquire with second instance - should fail
    const lock2 = new LockManager(testDir);
    const result2 = lock2.acquire();

    expect(result2.success).toBe(false);
    expect(result2.pid).toBe(process.pid);

    // Release first lock
    lock1.release();

    // Verify lock file is removed
    expect(existsSync(lock1.getLockFilePath())).toBe(false);

    // Now third instance should be able to acquire
    const lock3 = new LockManager(testDir);
    const result3 = lock3.acquire();

    expect(result3.success).toBe(true);
    lock3.release();
  });

  test("should detect and remove stale locks", () => {
    // Create a lock and release it to ensure we start clean
    const cleanLock = new LockManager(testDir);
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
    const lock = new LockManager(testDir);
    const result = lock.acquire();

    expect(result.success).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("should store lock file in correct location", () => {
    const lock = new LockManager(testDir);
    const lockPath = lock.getLockFilePath();

    // Verify lock is in .devintern-code directory with correct filename
    expect(lockPath).toContain(".devintern-code");
    expect(lockPath).toEndWith(".pid.lock");

    // Verify .devintern-code directory is created and lock file is created
    const result = lock.acquire();
    expect(result.success).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    lock.release();
  });

  test("should handle multiple release calls gracefully (idempotence)", () => {
    const lock = new LockManager(testDir);
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
    const lock1 = new LockManager(testDir);
    const result1 = lock1.acquire();

    expect(result1.success).toBe(true);

    const lock2 = new LockManager(testDir);
    const result2 = lock2.acquire();

    expect(result2.success).toBe(false);
    expect(result2.message).toContain("already running");
    expect(result2.pid).toBeDefined();

    lock1.release();
  });

  test("should include process information in lock file", () => {
    const lock = new LockManager(testDir);
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
      const taskLock = new LockManager(dir);
      const workerLock = new LockManager(dir, ".worker.lock");

      expect(taskLock.acquire().success).toBe(true);
      // A second task lock is blocked, but the worker lock is independent.
      expect(new LockManager(dir).acquire().success).toBe(false);
      expect(workerLock.acquire().success).toBe(true);
      expect(existsSync(join(dir, ".devintern-code", ".worker.lock"))).toBe(true);

      taskLock.release();
      workerLock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LockManager.readLockStatus", () => {
  test("reads a nested project lock and reports liveness, pid, and path", () => {
    const dir = join(
      tmpdir(),
      `lock-status-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(dir, { recursive: true });
    try {
      const lock = new LockManager(dir, ".worker.lock");
      expect(lock.acquire().success).toBe(true);

      const status = LockManager.readLockStatus(dir, ".worker.lock");
      expect(status?.running).toBe(true);
      expect(status?.pid).toBe(process.pid);
      expect(status?.path).toBe(join(dir, ".devintern-code", ".worker.lock"));

      lock.release();
      expect(LockManager.readLockStatus(dir, ".worker.lock")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plainDir reads workspace locks that sit directly in the directory", () => {
    const dir = join(
      tmpdir(),
      `lock-status-plain-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(dir, { recursive: true });
    try {
      const workspaceLock = new LockManager(dir, ".worker.lock", { plainDir: true });
      expect(workspaceLock.acquire().success).toBe(true);
      expect(existsSync(join(dir, ".worker.lock"))).toBe(true);

      // Nested lookup misses the plain lock; plainDir finds it.
      expect(LockManager.readLockStatus(dir, ".worker.lock")).toBeNull();
      const status = LockManager.readLockStatus(dir, ".worker.lock", { plainDir: true });
      expect(status?.running).toBe(true);
      expect(status?.pid).toBe(process.pid);
      expect(status?.path).toBe(join(dir, ".worker.lock"));

      workspaceLock.release();
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
      plainDir: true,
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

  test("EPERM reports running regardless of namespace", () => {
    writeLock({ pidNamespace: FOREIGN_NS });
    expect(status({ signalPid: errno("EPERM"), ns: OWN_NS })?.running).toBe(true);
  });

  test("a successful probe reports running", () => {
    writeLock({ pidNamespace: FOREIGN_NS });
    expect(status({ signalPid: () => {}, ns: OWN_NS })?.running).toBe(true);
  });

  test("acquire records the owner's namespace, and omits it when unreadable", () => {
    const withNs = new LockManager(testDir, ".a.lock", {
      plainDir: true,
      probes: { readPidNamespace: () => OWN_NS },
    });
    expect(withNs.acquire().success).toBe(true);
    expect(JSON.parse(readFileSync(withNs.getLockFilePath(), "utf8")).pidNamespace).toBe(OWN_NS);
    withNs.release();

    const withoutNs = new LockManager(testDir, ".b.lock", {
      plainDir: true,
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
      plainDir: true,
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

  test("acquire still steals a truly stale same-namespace lock", () => {
    const lockPath = writeLock({ pidNamespace: OWN_NS });
    const lock = new LockManager(testDir, ".worker.lock", {
      plainDir: true,
      probes: { signalPid: errno("ESRCH"), readPidNamespace: () => OWN_NS },
    });
    expect(lock.acquire().success).toBe(true);
    const written = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(written.pid).toBe(process.pid);
    expect(written.pidNamespace).toBe(OWN_NS);
    lock.release();
  });
});
