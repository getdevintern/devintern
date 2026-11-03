/**
 * Messages and process probes for injected-task startup recovery.
 *
 * Kept out of `workspace-worker.ts` so the daemon module stays within its
 * lint budget while the recovery rules remain independently readable.
 */

import { execFileSync } from "child_process";

import type { InjectedTask } from "../state/injected-tasks";

/** Message used when no safe resume state exists for an interrupted row. */
export const INJECTED_INTERRUPTED_MESSAGE = "worker restarted while this task was running";

/**
 * How far a probed process's start time may differ from the spawn time recorded
 * on the row. `ps` reports whole seconds, so an exact match is not available.
 */
const CHILD_START_TOLERANCE_MS = 2_000;

/** Actionable message when a row's automatic-resume budget is exhausted. */
export function injectedAutoResumeExhaustedMessage(
  taskKey: string,
  runId: number,
  branch: string,
): string {
  return (
    `worker restarted again while this task was running; automatic resume budget exhausted ` +
    `(run #${runId}, branch '${branch}'). Resume it manually with ` +
    `\`devintern worker add --resume ${taskKey}\` or the dashboard Re-queue action.`
  );
}

/** Manual re-queue refusal while the interrupted attempt's child is still alive. */
export function injectedChildStillRunningMessage(taskKey: string, pid: number): string {
  return (
    `worker restarted while this task was running and its child process (pid ${pid}) is still ` +
    `alive; re-queueing would force-remove the worktree that process is working in. Stop pid ` +
    `${pid} (or let it finish), then run \`devintern worker add --resume ${taskKey}\` or the ` +
    `dashboard Re-queue action. If that child finishes successfully, no resume is needed: the ` +
    `next worker startup settles the row from its run record.`
  );
}

/** Startup notice while the interrupted attempt's child is still running. */
export function injectedChildStillRunningNotice(taskKey: string, pid: number): string {
  return (
    `injected task ${taskKey} is still running its previous attempt (child pid ${pid}); leaving ` +
    `the row running and re-checking at the next startup. A child that succeeds needs no ` +
    `resume, and starting a second agent on the same branch is not safe while it runs.`
  );
}

/**
 * Start time of a process in epoch milliseconds, or `undefined` when the host
 * cannot report it (no `ps`, permission denied, process already gone).
 */
export function readProcessStartTime(pid: number): number | undefined {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    const startedAt = Date.parse(output);
    return Number.isFinite(startedAt) ? startedAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process at `pid` is the one spawned for the row.
 *
 * A recorded pid outlives the process it names: the OS recycles pids, and a
 * reboot restarts the table while the row survives in `queue.db`. The recorded
 * spawn time is compared with the live process's start time, so a recycled pid
 * is treated as dead instead of blocking the row (or telling the operator to
 * kill an unrelated process). Rows written before the start-time column keep
 * the conservative "assume it is the child" behavior.
 */
function isSameChildProcess(pid: number, recordedAt: number | undefined): boolean {
  if (recordedAt === undefined) return true;
  const startedAt = readProcessStartTime(pid);
  if (startedAt === undefined) return true;
  return Math.abs(startedAt - recordedAt) <= CHILD_START_TOLERANCE_MS;
}

/**
 * Whether an interrupted task child (or its detached process group) still
 * exists. EPERM means it exists but belongs to another user.
 */
function isInjectedChildAlive(pid: number): boolean {
  const probe = (target: number): boolean => {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  // Task children are spawned detached on non-Windows platforms, so the child
  // pid is also its process-group id; a surviving grandchild keeps the group.
  if (process.platform !== "win32" && probe(-pid)) return true;
  return probe(pid);
}

/**
 * Whether the child recorded on an interrupted row is still alive *and* still
 * the same process. Safe to call from any worker/dashboard/CLI process; it only
 * probes, never mutates the row.
 */
export function interruptedChildStillRunning(task: InjectedTask): boolean {
  if (task.childPid === undefined) return false;
  if (!isInjectedChildAlive(task.childPid)) return false;
  return isSameChildProcess(task.childPid, task.childStartedAt);
}

/**
 * Startup guard for a hard-killed worker's detached child.
 *
 * The child is the same task, so it may still finish and record a successful
 * run. Settling the row `failed` here would (a) discard that outcome and
 * (b) point the operator's `--resume` at a fresh run that seeds
 * `feature/local-<slug>-attempt-2` and opens a duplicate PR. Leave the row
 * `running` instead: the next startup either finds the child gone (and resumes
 * or fails from the run record) or records the successful run `done`.
 *
 * @returns true when recovery must skip the row for this startup
 */
export function skipInterruptedChildRunning(
  orphan: InjectedTask,
  warn: typeof console.warn,
): boolean {
  if (!interruptedChildStillRunning(orphan)) return false;
  const message = injectedChildStillRunningNotice(orphan.taskKey, orphan.childPid!);
  warn(`⚠️  [fleet] ${message}`);
  return true;
}
