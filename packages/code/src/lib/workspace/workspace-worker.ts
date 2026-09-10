/**
 * Worker workspace (fleet) mode.
 *
 * One `devintern worker` process drives every repo in the workspace: a
 * single fleet task acquirer polls the tracker with the workspace query,
 * routes each ready task to its repo (never guessing), and executes it in a
 * disposable worktree with a per-repo environment. All durable state lives
 * in the central workspace DB.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

import { LockManager } from "../lock-manager";
import { parseEnvInteger } from "../env-integer";
import { TaskPollingAcquirer, runTaskViaCli, workerTaskArgs } from "../task-polling-acquirer";
import type { TaskExecutionResult } from "../task-polling-acquirer";
import type { ChangeDetector } from "../change-detector";
import { createPickupGate } from "../schedule";
import type { PickupGate, ScheduleSnapshot } from "../schedule";
import type { WebhookQueue } from "../webhook-queue";
import type { WorkerState } from "../worker-state";
import {
  loadProjectSettingsFrom,
  recoverOrphanedTaskRuns,
  resolveStatusName,
} from "../orphan-recovery";
import { RunStore } from "../run-recorder";
import { RetryStateStore } from "../retry-state";
import { ScheduledRetryStore } from "../run-retry";
import type { TaskTrackerClient } from "../task-tracker-client";
import { findRepo, findTeam, loadWorkspaceConfig } from "./config";
import type { RepoConfig, TeamConfig, WorkspaceConfig } from "./config";
import {
  buildErrorMonitorEnv,
  buildRepoEnv,
  buildTeamEnv,
  buildTeamTaskEnv,
  parseEnvFile,
} from "./env";
import {
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceDbPath,
  workspaceEnvPath,
  worktreesDir,
  workspaceRunNowPath,
} from "./paths";
import { effectiveRoutingRules, routeTask, routeTaskWithRules, toRoutableTask } from "./router";
import type { RoutableTask } from "./router";
import { WorkspaceConfigReloader } from "./config-reload";
import { createRepoRunLock, createWorkspaceLock, openWorkspaceState } from "./state";
import type { RoutingSkipStore } from "./state";
import { BASE_WORKTREE_NAME, RepoManager } from "./repo-manager";
import { probePushAccess } from "../github-push-probe";
import { AutomationAcquirer } from "../automation-acquirer";
import type { AutomationConfig } from "../automation-config";
import { EstimationAcquirer } from "../estimation-acquirer";
import { RunCoordinator } from "../run-coordinator";
import type { AutomationRunContext } from "../automation-acquirer";
import { flushAnalytics, RUN_ORIGIN_ENV, trackWorkerStarted } from "../analytics";
import { startWorkerFailover } from "../worker-failover";
import { RetryQueueAcquirer } from "./retry-acquirer";

/** Orphaned-run feedback cutoff: `WORKER_ORPHAN_MAX_AGE_HOURS`, default 7 days. */
function orphanMaxAgeMs(): number {
  return parseEnvInteger("WORKER_ORPHAN_MAX_AGE_HOURS", 24 * 7, { min: 0 }) * 60 * 60 * 1000;
}

/**
 * Recover task runs left in progress by a previous (dead) worker before any
 * acquirer picks up new tickets: reap them and give their tickets the
 * graceful-shutdown feedback (failure comment + move back to To Do). Also
 * settles dashboard-scheduled retry rows left `running` by the crash.
 *
 * Replaces the old reap-only startup sweep, which also only ran when GitHub
 * credentials were configured; recovery here covers every workspace.
 */
export async function recoverOrphanedWorkspaceRuns(options: {
  config: WorkspaceConfig;
  workspaceDir: string;
  dbPath: string;
}): Promise<void> {
  const { config, workspaceDir, dbPath } = options;
  const runStore = new RunStore(dbPath);
  let retryStore: RetryStateStore | null = null;
  try {
    const hasTaskOrphans =
      runStore.listRuns({ status: "in_progress", origin: "task", limit: 1 }).length > 0;

    let tracker: TaskTrackerClient | undefined;
    if (hasTaskOrphans && (config.teams?.length ?? 0) === 0) {
      try {
        const { TaskTrackerManager } = await import("../task-tracker-manager");
        tracker = new TaskTrackerManager().getClient();
      } catch (error) {
        console.warn(
          `⚠️  [fleet] could not initialize the tracker to recover orphaned tickets: ${
            (error as Error).message
          }`,
        );
      }
    } else if (hasTaskOrphans) {
      console.warn(
        "⚠️  [fleet] orphaned multi-team task runs cannot be mapped safely from task key alone; " +
          "runs will be reaped without tracker status recovery.",
      );
    }

    // Fleet tasks run in per-repo worktrees, so their status names come from
    // each repo's checked-in settings; the base worktrees hold a checked-out
    // copy. Never triggers git work here — only existing directories are read.
    const settingsDirs = [
      ...config.repos
        .map((repo) => join(worktreesDir(workspaceDir), repo.name, BASE_WORKTREE_NAME))
        .filter(existsSync),
      workspaceDir,
    ];
    const settings = loadProjectSettingsFrom(settingsDirs);
    const trackerType = config.defaults.tracker || "multi-team";
    retryStore = new RetryStateStore(dbPath);

    await recoverOrphanedTaskRuns({
      runStore,
      tracker,
      trackerType,
      getInProgressStatus: (projectKey) =>
        resolveStatusName(settings, trackerType, projectKey, "inProgressStatus"),
      getTodoStatus: (projectKey) =>
        resolveStatusName(settings, trackerType, projectKey, "todoStatus"),
      recordAttempt: (taskKey, type, description) =>
        retryStore?.recordIncompleteAttempt(taskKey, type, description),
      maxAgeMs: orphanMaxAgeMs(),
    });

    // Dashboard-scheduled retries claimed by the previous worker: settle the
    // rows so the dashboard's per-task guard unblocks (the operator can
    // re-schedule) instead of reporting "already scheduled or running"
    // forever. The orphaned run itself was reaped above.
    const retryQueue = new ScheduledRetryStore(dbPath);
    try {
      const orphans = retryQueue.failRunning(
        "worker restarted while this retry was running; schedule it again",
      );
      for (const orphan of orphans) {
        console.warn(
          `⚠️  [fleet] scheduled retry of ${orphan.taskKey} was interrupted by a worker restart`,
        );
      }
    } finally {
      retryQueue.close();
    }
  } finally {
    retryStore?.close();
    runStore.close();
  }
}

/** Task shape the fleet acquirer needs (structural subset of `Task`). */
export interface FleetTask {
  key: string;
  updated?: string;
  labels?: string[];
  components?: string[];
}

/** Structural slice of {@link RepoManager} the acquirer uses (injectable). */
export interface RepoManagerLike {
  ensureBareClone(repo: RepoConfig): Promise<string>;
  fetch(repoName: string): Promise<void>;
  ensureBaseWorktree(repo: RepoConfig): Promise<string>;
  createTaskWorktree(repo: RepoConfig, taskKey: string): Promise<string>;
  removeTaskWorktree(repoName: string, worktreePath: string): Promise<void>;
  sweepStaleWorktrees(repoName: string, ttlDays: number): Promise<string[]>;
}

export interface WorkspaceTaskAcquirerDeps {
  config: WorkspaceConfig;
  workspaceDir: string;
  workerState: WorkerState;
  queue: WebhookQueue;
  skips: RoutingSkipStore;
  repoManager: RepoManagerLike;
  detector: ChangeDetector;
  searchTasks: (query: string) => Promise<{ tasks: FleetTask[] }>;
  query: string | (() => string | undefined);
  intervalSeconds: number;
  /** Team source for multi-team workspaces; omitted in single-defaults mode. */
  team?: TeamConfig;
  /** Working-window gate (quiet hours); optional so tests can skip it. */
  gate?: PickupGate;
  verbose?: boolean;
  /** Task runner (injected for tests; defaults to the CLI subprocess). */
  runTask?: (
    taskKey: string,
    extraArgs: string[],
    opts: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<TaskExecutionResult>;
  /** Repo run lock factory (injected for tests). */
  repoLock?: (repoName: string) => LockManager;
  /** Process-level agent-run gate; only set when scheduled estimation exists. */
  coordinator?: RunCoordinator;
}

interface RepoRunLockLike {
  acquire(): { success: boolean; message: string; pid?: number };
  release(): void;
}

/**
 * Hold a process-level agent slot for a scheduled run's lifetime.
 *
 * Without a coordinator (no [[estimations]] configured) the context passes
 * through untouched, so long-lived gates are never introduced silently.
 * With one, acquisition happens after any repo lock is held, and release
 * always runs — even when the caller's own release throws.
 */
async function withCoordinatorSlot(
  context: AutomationRunContext | null | Promise<AutomationRunContext | null>,
  coordinator?: RunCoordinator,
): Promise<AutomationRunContext | null> {
  const resolved = await context;
  if (!coordinator || !resolved) return resolved;
  const releaseRun = await coordinator.acquire();
  const releaseContext = resolved.release;
  return {
    ...resolved,
    release: async () => {
      try {
        await releaseContext();
      } finally {
        releaseRun();
      }
    },
  };
}

/** Resolve a scheduled run context while holding the repo lock during preparation. */
export async function resolveWorkspaceAutomationContext(
  automation: AutomationConfig,
  config: WorkspaceConfig,
  workspaceDir: string,
  repoManager: RepoManagerLike,
  repoLock: (repoName: string) => RepoRunLockLike = (name) => createRepoRunLock(name, workspaceDir),
) {
  // Keep occurrence task files in the workspace home (next to repos/,
  // worktrees/, and the central DB) instead of inside a repo worktree.
  const taskFileDir = join(workspaceDir, "automations");
  const repo = automation.repo
    ? findRepo(config, automation.repo)
    : config.repos.length === 1
      ? config.repos[0]
      : undefined;
  if (!repo) return { cwd: workspaceDir, env: { ...process.env }, taskFileDir, release() {} };

  const lock = repoLock(repo.name);
  if (!lock.acquire().success) return null;
  try {
    await repoManager.ensureBareClone(repo);
    await repoManager.fetch(repo.name);
    const cwd = await repoManager.ensureBaseWorktree(repo);
    return {
      cwd,
      env: buildRepoEnv(repo, workspaceDir),
      repo: repo.name,
      taskFileDir,
      release: () => lock.release(),
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/** Per-task CLI args from `[defaults].worker_task_args`, else `--create-pr`. */
export function fleetTaskArgs(config: WorkspaceConfig): string[] {
  const raw = config.defaults.workerTaskArgs;
  if (raw && raw.trim()) {
    return raw.trim().split(/\s+/);
  }
  return workerTaskArgs();
}

/** Error groups are pre-qualified by the monitor, so skip the generic feasibility agent pass. */
export function errorMonitorTaskArgs(config: WorkspaceConfig): string[] {
  const args = fleetTaskArgs(config);
  return args.includes("--skip-clarity-check") ? args : [...args, "--skip-clarity-check"];
}

const PUSH_PERMISSION_HINT =
  "Pushes use the ambient git credential chain — when GITHUB_TOKEN is exported, " +
  "'gh auth git-credential' serves it instead of your keyring login. Grant " +
  "'Contents: Read and write' to that token (or switch the remote to SSH).";

/**
 * Probe push access for every configured GitHub HTTPS remote at worker
 * startup. GitHub read APIs cannot detect an under-scoped fine-grained PAT
 * (role APIs report the user's permissions, not the token's), so pushes are
 * exercised directly via a side-effect-free dry run against each bare clone.
 *
 * Never throws: auth problems are warnings, not startup failures —
 * review-only setups legitimately cannot push.
 */
export async function warnOnPushAuthIssues(
  config: WorkspaceConfig,
  repoManager: RepoManagerLike,
): Promise<void> {
  for (const repo of config.repos) {
    if (!/^https:\/\/github\.com\//i.test(repo.remote)) {
      continue;
    }
    try {
      const clonePath = await repoManager.ensureBareClone(repo);
      const probe = await probePushAccess({ cwd: clonePath });
      if (probe.status === "ok") {
        console.log(`✅ [fleet] push access verified for ${repo.name}`);
        continue;
      }
      const reason = probe.message ? `: ${probe.message}` : "";
      if (probe.status === "permission") {
        console.warn(`⚠️  [fleet] ${repo.name} rejects pushes${reason}`);
        console.warn(`   💡 ${PUSH_PERMISSION_HINT}`);
      } else if (probe.status === "network") {
        console.warn(
          `⚠️  [fleet] could not verify push access for ${repo.name} (network)${reason}`,
        );
      } else {
        console.warn(`⚠️  [fleet] unexpected push-probe result for ${repo.name}${reason}`);
      }
    } catch (error) {
      // Clone failures surface later as real task errors; stay silent here.
      console.warn(`⚠️  [fleet] skipping push probe for ${repo.name}: ${(error as Error).message}`);
    }
  }
}

/**
 * Enabled-and-shape-valid automations for the current fleet, plus any
 * semantic problems. Shared by worker startup (problems are fatal) and the
 * live-reload path (problems surface as errors; offending entries do not
 * schedule, so a repo-less automation can never run outside every repo).
 */
export function resolveFleetAutomations(config: WorkspaceConfig): {
  automations: AutomationConfig[];
  problems: string[];
} {
  const problems: string[] = [];
  const fleetAutomations: AutomationConfig[] = [];
  for (const automation of config.automations) {
    if (!automation.repo && config.repos.length !== 1) {
      problems.push(
        `Automation "${automation.id}" must set repo when the workspace has multiple repositories.`,
      );
      continue;
    }
    fleetAutomations.push(automation);
  }
  return { automations: fleetAutomations, problems };
}

/**
 * Reconciliation hooks exposed to the live config reload path by the fleet
 * event wiring (see {@linkcode buildFleetEventAcquirers}).
 */
export interface FleetEventReloadHooks {
  /** Re-run mention-sweep reconciliation against the live config's repos. */
  reconcileMentionSweeps(): void;
  /** Apply live conflict-resolution mode and schedule settings. */
  reconcileConflictResolution(): void;
  /** Slugs currently served by a mention sweep (sorted). */
  mentionSweepRepos(): string[];
}

/**
 * Build the fleet task acquirer: detect-then-evaluate (reusing
 * {@link TaskPollingAcquirer}) with routing between evaluate and execute.
 *
 * Ambiguous/unrouted tasks are recorded as routing skips and count as
 * handled: the acquirer's dedupe keeps them out of the loop until the task
 * changes again — the same policy as failing tasks.
 */
export function createWorkspaceTaskAcquirer(deps: WorkspaceTaskAcquirerDeps): TaskPollingAcquirer {
  const {
    config,
    workerState,
    queue,
    detector,
    searchTasks,
    query,
    intervalSeconds,
    team,
    verbose,
  } = deps;
  const execute = createFleetTaskExecutor(deps);

  // The acquirer's executeTask only receives the task key; remember each
  // task's routing fields from the evaluate step of the same tick.
  const routables = new Map<string, RoutableTask>();

  const executeTask = (taskKey: string): Promise<TaskExecutionResult> =>
    execute(
      taskKey,
      routables.get(taskKey) ?? toRoutableTask({ key: taskKey, labels: [], components: [] }),
    );

  return new TaskPollingAcquirer({
    trackerType: team ? `${team.tracker}:${team.name}` : config.defaults.tracker,
    query,
    intervalSeconds,
    detector,
    workerState,
    queue,
    gate: deps.gate,
    searchTasks: async (q) => {
      const { tasks } = await searchTasks(q);
      routables.clear();
      for (const task of tasks) {
        routables.set(
          task.key,
          toRoutableTask({
            key: task.key,
            labels: task.labels ?? [],
            components: task.components ?? [],
          }),
        );
      }
      return { tasks };
    },
    executeTask,
    verbose,
  });
}

/** Routed-execution slice of {@link WorkspaceTaskAcquirerDeps}. */
export type FleetExecutorDeps = Pick<
  WorkspaceTaskAcquirerDeps,
  "config" | "workspaceDir" | "skips" | "repoManager" | "runTask" | "repoLock" | "team"
> & { coordinator?: RunCoordinator };

/**
 * Build the fleet execute step: route a task to its repo and run it in a
 * disposable worktree. Shared by the polling acquirer, the relay's task
 * evaluation, and the dashboard retry queue, which acquire tasks differently
 * but execute identically.
 *
 * Ambiguous/unrouted tasks are recorded as routing skips and count as
 * handled: dedupe keeps them out of the loop until the task changes again,
 * the same policy as failing tasks.
 *
 * @param deps - Routing, locking, and runner collaborators
 * @param options - `extraArgs` overrides the per-task CLI args (the retry
 *                  queue prepends `--force` to bypass the retry gate)
 */
export function createFleetTaskExecutor(
  deps: FleetExecutorDeps,
  options: {
    extraArgs?: string[] | (() => string[]);
    repo?: string;
    runOrigin?: "worker" | "error_monitor";
  } = {},
): (taskKey: string, routable: RoutableTask) => Promise<TaskExecutionResult> {
  const { config, workspaceDir, skips, repoManager } = deps;
  const runTask = deps.runTask ?? runTaskViaCli;
  const repoLock = deps.repoLock ?? ((name: string) => createRepoRunLock(name, workspaceDir));

  return async (taskKey, routable) => {
    // Read per run: live config reloads must apply to subsequent work.
    // Explicit overrides can also be factories (dashboard retries prepend
    // `--force` while still following live worker_task_args).
    const configuredArgs = options.extraArgs;
    const extraArgs =
      typeof configuredArgs === "function"
        ? configuredArgs()
        : (configuredArgs ?? fleetTaskArgs(config));
    const team = deps.team ? (findTeam(config, deps.team.name) ?? deps.team) : undefined;
    const rules = team?.repo ? [] : effectiveRoutingRules(config, team?.name);
    const onlyRepo = team?.repo ?? (config.repos.length === 1 ? config.repos[0]!.name : undefined);
    const decision = options.repo
      ? { kind: "routed" as const, repo: options.repo, matchedRules: [] }
      : team
        ? routeTaskWithRules(routable, rules, onlyRepo)
        : routeTask(routable, config);
    const scope = team ? `[fleet:${team.name}]` : "[fleet]";

    if (decision.kind !== "routed") {
      const candidates = decision.kind === "ambiguous" ? decision.candidates : [];
      skips.record({
        taskKey,
        reason: decision.kind,
        candidates,
        team: team?.name,
        taskUpdated: undefined,
      });
      console.warn(
        decision.kind === "ambiguous"
          ? `⚠️  ${scope} ${taskKey} matches rules for multiple repos (${candidates.join(", ")}); skipping - fix the routing rules. Recorded in routing skips.`
          : `⚠️  ${scope} ${taskKey} matches no routing rule; skipping. Recorded in routing skips.`,
      );
      // Handled: dedupe keeps it out until the task is updated again.
      return true;
    }

    const repo = findRepo(config, decision.repo);
    if (!repo) {
      // Config validation makes this unreachable; guard anyway.
      console.error(`❌ ${scope} routed ${taskKey} to unknown repo "${decision.repo}"`);
      return false;
    }

    const lock = repoLock(repo.name);
    const lockResult = lock.acquire();
    if (!lockResult.success) {
      console.warn(
        `⚠️  ${scope} repo "${repo.name}" is busy (${lockResult.message}); ${taskKey} deferred.`,
      );
      return "deferred";
    }

    try {
      await repoManager.ensureBareClone(repo);
      await repoManager.fetch(repo.name);
      const worktree = await repoManager.createTaskWorktree(repo, taskKey);
      console.log(`🏗️  ${scope} ${taskKey} → ${repo.name} (${worktree})`);

      const invoke = () =>
        runTask(taskKey, extraArgs, {
          cwd: worktree,
          env: {
            ...(team
              ? buildTeamTaskEnv(repo, team, workspaceDir)
              : buildRepoEnv(repo, workspaceDir)),
            [RUN_ORIGIN_ENV]: options.runOrigin ?? "worker",
          },
        });
      const ok = deps.coordinator ? await deps.coordinator.run(invoke) : await invoke();

      if (ok === true) {
        await repoManager.removeTaskWorktree(repo.name, worktree);
      } else {
        console.warn(`⚠️  ${scope} keeping worktree for debugging: ${worktree}`);
      }
      return ok;
    } catch (error) {
      console.error(
        `❌ ${scope} ${taskKey} failed in repo "${repo.name}": ${(error as Error).message}`,
      );
      return false;
    } finally {
      lock.release();
    }
  };
}

/** Interval between periodic stale-worktree sweeps (1 hour). */
export const WORKTREE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Sweep every configured repo's stale worktrees once.
 *
 * Shared by the startup sweep and the periodic sweeper.
 *
 * @returns Total worktrees removed across all repos.
 */
export async function sweepAllWorktrees(
  repos: RepoConfig[],
  repoManager: RepoManagerLike,
  ttlDays: number,
): Promise<number> {
  let removedTotal = 0;
  for (const repo of repos) {
    const removed = await repoManager.sweepStaleWorktrees(repo.name, ttlDays);
    removedTotal += removed.length;
    if (removed.length > 0) {
      console.log(`🧹 [fleet] swept ${removed.length} stale worktree(s) for ${repo.name}`);
    }
  }
  return removedTotal;
}

/**
 * Start periodic stale-worktree sweeps.
 *
 * The startup sweep alone misses worktrees that age past the TTL while the
 * worker keeps running, so a long-lived worker would accumulate failed-run
 * worktrees until the next restart. The returned timer is unref'd so it
 * never keeps the process alive on its own.
 */
export function startWorktreeSweeper(
  repos: RepoConfig[] | (() => RepoConfig[]),
  repoManager: RepoManagerLike,
  ttlDays: number | (() => number),
  intervalMs: number = WORKTREE_SWEEP_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const activeRepos = typeof repos === "function" ? repos() : repos;
    const activeTtlDays = typeof ttlDays === "function" ? ttlDays() : ttlDays;
    sweepAllWorktrees(activeRepos, repoManager, activeTtlDays).catch((error) =>
      console.warn(`⚠️  [fleet] periodic worktree sweep failed: ${(error as Error).message}`),
    );
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export interface RunWorkspaceWorkerOptions {
  /** Explicit workspace.toml path (defaults to the workspace home). */
  workspacePath?: string;
  verbose?: boolean;
  /** CLI release attached to anonymous worker startup analytics. */
  cliVersion?: string;
}

/** One tracker source served by the workspace worker. */
export interface FleetSourceRuntime {
  tracker: string;
  /** Initial team identity; live query/repo changes resolve by name from config. */
  team?: TeamConfig;
  query: () => string | undefined;
  searchTasks: (query: string) => Promise<{ tasks: FleetTask[] }>;
  detector: ChangeDetector;
}

function formatClockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Startup banner for working windows (quiet hours): what the windows are,
 * whether pickup is currently allowed, and when the next flip happens.
 */
export function describePickupSchedule(gate: PickupGate): void {
  const snapshot = gate.snapshot();
  if (!snapshot.enabled) {
    return;
  }
  const rules = [
    ...snapshot.active.map((spec) => `active ${spec}`),
    ...snapshot.blocked.map((spec) => `blocked ${spec}`),
  ].join(", ");
  console.log(`🕒 Working windows (${snapshot.timezone}): ${rules}`);
  const next = snapshot.nextChange;
  if (snapshot.pickupAllowed) {
    console.log(
      next
        ? `   New-task pickup is open now; it closes at ${formatClockTime(next.at)}.`
        : "   New-task pickup is open.",
    );
  } else {
    console.log(
      next
        ? `🌙 New-task pickup is paused until ${formatClockTime(next.at)} — in-flight tasks finish normally; \`devintern worker run-now\` drains immediately.`
        : "🌙 New-task pickup is paused — `devintern worker run-now` drains immediately.",
    );
  }
}

/** Log working-window flips exactly once per change (driven by poll ticks). */
export function attachPickupScheduleLogger(gate: PickupGate): void {
  gate.onChange((snapshot: ScheduleSnapshot) => {
    if (snapshot.pickupAllowed) {
      console.log(
        `☀️  [schedule] working window opened (${snapshot.active.join(", ")}, ${snapshot.timezone}); new-task pickup resumed`,
      );
    } else {
      const next = snapshot.nextChange;
      const until = next ? ` until ${formatClockTime(next.at)}` : "";
      console.log(
        `🌙 [schedule] outside the working window${until}; no new tracker tasks are picked up (in-flight tasks continue, other activity is unaffected)`,
      );
    }
  });
}

/**
 * Assemble and start the worker in workspace (fleet) mode.
 *
 * Loads the workspace config and shared `.env` (applied to this process so
 * the tracker client can be constructed), sweeps stale worktrees, and runs
 * one fleet task acquirer under the workspace-wide lock.
 *
 * The caller has already passed the license gate.
 */
export async function runWorkspaceWorker(options: RunWorkspaceWorkerOptions): Promise<void> {
  const configPath = options.workspacePath
    ? resolve(options.workspacePath)
    : workspaceConfigPath(resolveWorkspaceDir());
  const workspaceDir = options.workspacePath ? dirname(configPath) : resolveWorkspaceDir();
  const config = loadWorkspaceConfig(configPath);

  if (config.repos.length === 0) {
    console.error(
      `❌ No repos configured in ${configPath}.\n` +
        "   Add [[repos]] entries (or run `devintern worker add-repo` inside an existing repo).",
    );
    process.exit(1);
  }

  // Shared workspace values serve GitHub/review consumers and the legacy
  // single-defaults tracker. Team clients use explicit composed env maps.
  for (const [key, value] of Object.entries(parseEnvFile(workspaceEnvPath(workspaceDir)))) {
    process.env[key] = value;
  }
  const multiTeam = config.teams.length > 0;
  if (config.defaults.tracker) process.env.TASK_TRACKER = config.defaults.tracker;
  // In-process consumers (dashboard, run records) follow the fleet DB.
  process.env.WEBHOOK_QUEUE_DB = workspaceDbPath(workspaceDir);

  const initialQuery = config.defaults.taskQuery;
  const intervalSeconds = config.defaults.pollIntervalSeconds;
  const initialFleetAutomations = resolveFleetAutomations(config);
  if (initialFleetAutomations.problems.length > 0) {
    throw new Error(`Invalid ${configPath}:\n- ${initialFleetAutomations.problems.join("\n- ")}`);
  }

  // Dashboard retries ride the shared workspace DB: the dashboard inserts a
  // pending row, this worker drains it through the fleet executor below.
  const retryQueue = new ScheduledRetryStore(workspaceDbPath(workspaceDir));

  if (
    !multiTeam &&
    !initialQuery &&
    config.automations.length === 0 &&
    config.estimations.length === 0 &&
    !config.errorMonitors.some((source) => source.enabled)
  ) {
    if (retryQueue.hasPending()) {
      console.warn(
        "⚠️  No task query or automations configured; the worker will only drain scheduled dashboard retries.",
      );
    } else {
      console.error(
        "❌ Workspace mode needs a task query: set [defaults].task_query in workspace.toml.",
      );
      process.exit(1);
    }
  }

  const state = openWorkspaceState(workspaceDir);
  startWorkerFailover({
    queue: state.queue,
    onPause: ({ untilMs, harness, resetHint }) => {
      console.warn(
        `⏳ ${harness} hit a usage limit${resetHint ? ` (resets ${resetHint})` : ""} and no fallback harness is available. ` +
          `Deferring new agent work until ${new Date(untilMs).toISOString()}.`,
      );
    },
    onResume: () => {
      console.log("▶️  Usage-limit windows elapsed — resuming agent work on the available harness");
    },
  });
  const repoManager = new RepoManager(workspaceDir);
  // Preserve the worker's existing concurrency when scheduled estimation is
  // absent or fully disabled. The account-global gate is needed only once an
  // enabled schedule joins the process and must serialize with every other
  // agent run.
  const coordinator = new RunCoordinator(false);
  if (config.estimations.some((item) => item.enabled)) coordinator.enable();

  // Recover what the previous worker left behind before acquiring new work.
  await recoverOrphanedWorkspaceRuns({
    config,
    workspaceDir,
    dbPath: state.dbPath,
  });

  // Working windows (quiet hours): gate only the ready-task drain; reviews,
  // mentions, automations, and relay events stay on their normal paths.
  const pickupGate = createPickupGate(config.worker.schedule, {
    runNowPath: workspaceRunNowPath(workspaceDir),
  });
  describePickupSchedule(pickupGate);
  attachPickupScheduleLogger(pickupGate);

  await sweepAllWorktrees(config.repos, repoManager, config.workspace.worktreesTtlDays);
  // Keep sweeping while the worker runs, not only at startup: a long-lived
  // worker would otherwise accumulate worktrees that age past the TTL until
  // the next restart.
  startWorktreeSweeper(
    () => config.repos,
    repoManager,
    () => config.workspace.worktreesTtlDays,
  );

  await warnOnPushAuthIssues(config, repoManager);

  const acquirers: import("../../worker").Acquirer[] = [];

  // First in the list and on a short interval: a dashboard-scheduled retry
  // gets picked up ahead of the slower pollers.
  acquirers.push(
    new RetryQueueAcquirer({
      store: retryQueue,
      execute: (taskKey, routable, retry) =>
        createFleetTaskExecutor(
          {
            config,
            workspaceDir,
            skips: state.skips,
            repoManager,
            ...(retry.team ? { team: findTeam(config, retry.team) } : {}),
          },
          // The persisted repo/team make retries deterministic even when
          // task keys overlap or the original route depended on labels.
          { extraArgs: () => ["--force", ...fleetTaskArgs(config)], repo: retry.repo },
        )(taskKey, routable),
      intervalSeconds: parseEnvInteger("WORKER_RETRY_INTERVAL_SECONDS", 5, { min: 1 }),
      verbose: options.verbose,
    }),
  );

  // Always assembled (even with no automations yet): a live reload can add
  // [[automations]] without restarting, and applyAutomations schedules them.
  // Semantic problems were already rejected at startup above and are
  // re-checked on the reload path via resolveFleetAutomations.
  const fleetAutomationAcquirer = new AutomationAcquirer({
    automations: initialFleetAutomations.automations,
    dbPath: state.dbPath,
    extraArgs: () => fleetTaskArgs(config),
    resolveContext: async (automation) =>
      withCoordinatorSlot(
        await resolveWorkspaceAutomationContext(automation, config, workspaceDir, repoManager),
        coordinator,
      ),
  });
  const automationActions = {
    list: () => fleetAutomationAcquirer.listSchedules(),
    trigger: (automationId: string) => fleetAutomationAcquirer.triggerManual(automationId),
  };
  acquirers.push(fleetAutomationAcquirer);

  // Cadence reconciliation: applied on successful reloads of poll_interval.
  const intervalUpdaters: Array<(seconds: number) => void> = [];
  // Reload hooks published by buildFleetEventAcquirers (mention sweeps).
  const eventReloadHooks: { hooks?: FleetEventReloadHooks } = {};
  let pollIntervalSeconds = config.defaults.pollIntervalSeconds;

  // Always assemble the estimation scheduler so entries can be added to an
  // already-running schedules-only worker.
  const estimationAcquirer = new EstimationAcquirer({
    estimations: config.estimations,
    dbPath: state.dbPath,
    resolveContext: () =>
      withCoordinatorSlot(
        Promise.resolve({ cwd: workspaceDir, env: { ...process.env }, release() {} }),
        coordinator,
      ),
  });
  acquirers.push(estimationAcquirer);

  // Error-monitor adapters share one provider-neutral acquirer. Each source
  // is pinned to a repo (and optionally a team), so projects with different
  // credentials cannot be dispatched into the wrong codebase.
  const { ErrorMonitorAcquirer, createErrorMonitorProvider } = await import("../error-monitor");
  const errorTaskDir = join(workspaceDir, "error-fixes");
  for (const source of config.errorMonitors) {
    if (!source.enabled) continue;
    const repo = findRepo(config, source.repo);
    if (!repo) throw new Error(`Error monitor "${source.id}" references unknown repo.`);
    const team = source.team ? findTeam(config, source.team) : undefined;
    const env = buildErrorMonitorEnv(source, repo, team, workspaceDir);

    const provider = createErrorMonitorProvider(source, env);
    const execute = createFleetTaskExecutor(
      {
        config,
        workspaceDir,
        skips: state.skips,
        repoManager,
        team,
        coordinator,
      },
      {
        repo: repo.name,
        runOrigin: "error_monitor",
        extraArgs: () => errorMonitorTaskArgs(config),
      },
    );
    acquirers.push(
      new ErrorMonitorAcquirer({
        sourceId: source.id,
        intervalSeconds: source.intervalSeconds,
        minOccurrences: source.minOccurrences,
        maxIssuesPerTick: source.maxIssuesPerTick,
        commentOnAction: source.commentOnAction,
        queue: state.queue,
        provider,
        verbose: options.verbose,
        executeTask: async (issue, markdown) => {
          mkdirSync(errorTaskDir, { recursive: true });
          const safeId = `${source.id}-${issue.displayId}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
          const taskFile = join(errorTaskDir, `${safeId}.md`);
          writeFileSync(taskFile, markdown);
          return execute(taskFile, { key: issue.externalId, labels: [], components: [] });
        },
      }),
    );
  }

  // Tracker identities and credentials are startup-only. Queries and fixed
  // team repo mappings stay live through lookups against the shared config.
  const { TaskTrackerManager, createTrackerClient, trackerRequiredEnv } =
    await import("../task-tracker-manager");
  const { createChangeDetector } = await import("../change-detector");
  const sources: FleetSourceRuntime[] = [];

  if (multiTeam) {
    for (const team of config.teams) {
      const env = buildTeamEnv(team, workspaceDir);
      const missing = trackerRequiredEnv(team.tracker).filter((key) => !env[key]);
      if (missing.length > 0) {
        throw new Error(
          `Team "${team.name}" (${team.tracker}) is missing required variables: ${missing.join(", ")}. ` +
            "Add them to the workspace .env or the team's env_file.",
        );
      }
      const client = createTrackerClient(team.tracker, env);
      const searchTasks = (query: string) => client.searchTasks(query);
      const detector = createChangeDetector(team.tracker, searchTasks, {
        env,
        source: `${team.tracker}:${team.name}`,
      });
      if (!detector) {
        throw new Error(
          `Could not initialize the ${team.tracker} detector for team "${team.name}".`,
        );
      }
      sources.push({
        tracker: team.tracker,
        team,
        query: () => findTeam(config, team.name)?.taskQuery,
        searchTasks,
        detector,
      });
    }
  } else {
    // Keep the legacy client lazy so automations-only workspaces do not need
    // tracker credentials until a task query is enabled.
    const trackerManager = new TaskTrackerManager();
    const searchTasks = (query: string) => trackerManager.getClient().searchTasks(query);
    const detector = createChangeDetector(config.defaults.tracker, searchTasks);
    if (initialQuery && !detector) {
      throw new Error(
        `Could not initialize the ${config.defaults.tracker} change detector. ` +
          "Check the tracker's required variables in the workspace .env.",
      );
    }
    if (detector) {
      sources.push({
        tracker: config.defaults.tracker,
        query: () => config.defaults.taskQuery,
        searchTasks,
        detector,
      });
    }
  }

  for (const source of sources) {
    const taskAcquirer = createWorkspaceTaskAcquirer({
      config,
      workspaceDir,
      workerState: state.workerState,
      queue: state.queue,
      skips: state.skips,
      repoManager,
      detector: source.detector,
      searchTasks: source.searchTasks,
      query: source.query,
      intervalSeconds,
      gate: pickupGate,
      team: source.team,
      verbose: options.verbose,
      coordinator,
    });
    intervalUpdaters.push((seconds) => taskAcquirer.updateInterval(seconds));
    acquirers.push(taskAcquirer);
  }

  acquirers.push(
    ...(await buildFleetEventAcquirers({
      config,
      workspaceDir,
      state,
      repoManager,
      sources,
      intervalSeconds,
      verbose: options.verbose,
      intervalUpdaters,
      reloadHooksOut: eventReloadHooks,
      coordinator,
    })),
  );

  /**
   * Apply a freshly validated config to consumers that snapshot values:
   * reconciles the automation set, surfaces semantic problems, and refreshes
   * cadence-driven acquirers when `[defaults].poll_interval` changed.
   */
  const applyReloadedConfig = (updated: WorkspaceConfig): void => {
    const fleet = resolveFleetAutomations(updated);
    fleetAutomationAcquirer.applyAutomations(fleet.automations);
    if (updated.estimations.some((item) => item.enabled)) coordinator.enable();
    else coordinator.disableWhenIdle();
    estimationAcquirer.applyEstimations(updated.estimations);

    if (updated.defaults.pollIntervalSeconds !== pollIntervalSeconds) {
      pollIntervalSeconds = updated.defaults.pollIntervalSeconds;
      console.log(`⏱️  [config] Poll interval is now ${pollIntervalSeconds}s`);
      for (const update of intervalUpdaters) update(pollIntervalSeconds);
    }
    eventReloadHooks.hooks?.reconcileMentionSweeps();
    eventReloadHooks.hooks?.reconcileConflictResolution();
  };

  const teamRuntimeShape = (value: WorkspaceConfig) =>
    value.teams.map(({ name, tracker, envFile, env }) => ({ name, tracker, envFile, env }));

  // Live reload keeps queries, fixed team destinations, routing, repos,
  // automations, worker_task_args, and cadence live. Team identities and
  // credentials require rebuilding clients/detectors and therefore restart.
  const reloader = new WorkspaceConfigReloader({
    configPath,
    current: config,
    validate: (next, current) => {
      const fleet = resolveFleetAutomations(next);
      if (fleet.problems.length > 0) throw new Error(fleet.problems.join("\n- "));
      if (next.defaults.tracker !== current.defaults.tracker) {
        throw new Error("[defaults].tracker is startup-only; restart the worker to change it.");
      }
      if (JSON.stringify(teamRuntimeShape(next)) !== JSON.stringify(teamRuntimeShape(current))) {
        throw new Error(
          "Team names, trackers, env_file, and inline env are startup-only; restart the worker to change them.",
        );
      }
      if (JSON.stringify(next.errorMonitors) !== JSON.stringify(current.errorMonitors)) {
        throw new Error("[[error_monitors]] is startup-only; restart the worker to change it.");
      }
      if (!multiTeam && next.defaults.taskQuery && sources.length === 0) {
        throw new Error(
          `task_query cannot be enabled live because the ${current.defaults.tracker} change detector ` +
            "could not be initialized; fix its required workspace .env settings and restart the worker.",
        );
      }
      if (
        next.workspace.dashboard !== current.workspace.dashboard ||
        next.workspace.dashboardPort !== current.workspace.dashboardPort
      ) {
        throw new Error(
          "[workspace].dashboard and dashboard_port are startup-only; restart the worker to change them.",
        );
      }
      if (JSON.stringify(next.worker.schedule) !== JSON.stringify(current.worker.schedule)) {
        throw new Error("[worker.schedule] is startup-only; restart the worker to change it.");
      }
    },
    onApplied: applyReloadedConfig,
  });
  reloader.start();

  if (config.workspace.dashboard) {
    try {
      const { startDashboardServer } = await import("../../dashboard-server");
      // `schedule`: retries are drained by this worker's retry-queue acquirer
      // through the normal pipeline (never spawned from the workspace home);
      // automation "Run now" triggers go through the in-process scheduler.
      startDashboardServer({
        port: config.workspace.dashboardPort,
        retryMode: "schedule",
        automationActions,
        scheduleSnapshot: () => (pickupGate.enabled ? pickupGate.snapshot() : null),
      });
    } catch (error) {
      console.warn(
        `⚠️  Dashboard could not start (${(error as Error).message}); the worker will continue.`,
      );
    }
  }

  const teamsLabel = multiTeam ? `, ${config.teams.length} team(s)` : "";
  const analyticsTracker = multiTeam
    ? [...new Set(config.teams.map((team) => team.tracker))].sort().join(",")
    : config.defaults.tracker;
  console.log(`🗂️  Workspace: ${configPath} (${config.repos.length} repo(s)${teamsLabel})`);
  console.log(
    "🔄 Live config reload armed: edits to workspace.toml apply automatically (SIGHUP forces one)",
  );
  const { startWorker } = await import("../../worker");
  await startWorker(
    {
      lock: createWorkspaceLock(workspaceDir),
      label: workspaceDir,
      // Capture logs in the workspace home: one daemon serves many repos, and
      // the dashboard's log tailer already searches this directory.
      logDir: workspaceDir,
      onStarted: async (acquirerNames) => {
        trackWorkerStarted({
          cliVersion: options.cliVersion ?? "0.0.0",
          tracker: analyticsTracker,
          acquirerNames,
          configDir: workspaceDir,
        });
        await flushAnalytics();
      },
    },
    acquirers,
  );
}

/**
 * Wire the fleet's event acquirers: review polling on the agent's own PRs,
 * a mention sweep per GitHub repo, and the relay when configured.
 *
 * Runs are CLI subprocesses in each repo's base worktree; mention-driven
 * runs are permission-gated here (see `fleet-events.ts`). Relay in fleet
 * mode uses connect state under the workspace home (or `WORKER_RELAY_URL`
 * plus a stored `drt_…` token); per-repo `worker connect` state alone is
 * not enough for the fleet daemon.
 */
export async function buildFleetEventAcquirers(options: {
  config: WorkspaceConfig;
  workspaceDir: string;
  state: ReturnType<typeof openWorkspaceState>;
  repoManager: RepoManagerLike;
  /** Team/default tracker runtimes used to evaluate relay task envelopes. */
  sources?: FleetSourceRuntime[];
  /** Legacy single-source injectables retained for focused tests. */
  searchTasks?: (query: string) => Promise<{ tasks: FleetTask[] }>;
  query?: string | (() => string | undefined);
  intervalSeconds: number;
  verbose?: boolean;
  /** Collectors of cadence changes, applied on live config reloads. */
  intervalUpdaters?: Array<(seconds: number) => void>;
  /** Published once event acquirers are wired (mention-sweep reconcile). */
  reloadHooksOut?: { hooks?: FleetEventReloadHooks };
  /** Process-level agent-run gate; only set when scheduled estimation exists. */
  coordinator?: RunCoordinator;
}): Promise<import("../../worker").Acquirer[]> {
  const { config, workspaceDir, state, repoManager, intervalSeconds, verbose } = options;
  const taskSources: Array<Pick<FleetSourceRuntime, "tracker" | "team" | "query" | "searchTasks">> =
    options.sources ??
    (options.searchTasks
      ? [
          {
            tracker: config.defaults.tracker,
            query: () => {
              const query = options.query;
              return typeof query === "function" ? query() : query;
            },
            searchTasks: options.searchTasks,
          },
        ]
      : []);
  const intervalUpdaters = options.intervalUpdaters ?? [];
  const acquirers: import("../../worker").Acquirer[] = [];

  const {
    createFleetAddressPr,
    createFleetCiFix,
    coalescePrFeedbackRuns,
    createFleetResolveConflicts,
    createFleetMentionHandler,
    createFleetRelayTaskDispatcher,
    createFleetTaskEvaluator,
    fleetGitHubSlugs,
  } = await import("./fleet-events");

  const { hasGitHubRelayRouting, loadRelayState, RELAY_BOT_LOGIN } =
    await import("../relay-connect");
  const relayState = loadRelayState(workspaceDir);
  const relayToken = relayState?.relayToken;
  const relayUrl =
    process.env.WORKER_RELAY_URL?.replace(/\/+$/, "") || (relayState?.relayUrl ?? "");
  // Accept a live legacy repo registration at runtime as well as the newer
  // verified-id marker. The latter remains required when establishing a new
  // pairing, but upgrading must not disable an already-delivering relay.
  const usesHostedApp = Boolean(relayUrl && hasGitHubRelayRouting(relayState));
  const relayEnabled = Boolean(relayToken && relayUrl);
  let relayLastSuccessAt = 0;
  const relayHealthGraceMs = Math.max(90, intervalSeconds * 2) * 1000;
  const shouldPollFeedback = () =>
    !relayEnabled ||
    relayLastSuccessAt === 0 ||
    Date.now() - relayLastSuccessAt >= relayHealthGraceMs;

  // Hosted workspaces use the central App only for event delivery. All
  // follow-up GitHub reads/writes stay local and authenticate with the user's
  // GITHUB_TOKEN. Without a relay, preserve the customer-owned App-first path
  // for air-gapped/direct installations (with PAT fallback).
  const { GITHUB_AUTH_MODE_ENV, GitHubReviewsClient } = await import("../github-reviews");
  process.env[GITHUB_AUTH_MODE_ENV] = usesHostedApp ? "token-only" : "app-first";

  if (usesHostedApp) {
    const aliasNames = new Set(
      (process.env.GITHUB_BOT_ALIASES ?? "")
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean),
    );
    aliasNames.add(RELAY_BOT_LOGIN);
    process.env.GITHUB_BOT_ALIASES = [...aliasNames].join(",");
  }

  const hasCustomAppCredentials = Boolean(
    process.env.GITHUB_APP_ID &&
    (process.env.GITHUB_APP_PRIVATE_KEY_PATH || process.env.GITHUB_APP_PRIVATE_KEY_BASE64),
  );
  const hasGitHubCreds = usesHostedApp
    ? Boolean(process.env.GITHUB_TOKEN)
    : Boolean(process.env.GITHUB_TOKEN || hasCustomAppCredentials);
  const slugs = fleetGitHubSlugs(config);
  let github: import("../github-reviews").GitHubReviewsClient | undefined;
  let addressPr: ((repo: string, prNumber: number) => Promise<TaskExecutionResult>) | undefined;
  let handleMention:
    | ((repo: string, comment: { user: { login: string } }, prNumber: number) => Promise<void>)
    | undefined;

  // Built whenever credentials exist — even with zero GitHub repos today —
  // so a repo added to the config at runtime gets full event coverage.
  if (hasGitHubCreds) {
    github = new GitHubReviewsClient({ authMode: usesHostedApp ? "token-only" : "app-first" });
    const gh = github;
    const ownerOf = (slug: string) => slug.split("/")[0] as string;
    const nameOf = (slug: string) => slug.split("/")[1] as string;

    const eventDeps = {
      config,
      workspaceDir,
      repoManager,
      userHasPushAccess: (owner: string, repo: string, user: string) =>
        gh.userHasPushAccess(owner, repo, user),
      verbose,
      coordinator: options.coordinator,
    };
    const fleetAddressPr = coalescePrFeedbackRuns(createFleetAddressPr(eventDeps));
    addressPr = fleetAddressPr;
    const resolveConflicts = createFleetResolveConflicts(eventDeps);
    const fleetHandleMention = createFleetMentionHandler(eventDeps, fleetAddressPr);
    handleMention = fleetHandleMention;

    // Tier 1: the agent's own PRs (central agent_prs registry is repo-keyed,
    // so one acquirer covers the whole fleet).
    const { ReviewPollingAcquirer } = await import("../review-polling-acquirer");
    const { isGitHubNotFound } = await import("../github-reviews");
    const runStore = new RunStore(state.dbPath);
    const reviewAcquirer = new ReviewPollingAcquirer({
      intervalSeconds,
      shouldPollFeedback,
      workerState: state.workerState,
      queue: state.queue,
      github: {
        fetchPr: async (repo, n, etag) => {
          try {
            return await gh.conditionalGet(
              `/repos/${repo}/pulls/${n}`,
              ownerOf(repo),
              nameOf(repo),
              etag,
            );
          } catch (error) {
            if (isGitHubNotFound(error)) {
              // Renamed/transferred/deleted repo or PR (or lost App
              // access): report gone so the reconciler unregisters the
              // row instead of erroring on every tick.
              return { data: null, notModified: false, gone: true };
            }
            throw error;
          }
        },
        fetchReviews: (repo, n, etag) =>
          gh.conditionalGet(
            `/repos/${repo}/pulls/${n}/reviews?per_page=100`,
            ownerOf(repo),
            nameOf(repo),
            etag,
          ),
        fetchReviewCommentsSince: async (repo, n, sinceIso) => {
          const result = await gh.conditionalGet<
            Array<{ id: number; user: { login: string; type: string }; created_at: string }>
          >(
            `/repos/${repo}/pulls/${n}/comments?since=${encodeURIComponent(sinceIso)}&per_page=100`,
            ownerOf(repo),
            nameOf(repo),
          );
          return result.data ?? [];
        },
      },
      addressPr: fleetAddressPr,
      resolveConflicts,
      conflictSchedule: config.workspace.conflictSchedule,
      conflictResolution: config.workspace.conflictResolution,
      quietPeriodSeconds: parseEnvInteger("WORKER_BASE_SYNC_QUIET_SECONDS", 30, { min: 0 }),
      runStore,
      // Factory form: repos added at runtime become watchable without a
      // restart (a static list would pin the startup slug set).
      allowedRepos: () => fleetGitHubSlugs(config),
      verbose,
    });
    acquirers.push(reviewAcquirer);

    // CI failure repair uses the same durable agent-PR registry, repo
    // worktree, per-PR lock, and process-level run coordinator as reviews.
    const { CiFailureWatcherAcquirer } = await import("../ci-failure-watcher-acquirer");
    const fixPr = createFleetCiFix(eventDeps);
    const ciWatcher = new CiFailureWatcherAcquirer({
      intervalSeconds,
      enabled: () => config.workspace.ciFailureFix,
      workerState: state.workerState,
      queue: state.queue,
      github: {
        fetchPr: async (repo, n, etag) => {
          try {
            return await gh.conditionalGet(
              `/repos/${repo}/pulls/${n}`,
              ownerOf(repo),
              nameOf(repo),
              etag,
            );
          } catch (error) {
            if (isGitHubNotFound(error)) {
              return { data: null, notModified: false, gone: true };
            }
            throw error;
          }
        },
        fetchWorkflowRuns: async (repo, sha, etag) => {
          const result = await gh.conditionalGet<{
            workflow_runs: import("../github-reviews").WorkflowRunSummary[];
          }>(
            `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
            ownerOf(repo),
            nameOf(repo),
            etag,
          );
          return {
            data: result.data?.workflow_runs ?? null,
            etag: result.etag,
            notModified: result.notModified,
          };
        },
        fetchCommitStatus: (repo, sha, etag) =>
          gh.getCombinedStatus(ownerOf(repo), nameOf(repo), sha, etag),
        fetchFailingJobLogs: async (repo, sha) => {
          const owner = ownerOf(repo);
          const name = nameOf(repo);
          const runs = await gh.getWorkflowRunsForSha(owner, name, sha).catch(() => []);
          const chunks: string[] = [];
          for (const run of runs.slice(0, 3)) {
            const jobs = await gh.getWorkflowRunJobs(owner, name, run.id).catch(() => []);
            for (const job of jobs
              .filter(
                (candidate) =>
                  candidate.conclusion === "failure" || candidate.conclusion === "timed_out",
              )
              .slice(0, 5)) {
              const log = await gh.getJobLogs(owner, name, job.id).catch(() => null);
              if (log) chunks.push(`## Job: ${job.name}\n${log}`);
            }
          }
          return chunks.length > 0 ? chunks.join("\n\n") : null;
        },
        postComment: (repo, n, body) =>
          gh.postPullRequestComment(ownerOf(repo), nameOf(repo), n, body),
      },
      fixPr,
      verbose,
    });
    acquirers.push(ciWatcher);
    intervalUpdaters.push((seconds) => ciWatcher.updateInterval(seconds));

    // Tier 2: one mention sweep per GitHub repo (cursor sources are already
    // namespaced by slug). The permission gate runs in the fleet handler.
    // Sweeps are map-managed so live config reloads can attach sweeps for
    // newly added repos and stop them for removed ones.
    const { MentionSweepAcquirer } = await import("../mention-sweep-acquirer");
    type MentionSweep = import("../mention-sweep-acquirer").MentionSweepAcquirer;
    const mentionSweeps = new Map<string, MentionSweep>();
    const createMentionSweep = (slug: string): MentionSweep => {
      const [repoOwner, repoName] = slug.split("/") as [string, string];
      return new MentionSweepAcquirer({
        repo: slug,
        intervalSeconds,
        shouldPollFeedback,
        workerState: state.workerState,
        queue: state.queue,
        github: {
          fetchIssueCommentsSince: async (sinceIso) => {
            const result = await gh.conditionalGet<
              Array<{
                id: number;
                body: string | null;
                user: { login: string; type: string };
                created_at: string;
                html_url: string;
                issue_url?: string;
              }>
            >(
              `/repos/${slug}/issues/comments?since=${encodeURIComponent(sinceIso)}&per_page=100&sort=created&direction=asc`,
              repoOwner,
              repoName,
            );
            return result.data ?? [];
          },
          fetchReviewCommentsSince: async (sinceIso) => {
            const result = await gh.conditionalGet<
              Array<{
                id: number;
                body: string | null;
                user: { login: string; type: string };
                created_at: string;
                html_url: string;
                pull_request_url?: string;
              }>
            >(
              `/repos/${slug}/pulls/comments?since=${encodeURIComponent(sinceIso)}&per_page=100&sort=created&direction=asc`,
              repoOwner,
              repoName,
            );
            return result.data ?? [];
          },
          getBotUsername: () => gh.getBotUsername(repoOwner, repoName),
          getPr: async (prNumber) => {
            const pr = await gh.getPullRequest(repoOwner, repoName, prNumber);
            return {
              number: pr.number,
              state: pr.state,
              headRepoFullName: pr.head.repo?.full_name,
              maintainerCanModify: pr.maintainer_can_modify,
            };
          },
          postComment: async (prNumber, body) => {
            await gh.postPullRequestComment(repoOwner, repoName, prNumber, body);
          },
        },
        handleMention: (comment, prNumber) => fleetHandleMention(slug, comment, prNumber),
        verbose,
      });
    };
    for (const slug of slugs) {
      const sweep = createMentionSweep(slug);
      mentionSweeps.set(slug, sweep);
      acquirers.push(sweep);
      intervalUpdaters.push((seconds) => sweep.updateInterval(seconds));
    }

    if (options.reloadHooksOut && !options.reloadHooksOut.hooks) {
      options.reloadHooksOut.hooks = {
        reconcileMentionSweeps: () => {
          const wanted = new Set(fleetGitHubSlugs(config));
          for (const [slug, sweep] of [...mentionSweeps]) {
            if (!wanted.has(slug)) {
              // A stale updater calling updateInterval on a stopped sweep
              // only mutates options (no timer) and is harmless.
              sweep.stop();
              mentionSweeps.delete(slug);
              console.log(`🧹 [config] stopped @mention sweep for removed repo ${slug}`);
            }
          }
          for (const slug of wanted) {
            if (!mentionSweeps.has(slug)) {
              const sweep = createMentionSweep(slug);
              mentionSweeps.set(slug, sweep);
              intervalUpdaters.push((seconds) => sweep.updateInterval(seconds));
              void sweep.start();
              console.log(`➕ [config] watching @mentions on newly added repo ${slug}`);
            }
          }
        },
        reconcileConflictResolution: () =>
          reviewAcquirer.updateConflictResolution(
            config.workspace.conflictResolution,
            config.workspace.conflictSchedule,
          ),
        mentionSweepRepos: () => [...mentionSweeps.keys()].sort(),
      };
    }
  } else if (verbose) {
    console.log(
      hasGitHubCreds
        ? "   [fleet] no GitHub repos configured yet; mention sweeps attach on config changes."
        : usesHostedApp
          ? "   [fleet] GITHUB_TOKEN not set; central-App events can arrive, but GitHub review/mention handling is disabled."
          : "   [fleet] GITHUB_TOKEN or complete custom GitHub App credentials not set; review/mention acquirers disabled.",
    );
  }

  // GitLab polling is deliberately independent of GitHub credentials and
  // watches only provider-aware rows registered after successful MR creation.
  const { parseGitLabHostAliases, parseGitRemoteUrl } = await import("../code-host");
  const { resolveGitLabCodeHostConfig } = await import("../pr-client");
  const resolveGitLabRepo = (mr: import("../worker-state").AgentPr) =>
    config.repos.find((repo) => {
      const env = buildRepoEnv(repo, workspaceDir);
      const remote = parseGitRemoteUrl(repo.remote, {
        gitlabBaseUrl: env.GITLAB_CODE_HOST_URL,
        gitlabHostAliases: parseGitLabHostAliases(env.GITLAB_CODE_HOST_ALIASES),
      });
      return (
        remote?.provider === "gitlab" &&
        remote.instanceUrl === mr.instanceUrl &&
        remote.projectPath === mr.projectPath
      );
    });
  const hasGitLabProfile = config.repos.some((repo) => {
    const env = buildRepoEnv(repo, workspaceDir);
    const remote = parseGitRemoteUrl(repo.remote, {
      gitlabBaseUrl: env.GITLAB_CODE_HOST_URL,
      gitlabHostAliases: parseGitLabHostAliases(env.GITLAB_CODE_HOST_ALIASES),
    });
    return remote?.provider === "gitlab" && resolveGitLabCodeHostConfig(remote.instanceUrl, env).ok;
  });
  let reconcileGitLabRelay:
    | ((
        envelope: import("../relay-acquirer").RelayEnvelope & {
          codeHost: import("../relay-acquirer").RelayCodeHostIdentity;
        },
      ) => Promise<void>)
    | undefined;
  if (hasGitLabProfile) {
    const { CiFailureWatcherAcquirer, runCiFixViaCli } =
      await import("../ci-failure-watcher-acquirer");
    const { GitLabReviewPollingAcquirer } = await import("../gitlab-review-polling-acquirer");
    const { GitLabReviewsClient } = await import("../gitlab-reviews");
    const { runAddressReviewUrlViaCli, runResolveConflictsUrlViaCli } =
      await import("../review-polling-acquirer");
    const clientForGitLabMr = (mr: import("../worker-state").AgentPr) => {
      const repo = resolveGitLabRepo(mr);
      if (!repo) return null;
      const env = buildRepoEnv(repo, workspaceDir);
      const resolved = resolveGitLabCodeHostConfig(mr.instanceUrl, env);
      if (!resolved.ok) return null;
      try {
        return new GitLabReviewsClient(resolved.token, resolved.instanceUrl, {
          caFile: resolved.caFile,
          proxy: resolved.proxy,
        });
      } catch (error) {
        console.warn(
          `⚠️  [fleet] GitLab client for ${mr.projectPath} could not be initialized: ${(error as Error).message}`,
        );
        return null;
      }
    };
    const gitlabPoller = new GitLabReviewPollingAcquirer({
      intervalSeconds,
      workerState: state.workerState,
      queue: state.queue,
      allowed: (mr) => Boolean(resolveGitLabRepo(mr)),
      clientFor: clientForGitLabMr,
      addressMr: async (mr) => {
        const repo = resolveGitLabRepo(mr);
        if (!repo) return false;
        await repoManager.ensureBareClone(repo);
        await repoManager.fetch(repo.name);
        const base = await repoManager.ensureBaseWorktree(repo);
        const invoke = () =>
          runAddressReviewUrlViaCli(
            mr.webUrl,
            `${mr.instanceUrl}:${mr.projectPath}!${mr.changeNumber}`,
            {
              cwd: base,
              env: buildRepoEnv(repo, workspaceDir),
            },
          );
        return options.coordinator ? options.coordinator.run(invoke) : invoke();
      },
      // Scheduled GitLab conflict windows need provider-neutral durable
      // scheduling state; until that lands, never violate a scheduled policy.
      shouldResolve: () => config.workspace.conflictResolution === "auto",
      resolveMr: async (mr, expected) => {
        const repo = resolveGitLabRepo(mr);
        if (!repo) return { outcome: "skipped", message: "repository is not configured" };
        await repoManager.ensureBareClone(repo);
        await repoManager.fetch(repo.name);
        const base = await repoManager.ensureBaseWorktree(repo);
        const invoke = () =>
          runResolveConflictsUrlViaCli(
            mr.webUrl,
            `${mr.instanceUrl}:${mr.projectPath}!${mr.changeNumber}`,
            {
              cwd: base,
              env: buildRepoEnv(repo, workspaceDir),
              expectedHeadSha: expected.headSha,
              expectedBaseSha: expected.baseSha,
            },
          );
        return options.coordinator ? options.coordinator.run(invoke) : invoke();
      },
      reviewerAllowlist: (process.env.GITLAB_REVIEWER_ALLOWLIST ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    });
    acquirers.push(gitlabPoller);
    intervalUpdaters.push((seconds) => gitlabPoller.updateInterval(seconds));

    const gitlabCiRows = new Map<string, import("../worker-state").AgentPr>();
    const gitlabCiSnapshots = new Map<
      string,
      { sha: string; snapshot: import("../gitlab-reviews").GitLabCiSnapshot }
    >();
    const ciKey = (mr: import("../worker-state").AgentPr) => `${mr.instanceUrl}:${mr.projectPath}`;
    const resolveCi = (key: string) => {
      const mr = gitlabCiRows.get(key);
      if (!mr) throw new Error("GitLab MR is no longer registered");
      const client = clientForGitLabMr(mr);
      if (!client) throw new Error("GitLab code-host profile is unavailable");
      return { mr, client };
    };
    const gitlabCiWatcher = new CiFailureWatcherAcquirer({
      intervalSeconds,
      enabled: () => config.workspace.ciFailureFix,
      workerState: state.workerState,
      queue: state.queue,
      namespace: "gitlab",
      ciProviderLabel: "GitLab job trace",
      feedbackRepository: (key) => gitlabCiRows.get(key)?.projectPath ?? key,
      describeChange: (key, n) => `${gitlabCiRows.get(key)?.projectPath ?? key}!${n}`,
      escalationRecoveryText: "Push a new commit and I will take another look.",
      watchedChanges: () => {
        gitlabCiRows.clear();
        return state.workerState
          .listOpenAgentChangeRequests()
          .filter((mr) => mr.provider === "gitlab" && Boolean(resolveGitLabRepo(mr)))
          .map((mr) => {
            const key = ciKey(mr);
            gitlabCiRows.set(key, mr);
            return { repo: key, prNumber: mr.changeNumber };
          });
      },
      markClosed: (key) => {
        const mr = gitlabCiRows.get(key);
        if (mr) {
          state.workerState.markAgentChangeRequestClosed({
            provider: mr.provider,
            instanceUrl: mr.instanceUrl,
            projectId: mr.projectId,
            projectPath: mr.projectPath,
            number: mr.changeNumber,
            webUrl: mr.webUrl,
          });
        }
      },
      github: {
        fetchPr: async (key, n) => {
          const { mr, client } = resolveCi(key);
          try {
            const current = await client.getChangeRequest(mr.projectPath, n);
            return {
              data: {
                state: current.state === "opened" ? "open" : current.state,
                head: { sha: current.head.sha, repo: { full_name: key } },
              },
              notModified: false,
            };
          } catch (error) {
            if ((error as Error).message.includes("GitLab API error (404)")) {
              return { data: null, notModified: false, gone: true };
            }
            throw error;
          }
        },
        fetchWorkflowRuns: async (key, sha) => {
          const { mr, client } = resolveCi(key);
          const snapshot = await client.getCiSnapshot(mr.projectPath, sha);
          gitlabCiSnapshots.set(key, { sha, snapshot });
          const runs: import("../ci-failure-watcher-acquirer").WatchedWorkflowRun[] =
            snapshot.failures.map((failure, index) => ({
              id: index + 1,
              externalId: `gitlab:${mr.instanceUrl}:${failure.externalId}`,
              name: failure.name,
              status: "completed",
              conclusion: failure.conclusion,
              html_url: failure.detailsUrl,
            }));
          if (runs.length === 0 && snapshot.state === "pending") {
            runs.push({ id: 0, name: "GitLab pipeline", status: "running", conclusion: null });
          } else if (runs.length === 0 && snapshot.state === "success") {
            runs.push({
              id: 0,
              name: "GitLab pipeline",
              status: "completed",
              conclusion: "success",
            });
          }
          return { data: runs, notModified: false };
        },
        fetchCommitStatus: async (key, sha) => {
          const cached = gitlabCiSnapshots.get(key);
          const snapshot = cached?.sha === sha ? cached.snapshot : undefined;
          return {
            data: {
              state: snapshot?.state ?? "unknown",
              total_count: snapshot?.state === "unknown" ? 0 : 1,
              statuses: [],
            },
            notModified: false,
          };
        },
        fetchFailingJobLogs: async (key, sha) => {
          const { mr, client } = resolveCi(key);
          const cached = gitlabCiSnapshots.get(key);
          const snapshot = cached?.sha === sha ? cached.snapshot : undefined;
          return client.getJobTraces(mr.projectPath, snapshot?.jobIds ?? []);
        },
        postComment: async (key, n, body) => {
          const { mr, client } = resolveCi(key);
          await client.postMergeRequestNote(mr.projectId ?? mr.projectPath, n, body);
        },
      },
      fixPr: async (key, _n, feedbackPath, expectedHeadSha) => {
        const { mr, client } = resolveCi(key);
        const current = await client.getChangeRequest(mr.projectPath, mr.changeNumber);
        if (current.state !== "opened" || current.head.sha !== expectedHeadSha) return false;
        const repo = resolveGitLabRepo(mr);
        if (!repo) return false;
        await repoManager.ensureBareClone(repo);
        await repoManager.fetch(repo.name);
        const base = await repoManager.ensureBaseWorktree(repo);
        const invoke = () =>
          runCiFixViaCli(mr.projectPath, mr.changeNumber, feedbackPath, {
            cwd: base,
            env: buildRepoEnv(repo, workspaceDir),
            webUrl: mr.webUrl,
            serializationKey: `${mr.instanceUrl}:${mr.projectPath}!${mr.changeNumber}`,
            expectedHeadSha,
          });
        return options.coordinator ? options.coordinator.run(invoke) : invoke();
      },
      verbose,
    });
    acquirers.push(gitlabCiWatcher);
    intervalUpdaters.push((seconds) => gitlabCiWatcher.updateInterval(seconds));

    reconcileGitLabRelay = async (envelope) => {
      const { codeHost, ref } = envelope;
      const matches = state.workerState
        .listOpenAgentChangeRequests()
        .filter(
          (mr) =>
            mr.provider === "gitlab" &&
            mr.instanceUrl === codeHost.instanceUrl &&
            mr.projectId === codeHost.projectId &&
            mr.projectPath === codeHost.projectPath &&
            (ref.change === undefined || mr.changeNumber === ref.change) &&
            (ref.branch === undefined || mr.branch === ref.branch),
        );
      if (matches.length === 0) {
        if (verbose) {
          console.log(
            `   [relay] no registered GitLab change matches ${codeHost.projectPath}` +
              `${ref.change ? `!${ref.change}` : ref.branch ? `:${ref.branch}` : ""}`,
          );
        }
        return;
      }
      for (const mr of matches) {
        if (envelope.eventType === "ci.changed") {
          const key = ciKey(mr);
          gitlabCiRows.set(key, mr);
          await gitlabCiWatcher.reconcile(key, mr.changeNumber);
        } else {
          await gitlabPoller.reconcile(mr);
        }
      }
    };
  }

  // Mode 2 relay is independent of GitHub polling credentials: tracker
  // envelopes only need the active tracker client. PR envelopes use the
  // GitHub handlers when those credentials are available.
  if (relayState || process.env.WORKER_RELAY_URL) {
    if (!relayToken) {
      console.warn(
        "⚠️  Relay is configured but no relay token is stored in the workspace — re-run `devintern worker init`. Polling continues.",
      );
    } else if (relayUrl) {
      const { RelayAcquirer } = await import("../relay-acquirer");
      const { botMentionCandidates, mentionsAnyBot } = await import("../mention-sweep-acquirer");
      const relayTaskSources = taskSources.map((source) => {
        const execute = createFleetTaskExecutor({
          config,
          workspaceDir,
          skips: state.skips,
          repoManager,
          team: source.team,
          coordinator: options.coordinator,
        });
        return {
          tracker: source.tracker,
          label: source.team?.name,
          evaluate: createFleetTaskEvaluator({
            query: source.query,
            searchTasks: source.searchTasks,
            execute,
            verbose,
          }),
        };
      });
      const evaluateTask = createFleetRelayTaskDispatcher({
        sources: relayTaskSources,
        verbose,
      });

      acquirers.push(
        new RelayAcquirer({
          relayUrl,
          relayToken,
          workerState: state.workerState,
          queue: state.queue,
          isAgentPr: (repo, prNumber) =>
            state.workerState.listOpenAgentPrs(repo).some((pr) => pr.prNumber === prNumber),
          handlers: {
            addressPr: async (repo, prNumber) => {
              if (addressPr) return addressPr(repo, prNumber);
              // No GitHub credentials → review envelopes cannot be acted on.
              console.warn(
                `⚠️  [relay] review feedback on ${repo}#${prNumber} cannot be addressed: ` +
                  "GITHUB_TOKEN is not set in this relay-backed workspace.",
              );
              return false;
            },
            handlePrComment: async (repo, prNumber, commentId) => {
              if (!github || !handleMention) {
                if (verbose) {
                  console.log(
                    `   [relay] ignoring comment on ${repo}#${prNumber}: no GitHub credentials ` +
                      "(GITHUB_TOKEN is not set in this relay-backed workspace).",
                  );
                }
                return;
              }
              const [repoOwner, repoName] = repo.split("/") as [string, string];
              const { data: comment } = await github.conditionalGet<{
                id: number;
                body: string | null;
                user: { login: string; type: string };
                created_at: string;
                html_url: string;
              }>(`/repos/${repo}/issues/comments/${commentId}`, repoOwner, repoName);
              if (!comment) return;
              const botName = await github.getBotUsername(repoOwner, repoName);
              const botNames = botMentionCandidates(botName);
              if (botNames.length === 0 || !mentionsAnyBot(comment.body, botNames)) return;
              await handleMention(repo, comment, prNumber);
            },
            evaluateTask,
            reconcileCodeHost: async (envelope) => {
              if (envelope.codeHost.provider !== "gitlab") return;
              if (!reconcileGitLabRelay) {
                if (verbose) {
                  console.log(
                    `   [relay] ignoring GitLab hint for ${envelope.codeHost.projectPath}: ` +
                      "no matching local code-host credentials",
                  );
                }
                return;
              }
              await reconcileGitLabRelay(envelope);
            },
          },
          onPollSuccess: () => {
            relayLastSuccessAt = Date.now();
          },
          verbose,
        }),
      );
    }
  }

  return acquirers;
}
