import { createHash } from "crypto";
import { join, resolve } from "path";

/**
 * Long-lived DevIntern process whose job scopes get their own slice.
 *
 * The worker and `webhook serve` can run for the same workspace at the same
 * time, so one surface's startup/stop cleanup must never stop the other's
 * in-flight jobs. Each surface therefore owns a distinct slice.
 */
export type JobScopeSurface = "worker" | "webhook";

/**
 * Name of the systemd user slice that holds one surface's job scopes.
 *
 * Job scopes are not bound to the surface's unit (binding stopped them before
 * the worker's drain could finish), so they need a stable home that can be
 * stopped after a hard kill. The worker stops its slice at startup (after it
 * owns the workspace lock) and the installed unit stops it in `ExecStopPost=`;
 * `webhook serve` stops its slice when the process exits and the rendered
 * unit (when `listen` is set) stops it in `ExecStopPost=` too.
 *
 * Shared by `job-memory.ts` and `service.ts`, so it lives in its own module to
 * keep both free of an import cycle.
 *
 * @param workspaceDir - Workspace home the surface serves.
 * @param surface - Which surface's slice (defaults to the worker).
 * @returns A slice unit name, e.g. `devintern-jobs-0123456789ab.slice`.
 */
export function jobScopeSliceName(
  workspaceDir: string,
  surface: JobScopeSurface = "worker",
): string {
  const hash = createHash("sha256").update(resolve(workspaceDir)).digest("hex").slice(0, 12);
  return surface === "worker"
    ? `devintern-jobs-${hash}.slice`
    : `devintern-webhook-jobs-${hash}.slice`;
}

let claimed: { workspaceDir: string; surface: JobScopeSurface } | undefined;

/**
 * File name (relative to the workspace home) that records which unit
 * invocation claimed a slice.
 *
 * `ExecStopPost=` runs even when the unit fails before the worker took the
 * lock, so an unconditional `systemctl --user stop` there would kill a manual
 * worker's in-flight jobs. The worker writes its `INVOCATION_ID` here only
 * after claiming the slice; the unit stops the slice only when the marker
 * still names its own invocation.
 *
 * @param workspaceDir - Workspace home the surface serves.
 * @param surface - Which surface's slice (defaults to the worker).
 */
export function jobScopeClaimMarkerName(
  workspaceDir: string,
  surface: JobScopeSurface = "worker",
): string {
  return `${jobScopeSliceName(workspaceDir, surface)}.claim`;
}

/**
 * Absolute path of the per-invocation slice claim marker under the workspace
 * `state/` directory (shared with `ExecStopPost=` via the unit's
 * `WorkingDirectory=`).
 *
 * @param workspaceDir - Workspace home the surface serves.
 * @param surface - Which surface's slice (defaults to the worker).
 */
export function jobScopeClaimMarkerPath(
  workspaceDir: string,
  surface: JobScopeSurface = "worker",
): string {
  return join(resolve(workspaceDir), "state", jobScopeClaimMarkerName(workspaceDir, surface));
}

/**
 * Mark this process as the owner of `workspaceDir`'s job slice for `surface`.
 *
 * Call only while the surface is the sole long-lived process for that surface
 * and workspace. Until a process claims a slice, its job scopes are placed
 * outside every slice: the standalone dashboard's detached `--force` retries
 * and one-off CLI job runs must not land in a slice that a worker or webhook
 * server stops.
 *
 * @param workspaceDir - Workspace home whose jobs this process spawns.
 * @param surface - Surface claiming the slice (defaults to the worker).
 */
export function claimJobScopeSlice(
  workspaceDir: string,
  surface: JobScopeSurface = "worker",
): void {
  claimed = { workspaceDir: resolve(workspaceDir), surface };
}

/**
 * `systemd-run` slice arguments for a job spawned for `workspaceDir`: this
 * process's claimed slice when it owns one for that workspace, else none (the
 * job scope lands in the user manager's default slice).
 *
 * @param workspaceDir - Workspace the job's environment resolves to.
 * @returns `["--slice=<name>"]` or `[]`.
 */
export function jobScopeSliceArgs(workspaceDir: string): string[] {
  if (claimed === undefined || claimed.workspaceDir !== resolve(workspaceDir)) {
    return [];
  }
  return [`--slice=${jobScopeSliceName(claimed.workspaceDir, claimed.surface)}`];
}

/** Forget the slice claim (tests only). */
export function releaseJobScopeSliceForTests(): void {
  claimed = undefined;
}
