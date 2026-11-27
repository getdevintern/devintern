import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";

import { resolveWorkspaceDir, workspaceConfigPath } from "@devintern/workspace";

import { readOwnPidNamespace } from "../lock-manager.ts";

// Shared with `devpm` and the desktop app, so every product resolves the
// same workspace home and files.
export { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "@devintern/workspace";

/**
 * Directory holding worker runtime state: the shared queue database, the auth
 * session, and the license cache. Kept outside repo checkouts.
 */
export function workspaceStateDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "state");
}

/**
 * Directory holding the worker's auth session and license cache. Runtime
 * state lives alongside the shared queue database, outside repo checkouts.
 */
export function workspaceCodeStateDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceStateDir(workspaceDir), "code");
}

/**
 * Per-user files older releases kept in `<workspace>/.devintern-code/` and that
 * now live in {@linkcode workspaceCodeStateDir}.
 */
const LEGACY_WORKSPACE_STATE_FILES = [
  ".auth-session.json",
  "relay.json",
  "github-app.json",
  "license-cache.json",
] as const;

/** Legacy `<workspace>/.devintern-code/` directory, emptied by {@linkcode ensureWorkspaceCodeState}. */
export function legacyWorkspaceConfigDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, ".devintern-code");
}

/** Move one legacy file into place, falling back to copy + delete across devices. */
function moveFile(source: string, target: string): void {
  try {
    renameSync(source, target);
  } catch {
    copyFileSync(source, target);
    rmSync(source, { force: true });
  }
  chmodSync(target, 0o600);
}

/** Whether a SQLite file family (`db`, `-wal`, `-shm`) holds no data at all. */
function isEmptySqliteFamily(dbPath: string): boolean {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].every((path) => {
    try {
      return statSync(path).size === 0;
    } catch {
      return true;
    }
  });
}

/**
 * Move worker credentials and pairing records out of the legacy
 * `<workspace>/.devintern-code/` layer into `state/code/`, then remove it.
 *
 * A file already present in `state/code/` wins and the legacy copy is
 * discarded as superseded. An empty `queue.db` (created by older lookups that
 * resolved the legacy directory) is deleted; a non-empty one, or any file
 * this function does not know, keeps the directory in place.
 */
export function ensureWorkspaceCodeState(workspaceDir: string): void {
  const targetDir = workspaceCodeStateDir(workspaceDir);
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const legacyDir = legacyWorkspaceConfigDir(workspaceDir);
  if (!existsSync(legacyDir)) return;
  for (const name of LEGACY_WORKSPACE_STATE_FILES) {
    const source = join(legacyDir, name);
    if (!existsSync(source)) continue;
    const target = join(targetDir, name);
    if (existsSync(target)) rmSync(source, { force: true });
    else moveFile(source, target);
  }
  const strayDb = join(legacyDir, "queue.db");
  if (existsSync(strayDb) && isEmptySqliteFamily(strayDb)) {
    for (const path of [strayDb, `${strayDb}-wal`, `${strayDb}-shm`]) rmSync(path, { force: true });
  }
  try {
    rmdirSync(legacyDir);
  } catch {
    // Not empty: leave unknown files for the user to inspect.
  }
}

/**
 * Whether `dir` is a workspace home: it has a `workspace.toml`, or worker
 * state from a `worker connect` that ran before the config was written.
 */
export function isWorkspaceHome(dir: string): boolean {
  return existsSync(workspaceConfigPath(dir)) || existsSync(workspaceCodeStateDir(dir));
}

/**
 * Directory holding per-user runtime state (auth session, relay and GitHub App
 * pairing) for the workspace at `workspaceDir`: its `state/code/`, also
 * before the workspace is fully set up.
 */
export function codeStateDirFor(workspaceDir: string): string {
  return workspaceCodeStateDir(resolve(workspaceDir));
}

/** Path of the central workspace SQLite database. */
export function workspaceDbPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceStateDir(workspaceDir), "queue.db");
}

/**
 * Directory holding automation state (managed prompts and agent-maintained
 * cursors). Sandboxed automation agents write their cursor here.
 */
export function automationsDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "automations");
}

/**
 * Path of the worker's early startup marker. The process writes this as soon
 * as it resolves its workspace, before the slow pre-lock startup work (orphan
 * recovery, worktree sweep, push probes), so `worker add --wait` can tell a
 * replacement worker is starting rather than permanently gone.
 */
export function workspaceWorkerStartPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, ".worker.starting");
}

/**
 * Path of the record of which `workspace.toml` version the running worker
 * last applied (and the last rejected reload), read by the dashboard to tell
 * whether a saved edit is live. See `config-reload.ts`.
 */
export function workspaceAppliedConfigPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, ".worker.config-state.json");
}

/**
 * Path of the worker's lifecycle record: whether the last worker process
 * finished starting, stopped cleanly, or failed before it started (and why).
 * `worker status` and `worker service` read it once the lock is gone; see
 * `worker/lifecycle.ts`.
 */
export function workspaceWorkerLifecyclePath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, ".worker.lifecycle.json");
}

/** Shape of the worker's early startup marker. */
export interface WorkerStartMarker {
  pid: number;
  startedAt: number;
  /**
   * PID namespace of the writer (Linux only). A reader in another namespace
   * cannot probe `pid` (it may be invisible or collide with an unrelated
   * process), so it must not trust the pid; see `isReplacementWorkerStarting`.
   */
  pidNamespace?: string;
}

/**
 * Write the early startup marker. Failure is only a warning: the marker is an
 * optimization for `--wait`, never a startup requirement.
 */
export function writeWorkerStartMarker(workspaceDir: string, pid: number = process.pid): void {
  try {
    const pidNamespace = readOwnPidNamespace();
    writeFileSync(
      workspaceWorkerStartPath(workspaceDir),
      JSON.stringify({ pid, startedAt: Date.now(), ...(pidNamespace ? { pidNamespace } : {}) }),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (error) {
    console.warn(`⚠️  Could not write the worker startup marker: ${(error as Error).message}`);
  }
}

/** Read the startup marker, or null when absent/unreadable/malformed. */
export function readWorkerStartMarker(workspaceDir: string): WorkerStartMarker | null {
  try {
    const raw = JSON.parse(readFileSync(workspaceWorkerStartPath(workspaceDir), "utf8")) as {
      pid?: unknown;
      startedAt?: unknown;
      pidNamespace?: unknown;
    };
    if (typeof raw.pid !== "number" || typeof raw.startedAt !== "number") return null;
    return {
      pid: raw.pid,
      startedAt: raw.startedAt,
      ...(typeof raw.pidNamespace === "string" ? { pidNamespace: raw.pidNamespace } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Path of the "run now" sentinel. `devintern worker run-now` creates this
 * file; a running worker consumes it on its next poll tick and drains once,
 * ignoring working windows.
 */
export function workspaceRunNowPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, ".run-now");
}

/** Directory holding the worker-managed bare clones (`repos/<name>.git`). */
export function reposDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "repos");
}

/**
 * Directory holding ad-hoc task prompt files written by `devintern worker add`.
 *
 * Kept in the workspace home (next to `repos/`, `worktrees/`, and the central
 * DB) so an enqueued task survives worker restarts and never depends on a
 * repo checkout being present.
 */
export function injectedTasksDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "injected");
}

/**
 * Directory holding per-run outputs files (`DEVINTERN_RUN_OUTPUTS`): JSONL
 * records an agent run appends for the work it created, ingested into the
 * `run_outputs` table when the run finishes. Under `state/` so sandboxed
 * agents can already write it.
 */
export function runOutputsDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceStateDir(workspaceDir), "run-outputs");
}

/** Outputs file for one run (see {@link runOutputsDir}). */
export function runOutputsPath(
  runId: number,
  workspaceDir: string = resolveWorkspaceDir(),
): string {
  return join(runOutputsDir(workspaceDir), `${runId}.jsonl`);
}

/** Directory holding per-task worktrees (`worktrees/<repo>/<task>`). */
export function worktreesDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "worktrees");
}

/** Directory holding per-repo run lock files. */
export function locksDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "locks");
}

/**
 * Whether a workspace is configured (a `workspace.toml` exists).
 *
 * @returns True when the workspace config file is present.
 */
export function hasWorkspace(workspaceDir: string = resolveWorkspaceDir()): boolean {
  return existsSync(workspaceConfigPath(workspaceDir));
}
