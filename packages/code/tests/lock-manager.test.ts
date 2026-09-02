/**
 * Test suite for LockManager
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
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
    } catch (e) {
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
