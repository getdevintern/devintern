/**
 * Stop job scopes a finished process left behind in a job slice.
 *
 * Separate from `job-memory.ts` (size) and `job-scope-slice.ts` (which
 * `service.ts` imports, so it cannot import `service.ts` back).
 */

import { spawn, spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";

import { resolveWorkspaceDir } from "../workspace/paths";
import { describeJobMemoryPlan, resolveJobMemoryPlanForStartup } from "./job-memory";
import { claimJobScopeSlice, jobScopeClaimMarkerPath, jobScopeSliceName } from "./job-scope-slice";
import type { JobScopeSurface } from "./job-scope-slice";
import { userBusEnv } from "./service";

/** Upper bound for stopping leftover scopes (systemd's default stop timeout is 90 s). */
const LEFTOVER_STOP_TIMEOUT_MS = 120_000;
/** Bound for the exit-path stop: never delay process teardown on a wedged manager. */
const WEBHOOK_EXIT_STOP_TIMEOUT_MS = 10_000;

/**
 * Record this process's claim of a slice for the unit's `ExecStopPost=`.
 *
 * The marker holds systemd's `INVOCATION_ID`, which is unique per unit start
 * and visible to `ExecStopPost=`. Without the marker a start that fails before
 * claiming the slice (another worker holds the lock, a config error) would
 * still run the unit's stop and kill that worker's in-flight jobs. A process
 * not started by a unit (manual `devintern worker`, `webhook serve`) removes
 * any earlier marker, so a stale unit marker can never authorize stopping the
 * slice it just claimed.
 *
 * @param workspaceDir - Workspace home whose slice was claimed.
 * @param env - Environment carrying `INVOCATION_ID` under a service manager.
 * @param surface - Surface claiming the slice (defaults to the worker).
 * @returns True when a marker was written for this invocation.
 */
export function recordJobScopeClaim(
  workspaceDir: string,
  env: Record<string, string | undefined> = process.env,
  surface: JobScopeSurface = "worker",
): boolean {
  const marker = jobScopeClaimMarkerPath(workspaceDir, surface);
  const invocation = env.INVOCATION_ID?.trim();
  try {
    if (!invocation) {
      rmSync(marker, { force: true });
      return false;
    }
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, invocation, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    // Best effort: a missing marker only skips the unit's crash cleanup.
    return false;
  }
}

/**
 * Stop job scopes a previous worker for this workspace left behind.
 *
 * Job scopes live outside the service unit's cgroup, so a worker that was
 * SIGKILLed, crashed, or OOM-stopped cannot stop them itself, and a job tree
 * that detached (setsid) escapes its process-group kill. Call this only while
 * holding the workspace lock, before this process claims the slice: only a
 * lock-holding worker places jobs there (`claimJobScopeSlice`; the standalone
 * dashboard and `webhook serve` own separate/absent slices), so every scope in
 * the slice belongs to a dead or finished worker. Linux only; any failure (no
 * user manager, no `systemctl`, slice not loaded) is ignored.
 *
 * `systemctl is-active` alone is not enough: the startup support probe starts a
 * scope in this slice (`systemd-run --slice=`), and systemd keeps the empty
 * slice active. Stopping it on every clean start logged a false leftover
 * warning (and could stop a detached retry that shared the slice). The slice is
 * only stopped when it still holds an active scope unit.
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
  // Undefined means the query failed; keep the conservative stop so a wedged
  // query cannot leave a dead worker's runaway job running.
  if ((await sliceHasLiveScopes(slice, busEnv)) === false) return false;
  console.warn(`⚠️  Stopping job scopes left running by a previous worker (${slice})`);
  return runSystemctl(["--user", "stop", slice], busEnv, LEFTOVER_STOP_TIMEOUT_MS);
}

/**
 * Whether a slice still contains an active scope unit.
 *
 * systemd keeps an empty slice active (the startup probe leaves one behind), so
 * membership is checked against the scope units themselves: list the active
 * scopes and match their `Slice=` property.
 *
 * @param slice - Slice unit name.
 * @param env - Environment carrying the user bus.
 * @returns True/false, or undefined when `systemctl` could not answer.
 */
async function sliceHasLiveScopes(
  slice: string,
  env: Record<string, string | undefined>,
): Promise<boolean | undefined> {
  const listing = await runSystemctlCapture(
    ["--user", "list-units", "--type=scope", "--no-legend", "--plain", "--no-pager"],
    env,
    5_000,
  );
  if (listing === undefined) return undefined;
  const names: string[] = [];
  for (const line of listing.split("\n")) {
    const name = line.trim().split(/\s+/)[0];
    if (name?.endsWith(".scope")) names.push(name);
  }
  if (names.length === 0) return false;
  const properties = await runSystemctlCapture(
    ["--user", "show", "-p", "Slice", "--no-pager", ...names],
    env,
    5_000,
  );
  if (properties === undefined) return undefined;
  return properties.split("\n").some((line) => line.trim() === `Slice=${slice}`);
}

/**
 * Stop the webhook server's job slice from its process exit path.
 *
 * `webhook serve` has no drain: CI-fix children run in a slice of their own
 * so a stop that reaches the server also stops its jobs (hand-written units
 * otherwise only kill the server's cgroup). This must be synchronous, because
 * process exit handlers cannot await work. Linux only; a missing slice or
 * manager is ignored.
 *
 * @param env - Webhook server environment (resolves the workspace and user bus).
 * @returns True when the stop command succeeded.
 */
export function stopWebhookJobScopesSync(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (process.platform !== "linux") return false;
  const slice = jobScopeSliceName(resolveWorkspaceDir(env), "webhook");
  const busEnv = { ...env, ...userBusEnv({ env: env as NodeJS.ProcessEnv }) };
  try {
    return (
      spawnSync("systemctl", ["--user", "stop", slice], {
        stdio: "ignore",
        env: busEnv,
        timeout: WEBHOOK_EXIT_STOP_TIMEOUT_MS,
      }).status === 0
    );
  } catch {
    return false;
  }
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
 * Run `systemctl` and capture stdout.
 *
 * @param args - Arguments after the binary name.
 * @param env - Environment carrying the user bus.
 * @param timeoutMs - Bound for a wedged manager.
 * @returns The output, or undefined on a missing binary, non-zero exit, or timeout.
 */
function runSystemctlCapture(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    let stdout = "";
    const finish = (output: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- settled guards a single resolution.
      resolve(output);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      finish(undefined);
    }, timeoutMs);
    try {
      child = spawn("systemctl", args, { stdio: ["ignore", "pipe", "ignore"], env });
    } catch {
      finish(undefined);
      return;
    }
    child.stdout?.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code === 0 ? stdout : undefined));
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
    // Authorize the unit's ExecStopPost for this invocation only; a unit start
    // that never reached this hook must not stop a manual worker's jobs.
    recordJobScopeClaim(resolveWorkspaceDir(env), env);
    await next();
  };
}

/**
 * Resolve the startup plan and log it, so the effective cap is in the worker
 * log before the first job.
 *
 * @param surface - Slice the process claims; see `resolveJobMemoryPlanForStartup`.
 */
export async function logJobMemoryPlan(surface: JobScopeSurface): Promise<void> {
  console.log(
    `🧠 ${describeJobMemoryPlan(await resolveJobMemoryPlanForStartup(process.env, surface))}`,
  );
}
