import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { resolve, join } from "path";

/**
 * Liveness of a lock holder. `"unknown"` means the lock was taken in a
 * different PID namespace (e.g. one side runs inside a bubblewrap
 * `--unshare-pid` sandbox), so its pid cannot be probed from here, and its
 * heartbeat is still fresh: the owner may well be alive.
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
  /** Current time in epoch ms (heartbeat age). */
  now?: () => number;
}

/** How often a lock holder refreshes `heartbeatAt` in its lock file. */
export const LOCK_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * A foreign-namespace lock whose heartbeat is older than this is treated as
 * stale: the owner cannot be probed, but a live owner would have refreshed it.
 * This lets a restarted owner in a new PID namespace (container restart, fresh
 * `bwrap --unshare-pid`) reclaim its own lock after a crash.
 */
export const LOCK_HEARTBEAT_STALE_MS = 2 * 60_000;

/**
 * How old a foreign-namespace lock's heartbeat must be before `acquire()`
 * takes the lock over, for locks constructed with `reclaimForeign` (worker
 * locks only). Deliberately longer than {@link LOCK_HEARTBEAT_STALE_MS}:
 * reporting a worker as stopped too early only misleads a status line, but
 * reclaiming too early starts a second instance. The heartbeat runs on the
 * owner's event loop, so reclaim is only safe for owners that never block
 * synchronously for this long: the worker daemon, whose longest synchronous
 * child-process call (`readProcessStartTime`) is capped at 2 s. CLI task runs
 * call `execFileSync('git', ...)` without a timeout, so their locks never
 * opt in and stay `"unknown"` across namespaces until removed by hand.
 */
export const LOCK_HEARTBEAT_RECLAIM_MS = 5 * 60_000;

/** Lock files currently held by a LockManager in this process. */
const heldLockPaths = new Set<string>();

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
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reclaimForeign: boolean;

  /**
   * Create a process lock whose file sits directly in `lockDir`.
   *
   * @param lockDir - Directory holding the lock file; created if missing
   * @param lockFileName - Lock file name (e.g. `.worker.lock`)
   * @param options - `probes` overrides the OS liveness seams (tests);
   *                  `reclaimForeign` lets `acquire()` take over a
   *                  foreign-namespace lock whose heartbeat is older than
   *                  {@link LOCK_HEARTBEAT_RECLAIM_MS}. Only set it for
   *                  owners that never block their event loop that long
   *                  (the worker daemon); without it such locks are never
   *                  reclaimed automatically
   */
  constructor(
    lockDir: string,
    lockFileName: string,
    options: { probes?: LockProbes; reclaimForeign?: boolean } = {},
  ) {
    this.probes = options.probes ?? {};
    this.reclaimForeign = options.reclaimForeign ?? false;
    const dir = resolve(lockDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.lockFilePath = join(dir, lockFileName);
  }

  /**
   * Acquire this exclusive lock.
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

          // Check if the process is still running. A lock with our own pid in our
          // own namespace that no LockManager in this process holds was left by
          // an earlier process whose pid we reused, so it cannot be "another
          // instance".
          const reusedOwnPid =
            pid === process.pid &&
            ownerNamespace === LockManager.ownNamespace(this.probes) &&
            !heldLockPaths.has(this.lockFilePath);
          const liveness = reusedOwnPid
            ? false
            : LockManager.probeLiveness(
                pid,
                ownerNamespace,
                LockManager.heartbeatOf(lockData),
                this.probes,
                this.reclaimForeign ? LOCK_HEARTBEAT_RECLAIM_MS : null,
              );

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
            const reclaimNote = this.reclaimForeign
              ? `Its heartbeat is still recent; the lock is reclaimed automatically once the heartbeat is ` +
                `older than ${LOCK_HEARTBEAT_RECLAIM_MS / 60_000} minutes. `
              : "";
            return {
              success: false,
              message:
                `Another instance of devintern may be running in this directory (PID: ${pid}); ` +
                `it cannot be verified because the lock was taken in PID namespace ${ownerNamespace} ` +
                `and this process runs in ${ownNamespace} (e.g. inside a sandbox). ` +
                reclaimNote +
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
      const now = new Date(LockManager.now(this.probes)).toISOString();
      const lockData = {
        pid: process.pid,
        timestamp: now,
        heartbeatAt: now,
        workingDir: process.cwd(),
        ...(pidNamespace ? { pidNamespace } : {}),
      };

      writeFileSync(this.lockFilePath, JSON.stringify(lockData, null, 2), "utf8");
      this.lockAcquired = true;
      heldLockPaths.add(this.lockFilePath);
      this.startHeartbeat();

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

    this.stopHeartbeat();
    heldLockPaths.delete(this.lockFilePath);
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
   * Rewrite `heartbeatAt` in the held lock file so readers in another PID
   * namespace can tell a live owner from a dead one. A no-op when this
   * instance does not hold the lock or the file now belongs to someone else.
   */
  refreshHeartbeat(): void {
    if (!this.lockAcquired) return;
    try {
      const lockData = JSON.parse(readFileSync(this.lockFilePath, "utf8"));
      if (lockData.pid !== process.pid) return;
      lockData.heartbeatAt = new Date(LockManager.now(this.probes)).toISOString();
      // Write-then-rename so a concurrent reader never sees a truncated file.
      const tmpPath = `${this.lockFilePath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(lockData, null, 2), "utf8");
      renameSync(tmpPath, this.lockFilePath);
    } catch {
      // Best effort: a missed beat only matters after LOCK_HEARTBEAT_STALE_MS.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.refreshHeartbeat(), LOCK_HEARTBEAT_INTERVAL_MS);
    // Never keep the process alive just to refresh a lock.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * Read a lock file's status without acquiring or touching it.
   *
   * @param lockDir - Directory holding the lock file
   * @param lockFileName - Lock file name (e.g. `.worker.lock`)
   * @param options - `probes` overrides the OS liveness seams (tests)
   * @returns Lock status, or `null` when no lock file exists (or it is unreadable)
   */
  static readLockStatus(
    lockDir: string,
    lockFileName: string,
    options: { probes?: LockProbes } = {},
  ): LockStatus | null {
    const lockFilePath = join(resolve(lockDir), lockFileName);
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
        running: LockManager.probeLiveness(
          pid,
          pidNamespace,
          LockManager.heartbeatOf(lockData),
          options.probes ?? {},
        ),
        pid,
        ...(pidNamespace ? { pidNamespace } : {}),
        startedAt: typeof lockData.timestamp === "string" ? lockData.timestamp : undefined,
        path: lockFilePath,
      };
    } catch {
      return null;
    }
  }

  private static now(probes: LockProbes): number {
    return (probes.now ?? Date.now)();
  }

  /** Last heartbeat in epoch ms (falls back to the acquire timestamp), or `undefined`. */
  private static heartbeatOf(lockData: {
    heartbeatAt?: unknown;
    timestamp?: unknown;
  }): number | undefined {
    for (const value of [lockData.heartbeatAt, lockData.timestamp]) {
      if (typeof value !== "string") continue;
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) return ms;
    }
    return undefined;
  }

  private static ownNamespace(probes: LockProbes): string | undefined {
    return (probes.readPidNamespace ?? readOwnPidNamespace)();
  }

  /**
   * Check whether a lock owner is still running.
   *
   * When the lock records a PID namespace that differs from this process's own
   * (or this process's namespace is unreadable), the recorded pid means nothing
   * here: it may be invisible (`ESRCH`) or collide with an unrelated process
   * (sandboxed pids are small, so `kill(pid, 0)` usually succeeds). The pid is
   * therefore never probed, and the heartbeat alone decides: fresh means
   * `"unknown"`, older than `staleMs` means a live owner would have refreshed
   * it, so the lock is stale (`false`). Locks in the reader's own namespace, and
   * locks without a recorded namespace (legacy, or written off Linux), use the
   * plain signal-0 probe.
   *
   * @param pid - Process ID from the lock file
   * @param ownerNamespace - PID namespace recorded in the lock, if any
   * @param heartbeatMs - Last heartbeat (or acquire time) in epoch ms, if any
   * @param probes - OS seams (tests)
   * @param staleMs - Heartbeat age after which a foreign-namespace lock is
   *                  stale; `null` means never (always `"unknown"`)
   */
  static probeLiveness(
    pid: number,
    ownerNamespace: string | undefined,
    heartbeatMs: number | undefined,
    probes: LockProbes,
    staleMs: number | null = LOCK_HEARTBEAT_STALE_MS,
  ): PidLiveness {
    if (ownerNamespace !== undefined && ownerNamespace !== LockManager.ownNamespace(probes)) {
      if (staleMs === null) return "unknown";
      const heartbeatStale =
        heartbeatMs === undefined || LockManager.now(probes) - heartbeatMs > staleMs;
      return heartbeatStale ? false : "unknown";
    }
    const signalPid = probes.signalPid ?? ((target: number) => process.kill(target, 0));
    try {
      // Signal 0 checks existence without delivering a signal (Unix and Windows).
      signalPid(pid);
      return true;
    } catch (error) {
      // EPERM: the process exists but we may not signal it, so it is running.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /** @returns Absolute path to the lock file */
  getLockFilePath(): string {
    return this.lockFilePath;
  }
}
