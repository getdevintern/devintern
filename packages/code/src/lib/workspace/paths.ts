import { existsSync } from "fs";
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

/** Path of the workspace-scoped relay connect state (`relay.json`). */
export function workspaceRelayPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "relay.json");
}

/** Path of the central workspace SQLite database. */
export function workspaceDbPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "state", "queue.db");
}

/** Directory holding the worker-managed bare clones (`repos/<name>.git`). */
export function reposDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "repos");
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
