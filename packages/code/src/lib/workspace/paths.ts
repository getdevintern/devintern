import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Resolve the workspace home directory.
 *
 * Defaults to `~/.devintern`; `DEVINTERN_WORKSPACE_DIR` overrides it
 * (required by tests, which cannot chdir or touch the real home).
 *
 * @returns Absolute path of the workspace directory.
 */
export function resolveWorkspaceDir(): string {
  const override = process.env.DEVINTERN_WORKSPACE_DIR;
  if (override && override.trim()) {
    return override.trim();
  }
  return join(homedir(), ".devintern");
}

/** Path of the workspace config file (`workspace.toml`). */
export function workspaceConfigPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "workspace.toml");
}

/** Path of the shared workspace `.env` file. */
export function workspaceEnvPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, ".env");
}

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

/** Preserve worker credentials and relay pairing from the old workspace path. */
export function ensureWorkspaceCodeState(workspaceDir: string): void {
  const targetDir = workspaceCodeStateDir(workspaceDir);
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const legacyDir = join(workspaceDir, ".devintern-code");
  for (const name of [".auth-session.json", "relay.json"]) {
    const source = join(legacyDir, name);
    const target = join(targetDir, name);
    if (!existsSync(source) || existsSync(target)) continue;
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }
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

/** Shape of the worker's early startup marker. */
export interface WorkerStartMarker {
  pid: number;
  startedAt: number;
}

/**
 * Write the early startup marker. Failure is only a warning: the marker is an
 * optimization for `--wait`, never a startup requirement.
 */
export function writeWorkerStartMarker(workspaceDir: string, pid: number = process.pid): void {
  try {
    writeFileSync(
      workspaceWorkerStartPath(workspaceDir),
      JSON.stringify({ pid, startedAt: Date.now() }),
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
    };
    if (typeof raw.pid !== "number" || typeof raw.startedAt !== "number") return null;
    return { pid: raw.pid, startedAt: raw.startedAt };
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
