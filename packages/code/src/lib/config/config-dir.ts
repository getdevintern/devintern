import { resolveConfigDir } from "@devintern/utils";
import { resolveWorkspaceDir, workspaceCodeStateDir } from "../workspace/paths";

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

/** Worker task subprocesses share the workspace session and license cache. */
export function resolveRuntimeStateDir(startDir: string = process.cwd()): string {
  return isWorkerSubprocess()
    ? workspaceCodeStateDir(resolveWorkspaceDir())
    : manualWorkspaceStateDir
      ? workspaceCodeStateDir(manualWorkspaceStateDir)
      : resolveProjectConfigDir(startDir);
}
