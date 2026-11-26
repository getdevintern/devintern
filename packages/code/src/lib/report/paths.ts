/**
 * Local report paths.
 *
 * The public report API must not import `@devintern/utils` or the CLI's
 * workspace helpers, so this module mirrors the one rule it needs: reports
 * and the run database live in the workspace home (`DEVINTERN_WORKSPACE_DIR`,
 * default `~/.devintern`). CLI entry points pass the exact runtime state
 * directory instead.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Workspace home, matching `resolveWorkspaceDir()` in the CLI. */
export function reportWorkspaceDir(): string {
  const override = process.env.DEVINTERN_WORKSPACE_DIR?.trim();
  return override ? override : join(homedir(), ".devintern");
}

/** Resolve the report config directory (the workspace's `state/code/` unless supplied). */
export function resolveReportConfigDir(configDir?: string): string {
  if (configDir?.trim()) return resolve(configDir.trim());
  return join(reportWorkspaceDir(), "state", "code");
}

/** Resolve the local report spool directory. */
export function resolveReportDir(configDir?: string): string {
  return join(resolveReportConfigDir(configDir), "reports");
}
