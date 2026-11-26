/**
 * Filesystem helpers for `worker init --non-interactive`: one-line error
 * messages, atomic writes, and the exclusive workspace write lock.
 */

import {
  chmodSync,
  linkSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { condenseMessage } from "@devintern/task-trackers";

import { isProcessAlive } from "../utils/repo-git-lock";

export { condenseMessage };

/** Lock file guarding concurrent writes to one workspace. */
export const WORKER_INIT_LOCK_FILE = ".worker-init.lock";

/** Error message without a stack trace, on one bounded line. */
export function errorMessage(error: unknown): string {
  return condenseMessage(error instanceof Error ? error.message : String(error));
}

/**
 * Write `content` to `path` via a sibling temp file and rename (atomic on POSIX).
 *
 * The rename replaces the inode, so without an explicit `mode` the existing
 * file's permission bits are carried over (a 0600 workspace.toml holding
 * `[repos.env]` secrets must stay 0600). The mode is applied with `chmod`
 * because `writeFileSync`'s `mode` is masked by the umask.
 */
export function writeFileAtomic(path: string, content: string, mode?: number): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let targetMode = mode;
  if (targetMode === undefined) {
    try {
      targetMode = statSync(path).mode & 0o777;
    } catch {
      // New file: the umask default applies.
    }
  }
  try {
    writeFileSync(temp, content, targetMode === undefined ? undefined : { mode: targetMode });
    if (targetMode !== undefined) chmodSync(temp, targetMode);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Temp file was never created or is already gone.
    }
    throw error;
  }
}

/** An unparseable lock younger than this may still be mid-write by its owner. */
const PARTIAL_LOCK_GRACE_MS = 10_000;

function readLockFile(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
}

function lockHolderPid(raw: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "pid" in parsed) {
      return typeof parsed.pid === "number" ? parsed.pid : undefined;
    }
  } catch {
    // Unparseable: empty while its owner writes it, or corrupt.
  }
  return undefined;
}

/**
 * Remove a stale lock only if it still holds `staleContent`. The lock is
 * renamed to a unique tombstone first, so two runs taking over the same
 * stale lock cannot both delete it: the loser either finds nothing to rename
 * or renames the winner's fresh lock, sees different content, and puts it
 * back with `link` (which never overwrites).
 *
 * @returns Whether the stale lock was removed
 */
export function removeStaleLock(lockPath: string, staleContent: string): boolean {
  const tombstone = `${lockPath}.${process.pid}.${Date.now()}.stale`;
  try {
    renameSync(lockPath, tombstone);
  } catch {
    return false; // Another run took it over first.
  }
  if (readLockFile(tombstone) === staleContent) {
    try {
      unlinkSync(tombstone);
    } catch {
      // Best effort; the tombstone is not the lock.
    }
    return true;
  }
  // We moved a live lock aside: restore it unless a new one already exists.
  try {
    linkSync(tombstone, lockPath);
  } catch {
    // A third run created a lock meanwhile; it holds the lock now.
  }
  try {
    unlinkSync(tombstone);
  } catch {
    // Best effort.
  }
  return false;
}

/**
 * Take the workspace write lock without waiting. A lock left by a dead
 * process is taken over once.
 *
 * @returns A release function, or an error message when another run holds it
 */
export function acquireWorkspaceInitLock(
  workspaceDir: string,
): { ok: true; release: () => void } | { ok: false; error: string } {
  const lockPath = join(workspaceDir, WORKER_INIT_LOCK_FILE);
  const busy = (detail: string) => ({
    ok: false as const,
    error:
      `The workspace is being modified by another \`devintern worker init\`${detail}. ` +
      `Wait for it to finish, then re-run. Lock: ${lockPath}`,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    try {
      writeFileSync(lockPath, content, { flag: "wx", mode: 0o600 });
      return {
        ok: true,
        // Only remove the lock while it is still ours.
        release: () => {
          if (readLockFile(lockPath) !== content) return;
          try {
            unlinkSync(lockPath);
          } catch {
            // Already removed.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, error: `Cannot create ${lockPath}: ${errorMessage(error)}` };
      }
      const raw = readLockFile(lockPath);
      if (raw === undefined) continue; // Released meanwhile; retry the create.
      const holder = lockHolderPid(raw);
      if (holder !== undefined && isProcessAlive(holder)) return busy(` (pid ${holder})`);
      if (holder === undefined) {
        let ageMs = Infinity;
        try {
          ageMs = Date.now() - statSync(lockPath).mtimeMs;
        } catch {
          // Gone; the retry below creates it.
        }
        if (ageMs < PARTIAL_LOCK_GRACE_MS) return busy("");
      }
      removeStaleLock(lockPath, raw);
    }
  }
  return {
    ok: false,
    error: `The workspace is being modified by another process (lock ${lockPath}); re-run.`,
  };
}
