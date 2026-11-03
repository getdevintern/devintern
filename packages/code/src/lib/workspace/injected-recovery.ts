/**
 * Messages and process probes for injected-task startup recovery.
 *
 * Kept out of `workspace-worker.ts` so the daemon module stays within its
 * lint budget while the recovery rules remain independently readable.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";

import { parseEnvInteger } from "../config/env-integer";
import { InjectedTaskStore, succeededRunCoversClaim } from "../state/injected-tasks";
import type { InjectedTask } from "../state/injected-tasks";
import { RunStore } from "../state/run-recorder";
import type { RunRecord } from "../state/run-recorder";
import { latestScopedTaskRun, resolveSessionPickup } from "../state/session-pickup";
import type { SessionPickupRunStore } from "../state/session-pickup";
import { Utils } from "../utils";
import { workspaceDbPath } from "./paths";
import { RepoManager } from "./repo-manager";

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

/**
 * Automatic resumes allowed per injected-task row across worker restarts:
 * `WORKER_INJECTED_AUTO_RESUME_LIMIT`, default 1. `0` disables automatic
 * resume (interrupted rows still settle `failed` with the manual fallback).
 */
function injectedAutoResumeLimit(): number {
  return parseEnvInteger("WORKER_INJECTED_AUTO_RESUME_LIMIT", 1, { min: 0 });
}

/** Checkout to probe an injected row's repo through: bare clone, else base worktree. */
function injectedRepoCwd(repoManager: RepoManager, repo: string): string | undefined {
  const bareCwd = repoManager.bareClonePath(repo);
  if (existsSync(bareCwd)) return bareCwd;
  const baseCwd = repoManager.baseWorktreePath(repo);
  return existsSync(baseCwd) ? baseCwd : undefined;
}

/**
 * Startup recovery for injected rows left `running` by a dead worker.
 *
 * Rows whose latest terminal `origin: "local"` run has complete resumable state
 * (recorded branch, implementation report, and — when the workspace can probe
 * it — a branch that still exists) are returned to `pending` so the next run
 * inherits that branch and report through the normal session-pickup path. Every
 * other row settles `failed`: silently starting a fresh run for an interrupted
 * task whose side effects are unknown is not safe.
 *
 * A run that was interrupted before its report existed (or whose delivery
 * halted afterwards) still has evidence in its branch: {@link
 * createInjectedCommitProbe} is consulted as a fallback, so landed commits
 * resume the task instead of discarding work the agent already committed. The
 * report stays authoritative when it exists — a report with an uncommitted
 * branch is resumed and delivered by the replacement run, matching the
 * pre-existing behavior of this path.
 *
 * Automatic resumes are bounded durably per row (`options.maxAutoResumes`,
 * default {@link injectedAutoResumeLimit}) so a restart loop cannot re-run the
 * same task forever. Exhausting the bound settles the row `failed` with a
 * message naming the run and the manual fallback; `worker add --resume` and the
 * dashboard re-queue action keep working.
 *
 * Call this only while holding the workspace singleton lock (the worker's
 * post-lock `beforeAcquirersStart` hook). A second `devintern worker` that has
 * not yet acquired the lock would otherwise fail the still-live worker's
 * `running` rows before exiting; the live worker's later `finish` is guarded
 * by `WHERE status = 'running'`, so the successful task would be recorded
 * `failed`.
 */
export interface InjectedTaskRecoveryOptions {
  /** Run store used to reconstruct the interrupted run's session. */
  runStore?: SessionPickupRunStore & { reapOrphanedRuns?: () => number };
  /**
   * Optional branch-existence probe scoped to the row's repo. Absent (or a
   * missing base worktree) trusts the recorded branch, matching
   * `recoverOrphanedTaskRuns`.
   */
  branchExists?: (branch: string, task: InjectedTask) => boolean | Promise<boolean>;
  /**
   * Optional probe for commits on the recorded branch ahead of its base. Used
   * only when the run has no usable report, or when its implementation stage is
   * `failed` (a delivery halt after the early success record): those attempts
   * can hold real commits with nothing else to prove it.
   */
  hasLandedCommits?: (branch: string, task: InjectedTask) => boolean | Promise<boolean>;
  /** Automatic resumes allowed per row; defaults to the worker env setting. */
  maxAutoResumes?: number;
  log?: typeof console.log;
  warn?: typeof console.warn;
}

export async function recoverOrphanedInjectedTasks(
  store: InjectedTaskStore,
  options: InjectedTaskRecoveryOptions = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const limit = options.maxAutoResumes ?? injectedAutoResumeLimit();

  for (const orphan of store.listRunning()) {
    // A hard kill can leave the detached task child alive. That child is the
    // same task and may still finish successfully, so resume only once it is
    // gone (a mismatched start time means its pid was recycled).
    if (skipInterruptedChildRunning(orphan, warn)) {
      continue;
    }
    // Injected runs are local origin/tracker, pinned to the row's repo.
    const scope = { origin: "local", tracker: "local", repo: orphan.repo } as const;
    let decision: Awaited<ReturnType<typeof resolveSessionPickup>> = {
      kind: "fresh",
      reason: "run store unavailable",
    };
    let latestRun: RunRecord | undefined;
    if (options.runStore) {
      try {
        latestRun = latestScopedTaskRun(options.runStore, orphan.taskKey, scope);
        // Ordering or a failed sweep can leave the latest run `in_progress`.
        // Reap it (idempotent; only touches runs still `in_progress`) so an
        // interrupted attempt is evaluated as terminal, not as a live run.
        if (latestRun?.status === "in_progress") {
          options.runStore.reapOrphanedRuns?.();
          latestRun = latestScopedTaskRun(options.runStore, orphan.taskKey, scope);
        }
        decision = await resolvePickup({ runStore: options.runStore, orphan, options });
      } catch (error) {
        warn(
          `⚠️  [fleet] could not evaluate session pickup for injected task ${orphan.taskKey}: ` +
            `${(error as Error).message}`,
        );
      }
    }

    if (decision.kind === "resume") {
      const { runId, branch } = decision.session;
      const resumed = store.autoResume(orphan.id, {
        limit,
        exhaustedMessage: injectedAutoResumeExhaustedMessage(orphan.taskKey, runId, branch),
      });
      if (!resumed) continue;
      if (resumed.resumed) {
        log(
          `♻️  [fleet] auto-resuming interrupted injected task ${orphan.taskKey} ` +
            `(run #${runId}, branch '${branch}')`,
        );
      } else {
        warn(
          `⚠️  [fleet] injected task ${orphan.taskKey} was interrupted by a worker restart ` +
            `and its automatic resume budget is exhausted; run ` +
            `\`devintern worker add --resume ${orphan.taskKey}\` or use the dashboard Re-queue action`,
        );
      }
      continue;
    }
    // Only a run that started after this claim proves the attempt finished:
    // `--resume` re-queues settled rows, so a pre-restart success is stale.
    if (succeededRunCoversClaim(latestRun, orphan.startedAt)) {
      store.finish(orphan.id, "done", `run #${latestRun!.id} already succeeded before the restart`);
      continue;
    }
    store.finish(orphan.id, "failed", INJECTED_INTERRUPTED_MESSAGE);
    warn(`⚠️  [fleet] injected task ${orphan.taskKey} was interrupted by a worker restart`);
  }
}

/**
 * Decide pickup for one interrupted row.
 *
 * The report-backed decision is tried first because a report is the stronger
 * signal: a run interrupted after the agent session but before its commit can
 * be resumed and delivered by the replacement run. When that decision is
 * `fresh` — no report, or a stage that already recorded a halted delivery —
 * ask again with the commit probe, which can prove resumable work on its own.
 */
async function resolvePickup(input: {
  runStore: NonNullable<InjectedTaskRecoveryOptions["runStore"]>;
  orphan: InjectedTask;
  options: InjectedTaskRecoveryOptions;
}): Promise<Awaited<ReturnType<typeof resolveSessionPickup>>> {
  const { runStore, orphan, options } = input;
  const scope = { origin: "local", tracker: "local", repo: orphan.repo } as const;
  const baseOptions = {
    runStore,
    taskKey: orphan.taskKey,
    scope,
    ...(options.branchExists
      ? { branchExists: (branch: string) => options.branchExists!(branch, orphan) }
      : {}),
  };
  const decision = await resolveSessionPickup(baseOptions);
  if (decision.kind !== "fresh" || !options.hasLandedCommits) {
    return decision;
  }
  return resolveSessionPickup({
    ...baseOptions,
    hasLandedCommits: ({ branch }) => options.hasLandedCommits!(branch, orphan),
  });
}

/**
 * Compose the post-lock startup hook: recover injected orphans (safe now that
 * this process owns the workspace lock), then run the caller's own hook.
 */
export function makeBeforeAcquirersStart(
  store: InjectedTaskStore,
  options: InjectedTaskRecoveryOptions & { next?: () => Promise<void> | void } = {},
): () => Promise<void> {
  return async () => {
    await recoverOrphanedInjectedTasks(store, options);
    await options.next?.();
  };
}

/**
 * Branch-existence probe for injected-row auto-resume.
 *
 * Injected-only workspaces never materialize the per-repo base worktree (the
 * executor adds only a disposable task worktree), so probe the bare clone,
 * which always exists after the repo's first run. Link worktrees share the
 * bare clone's ref store, so both local task branches and fetched origin refs
 * are visible there. Fall back to the base worktree when present, and treat a
 * completely missing repo as "unknown" — refuse the resume and settle the row
 * `failed` rather than trusting a branch that cannot be verified.
 */
export function createInjectedBranchExistsProbe(
  workspaceDir: string,
): (branch: string, task: InjectedTask) => Promise<boolean> {
  const repoManager = new RepoManager(workspaceDir);
  return async (branch, task) => {
    const repoCwd = injectedRepoCwd(repoManager, task.repo);
    if (!repoCwd) return false;
    return (
      (await Utils.gitRefExists(`refs/heads/${branch}`, { cwd: repoCwd })) ||
      (await Utils.gitRefExists(`refs/remotes/origin/${branch}`, { cwd: repoCwd }))
    );
  };
}

/**
 * Commit probe for injected-row auto-resume.
 *
 * A run interrupted before its report was written — or one whose delivery
 * halted after the early success record — has no report to resume from, but its
 * branch may hold the agent's commits. Verify them against every plausible base
 * so the row resumes instead of restarting the task on a new `-attempt-2`
 * branch. Bases are the clone's cached `origin/HEAD` plus the conventional
 * remote defaults that exist locally: a stale cached value would otherwise let
 * commits belonging to the repo's new default look like the branch's own work.
 * A repo that cannot be inspected reports false, so recovery stays
 * conservative.
 */
export function createInjectedCommitProbe(
  workspaceDir: string,
): (branch: string, task: InjectedTask) => Promise<boolean> {
  const repoManager = new RepoManager(workspaceDir);
  const basesByRepo = new Map<string, Promise<string[]>>();
  const basesFor = (repo: string, repoCwd: string): Promise<string[]> => {
    let pending = basesByRepo.get(repo);
    if (!pending) {
      pending = (async () => {
        const base = await Utils.getCachedDefaultBranch({ cwd: repoCwd });
        const candidates = [base];
        for (const name of ["main", "master"]) {
          if (name === base) continue;
          if (await Utils.gitRefExists(`refs/remotes/origin/${name}`, { cwd: repoCwd })) {
            candidates.push(`origin/${name}`);
          }
        }
        return candidates;
      })();
      basesByRepo.set(repo, pending);
    }
    return pending;
  };
  return async (branch, task) => {
    const repoCwd = injectedRepoCwd(repoManager, task.repo);
    if (!repoCwd) return false;
    for (const baseBranch of await basesFor(task.repo, repoCwd)) {
      if (!(await Utils.hasCommitsAhead(branch, baseBranch, { cwd: repoCwd }))) {
        return false;
      }
    }
    return true;
  };
}

/** Build the production post-lock hook for injected-row startup recovery. */
export function makeStartupInjectedRecovery(
  store: InjectedTaskStore,
  runStore: SessionPickupRunStore,
  workspaceDir: string,
  next?: () => Promise<void> | void,
): () => Promise<void> {
  return makeBeforeAcquirersStart(store, {
    runStore,
    branchExists: createInjectedBranchExistsProbe(workspaceDir),
    hasLandedCommits: createInjectedCommitProbe(workspaceDir),
    next,
  });
}

/**
 * Own the run store for injected-row startup recovery, exposing the hook and a
 * close callback so the worker can release it during shutdown.
 */
export function createInjectedStartupRecovery(
  store: InjectedTaskStore,
  workspaceDir: string,
  next?: () => Promise<void> | void,
): { hook: () => Promise<void>; close: () => void } {
  const runStore = new RunStore(workspaceDbPath(workspaceDir));
  return {
    hook: makeStartupInjectedRecovery(store, runStore, workspaceDir, next),
    close: () => runStore.close(),
  };
}
