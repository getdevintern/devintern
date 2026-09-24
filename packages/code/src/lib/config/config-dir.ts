import { resolveConfigDir } from "@devintern/utils";
import { resolveWorkspaceDir, workspaceCodeStateDir } from "../workspace/paths";

/** Marks a task subprocess launched by the workspace supervisor. */
export const WORKER_SUBPROCESS_ENV = "DEVINTERN_WORKER_SUBPROCESS";

export function isWorkerSubprocess(): boolean {
  return process.env[WORKER_SUBPROCESS_ENV] === "1";
}

/** Resolve the normal project config directory, independent of worker state. */
export function resolveProjectConfigDir(startDir: string = process.cwd()): string {
  return resolveConfigDir({ configDirName: ".devintern-code", startDir });
}

/** Worker task subprocesses share the workspace session and license cache. */
export function resolveRuntimeStateDir(startDir: string = process.cwd()): string {
  return isWorkerSubprocess()
    ? workspaceCodeStateDir(resolveWorkspaceDir())
    : resolveProjectConfigDir(startDir);
}
