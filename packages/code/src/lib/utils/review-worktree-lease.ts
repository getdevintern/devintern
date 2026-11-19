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

import { randomUUID } from "crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import { isProcessAlive, takeOverStaleFile } from "./repo-git-lock";

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

function parseLease(raw: string): ReviewWorktreeLease | null {
  try {
    const parsed: unknown = JSON.parse(raw);
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

function readRawLease(worktreePath: string): string | null {
  try {
    return readFileSync(reviewWorktreeLeasePath(worktreePath), "utf8");
  } catch {
    return null;
  }
}

/** Read a worktree's lease; null when absent or unreadable. */
export function readReviewWorktreeLease(worktreePath: string): ReviewWorktreeLease | null {
  const raw = readRawLease(worktreePath);
  return raw === null ? null : parseLease(raw);
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
 * Create the lease file only when none exists. The content is written to a
 * private temp file first and hard-linked into place: `link` fails with
 * EEXIST atomically, and a reader never sees a half-written lease.
 */
function tryCreateLease(worktreePath: string, lease: ReviewWorktreeLease): boolean {
  const path = reviewWorktreeLeasePath(worktreePath);
  mkdirSync(reviewWorktreeLeaseDir(), { recursive: true });
  const tmp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease));
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Ignore
    }
  }
}

/** Thrown when another live job holds a review worktree's lease. */
export class ReviewWorktreeInUseError extends Error {
  constructor(worktreePath: string, pid?: number) {
    super(
      `Review worktree ${worktreePath} is in use by another job` +
        `${pid === undefined ? "" : ` (pid ${pid})`}; retry once it finishes.`,
    );
    this.name = "ReviewWorktreeInUseError";
  }
}

function inUseError(worktreePath: string, pid?: number): Error {
  return new ReviewWorktreeInUseError(worktreePath, pid);
}

/** Attempts to replace a stale lease before reporting the worktree as in use. */
const ACQUIRE_ATTEMPTS = 5;

/**
 * Take the lease on `worktreePath` for this process and keep its heartbeat
 * fresh until {@link releaseReviewWorktreeLease}.
 *
 * Acquisition is atomic across processes: the lease file is created
 * exclusively, so of several jobs racing for one path exactly one wins. A
 * lease whose holder is dead, expired, or leaked by this process is removed
 * (only that exact file) and creation retried.
 *
 * @throws {ReviewWorktreeInUseError} When another live process holds the
 *   lease (two jobs mapping to the same path, such as two PRs from one head
 *   branch in one repository).
 */
export function acquireReviewWorktreeLease(worktreePath: string): void {
  if (heartbeats.has(worktreePath)) {
    // Already held by this process: refresh only.
    const current = readReviewWorktreeLease(worktreePath);
    if (current?.pid === process.pid) {
      writeLease(worktreePath, { ...current, heartbeatAt: Date.now() });
      return;
    }
  }
  let holder: number | undefined;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    const now = Date.now();
    if (tryCreateLease(worktreePath, { pid: process.pid, startedAt: now, heartbeatAt: now })) {
      startLeaseHeartbeat(worktreePath);
      return;
    }
    const raw = readRawLease(worktreePath);
    if (raw === null) continue; // Released between our create and read.
    const existing = parseLease(raw);
    // Leases are written whole (link or rename), so unparseable content is
    // garbage, not a write in progress.
    const stale = existing === null || !isLeaseHeldBy(worktreePath, existing);
    if (!stale) {
      holder = existing.pid;
      break;
    }
    takeOverStaleFile(reviewWorktreeLeasePath(worktreePath), raw);
  }
  throw inUseError(worktreePath, holder);
}

/** Whether `lease` protects its worktree from the point of view of this process. */
function isLeaseHeldBy(worktreePath: string, lease: ReviewWorktreeLease): boolean {
  if (lease.pid === process.pid) return heartbeats.has(worktreePath);
  return isReviewWorktreeLeaseLive(lease);
}

function startLeaseHeartbeat(worktreePath: string): void {
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
