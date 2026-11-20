import { resolveConfigDir } from "@devintern/utils";
import { dirname } from "path";

import { hasWorkspace, resolveWorkspaceDir, workspaceCodeStateDir } from "../workspace/paths";

/** Marks a task subprocess launched by the workspace supervisor. */
export const WORKER_SUBPROCESS_ENV = "DEVINTERN_WORKER_SUBPROCESS";
let manualWorkspaceStateDir: string | null = null;

export function isWorkerSubprocess(): boolean {
  return process.env[WORKER_SUBPROCESS_ENV] === "1";
}

/** Resolve the normal project config directory, independent of worker state. */
export function resolveProjectConfigDir(startDir: string = process.cwd()): string {
  return resolveConfigDir({ configDirName: ".devintern-code", startDir });
}

/** Use the workspace session for a manual command targeting a registered repo. */
export function setManualWorkspaceStateDir(workspaceDir: string | null): void {
  manualWorkspaceStateDir = workspaceDir;
}

/**
 * Directory holding the auth session and license cache.
 *
 * Worker task subprocesses share the workspace session and license cache. A
 * command run from the workspace home itself (whose nearest config dir would
 * be the legacy `<workspace>/.devintern-code/`) uses the same `state/code/`.
 */
export function resolveRuntimeStateDir(startDir: string = process.cwd()): string {
  if (isWorkerSubprocess()) return workspaceCodeStateDir(resolveWorkspaceDir());
  if (manualWorkspaceStateDir) return workspaceCodeStateDir(manualWorkspaceStateDir);
  const projectConfigDir = resolveProjectConfigDir(startDir);
  const owner = dirname(projectConfigDir);
  return hasWorkspace(owner) ? workspaceCodeStateDir(owner) : projectConfigDir;
}
