import { createHash } from "crypto";
import { resolve } from "path";

/**
 * Name of the systemd user slice that holds one workspace's job scopes.
 *
 * Job scopes are not bound to the worker's service unit (binding stopped them
 * before the drain could finish), so they need a stable home the worker can
 * stop after a hard kill: the worker stops this slice at startup (after it
 * owns the workspace lock) and the installed unit stops it in `ExecStopPost=`.
 * Shared by `job-memory.ts` and `service.ts`, so it lives in its own module to
 * keep both free of an import cycle.
 *
 * @param workspaceDir - Workspace home the worker serves.
 * @returns A slice unit name, e.g. `devintern-jobs-0123456789ab.slice`.
 */
export function jobScopeSliceName(workspaceDir: string): string {
  const hash = createHash("sha256").update(resolve(workspaceDir)).digest("hex").slice(0, 12);
  return `devintern-jobs-${hash}.slice`;
}

let claimedWorkspaceDir: string | undefined;

/**
 * Mark this process as the worker that owns `workspaceDir`'s job slice.
 *
 * Call only while holding the workspace lock. Until a process claims the
 * slice, its job scopes are placed outside it: the standalone dashboard's
 * detached `--force` retries and a standalone `webhook serve` CI fix must not
 * land in a slice that the worker stops at startup and on service stop.
 *
 * @param workspaceDir - Workspace home whose lock this process holds.
 */
export function claimJobScopeSlice(workspaceDir: string): void {
  claimedWorkspaceDir = resolve(workspaceDir);
}

/**
 * `systemd-run` slice arguments for a job spawned for `workspaceDir`: the
 * workspace's job slice when this process is its lock-holding worker, else
 * none (the job scope lands in the user manager's default slice).
 *
 * @param workspaceDir - Workspace the job's environment resolves to.
 * @returns `["--slice=<name>"]` or `[]`.
 */
export function jobScopeSliceArgs(workspaceDir: string): string[] {
  if (claimedWorkspaceDir === undefined || claimedWorkspaceDir !== resolve(workspaceDir)) {
    return [];
  }
  return [`--slice=${jobScopeSliceName(claimedWorkspaceDir)}`];
}

/** Forget the slice claim (tests only). */
export function releaseJobScopeSliceForTests(): void {
  claimedWorkspaceDir = undefined;
}
