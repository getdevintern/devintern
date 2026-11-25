import { homedir } from "node:os";
import { join } from "node:path";

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve the DevIntern workspace home.
 *
 * `DEVINTERN_WORKSPACE_DIR` wins when set (non-default workspaces, tests);
 * otherwise `~/.devintern`.
 *
 * @param env - Environment to read (defaults to `process.env`)
 */
export function resolveWorkspaceDir(env: EnvLike = process.env): string {
  const override = env.DEVINTERN_WORKSPACE_DIR?.trim();
  return override || join(homedir(), ".devintern");
}

/** Path of the workspace config file (`workspace.toml`). */
export function workspaceConfigPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "workspace.toml");
}

/** Path of the shared workspace `.env` file. */
export function workspaceEnvPath(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, ".env");
}
