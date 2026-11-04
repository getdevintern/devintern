/**
 * Writable Bun install/temp roots for sandboxed runs.
 *
 * Bun defaults `BUN_INSTALL` to `~/.bun`, which sandbox providers keep
 * read-only (the policy only grants most of `$HOME` as readable). A child
 * `bun install` / `bun add` therefore fails with
 *
 *   error: EACCES accessing temporary directory. Please set $BUN_TMPDIR or $BUN_INSTALL
 *
 * before it resolves a single package. Providers overlay these environment
 * variables so dependency work lands in a cache the sandbox already trusts,
 * instead of the user's real Bun installation.
 *
 * The cache is persistent (a warm install cache avoids re-downloading packages
 * on every run) but not unbounded: stale roots and temp entries are evicted by
 * {@link sweepStaleRoots} / {@link evictStaleCache} / {@link pruneStaleTemp}.
 *
 * The base lives under `~/.cache`, not the OS tmpdir: every sandboxed run is
 * granted the whole tmpdir read+write, so a cache there could be poisoned by
 * one repository against another. Only the current workspace's subdirectory is
 * granted, leaving the base and sibling repositories unreadable/unwritable.
 */

import { createHash } from "crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import type { Stats } from "fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "path";
import { resolveHomeDir } from "./harness-state.js";

/** Discard a whole cache root after this long without a sandboxed run. */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Remove individual BUN_TMPDIR entries older than this on every run. */
const STALE_TEMP_MS = 7 * 24 * 60 * 60 * 1000;
/** Marker recording the last time this cache root was reused. */
const CACHE_MARKER = ".last-used";

/** Bun environment additions plus the writable root a provider must grant. */
export interface BunSandboxEnv {
  /** Environment overlay for the wrapped child. */
  env: { BUN_INSTALL: string; BUN_TMPDIR: string };
  /** Root directory containing both paths; grant read+write. */
  writablePath: string;
}

/** A provider's Bun adaptation: the env overlay plus the root to grant. */
export interface BunSandboxOverlay {
  /** Environment additions merged over the child env. */
  env: Record<string, string>;
  /** Root directory the provider must grant read+write. */
  writablePath: string;
  /** True when the overlay actually points at the sandbox cache. */
  usesCache: boolean;
}

/**
 * Per-user cache root.
 *
 * Lives under `~/.cache` rather than the OS tmpdir: `buildDefaultSandboxPolicy`
 * grants every sandboxed run write access to the whole tmpdir, so a cache there
 * is reachable (and poisonable) by any repository's agent. `~/.cache` itself is
 * only readable in the default policy, and providers grant just the current
 * workspace's subdirectory (see {@link sandboxBunEnv}).
 *
 * The path is scoped to the current user by `$HOME`; `ensurePrivateDir` still
 * rejects symlinks, foreign owners, and non-directories so a pre-created entry
 * cannot redirect the grant.
 */
function defaultCacheBase(): string {
  return join(resolveHomeDir(), ".cache", "devintern", "bun");
}

/**
 * Stable directory name for a workspace.
 *
 * Two repositories must never share a writable Bun root: an agent working on
 * one untrusted repo could otherwise plant a launcher or poison the package
 * cache that a later run in another repo loads. Hashing keeps the directory
 * name filesystem-safe regardless of the workspace path.
 *
 * @param workspace - Absolute working directory of the sandboxed run.
 */
function workspaceKey(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
}

/**
 * Create (or validate) a private directory.
 *
 * Rejects a path that is a symlink, is not a directory, or is owned by another
 * user before any child directory is created under it. That check prevents a
 * pre-created link from redirecting `mkdirSync` (and therefore the nono
 * `--allow` grant) somewhere else. Existing directories owned by this user are
 * tightened to 0700.
 *
 * @param path - Directory to create or validate.
 */
function ensurePrivateDir(path: string): void {
  const existing = lstatIfExists(path);
  if (!existing) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const stats = existing ?? lstatSync(path);
  validatePrivateDir(path, stats);
  // A directory created by an earlier version (or with a permissive umask)
  // may still be group/world accessible; tighten what we own.
  if ((stats.mode & 0o077) !== 0o000) {
    chmodSync(path, 0o700);
  }
  accessSync(path, constants.W_OK);
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validatePrivateDir(path: string, stats: Stats): void {
  if (stats.isSymbolicLink()) {
    throw new Error(`refusing to use a symlinked Bun cache directory: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Bun cache path is not a directory: ${path}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`Bun cache directory is owned by another user: ${path}`);
  }
}

/**
 * Discard a cache root's contents after a long period without use.
 *
 * The package cache is intentionally persistent — re-downloading every
 * dependency on each run would be slow — but leaving it on disk forever lets a
 * long-lived worker accumulate stale installs. A marker file records the last
 * use; when it is older than {@link CACHE_MAX_AGE_MS} the install and temp
 * trees are removed and recreated. Eviction is best-effort: a cache that cannot
 * be inspected stays usable instead of aborting the run.
 *
 * @param dir - Cache root (the base or a workspace subdirectory).
 */
function evictStaleCache(dir: string): void {
  const marker = join(dir, CACHE_MARKER);
  try {
    const stats = lstatIfExists(marker);
    if (stats && !stats.isFile()) return;
    if (stats && Date.now() - stats.mtimeMs > CACHE_MAX_AGE_MS) {
      rmSync(join(dir, "install"), { recursive: true, force: true });
      rmSync(join(dir, "tmp"), { recursive: true, force: true });
    }
    writeFileSync(marker, "", { mode: 0o600 });
  } catch {
    // Eviction is opportunistic; keep using the cache if it cannot be pruned.
  }
}

/**
 * Sweep every workspace root under `base`, discarding roots idle past
 * {@link CACHE_MAX_AGE_MS}.
 *
 * `evictStaleCache` only inspects the root being resolved, so one-off or
 * abandoned workspaces (the harness probe creates a fresh temp working dir per
 * probe) would otherwise accumulate forever. This runs on every resolution so
 * the cache is genuinely bounded regardless of which workspace is active.
 *
 * @param base - Cache base directory containing per-workspace hash roots.
 */
function sweepStaleRoots(base: string): void {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // A workspace-less root keeps install/tmp directly under `base`; those are
    // handled by `evictStaleCache(base)` and must not be removed here.
    if (!entry.isDirectory() || entry.name === "install" || entry.name === "tmp") continue;
    const dir = join(base, entry.name);
    try {
      const marker = lstatIfExists(join(dir, CACHE_MARKER));
      // Fall back to the directory mtime for roots written before markers
      // existed (or whose marker was removed).
      const lastUsed = marker?.isFile() ? marker.mtimeMs : lstatSync(dir).mtimeMs;
      if (Date.now() - lastUsed > CACHE_MAX_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Concurrent removal or an unreadable root: leave it for the next sweep.
    }
  }
}

/**
 * Remove individual BUN_TMPDIR leftovers from crashed runs.
 *
 * Temp files are only needed while a run is active; anything older than
 * {@link STALE_TEMP_MS} is safe to discard even when the package cache stays
 * warm.
 *
 * @param temp - The cache's BUN_TMPDIR directory.
 */
function pruneStaleTemp(temp: string): void {
  let entries;
  try {
    entries = readdirSync(temp, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMP_MS;
  for (const entry of entries) {
    const path = join(temp, entry.name);
    try {
      if (lstatSync(path).mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent run removed it first; nothing left to prune.
    }
  }
}

/**
 * Resolve and create a sandbox-local Bun install/temp root.
 *
 * Paths are stable per user (and per workspace when one is given) so a
 * provider's grant and preflight caches are reused across runs. Directories
 * are created with mode 0700 when missing; a warm install cache avoids
 * re-downloading packages on every run. Roots unused for 30 days and temp
 * entries older than 7 days are evicted, including roots for workspaces other
 * than the current one.
 *
 * Throws when the root cannot be created safely (symlink, foreign owner,
 * regular file, read-only parent). Callers should omit the overlay rather than
 * abort the run; use {@link trySandboxBunEnv} to get a warning instead.
 *
 * @param base - Root cache directory. Defaults to `~/.cache/devintern/bun`.
 * @param workspace - Working directory the sandboxed run operates on. When
 *   set, the cache is scoped to that workspace so repositories cannot influence
 *   each other's launchers or package cache.
 * @returns The env overlay and the single writable root to grant.
 */
export function sandboxBunEnv(
  base: string = defaultCacheBase(),
  workspace?: string,
): BunSandboxEnv {
  ensurePrivateDir(base);
  sweepStaleRoots(base);
  const root = workspace ? join(base, workspaceKey(workspace)) : base;
  if (workspace) ensurePrivateDir(root);
  evictStaleCache(root);

  const install = join(root, "install");
  const temp = join(root, "tmp");
  ensurePrivateDir(install);
  ensurePrivateDir(temp);
  pruneStaleTemp(temp);
  return {
    env: { BUN_INSTALL: install, BUN_TMPDIR: temp },
    writablePath: root,
  };
}

/** Set once the Bun-cache fallback is reported, to avoid a warning per spawn. */
let bunCacheWarned = false;

/**
 * Forget the Bun-cache warning, so tests (or a long-lived host that repairs its
 * cache) can observe the next failure.
 */
export function resetBunEnvWarning(): void {
  bunCacheWarned = false;
}

/**
 * Resolve the sandbox Bun cache without throwing.
 *
 * `wrapCommand` runs before every sandboxed spawn; a cache problem (foreign
 * owner, symlink, read-only tmp) must not abort harnesses that never invoke
 * Bun, so providers omit the overlay instead. The degraded state is still
 * reported once per process — otherwise the default native provider would
 * silently fall back to exactly the read-only `~/.bun` this module exists to
 * avoid, with nothing explaining the missing overlay.
 *
 * @param base - Root cache directory. Defaults to `~/.cache/devintern/bun`.
 * @param workspace - Working directory used to scope the cache (see
 *   {@link sandboxBunEnv}).
 * @returns The cache paths, or undefined when the cache cannot be created safely.
 */
export function trySandboxBunEnv(base?: string, workspace?: string): BunSandboxEnv | undefined {
  try {
    return sandboxBunEnv(base, workspace);
  } catch (error) {
    if (!bunCacheWarned) {
      bunCacheWarned = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[sandbox] Bun cache unavailable (${reason}); ` +
          "continuing without BUN_INSTALL/BUN_TMPDIR overrides.",
      );
    }
    return undefined;
  }
}

/**
 * Canonical form of an absolute path for sandbox-grant comparison.
 *
 * Grants are enforced on canonical paths, so comparing lexically would treat a
 * `<writable>/.bun` symlink pointing at read-only `~/.bun` as writable.
 * `realpathSync` resolves existing links; for a path that does not exist yet,
 * the nearest existing ancestor is canonicalized and the remainder reattached.
 * A dangling symlink is followed through its declared target so it cannot
 * masquerade as writable either.
 *
 * @param path - Absolute path to canonicalize.
 * @param seen - Paths already visited, to terminate symlink cycles.
 */
function canonicalPath(path: string, seen: Set<string> = new Set()): string {
  const absolute = resolve(path);
  if (seen.has(absolute)) return absolute;
  seen.add(absolute);
  try {
    return realpathSync(absolute);
  } catch {
    // Missing or dangling target: resolve the link/parent manually below.
  }
  let existing: Stats | undefined;
  try {
    existing = lstatIfExists(absolute);
  } catch {
    // An inaccessible or non-directory component cannot be a writable target.
    return absolute;
  }
  if (existing?.isSymbolicLink()) {
    try {
      const target = readlinkSync(absolute);
      return canonicalPath(isAbsolute(target) ? target : resolve(dirname(absolute), target), seen);
    } catch {
      return absolute;
    }
  }
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalPath(parent, seen), basename(absolute));
}

/**
 * True when `path` equals or is nested under any of `roots`.
 *
 * Both operands are canonicalized (`realpathSync`) before comparison, so a
 * symlink inside a granted root that points outside it is not treated as
 * writable — the sandbox enforces grants on canonical paths too. A path that
 * does not exist yet is canonicalized through its nearest existing ancestor.
 * Component boundaries are respected, so a path that merely shares a string
 * prefix (`/tmp/bunny` vs `/tmp/bun`) cannot fool the check.
 *
 * Relative paths are rejected: they are interpreted against the child's working
 * directory, which this helper does not know, so it must never assume one is
 * inside a grant.
 *
 * @param path - Path to test.
 * @param roots - Roots a provider grants read+write.
 */
export function isPathWithin(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  const target = canonicalPath(path);
  return roots.some((root) => {
    // An empty or relative root cannot be trusted as a grant.
    if (!root || !isAbsolute(root)) return false;
    const rel = relative(canonicalPath(root), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/**
 * Compose the Bun env overlay for a provider that grants `writableRoots`.
 *
 * A configured `BUN_INSTALL`/`BUN_TMPDIR` is kept only when the sandbox grants
 * the child write access to it. A default `BUN_INSTALL=$HOME/.bun` is writable
 * for this process but read-only for a sandboxed child, so `bun install` would
 * still fail with EACCES. When the install root is redirected:
 *
 * - `<cache>/bin` is appended to `PATH`, because `bun install -g` writes its
 *   launchers there and they would otherwise be unreachable by name (ENOENT).
 *   Appending (rather than prepending) keeps system tools ahead of anything a
 *   sandboxed run can plant in the writable cache.
 * - The CLI self-updaters are disabled: an install into the ephemeral root
 *   cannot replace the running binary, while their skip cache under
 *   `~/.devintern` is read-only in the sandbox, so they would re-exec the
 *   unchanged binary forever.
 *
 * Both providers call this so a future provider cannot silently omit the
 * overlay or the writable root.
 *
 * @param bun - Cache resolved by {@link sandboxBunEnv}.
 * @param writableRoots - Roots the provider grants read+write to the child.
 * @param childEnv - Environment the child is spawned with, before this overlay.
 * @returns The env overlay and the root to grant.
 */
export function bunSandboxOverlay(
  bun: BunSandboxEnv,
  writableRoots: readonly string[],
  childEnv: NodeJS.ProcessEnv = process.env,
): BunSandboxOverlay {
  const env: Record<string, string> = {};
  const installWritable =
    childEnv.BUN_INSTALL !== undefined && isPathWithin(childEnv.BUN_INSTALL, writableRoots);
  if (!installWritable) {
    env.BUN_INSTALL = bun.env.BUN_INSTALL;
  }
  if (childEnv.BUN_TMPDIR === undefined || !isPathWithin(childEnv.BUN_TMPDIR, writableRoots)) {
    env.BUN_TMPDIR = bun.env.BUN_TMPDIR;
  }
  if (!installWritable) {
    const bin = join(bun.env.BUN_INSTALL, "bin");
    env.PATH = childEnv.PATH ? `${childEnv.PATH}${delimiter}${bin}` : bin;
    env.DEVINTERN_NO_UPDATE = "1";
    env.DEVPM_NO_UPDATE = "1";
  }
  return {
    env,
    writablePath: bun.writablePath,
    usesCache: env.BUN_INSTALL !== undefined || env.BUN_TMPDIR !== undefined,
  };
}
