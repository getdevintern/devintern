import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve, join } from "path";

export interface LockStatus {
  /** Whether the lock-holding process is still alive. */
  running: boolean;
  pid?: number;
  /** ISO timestamp the lock was taken. */
  startedAt?: string;
}

export class LockManager {
  private lockFilePath: string;
  private lockAcquired: boolean = false;

  /**
   * Create a per-directory process lock under `.devintern-code/`.
   *
   * @param workingDir - Project root used to locate the lock file
   * @param lockFileName - Lock file name; the default guards CLI task runs,
   *                       while the worker daemon uses its own lock so an
   *                       idle daemon does not block manual runs
   * @param options - `plainDir` places the lock file directly in
   *                  `workingDir` instead of nesting `.devintern-code/`
   *                  (workspace locks live in `~/.devintern/`, which is a
   *                  config dir already, not a project root)
   */
  constructor(
    workingDir: string = process.cwd(),
    lockFileName = ".pid.lock",
    options: { plainDir?: boolean } = {},
  ) {
    // Create lock file in .devintern-code directory
    const configDir = options.plainDir
      ? resolve(workingDir)
      : resolve(workingDir, ".devintern-code");

    // Ensure .devintern-code directory exists
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    this.lockFilePath = join(configDir, lockFileName);
  }

  /**
   * Acquire an exclusive lock for the current directory.
   *
   * @returns Success flag, message, and conflicting PID when another instance runs
   */
  acquire(): { success: boolean; message: string; pid?: number } {
    try {
      // Check if lock file exists
      if (existsSync(this.lockFilePath)) {
        // Read existing lock file to get PID
        try {
          const lockContent = readFileSync(this.lockFilePath, "utf8");
          const lockData = JSON.parse(lockContent);
          const pid = lockData.pid;
          const timestamp = lockData.timestamp;

          // Check if the process is still running
          const isProcessRunning = LockManager.isPidRunning(pid);

          if (isProcessRunning) {
            return {
              success: false,
              message: `Another instance of devintern is already running in this directory (PID: ${pid})`,
              pid,
            };
          }

          // Process is not running anymore, remove stale lock file
          console.log(
            `⚠️  Found stale lock file from previous instance (PID: ${pid}, started: ${new Date(timestamp).toLocaleString()})`,
          );
          console.log("   Removing stale lock and continuing...");
          unlinkSync(this.lockFilePath);
        } catch (error) {
          // If we can't read or parse the lock file, assume it's corrupted and remove it
          console.log("⚠️  Found corrupted lock file, removing and continuing...");
          unlinkSync(this.lockFilePath);
        }
      }

      // Create new lock file with current process PID
      const lockData = {
        pid: process.pid,
        timestamp: new Date().toISOString(),
        workingDir: process.cwd(),
      };

      writeFileSync(this.lockFilePath, JSON.stringify(lockData, null, 2), "utf8");
      this.lockAcquired = true;

      return {
        success: true,
        message: "Lock acquired successfully",
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to acquire lock: ${(error as Error).message}`,
      };
    }
  }

  /** Release the lock file if this instance acquired it. */
  release(): void {
    if (!this.lockAcquired) {
      return;
    }

    try {
      if (existsSync(this.lockFilePath)) {
        unlinkSync(this.lockFilePath);
      }
      this.lockAcquired = false;
    } catch (error) {
      console.warn(`⚠️  Failed to release lock: ${(error as Error).message}`);
    }
  }

  /**
   * Read a lock file's status without acquiring or touching it.
   *
   * @param workingDir - Project root used to locate the lock file
   * @param lockFileName - Lock file name (e.g. `.worker.lock`)
   * @returns Lock status, or `null` when no lock file exists (or it is unreadable)
   */
  static readLockStatus(
    workingDir: string = process.cwd(),
    lockFileName = ".pid.lock",
  ): LockStatus | null {
    const lockFilePath = join(resolve(workingDir, ".devintern-code"), lockFileName);
    if (!existsSync(lockFilePath)) {
      return null;
    }
    try {
      const lockData = JSON.parse(readFileSync(lockFilePath, "utf8"));
      const pid = lockData.pid;
      if (typeof pid !== "number") {
        return null;
      }
      return {
        running: LockManager.isPidRunning(pid),
        pid,
        startedAt: typeof lockData.timestamp === "string" ? lockData.timestamp : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check whether a process ID is still running.
   *
   * @param pid - Process ID from the lock file
   */
  private static isPidRunning(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without actually sending a signal
      // This works cross-platform (Unix-like systems and Windows)
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // If we get ESRCH error, the process doesn't exist
      // If we get EPERM error, the process exists but we don't have permission to signal it
      // For our purposes, if we can't verify the process is running, we treat it as not running
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EPERM") {
        // Process exists but we don't have permission - treat as running
        return true;
      }
      return false;
    }
  }

  /** @returns Absolute path to the lock file */
  getLockFilePath(): string {
    return this.lockFilePath;
  }
}
