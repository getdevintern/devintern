import { resolveConfigDir } from "@devintern/utils";
import { resolveWorkspaceDir, workspaceCodeStateDir } from "../workspace/paths";

/** Marks a task subprocess launched by the workspace supervisor. */
export const WORKER_SUBPROCESS_ENV = "DEVINTERN_WORKER_SUBPROCESS";
/**
 * Narrow marker for a subprocess that must skip the checkout's
 * `.devintern-code/.env` without being treated as a worker subprocess (so its
 * runtime state and license/auth session keep resolving to the project config
 * dir). Used by the standalone dashboard's manual automation spawn, whose
 * composed entry selection must not be re-populated by dotenv.
 */
export const SKIP_PROJECT_ENV_ENV = "DEVINTERN_SKIP_PROJECT_ENV";
let manualWorkspaceStateDir: string | null = null;

export function isWorkerSubprocess(): boolean {
  return process.env[WORKER_SUBPROCESS_ENV] === "1";
}

/** Whether this process must not load the checkout's local `.env`. */
export function shouldSkipProjectEnv(): boolean {
  return isWorkerSubprocess() || process.env[SKIP_PROJECT_ENV_ENV] === "1";
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
