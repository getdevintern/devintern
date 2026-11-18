/**
 * Per-repository lock around short git metadata sections.
 *
 * Several worker jobs can touch one shared repository at once: task worktree
 * setup in the worker process and PR jobs in CLI subprocesses all run
 * `worktree add/remove/prune`, `fetch`, `branch -D`, and `config` writes
 * against the same `.git` / bare clone. Git takes its own `config.lock` and
 * `index.lock` files and fails immediately when another process holds them,
 * so concurrent setups surface as `could not lock config file` errors.
 *
 * {@link withRepoGitLock} serializes those sections on one host with an
 * exclusive-create lock file in the repository's git directory. It is held
 * only for the metadata commands, never across an agent run. A lock left by
 * a crashed process (dead pid, or older than {@link REPO_GIT_LOCK_STALE_MS})
 * is taken over. Coordination across hosts is out of scope.
 */

import { randomUUID } from "crypto";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { join, resolve } from "path";

/** Lock file created inside the repository's git directory. */
export const REPO_GIT_LOCK_FILE = "devintern-meta.lock";

/** A lock older than this is treated as abandoned even when its pid is alive. */
export const REPO_GIT_LOCK_STALE_MS = 120_000;

/** How long an acquirer waits before giving up. */
export const REPO_GIT_LOCK_TIMEOUT_MS = 60_000;

const RETRY_INITIAL_MS = 25;
const RETRY_MAX_MS = 500;

/** The lock could not be acquired within the timeout. */
export class RepoGitLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number, holder?: string) {
    super(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the git metadata lock ` +
        `${lockPath}${holder ? ` (held by ${holder})` : ""}`,
    );
    this.name = "RepoGitLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export interface RepoGitLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  /** Clock; injectable for tests. */
  now?: () => number;
}

interface LockContent {
  pid: number;
  acquiredAt: number;
  token: string;
}

/** Tokens of locks this process currently holds. */
const heldTokens = new Set<string>();
/** In-process FIFO per lock path, so one process never races itself. */
const processTails = new Map<string, Promise<void>>();

/** Absolute lock file path for a repository git directory. */
export function repoGitLockPath(gitDir: string): string {
  return join(resolve(gitDir), REPO_GIT_LOCK_FILE);
}

/** Whether `pid` names a live process (EPERM still means it exists). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockContent(raw: string): LockContent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== "number" || typeof record.acquiredAt !== "number") return null;
    return {
      pid: record.pid,
      acquiredAt: record.acquiredAt,
      token: typeof record.token === "string" ? record.token : "",
    };
  } catch {
    return null;
  }
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function tryCreate(lockPath: string, content: LockContent): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(content));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Whether the lock file content describes an abandoned lock.
 *
 * Unparseable content (a holder that crashed between create and write) is
 * judged by the file's age.
 */
function isStale(lockPath: string, raw: string, staleMs: number, at: number): boolean {
  const content = parseLockContent(raw);
  if (!content) {
    try {
      return at - statSync(lockPath).mtimeMs > Math.min(staleMs, 5_000);
    } catch {
      return true;
    }
  }
  if (at - content.acquiredAt > staleMs) return true;
  if (content.pid === process.pid) {
    // This process serializes its own acquisitions, so a lock carrying our
    // pid that we do not hold was leaked by an earlier failure.
    return !heldTokens.has(content.token);
  }
  return !isProcessAlive(content.pid);
}

/**
 * Remove a stale lock, but only the exact file judged stale: rename it aside,
 * then restore it if another acquirer replaced it in between.
 */
function takeOver(lockPath: string, staleRaw: string): void {
  const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return; // Someone else removed it first.
  }
  const moved = readRaw(aside);
  if (moved !== null && moved !== staleRaw) {
    // We moved a fresh lock another acquirer had just created; put it back
    // unless yet another acquirer has already created a new one.
    try {
      linkSync(aside, lockPath);
    } catch {
      // The slot is taken again; that holder owns the lock now.
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // Ignore
  }
}

function describeHolder(raw: string | null): string | undefined {
  const content = raw ? parseLockContent(raw) : null;
  return content ? `pid ${content.pid}` : undefined;
}

async function acquireFileLock(
  lockPath: string,
  options: Required<Pick<RepoGitLockOptions, "timeoutMs" | "staleMs" | "now">>,
): Promise<string> {
  const token = randomUUID();
  const started = options.now();
  let delay = RETRY_INITIAL_MS;
  for (;;) {
    const at = options.now();
    if (tryCreate(lockPath, { pid: process.pid, acquiredAt: at, token })) {
      heldTokens.add(token);
      return token;
    }
    const raw = readRaw(lockPath);
    if (raw === null) continue; // Released between our create and read.
    if (isStale(lockPath, raw, options.staleMs, at)) {
      takeOver(lockPath, raw);
      continue;
    }
    if (at - started >= options.timeoutMs) {
      throw new RepoGitLockTimeoutError(lockPath, options.timeoutMs, describeHolder(raw));
    }
    const jitter = Math.random() * delay * 0.5;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay + jitter));
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }
}

function releaseFileLock(lockPath: string, token: string): void {
  heldTokens.delete(token);
  const content = parseLockContent(readRaw(lockPath) ?? "");
  if (content?.token !== token) return; // Taken over after we went stale.
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

/**
 * Run `fn` while holding the repository's git metadata lock.
 *
 * Not reentrant: never call it from inside another `withRepoGitLock` for the
 * same repository, or the inner call waits for the outer one.
 *
 * @param gitDir - The repository's git directory (a bare clone, or the
 *   common `.git` directory of a checkout)
 * @param fn - Short git metadata section to run
 * @throws {RepoGitLockTimeoutError} When the lock stays held past the timeout.
 */
export async function withRepoGitLock<T>(
  gitDir: string,
  fn: () => Promise<T>,
  options: RepoGitLockOptions = {},
): Promise<T> {
  const lockPath = repoGitLockPath(gitDir);
  const resolved = {
    timeoutMs: options.timeoutMs ?? REPO_GIT_LOCK_TIMEOUT_MS,
    staleMs: options.staleMs ?? REPO_GIT_LOCK_STALE_MS,
    now: options.now ?? Date.now,
  };

  const previous = processTails.get(lockPath) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    releaseTurn = resolveTurn;
  });
  const tail = previous.then(() => turn);
  processTails.set(lockPath, tail);
  await previous;
  try {
    const token = await acquireFileLock(lockPath, resolved);
    try {
      return await fn();
    } finally {
      releaseFileLock(lockPath, token);
    }
  } finally {
    releaseTurn();
    if (processTails.get(lockPath) === tail) processTails.delete(lockPath);
  }
}
