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
 * only for the metadata commands, never across an agent run or a network
 * fetch. The holder refreshes a heartbeat in the lock file while it runs, so
 * a slow section is never mistaken for an abandoned one. A lock left by a
 * crashed process (dead pid, or a heartbeat older than
 * {@link REPO_GIT_LOCK_STALE_MS}) is taken over. Coordination across hosts is
 * out of scope.
 */

import { createHash, randomUUID } from "crypto";
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";

/** Lock file created inside the repository's git directory. */
export const REPO_GIT_LOCK_FILE = "devintern-meta.lock";

/**
 * A lock whose heartbeat is older than this is treated as abandoned even when
 * its pid is alive (a reused pid, or a holder frozen for minutes).
 */
export const REPO_GIT_LOCK_STALE_MS = 120_000;

/** Upper bound on how often a holder refreshes its heartbeat. */
const HEARTBEAT_MAX_INTERVAL_MS = 15_000;

/**
 * How long an acquirer waits before giving up. Longer than
 * {@link REPO_GIT_LOCK_STALE_MS}, so a lock leaked by a live process (no
 * heartbeat) goes stale and is taken over before every waiter gives up.
 */
export const REPO_GIT_LOCK_TIMEOUT_MS = 180_000;

/**
 * A takeover guard older than this is abandoned even when its pid is alive
 * (a reused pid). The guarded section is one read plus one unlink.
 */
const TAKEOVER_GUARD_STALE_MS = 30_000;

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
  /** Last refresh by the holder; staleness is judged from this. */
  heartbeatAt: number;
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
      heartbeatAt: typeof record.heartbeatAt === "number" ? record.heartbeatAt : record.acquiredAt,
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

/**
 * Create `path` with `data` only when it does not exist. The content is
 * written to a private temp file and hard-linked into place: `link` fails
 * with EEXIST atomically, and a reader never sees an empty or half-written
 * file (so every lock file's content is unique, carrying its token).
 */
function tryCreateFile(path: string, data: string): boolean {
  const tmp = `${path}.new-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, data);
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

function tryCreate(lockPath: string, content: LockContent): boolean {
  return tryCreateFile(lockPath, JSON.stringify(content));
}

/**
 * Whether the lock file content describes an abandoned lock.
 *
 * Unparseable content (written by something other than this module; lock
 * files are created whole) is judged by the file's age.
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
  if (at - content.heartbeatAt > staleMs) return true;
  if (content.pid === process.pid) {
    // This process serializes its own acquisitions, so a lock carrying our
    // pid that we do not hold was leaked by an earlier failure.
    return !heldTokens.has(content.token);
  }
  return !isProcessAlive(content.pid);
}

/** Whether a takeover guard file was left by a crashed or reused-pid process. */
function isGuardStale(guardPath: string, raw: string | null): boolean {
  const parsed = raw ? parseLockContent(raw) : null;
  if (!parsed) {
    try {
      return Date.now() - statSync(guardPath).mtimeMs > TAKEOVER_GUARD_STALE_MS;
    } catch {
      return true;
    }
  }
  // The guarded section is synchronous, so a guard carrying this process's
  // pid is never one we are inside of.
  if (parsed.pid === process.pid) return true;
  return Date.now() - parsed.acquiredAt > TAKEOVER_GUARD_STALE_MS || !isProcessAlive(parsed.pid);
}

/**
 * Remove a stale lock file, but only while it still holds exactly the
 * content that was judged stale. Never moves or restores a lock file, so a
 * fresh lock another acquirer created is never displaced.
 *
 * Contenders that judged the same content stale serialize on a guard file
 * named after that content. The winner re-reads the lock and unlinks it only
 * if the content is unchanged. Nothing else can replace that content while
 * the guard is held: `tryCreate` needs the path to be absent, and every lock
 * file's content is unique (it carries a random token), so once the stale
 * file is gone a later guard holder sees different content and leaves it.
 * The only writer that could still change it is the stale holder itself,
 * which by definition is dead or frozen past the stale window.
 *
 * Callers retry their create after this returns, whether or not it removed
 * anything.
 *
 * @param lockPath - Lock file to remove
 * @param staleRaw - The content that was judged stale
 */
export function takeOverStaleFile(lockPath: string, staleRaw: string): void {
  const digest = createHash("sha256").update(staleRaw).digest("hex").slice(0, 16);
  const guardPath = `${lockPath}.takeover-${digest}`;
  const guardToken = randomUUID();
  const guard: LockContent = {
    pid: process.pid,
    acquiredAt: Date.now(),
    heartbeatAt: Date.now(),
    token: guardToken,
  };
  if (!tryCreateFile(guardPath, JSON.stringify(guard))) {
    const guardRaw = readRaw(guardPath);
    // Another contender is removing this exact stale file; let it finish.
    // A guard abandoned by a crashed contender is dropped so the next
    // attempt can take it.
    if (isGuardStale(guardPath, guardRaw) && readRaw(guardPath) === guardRaw) {
      try {
        unlinkSync(guardPath);
      } catch {
        // Ignore
      }
    }
    return;
  }
  try {
    if (readRaw(lockPath) !== staleRaw) return; // Released or replaced: not ours to remove.
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  } finally {
    if (parseLockContent(readRaw(guardPath) ?? "")?.token === guardToken) {
      try {
        unlinkSync(guardPath);
      } catch {
        // Ignore
      }
    }
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
    if (tryCreate(lockPath, { pid: process.pid, acquiredAt: at, heartbeatAt: at, token })) {
      heldTokens.add(token);
      return token;
    }
    const raw = readRaw(lockPath);
    if (raw === null) continue; // Released between our create and read.
    if (isStale(lockPath, raw, options.staleMs, at)) {
      takeOverStaleFile(lockPath, raw);
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

/**
 * Keep a held lock's heartbeat fresh until the returned stop function runs.
 *
 * Refreshes rewrite the file atomically (temp file + rename) and only while
 * it still carries this holder's token. Waiters see a recent heartbeat and
 * keep waiting (or time out) instead of taking over a live, slow holder.
 */
function startHeartbeat(
  lockPath: string,
  token: string,
  staleMs: number,
  now: () => number,
): () => void {
  const interval = Math.max(10, Math.min(Math.floor(staleMs / 4), HEARTBEAT_MAX_INTERVAL_MS));
  const timer = setInterval(() => {
    const content = parseLockContent(readRaw(lockPath) ?? "");
    if (content?.token !== token) return;
    const tmp = `${lockPath}.hb-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, JSON.stringify({ ...content, heartbeatAt: now() }));
      renameSync(tmp, lockPath);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // Ignore
      }
    }
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
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
    const stopHeartbeat = startHeartbeat(lockPath, token, resolved.staleMs, resolved.now);
    try {
      return await fn();
    } finally {
      stopHeartbeat();
      releaseFileLock(lockPath, token);
    }
  } finally {
    releaseTurn();
    if (processTails.get(lockPath) === tail) processTails.delete(lockPath);
  }
}
