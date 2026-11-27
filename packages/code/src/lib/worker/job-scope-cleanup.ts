/**
 * Stop job scopes a dead worker left behind in its workspace's job slice.
 *
 * Separate from `job-memory.ts` (size) and `job-scope-slice.ts` (which
 * `service.ts` imports, so it cannot import `service.ts` back).
 */

import { spawn } from "child_process";

import { resolveWorkspaceDir } from "../workspace/paths";
import { claimJobScopeSlice, jobScopeSliceName } from "./job-scope-slice";
import { userBusEnv } from "./service";

/** Upper bound for stopping leftover scopes (systemd's default stop timeout is 90 s). */
const LEFTOVER_STOP_TIMEOUT_MS = 120_000;

/**
 * Stop job scopes a previous worker for this workspace left behind.
 *
 * Job scopes live outside the service unit's cgroup, so a worker that was
 * SIGKILLed, crashed, or OOM-stopped cannot stop them itself, and a job tree
 * that detached (setsid) escapes its process-group kill. Call this only while
 * holding the workspace lock, before this process claims the slice: only a
 * lock-holding worker places jobs there (`claimJobScopeSlice`; the standalone
 * dashboard and `webhook serve` keep theirs outside it), so every scope in the
 * slice belongs to a dead or finished worker. Linux only; any failure (no user manager, no
 * `systemctl`, slice not loaded) is ignored.
 *
 * @param env - Worker environment (resolves the workspace and the user bus).
 * @returns True when an active slice was found and stopped.
 */
export async function stopLeftoverJobScopes(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const slice = jobScopeSliceName(resolveWorkspaceDir(env));
  const busEnv = { ...env, ...userBusEnv({ env: env as NodeJS.ProcessEnv }) };
  const active = await runSystemctl(["--user", "is-active", "--quiet", slice], busEnv, 5_000);
  if (!active) return false;
  console.warn(`⚠️  Stopping job scopes left running by a previous worker (${slice})`);
  return runSystemctl(["--user", "stop", slice], busEnv, LEFTOVER_STOP_TIMEOUT_MS);
}

function runSystemctl(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- settled guards a single resolution.
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      finish(false);
    }, timeoutMs);
    try {
      child = spawn("systemctl", args, { stdio: "ignore", env });
    } catch {
      finish(false);
      return;
    }
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Wrap a post-lock startup hook so leftover job scopes are stopped first.
 *
 * @param next - The hook to run afterwards (injected-task recovery).
 * @returns A `beforeAcquirersStart` hook.
 */
export function withLeftoverJobScopeCleanup(
  next: () => Promise<void>,
  env: Record<string, string | undefined> = process.env,
): () => Promise<void> {
  return async () => {
    // The workspace lock is held now, so any scope left in this workspace's
    // job slice belongs to a worker that died without stopping it.
    await stopLeftoverJobScopes(env);
    // From here on this process's job scopes go in the slice (and are stopped
    // with it by the next worker or the unit's ExecStopPost).
    claimJobScopeSlice(resolveWorkspaceDir(env));
    await next();
  };
}
