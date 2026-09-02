/**
 * Task-execution isolation in disposable git worktrees (DEV-90).
 *
 * When the CLI processes a task in a git repository, the whole per-task
 * pipeline runs with the process cwd moved into a throwaway linked worktree
 * under `<repo>/.devintern-code/worktrees/<task>-<pid>-<ts>` instead of the
 * user's checkout. The user's uncommitted changes, staged files, index, and
 * current branch are never touched; `createFeatureBranch`'s destructive
 * cleanup (`reset --hard`, `clean -fd`) happens in the throwaway tree, which
 * is exactly why fleet mode already runs tasks in worktrees.
 *
 * Lifecycle:
 * - create: detached worktree from `origin/<target>` (fallback `<target>`,
 *   then HEAD), branched later by the pipeline's own `createFeatureBranch`
 * - preserve: before removal, uncommitted worktree changes are committed to
 *   the feature branch (commits survive worktree removal — they live in the
 *   shared object store); if a commit is impossible a patch file is written
 *   to the task output directory instead; when both fail the directory is
 *   renamed to `<name>.unsaved` and left for manual recovery instead of
 *   being destroyed
 * - teardown: `git worktree remove --force` → `rmSync` fallback → `prune`
 *   (the same ladder as `removeReviewWorktree` / `removeTaskWorktree`)
 *
 * Teardown runs on success, failure, and interruption: the pipeline's
 * `process.exit()` calls and fatal signals bypass `finally` blocks, so an
 * exit-event guard plus a hook in `gracefulShutdown` perform the same
 * synchronous cleanup. Worktrees orphaned by SIGKILL/power loss are swept by
 * PID-liveness on the next run (dir names embed the creating pid); dirty
 * orphans are kept as `<name>.unsaved` rather than destroyed.
 *
 * Config continuity: config discovery walks up from cwd but stops at the
 * first `.git` entry — which includes every linked worktree's `.git` file.
 * A `.devintern-code` symlink inside the worktree points back at the repo's
 * shared state directory so settings.json/analytics resolve unchanged, and
 * `WEBHOOK_QUEUE_DB` pins queue.db so run records/retry state stay durable.
 * The pattern `.devintern-code` is registered in `.git/info/exclude` so the
 * symlink and worktree dirs never show up in `git status` or get swept into
 * `git add -A`.
 *
 * All git calls here take explicit `{ cwd }` arguments (never rely on the
 * ambient cwd) so tests can exercise the module without `process.chdir`,
 * which is banned by tests/setup/guard-git-state.ts.
 */

import { spawnSync } from "child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join, dirname, isAbsolute } from "path";

import { Utils } from "./utils";

/** Base directory override for isolated task worktrees (tests / power users). */
export const WORKTREE_ISOLATION_DIR_ENV = "DEVINTERN_TASK_WORKTREE_DIR";

/** Set to disable isolation entirely; tasks then run in the user's checkout. */
export const WORKTREE_ISOLATION_DISABLE_ENV = "DEVINTERN_NO_WORKTREE_ISOLATION";

/** While a task runs isolated, holds the active worktree path (recursion guard). */
export const WORKTREE_ISOLATION_MARKER_ENV = "DEVINTERN_TASK_WORKTREE";

const WORKTREE_NAME_PREFIX = "devintern-task";

/**
 * Orphan backstop: entries older than this are swept even when their embedded
 * pid happens to look alive (pid reuse). Far above any legitimate agent run.
 */
const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Patch file written to the task output dir when changes can't be committed. */
export const WORKTREE_PATCH_FILE_NAME = "worktree-changes.patch";

export type IsolationOutcome = "completed" | "failed" | "interrupted";

interface GitSyncResult {
  success: boolean;
  output: string;
  error?: string;
}

/** Injectable process seam so tests never need real `process.chdir`. */
export interface WorktreeIsolationDeps {
  chdir: (directory: string) => void;
  cwd: () => string;
  /** Injectable symlink so tests can simulate environments without symlink support. */
  symlink?: typeof symlinkSync;
}

export interface EnterTaskWorktreeOptions {
  /** Task key; used for the worktree dir name and commit messages */
  taskKey: string;
  /** Optional task summary for commit messages */
  taskSummary?: string;
  /** Branch to base the worktree on (defaults to HEAD) */
  targetBranch?: string;
  /**
   * Mirrors --no-auto-commit: when false, uncommitted worktree changes are
   * preserved as a patch file instead of an automatic commit.
   */
  autoCommit: boolean;
  /** Task output directory; receives the fallback patch file */
  patchDir: string;
  verbose?: boolean;
}

export interface WorktreeIsolationHandle {
  readonly worktreePath: string;
  readonly repoRoot: string;
  readonly originalCwd: string;
  /**
   * Preserve results and remove the worktree. Idempotent; safe to call from
   * both normal control flow and signal/exit paths.
   */
  finish(outcome: IsolationOutcome): void;
}

/** Currently-active handle, for cleanup from signal handlers. */
let activeHandle: WorktreeIsolation | null = null;

const defaultDeps: WorktreeIsolationDeps = {
  chdir: (directory: string) => process.chdir(directory),
  cwd: () => process.cwd(),
};

/** Filesystem-safe path segment for a task key (repo-manager convention). */
export function sanitizeTaskKeyForPath(taskKey: string): string {
  return (
    taskKey
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "task"
  );
}

export interface ParsedWorktreeName {
  pid: number;
  createdAt: number;
}

/**
 * Parse `<prefix>-<task>-<pid>-<createdAtMs>` worktree dir names.
 *
 * Returns null for anything else (user dirs, other tooling) — those are never
 * touched by the sweep.
 */
export function parseWorktreeName(name: string): ParsedWorktreeName | null {
  const pattern = new RegExp(`^${WORKTREE_NAME_PREFIX}-(?:[a-z0-9._-]+)-(\\d+)-(\\d{13,})$`);
  const match = name.match(pattern);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1], 10);
  const createdAt = Number.parseInt(match[2], 10);
  if (!Number.isFinite(pid) || !Number.isFinite(createdAt)) {
    return null;
  }
  return { pid, createdAt };
}

/** Liveness probe shared with LockManager semantics (EPERM counts as alive). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runGitSync(args: string[], cwd?: string): GitSyncResult {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.error) {
      return { success: false, output: "", error: result.error.message };
    }
    if (result.status !== 0) {
      return {
        success: false,
        output: (result.stdout ?? "").trim(),
        error: ((result.stderr ?? "") || `git exited with code ${result.status}`).trim(),
      };
    }
    return { success: true, output: (result.stdout ?? "").trim() };
  } catch (error) {
    return { success: false, output: "", error: (error as Error).message };
  }
}

function captureWorktreeState(worktreePath: string): { dirty: boolean; branchName: string | null } {
  const status = runGitSync(["status", "--porcelain"], worktreePath);
  // A failed status (index.lock contention, fs error) is unknown state, not a
  // clean tree: treat it as dirty so preservation runs instead of teardown
  // destroying uncommitted work.
  const dirty = !status.success || status.output.length > 0;
  const branch = runGitSync(["branch", "--show-current"], worktreePath);
  return {
    dirty,
    branchName: branch.success && branch.output ? branch.output : null,
  };
}

function writeGitDiff(worktreePath: string, args: string[], patchDir: string): string | null {
  try {
    const diff = spawnSync("git", args, {
      cwd: worktreePath,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (diff.status !== 0 || !diff.stdout || diff.stdout.length === 0) {
      return null;
    }
    mkdirSync(patchDir, { recursive: true });
    const patchPath = join(patchDir, WORKTREE_PATCH_FILE_NAME);
    writeFileSync(patchPath, diff.stdout);
    return patchPath;
  } catch {
    return null;
  }
}

/**
 * Best-effort snapshot of uncommitted changes as a binary-safe patch.
 *
 * @returns Patch path, or null when nothing could be captured
 */
function writePatchSnapshot(worktreePath: string, patchDir: string): string | null {
  // Primary: stage everything (captures untracked files) and diff the index.
  runGitSync(["add", "-A"], worktreePath);
  const staged = writeGitDiff(worktreePath, ["diff", "--cached", "--binary"], patchDir);
  if (staged) {
    return staged;
  }
  // Last resort when staging or reading the index failed (index lock held by
  // another process, non-zero diff exit): tracked changes against HEAD,
  // which needs no index writes at all.
  return writeGitDiff(worktreePath, ["diff", "HEAD", "--binary"], patchDir);
}

/**
 * Preserve uncommitted worktree changes so they survive worktree removal.
 *
 * Policy by outcome:
 * - completed: implementation commit with hooks (falls back to --no-verify)
 * - failed/interrupted: WIP commit with --no-verify (hooks may hang or fail
 *   mid-interrupt; no arbitrary hook code on the teardown path)
 * - autoCommit=false: no automatic commits at all — patch only
 *
 * Anything still dirty afterwards (hook mutations, refused commits) ends up
 * in the patch snapshot.
 */
function preserveWorktreeChanges(options: {
  worktreePath: string;
  taskKey: string;
  taskSummary?: string;
  outcome: IsolationOutcome;
  autoCommit: boolean;
  patchDir: string;
}): { committed: boolean; patchPath?: string } {
  const { worktreePath } = options;
  const state = captureWorktreeState(worktreePath);
  if (!state.dirty) {
    return { committed: false };
  }

  // A detached HEAD (interrupt before the pipeline created the feature
  // branch) has nowhere durable to receive a commit — patch instead.
  let mayCommit = options.autoCommit && state.branchName !== null;
  if (mayCommit) {
    const message =
      options.outcome === "completed"
        ? `feat: implement ${options.taskKey}${
            options.taskSummary ? ` - ${options.taskSummary}` : ""
          }`
        : `wip(devintern): preserve incomplete work on ${options.taskKey}`;
    runGitSync(["add", "-A"], worktreePath);
    let commit = runGitSync(["commit", "-m", message], worktreePath);
    if (!commit.success) {
      commit = runGitSync(["commit", "--no-verify", "-m", message], worktreePath);
    }
    if (commit.success && !captureWorktreeState(worktreePath).dirty) {
      return { committed: true };
    }
  }

  const patchPath = writePatchSnapshot(worktreePath, options.patchDir);
  return { committed: false, ...(patchPath ? { patchPath } : {}) };
}

/**
 * Remove a worktree directory and its registration: git remove → rmSync
 * fallback → prune. Never throws; a failed cleanup must not mask the task's
 * result.
 */
function teardownWorktreeSync(worktreePath: string, repoCwd: string): void {
  if (existsSync(worktreePath)) {
    const removed = runGitSync(["worktree", "remove", "--force", worktreePath], repoCwd);
    if (!removed.success) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        /* best-effort: prune below drops the dangling registration */
      }
    }
  }
  runGitSync(["worktree", "prune"], repoCwd);
}

/**
 * Register `.devintern-code` in the repo's local `.git/info/exclude` so the
 * shared-state symlink inside each worktree (and the worktrees themselves,
 * which live under `.devintern-code/worktrees/`) stay out of `git status`
 * and `git add -A`. Applies to every linked worktree via the common git dir.
 */
function ensureStateDirIgnored(repoRoot: string): void {
  try {
    const excludePath = runGitSync(["rev-parse", "--git-path", "info/exclude"], repoRoot);
    if (!excludePath.success || !excludePath.output) {
      return;
    }
    const absoluteExcludePath = resolveFrom(repoRoot, excludePath.output);
    const existing = existsSync(absoluteExcludePath)
      ? readFileSync(absoluteExcludePath, "utf8")
      : "";
    if (existing.split("\n").some((line) => line.trim() === ".devintern-code")) {
      return;
    }
    mkdirSync(dirname(absoluteExcludePath), { recursive: true });
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(
      absoluteExcludePath,
      `${separator}\n# @devintern/code local state (not committed)\n.devintern-code\n`,
    );
  } catch {
    // Hiding state is a convenience, never a requirement.
  }
}

/** Resolve `path` relative to `from` without depending on process.cwd(). */
function resolveFrom(from: string, path: string): string {
  return isAbsolute(path) ? path : join(from, path);
}

/**
 * Remove worktrees left behind by crashed runs (SIGKILL, power loss).
 *
 * An entry is stale when its embedded pid is dead or it predates the orphan
 * age backstop. Entries belonging to live processes (concurrent runs) and
 * unrecognized names are never touched. A stale entry holding uncommitted
 * changes (a failed status counts as unknown-dirty) is renamed to
 * `<name>.unsaved` for manual recovery instead of being destroyed — a run
 * killed minutes ago can hold hours of agent work; only clean stale entries
 * are removed outright.
 *
 * @returns Paths that were removed
 */
export function sweepOrphanedTaskWorktrees(
  worktreeRoot: string,
  repoCwd: string,
  options?: { verbose?: boolean },
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(worktreeRoot);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const parsed = parseWorktreeName(entry);
    if (!parsed) {
      continue;
    }
    let ageTooOld = false;
    try {
      ageTooOld = Date.now() - statSync(join(worktreeRoot, entry)).mtimeMs > ORPHAN_MAX_AGE_MS;
    } catch {
      continue;
    }
    if (isPidAlive(parsed.pid) && !ageTooOld) {
      continue;
    }
    const stalePath = join(worktreeRoot, entry);
    if (options?.verbose) {
      console.log(`   🧹 Sweeping orphaned task worktree: ${stalePath}`);
    }
    // No preservation step ever ran for a crashed run, so the sweep must not
    // assume a dead-pid tree is disposable. Mirror finish()'s salvage policy:
    // unknown or dirty trees are renamed aside — the suffix also escapes the
    // name-pattern check, so future sweeps cannot rematch them — with only
    // the registration pruned; teardown deletes clean trees only.
    if (captureWorktreeState(stalePath).dirty) {
      const salvagedPath = `${stalePath}.unsaved`;
      try {
        renameSync(stalePath, salvagedPath);
        console.warn(`\n⚠️  Orphaned task worktree had uncommitted changes; kept for recovery:`);
        console.warn(`   ${salvagedPath}`);
        console.warn("   Recover your files from it manually, then delete it.");
      } catch {
        console.warn(`⚠️  Could not move dirty orphan aside; left intact at: ${stalePath}`);
      }
      // The salvaged copy no longer sits at its registered path; drop only
      // the stale registration (prune never touches directories that exist).
      runGitSync(["worktree", "prune"], repoCwd);
      if (!existsSync(stalePath)) {
        removed.push(stalePath);
      }
      continue;
    }
    teardownWorktreeSync(stalePath, repoCwd);
    if (!existsSync(stalePath)) {
      removed.push(stalePath);
    }
  }
  return removed;
}

/** True when the user/environment opted out of worktree isolation. */
export function isWorktreeIsolationDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[WORKTREE_ISOLATION_DISABLE_ENV] ?? "");
}

/**
 * Whether a task run started right now would be isolated.
 *
 * Used by startup to swap the user-checkout `git pull` for a fetch-only sync
 * (a pull would move the user's branch; a fetch only updates origin/*).
 */
export async function isWorktreeIsolationActive(gitEnabled: boolean): Promise<boolean> {
  if (!gitEnabled || isWorktreeIsolationDisabled()) {
    return false;
  }
  if (process.env[WORKTREE_ISOLATION_MARKER_ENV]) {
    return false;
  }
  return Utils.isGitRepository();
}

class WorktreeIsolation implements WorktreeIsolationHandle {
  private phase: "active" | "finished" = "active";

  constructor(
    readonly worktreePath: string,
    readonly repoRoot: string,
    readonly originalCwd: string,
    private readonly deps: WorktreeIsolationDeps,
    private readonly options: EnterTaskWorktreeOptions,
  ) {}

  finish(outcome: IsolationOutcome): void {
    if (this.phase === "finished") {
      return;
    }
    this.phase = "finished";
    if (activeHandle === this) {
      activeHandle = null;
    }
    delete process.env[WORKTREE_ISOLATION_MARKER_ENV];

    // Move out of the tree before deleting it; all git calls use explicit
    // cwds, this only protects incidental cwd-relative work downstream.
    try {
      this.deps.chdir(this.originalCwd);
    } catch {
      /* original cwd deleted underneath us — nothing sensible to restore */
    }

    let preserved: { committed: boolean; patchPath?: string } = { committed: false };
    let branchName: string | null = null;
    let unsalvageable = false;
    if (existsSync(this.worktreePath)) {
      // Drop the shared-state link before anything inspects the tree: the
      // agent run has ended, so config continuity is no longer needed, and a
      // link surviving into `git status --porcelain` / `git add -A` whenever
      // the .git/info/exclude registration failed would commit a
      // machine-specific absolute symlink onto the feature branch. rmSync
      // also covers the copied-settings fallback directory and never
      // traverses a symlink, so the real state dir stays intact either way.
      try {
        rmSync(join(this.worktreePath, ".devintern-code"), { force: true, recursive: true });
      } catch {
        /* best-effort: absent, already removed, or unwritable */
      }
      const entryState = captureWorktreeState(this.worktreePath);
      branchName = entryState.branchName;
      preserved = preserveWorktreeChanges({
        worktreePath: this.worktreePath,
        taskKey: this.options.taskKey,
        taskSummary: this.options.taskSummary,
        outcome,
        autoCommit: this.options.autoCommit,
        patchDir: this.options.patchDir,
      });
      // Dirty on entry but neither a commit nor a patch captured it: tearing
      // down would destroy that work. Keep the raw directory instead — the
      // failure modes here (unwritable patch dir, refused commits, index
      // lock) correlate with unusual environments where the user most needs
      // the bytes. Renaming outside the parsed worktree-name pattern also
      // keeps the orphan sweep from reaping it later; recovery costs one
      // leftover directory, deletion loses the work permanently.
      unsalvageable = entryState.dirty && !preserved.committed && !preserved.patchPath;
      if (unsalvageable) {
        console.warn(`\n⚠️  WARNING: uncommitted changes could NOT be saved from:`);
        console.warn(`   ${this.worktreePath}`);
        console.warn("   Commit and patch preservation both failed.");
      }
      if (unsalvageable) {
        const salvagedPath = `${this.worktreePath}.unsaved`;
        try {
          renameSync(this.worktreePath, salvagedPath);
          console.warn(`   Directory kept intact at: ${salvagedPath}`);
          console.warn("   Recover your files from it manually, then delete it.");
        } catch {
          console.warn(`   Directory left intact at: ${this.worktreePath}`);
        }
        // The salvaged copy is unregistered; drop only the stale registration
        // (prune never touches directories that still exist).
        runGitSync(["worktree", "prune"], this.repoRoot);
      } else {
        teardownWorktreeSync(this.worktreePath, this.repoRoot);
      }
    }

    this.report(outcome, preserved, branchName, unsalvageable);
  }

  private report(
    outcome: IsolationOutcome,
    preserved: { committed: boolean; patchPath?: string },
    branchName: string | null,
    unsalvageable: boolean,
  ): void {
    if (unsalvageable) {
      console.log("\n🧹 Isolated worktree kept for manual recovery");
    } else if (outcome === "completed") {
      console.log("\n🧹 Isolated worktree cleaned up");
    } else if (outcome === "interrupted") {
      console.log("\n🧹 Interrupted run: isolated worktree cleaned up");
    } else {
      console.log("\n🧠 Task failed: isolated worktree cleaned up");
    }

    if (branchName && !unsalvageable) {
      console.log(
        `   Results live on branch '${branchName}' — check out with: git checkout ${branchName}`,
      );
    } else if (!unsalvageable) {
      console.log(`   Your working directory was not modified.`);
    }
    if (preserved.patchPath) {
      console.log(
        `   Uncommitted changes saved to: ${preserved.patchPath} (apply with: git apply <file>)`,
      );
    }
    if (preserved.committed && branchName) {
      console.log("   The worktree itself was removed after preserving your results.");
    }
  }
}

// Synchronous teardown for paths that bypass finally blocks (process.exit,
// fatal signals). Installed once per process; the guard is a no-op whenever
// no isolated run is active, so it never needs to be unregistered.
let exitGuardInstalled = false;

function installExitGuard(): void {
  if (exitGuardInstalled) {
    return;
  }
  exitGuardInstalled = true;
  process.on("exit", () => {
    if (activeHandle) {
      console.log("\n🧹 Cleaning up isolated task worktree...");
      activeHandle.finish("interrupted");
    }
  });
}

/** Cleanup entry point for gracefulShutdown (SIGINT/SIGTERM). */
export function cleanupActiveWorktreeIsolation(): void {
  if (activeHandle) {
    activeHandle.finish("interrupted");
  }
}

/**
 * Link the repo's shared state directory into the worktree so lazy lookups
 * (settings.json, analytics id, queue.db) resolve to the real thing despite
 * config discovery stopping at the worktree's `.git` entry.
 *
 * Falls back to copying settings.json when symlinks are unavailable, and
 * `WEBHOOK_QUEUE_DB` is pinned before any early return — including on a
 * genuinely first run where the shared dir does not exist yet. Lazy queue.db
 * writers create missing parent directories, so an unpinned first run would
 * create the database inside the disposable worktree and teardown would
 * destroy the run records/retry bookkeeping in it.
 */
function linkSharedConfigDir(
  worktreePath: string,
  repoRoot: string,
  symlink: typeof symlinkSync,
): void {
  const sharedDir = join(repoRoot, ".devintern-code");
  const linkPath = join(worktreePath, ".devintern-code");

  process.env.WEBHOOK_QUEUE_DB = join(sharedDir, "queue.db");

  if (!existsSync(sharedDir)) {
    return;
  }

  try {
    symlink(sharedDir, linkPath, "dir");
    return;
  } catch {
    // Symlinks unavailable (Windows without dev mode, restricted fs): fall
    // back to copying the small settings file so behavior stays consistent.
  }

  try {
    mkdirSync(linkPath, { recursive: true });
    const settingsPath = join(sharedDir, "settings.json");
    if (existsSync(settingsPath)) {
      cpSync(settingsPath, join(linkPath, "settings.json"));
    }
  } catch {
    /* degraded-but-working: env-based lookups still resolve */
  }
}

async function resolveBaseRef(
  targetBranch: string | undefined,
  repoRoot: string,
  verbose?: boolean,
): Promise<string> {
  if (targetBranch) {
    // Best-effort refresh; offline repos fall back to whatever refs exist.
    await Utils.executeGitCommand(["fetch", "origin", targetBranch], {
      cwd: repoRoot,
      timeoutMs: 15_000,
      verbose,
    });
    if (await Utils.gitRefExists(`refs/remotes/origin/${targetBranch}`, { cwd: repoRoot })) {
      return `origin/${targetBranch}`;
    }
    if (await Utils.gitRefExists(`refs/heads/${targetBranch}`, { cwd: repoRoot })) {
      return targetBranch;
    }
  }
  return "HEAD";
}

/**
 * Per-process cache over {@link resolveBaseRef}, keyed by repo root + branch.
 *
 * Batch mode resolves the same base for every task; without this each entry
 * pays a network fetch round-trip against an unchanged remote. The promise is
 * cached (not the value) so concurrent entries share one in-flight resolution,
 * and a rejection evicts the entry so a later task can retry.
 */
const baseRefCache = new Map<string, Promise<string>>();

async function resolveBaseRefCached(
  targetBranch: string | undefined,
  repoRoot: string,
  verbose?: boolean,
): Promise<string> {
  const key = `${repoRoot}\u0000${targetBranch ?? ""}`;
  let resolved = baseRefCache.get(key);
  if (!resolved) {
    resolved = resolveBaseRef(targetBranch, repoRoot, verbose);
    baseRefCache.set(key, resolved);
    try {
      await resolved;
    } catch (error) {
      baseRefCache.delete(key);
      throw error;
    }
  }
  return resolved;
}

/**
 * Put the current task run into an isolated git worktree.
 *
 * Moves the process cwd into a fresh disposable worktree (via the injected
 * {@link WorktreeIsolationDeps.chdir}) and returns a handle whose `finish()`
 * preserves results and removes the worktree. Returns null — leaving the cwd
 * untouched — when isolation does not apply:
 * - disabled via flag/env (`--no-worktree-isolation`, DEVINTERN_NO_WORKTREE_ISOLATION)
 * - already inside an isolated run (marker env var)
 * - not a git repository (graceful fallback with a notice)
 * - worktree creation fails (loud warning, legacy in-place run)
 *
 * Callers MUST call `finish()` exactly once per returned handle; see the
 * lifecycle notes at the top of this file.
 */
export async function enterTaskWorktreeIsolation(
  options: EnterTaskWorktreeOptions,
  deps: WorktreeIsolationDeps = defaultDeps,
): Promise<WorktreeIsolationHandle | null> {
  if (isWorktreeIsolationDisabled()) {
    return null;
  }
  if (process.env[WORKTREE_ISOLATION_MARKER_ENV]) {
    return null;
  }

  const originalCwd = deps.cwd();

  if (!(await Utils.isGitRepository(originalCwd))) {
    console.log(
      `ℹ️  ${originalCwd} is not a git repository — running directly without worktree isolation.`,
    );
    return null;
  }

  const toplevel = await Utils.executeGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: originalCwd,
  });
  if (!toplevel.success || !toplevel.output) {
    console.log("⚠️  Could not locate the repository root — running directly without isolation.");
    return null;
  }
  const repoRoot = toplevel.output;

  const worktreeRoot =
    process.env[WORKTREE_ISOLATION_DIR_ENV] || join(repoRoot, ".devintern-code", "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  ensureStateDirIgnored(repoRoot);
  sweepOrphanedTaskWorktrees(worktreeRoot, repoRoot, { verbose: options.verbose });

  const baseRef = await resolveBaseRefCached(options.targetBranch, repoRoot, options.verbose);

  const safeKey = sanitizeTaskKeyForPath(options.taskKey);
  let worktreePath = join(
    worktreeRoot,
    `${WORKTREE_NAME_PREFIX}-${safeKey}-${process.pid}-${Date.now()}`,
  );
  while (existsSync(worktreePath)) {
    worktreePath = join(
      worktreeRoot,
      `${WORKTREE_NAME_PREFIX}-${safeKey}-${process.pid}-${Date.now() + 1}`,
    );
  }

  const added = await Utils.executeGitCommand(
    ["worktree", "add", "--detach", worktreePath, baseRef],
    { cwd: repoRoot, verbose: options.verbose },
  );
  if (!added.success) {
    console.warn(`⚠️  Could not create an isolated worktree (${added.error}).`);
    console.warn("   Running directly in your working directory — commit or stash to be safe.");
    return null;
  }

  linkSharedConfigDir(worktreePath, repoRoot, deps.symlink ?? symlinkSync);

  const handle = new WorktreeIsolation(worktreePath, repoRoot, originalCwd, deps, options);
  activeHandle = handle;
  installExitGuard();
  process.env[WORKTREE_ISOLATION_MARKER_ENV] = worktreePath;

  try {
    deps.chdir(worktreePath);
  } catch (error) {
    delete process.env[WORKTREE_ISOLATION_MARKER_ENV];
    activeHandle = null;
    handle.finish("failed");
    console.warn(`⚠️  Could not enter the isolated worktree: ${(error as Error).message}`);
    console.warn("   Running directly in your working directory.");
    return null;
  }

  console.log(`🏝️  Running isolated in worktree: ${worktreePath}`);
  console.log(`   Based on '${baseRef}'. Your working directory stays untouched.`);

  return handle;
}

/** Test seam: whether an isolated run is currently active in this process. */
export function hasActiveWorktreeIsolation(): boolean {
  return activeHandle !== null;
}
