import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, unlinkSync } from "fs";
import { resolve, join } from "path";

/**
 * Liveness of a lock holder. `"unknown"` means the pid probe reported the
 * process missing, but the lock was taken in a different PID namespace (e.g.
 * the reader runs inside a bubblewrap `--unshare-pid` sandbox), so the owner
 * may well be alive and simply invisible to this process.
 */
export type PidLiveness = boolean | "unknown";

/**
 * OS seams for liveness checks; injected by tests so results do not depend on
 * the host platform.
 */
export interface LockProbes {
  /** Signal-0 probe; throws an errno error like `process.kill(pid, 0)`. */
  signalPid?: (pid: number) => void;
  /** This process's PID namespace id (e.g. `pid:[4026531836]`), or `undefined` when unreadable. */
  readPidNamespace?: () => string | undefined;
}

/**
 * Read the current process's Linux PID namespace id.
 *
 * @returns e.g. `pid:[4026531836]`, or `undefined` off Linux or when `/proc` is restricted
 */
export function readOwnPidNamespace(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const link = readlinkSync("/proc/self/ns/pid");
    return link.length > 0 ? link : undefined;
  } catch {
    return undefined;
  }
}

export interface LockStatus {
  /**
   * Whether the lock-holding process is still alive; `"unknown"` when it
   * cannot be verified from this PID namespace (see {@link PidLiveness}).
   */
  running: PidLiveness;
  pid?: number;
  /** PID namespace recorded by the lock owner (Linux only). */
  pidNamespace?: string;
  /** ISO timestamp the lock was taken. */
  startedAt?: string;
  /** Absolute path of the lock file the status was read from. */
  path?: string;
}

export class LockManager {
  private lockFilePath: string;
  private lockAcquired: boolean = false;
  private probes: LockProbes;

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
   *                  config dir already, not a project root); `probes`
   *                  overrides the OS liveness seams (tests)
   */
  constructor(
    workingDir: string = process.cwd(),
    lockFileName = ".pid.lock",
    options: { plainDir?: boolean; probes?: LockProbes } = {},
  ) {
    this.probes = options.probes ?? {};
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
          const ownerNamespace =
            typeof lockData.pidNamespace === "string" ? lockData.pidNamespace : undefined;

          // Check if the process is still running
          const liveness = LockManager.probeLiveness(pid, ownerNamespace, this.probes);

          if (liveness === true) {
            return {
              success: false,
              message: `Another instance of devintern is already running in this directory (PID: ${pid})`,
              pid,
            };
          }
          if (liveness === "unknown") {
            // The owner lives in another PID namespace, so "not found" proves
            // nothing; stealing the lock could start a second instance next to
            // a live one.
            const ownNamespace = LockManager.ownNamespace(this.probes) ?? "unreadable";
            return {
              success: false,
              message:
                `Another instance of devintern may be running in this directory (PID: ${pid}); ` +
                `it cannot be verified because the lock was taken in PID namespace ${ownerNamespace} ` +
                `and this process runs in ${ownNamespace} (e.g. inside a sandbox). ` +
                `Run outside the sandbox, or remove ${this.lockFilePath} once you have confirmed the process is gone.`,
              pid,
            };
          }

          // Process is not running anymore, remove stale lock file
          console.log(
            `⚠️  Found stale lock file from previous instance (PID: ${pid}, started: ${new Date(timestamp).toLocaleString()})`,
          );
          console.log("   Removing stale lock and continuing...");
          unlinkSync(this.lockFilePath);
        } catch {
          // If we can't read or parse the lock file, assume it's corrupted and remove it
          console.log("⚠️  Found corrupted lock file, removing and continuing...");
          unlinkSync(this.lockFilePath);
        }
      }

      // Create new lock file with current process PID
      const pidNamespace = LockManager.ownNamespace(this.probes);
      const lockData = {
        pid: process.pid,
        timestamp: new Date().toISOString(),
        workingDir: process.cwd(),
        ...(pidNamespace ? { pidNamespace } : {}),
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
   * @param options - `plainDir` reads the lock directly from `workingDir`
   *                  instead of nesting `.devintern-code/` (workspace locks
   *                  live in `~/.devintern/`, which is not a project root);
   *                  `probes` overrides the OS liveness seams (tests)
   * @returns Lock status, or `null` when no lock file exists (or it is unreadable)
   */
  static readLockStatus(
    workingDir: string = process.cwd(),
    lockFileName = ".pid.lock",
    options: { plainDir?: boolean; probes?: LockProbes } = {},
  ): LockStatus | null {
    const configDir = options.plainDir
      ? resolve(workingDir)
      : resolve(workingDir, ".devintern-code");
    const lockFilePath = join(configDir, lockFileName);
    if (!existsSync(lockFilePath)) {
      return null;
    }
    try {
      const lockData = JSON.parse(readFileSync(lockFilePath, "utf8"));
      const pid = lockData.pid;
      if (typeof pid !== "number") {
        return null;
      }
      const pidNamespace =
        typeof lockData.pidNamespace === "string" ? lockData.pidNamespace : undefined;
      return {
        running: LockManager.probeLiveness(pid, pidNamespace, options.probes ?? {}),
        pid,
        ...(pidNamespace ? { pidNamespace } : {}),
        startedAt: typeof lockData.timestamp === "string" ? lockData.timestamp : undefined,
        path: lockFilePath,
      };
    } catch {
      return null;
    }
  }

  private static ownNamespace(probes: LockProbes): string | undefined {
    return (probes.readPidNamespace ?? readOwnPidNamespace)();
  }

  /**
   * Check whether a lock owner is still running.
   *
   * `ESRCH` normally means the process is gone, but when the lock records a
   * PID namespace that differs from this process's own (or this process's
   * namespace is unreadable), the owner may simply be invisible here, so the
   * answer is `"unknown"`. Locks without a recorded namespace (legacy, or
   * written off Linux) keep the plain boolean behavior.
   *
   * @param pid - Process ID from the lock file
   * @param ownerNamespace - PID namespace recorded in the lock, if any
   * @param probes - OS seams (tests)
   */
  private static probeLiveness(
    pid: number,
    ownerNamespace: string | undefined,
    probes: LockProbes,
  ): PidLiveness {
    const signalPid = probes.signalPid ?? ((target: number) => process.kill(target, 0));
    try {
      // Signal 0 checks existence without delivering a signal (Unix and Windows).
      signalPid(pid);
      return true;
    } catch (error) {
      // EPERM: the process exists but we may not signal it, so it is running.
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return true;
      }
      if (ownerNamespace !== undefined && ownerNamespace !== LockManager.ownNamespace(probes)) {
        return "unknown";
      }
      return false;
    }
  }

  /** @returns Absolute path to the lock file */
  getLockFilePath(): string {
    return this.lockFilePath;
  }
}
