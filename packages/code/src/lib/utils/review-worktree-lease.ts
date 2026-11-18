/**
 * Lease files that mark a branch-scoped review worktree as in use.
 *
 * PR jobs run as CLI subprocesses, several at a time, and each prepares its
 * own `/tmp/devintern-review-worktree-<branch>` checkout. Any of them may run
 * the stale-worktree cleanup, so an in-memory "in use" flag is not enough:
 * the lease is a file other processes can read. It records the holder's pid
 * and a heartbeat the holder refreshes while it runs.
 *
 * Leases live in a sibling `<base>.leases/` directory (one JSON file per
 * worktree directory name), outside every worktree and outside the
 * `<base>-*` names the cleanup scans.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import { isProcessAlive } from "./repo-git-lock";

/** How often a held lease's heartbeat is refreshed. */
export const REVIEW_WORKTREE_LEASE_HEARTBEAT_MS = 30_000;

/**
 * A live pid whose heartbeat is older than this is treated as a reused pid
 * (the original holder died without releasing), so the worktree is idle.
 */
export const REVIEW_WORKTREE_LEASE_TTL_MS = 10 * 60_000;

/** What a lease file records. */
export interface ReviewWorktreeLease {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

/** Heartbeat timers for leases this process holds, by worktree path. */
const heartbeats = new Map<string, ReturnType<typeof setInterval>>();

/** Base review worktree path (honors `DEVINTERN_REVIEW_WORKTREE_PATH`). */
function reviewWorktreeBase(): string {
  return process.env.DEVINTERN_REVIEW_WORKTREE_PATH || "/tmp/devintern-review-worktree";
}

/** Directory holding lease files for the current review worktree base. */
export function reviewWorktreeLeaseDir(): string {
  return `${reviewWorktreeBase()}.leases`;
}

/** Lease file for one review worktree. */
export function reviewWorktreeLeasePath(worktreePath: string): string {
  return join(reviewWorktreeLeaseDir(), `${basename(worktreePath)}.json`);
}

/** Read a worktree's lease; null when absent or unreadable. */
export function readReviewWorktreeLease(worktreePath: string): ReviewWorktreeLease | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(reviewWorktreeLeasePath(worktreePath), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      typeof record.startedAt !== "number" ||
      typeof record.heartbeatAt !== "number"
    ) {
      return null;
    }
    return { pid: record.pid, startedAt: record.startedAt, heartbeatAt: record.heartbeatAt };
  } catch {
    return null;
  }
}

/**
 * Whether a lease still protects its worktree: the holder pid is alive and
 * its heartbeat is recent. A dead pid (crashed job, restarted worker) frees
 * the worktree immediately.
 */
export function isReviewWorktreeLeaseLive(
  lease: ReviewWorktreeLease | null,
  now: number = Date.now(),
): boolean {
  if (!lease) return false;
  return isProcessAlive(lease.pid) && now - lease.heartbeatAt <= REVIEW_WORKTREE_LEASE_TTL_MS;
}

/**
 * Whether `worktreePath` is held by a live lease. A lease carrying this
 * process's pid counts only while this process actually holds it; one it
 * leaked (a caller that never released) does not pin the worktree forever.
 */
export function isReviewWorktreeLeased(worktreePath: string, now: number = Date.now()): boolean {
  const lease = readReviewWorktreeLease(worktreePath);
  if (lease?.pid === process.pid) return heartbeats.has(worktreePath);
  return isReviewWorktreeLeaseLive(lease, now);
}

function writeLease(worktreePath: string, lease: ReviewWorktreeLease): void {
  const path = reviewWorktreeLeasePath(worktreePath);
  mkdirSync(reviewWorktreeLeaseDir(), { recursive: true });
  // Write-then-rename so a reader never sees a half-written lease.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease));
  renameSync(tmp, path);
}

/**
 * Take the lease on `worktreePath` for this process and keep its heartbeat
 * fresh until {@link releaseReviewWorktreeLease}.
 *
 * @throws When another live process holds the lease (two jobs mapping to the
 *   same branch-scoped path, such as two PRs from one head branch).
 */
export function acquireReviewWorktreeLease(worktreePath: string): void {
  const existing = readReviewWorktreeLease(worktreePath);
  if (existing && existing.pid !== process.pid && isReviewWorktreeLeaseLive(existing)) {
    throw new Error(
      `Review worktree ${worktreePath} is in use by another job (pid ${existing.pid}); ` +
        "retry once it finishes.",
    );
  }
  const now = Date.now();
  writeLease(worktreePath, {
    pid: process.pid,
    startedAt: existing?.pid === process.pid ? existing.startedAt : now,
    heartbeatAt: now,
  });
  if (!heartbeats.has(worktreePath)) {
    const timer = setInterval(() => {
      const current = readReviewWorktreeLease(worktreePath);
      if (current?.pid !== process.pid) return;
      try {
        writeLease(worktreePath, { ...current, heartbeatAt: Date.now() });
      } catch {
        // Best effort; the pid check still protects the worktree.
      }
    }, REVIEW_WORKTREE_LEASE_HEARTBEAT_MS);
    timer.unref?.();
    heartbeats.set(worktreePath, timer);
  }
}

/**
 * Drop this process's lease on `worktreePath` (no-op when another process
 * holds it) and stamp the directory's mtime as its last use, which orders
 * idle worktrees for cleanup.
 */
export function releaseReviewWorktreeLease(worktreePath: string): void {
  const timer = heartbeats.get(worktreePath);
  if (timer) {
    clearInterval(timer);
    heartbeats.delete(worktreePath);
  }
  const lease = readReviewWorktreeLease(worktreePath);
  if (lease && lease.pid !== process.pid) return;
  try {
    unlinkSync(reviewWorktreeLeasePath(worktreePath));
  } catch {
    // Already gone.
  }
  if (existsSync(worktreePath)) {
    try {
      const now = new Date();
      utimesSync(worktreePath, now, now);
    } catch {
      // Ignore
    }
  }
}

/** Remove a lease file regardless of holder (the worktree itself is gone). */
export function deleteReviewWorktreeLease(worktreePath: string): void {
  const timer = heartbeats.get(worktreePath);
  if (timer) {
    clearInterval(timer);
    heartbeats.delete(worktreePath);
  }
  try {
    unlinkSync(reviewWorktreeLeasePath(worktreePath));
  } catch {
    // Already gone.
  }
}
