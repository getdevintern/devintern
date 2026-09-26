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
import { randomUUID } from "crypto";

import { parseEnvInteger } from "../config/env-integer";
import { createPickupGate } from "../worker/schedule";
import type { PickupGate, ScheduleSnapshot } from "../worker/schedule";
import {
  loadProjectSettingsFrom,
  recoverOrphanedTaskRuns,
  resolveStatusName,
} from "../worker/orphan-recovery";
import { RunStore } from "../state/run-recorder";
import { RetryStateStore } from "../state/retry-state";
import { ScheduledRetryStore } from "../state/run-retry";
import { createTaskActionedGate } from "../task/actioned-state";
import type { TaskTrackerClient } from "../trackers/client";
import { findRepo, findTeam, loadWorkspaceConfig } from "./config";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { applyWorkspaceProcessEnv, buildErrorMonitorEnv, buildRepoEnv, buildTeamEnv } from "./env";
import {
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceDbPath,
  worktreesDir,
  workspaceRunNowPath,
} from "./paths";
import { WorkspaceConfigReloader } from "./config-reload";
import { createWorkspaceLock, openWorkspaceState } from "./state";
import { BASE_WORKTREE_NAME, RepoManager } from "./repo-manager";
import { probePushAccess } from "../code-host/github/push-probe";
import { AutomationAcquirer } from "../automation/acquirer";
import type { AutomationConfig } from "../automation/config";
import { automationTaskArgs } from "../automation/config";
import { EstimationAcquirer } from "../automation/estimation-acquirer";
import { createTaskSupervisor, JobNotStartedError } from "../worker/supervisor";
import type { TaskSupervisor } from "../worker/supervisor";
import type { AutomationRunContext } from "../automation/acquirer";
import { flushAnalytics, trackWorkerStarted } from "../observability/analytics";
import { startWorkerFailover } from "../worker/failover";
import { RetryQueueAcquirer } from "./retry-acquirer";
import { createIdleWorkerAutoUpdater } from "./worker-auto-update";
import {
  createFleetTaskExecutor,
  createWorkspaceTaskAcquirer,
  errorMonitorTaskArgs,
  fleetTaskArgs,
  resolveActionedSource,
} from "./fleet-executor";
import type { RepoManagerLike } from "./fleet-executor";
import { buildFleetEventAcquirers } from "./fleet-event-acquirers";
import type { FleetEventReloadHooks, FleetSourceRuntime } from "./fleet-event-acquirers";

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
        const { TaskTrackerManager } = await import("../trackers/manager");
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

/**
 * Admit an automation context and retain its supervisor slot until the
 * acquirer releases that context after its subprocess settles.
 */
async function withSupervisorSlot(
  resolveContext: () => Promise<AutomationRunContext | null>,
  supervisor: TaskSupervisor,
  request: {
    source: string;
    kind: "automation" | "estimation";
    repo?: string;
    checkoutClass: "shared_base" | "workspace";
  },
): Promise<AutomationRunContext | null> {
  let admit!: (context: AutomationRunContext | null) => void;
  let rejectAdmission!: (error: unknown) => void;
  const admitted = new Promise<AutomationRunContext | null>((resolve, reject) => {
    admit = resolve;
    rejectAdmission = reject;
  });
  let releaseSlot!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });

  const scheduled = supervisor.schedule({
    id: randomUUID(),
    ...request,
    run: async (signal) => {
      const context = await resolveContext();
      if (!context) {
        admit(null);
        return;
      }
      if (signal.aborted) {
        await context.release();
        throw new Error("The worker stopped while preparing the scheduled run.");
      }
      const releaseContext = context.release;
      let released = false;
      admit({
        ...context,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await releaseContext();
          } finally {
            releaseSlot();
          }
        },
      });
      await held;
    },
  });
  void scheduled.catch(rejectAdmission);
  try {
    return await admitted;
  } catch (error) {
    if (error instanceof JobNotStartedError) return null;
    throw error;
  }
}

/** Resolve a scheduled run context while holding the repo lock during preparation. */
export async function resolveWorkspaceAutomationContext(
  automation: AutomationConfig,
  config: WorkspaceConfig,
  workspaceDir: string,
  repoManager: RepoManagerLike,
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

  await repoManager.ensureBareClone(repo);
  await repoManager.fetch(repo.name);
  const cwd = await repoManager.ensureBaseWorktree(repo);
  return {
    cwd,
    env: buildRepoEnv(repo, workspaceDir),
    repo: repo.name,
    taskFileDir,
    release() {},
  };
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
  /** Activate an eligible Worker Pilot after validation, before sources acquire work. */
  beforeAcquirersStart?: () => Promise<void>;
  /** Revalidate paid or trial automation access while the daemon remains alive. */
  accessCheck?: () => Promise<{ valid: boolean; message: string }>;
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

/** Runtime facts the production reload validator needs about the worker. */
export interface ReloadValidationContext {
  /** Multi-team mode builds per-team clients, so team identities restart. */
  multiTeam: boolean;
  /** Running change-detector sources; 0 means none could be initialized. */
  sourceCount: number;
}

function teamRuntimeShape(value: WorkspaceConfig) {
  return value.teams.map(({ name, tracker, envFile, env }) => ({ name, tracker, envFile, env }));
}

/**
 * The production reload gate the workspace worker installs on its reloader:
 * rejects runtime-incompatible edits before the shared config instance is
 * mutated (see `applyWorkspaceConfig`). Edits it allow apply live — including
 * the whole `[worker]` section (e.g. `auto_update`); the startup-only keys it
 * rejects (team identities, error monitors, dashboard, `[worker.schedule]`)
 * need a restart.
 */
export function validateReloadedWorkspaceConfig(
  next: WorkspaceConfig,
  current: WorkspaceConfig,
  context: ReloadValidationContext,
): void {
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
  if (!context.multiTeam && next.defaults.taskQuery && context.sourceCount === 0) {
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

  const { multiTeam, initialQuery, intervalSeconds } = applyWorkspaceEnv(config, workspaceDir);
  const initialFleetAutomations = resolveFleetAutomations(config);
  if (initialFleetAutomations.problems.length > 0) {
    throw new Error(`Invalid ${configPath}:\n- ${initialFleetAutomations.problems.join("\n- ")}`);
  }

  // Dashboard retries ride the shared workspace DB: the dashboard inserts a
  // pending row, this worker drains it through the fleet executor below.
  const retryQueue = new ScheduledRetryStore(workspaceDbPath(workspaceDir));

  assertWorkspaceHasWork(config, retryQueue, multiTeam, initialQuery);

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
  const supervisor = createTaskSupervisor({
    maxConcurrency: config.workspace.execution.maxConcurrency,
    maxConcurrencyPerRepo: config.workspace.execution.maxConcurrencyPerRepo,
  });
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
      execute: (taskKey, routable, retry) => {
        const retryTeam = retry.team ? findTeam(config, retry.team) : undefined;
        return createFleetTaskExecutor(
          {
            config,
            workspaceDir,
            skips: state.skips,
            repoManager,
            supervisor,
            ...(retryTeam ? { team: retryTeam } : {}),
            actionedSource: resolveActionedSource(config, retryTeam),
          },
          // The persisted repo/team make retries deterministic even when
          // task keys overlap or the original route depended on labels.
          {
            extraArgs: () => ["--force", ...fleetTaskArgs(config)],
            repo: retry.repo,
            source: "retry",
          },
        )(taskKey, routable);
      },
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
    // Each automation's `open_pr` decides PR creation — workspace-level
    // `worker_task_args` (`--create-pr --auto-review`) applies only when the
    // schedule opts in, and off/omitted runs get `--no-git` instead.
    automationArgs: (automation) => automationTaskArgs(automation, fleetTaskArgs(config)),
    resolveContext: async (automation) => {
      const repo = automation.repo
        ? findRepo(config, automation.repo)
        : config.repos.length === 1
          ? config.repos[0]
          : undefined;
      return withSupervisorSlot(
        () => resolveWorkspaceAutomationContext(automation, config, workspaceDir, repoManager),
        supervisor,
        {
          source: `automation:${automation.id}`,
          kind: "automation",
          repo: repo?.name,
          checkoutClass: repo ? "shared_base" : "workspace",
        },
      );
    },
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
    resolveContext: (estimation) =>
      withSupervisorSlot(
        async () => ({ cwd: workspaceDir, env: { ...process.env }, release() {} }),
        supervisor,
        {
          source: `estimation:${estimation.id}`,
          kind: "estimation",
          checkoutClass: "workspace",
        },
      ),
  });
  acquirers.push(estimationAcquirer);

  // Error-monitor adapters share one provider-neutral acquirer. Each source
  // is pinned to a repo (and optionally a team), so projects with different
  // credentials cannot be dispatched into the wrong codebase.
  const { ErrorMonitorAcquirer, createErrorMonitorProvider } =
    await import("../acquirers/error-monitor");
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
        supervisor,
      },
      {
        repo: repo.name,
        runOrigin: "error_monitor",
        source: `error_monitor:${source.id}`,
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
    await import("../trackers/manager");
  const { createChangeDetector } = await import("../acquirers/change-detector");
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
        client,
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

  // Single-source workspaces keep the tracker client lazy (automations-only
  // workspaces need no tracker credentials at startup); multi-team sources
  // carry the client built above.
  const singleTrackerManager = multiTeam ? undefined : new TaskTrackerManager();
  for (const source of sources) {
    // Derive the actioned source key once and reuse it verbatim for the gate
    // and the subprocess env (`DEVINTERN_ACTIONED_SOURCE`), so a stale `.env`
    // tracker or a leaked team name cannot make the recorder and gate disagree.
    const actionedSource = resolveActionedSource(config, source.team);
    const actionedGate = createTaskActionedGate({
      getTracker: source.client ? () => source.client! : () => singleTrackerManager!.getClient(),
      workerState: state.workerState,
      source: actionedSource,
    });
    // Share the gate with the relay task evaluator so a relayed change caused
    // by the worker's own post-PR transition is not re-implemented either.
    source.isTaskActionedUnchanged = actionedGate;
    const taskAcquirer = createWorkspaceTaskAcquirer({
      config,
      workspaceDir,
      workerState: state.workerState,
      queue: state.queue,
      skips: state.skips,
      repoManager,
      detector: source.detector,
      searchTasks: source.searchTasks,
      isTaskActionedUnchanged: (taskKey, updated) => actionedGate(taskKey, updated),
      actionedSource,
      query: source.query,
      intervalSeconds,
      gate: pickupGate,
      team: source.team,
      verbose: options.verbose,
      supervisor,
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
      supervisor,
    })),
  );

  /**
   * Apply a freshly validated config to consumers that snapshot values:
   * reconciles the automation set, surfaces semantic problems, and refreshes
   * cadence-driven acquirers when `[defaults].poll_interval` changed.
   */
  const applyReloadedConfig = (updated: WorkspaceConfig): void => {
    supervisor.updateLimits({
      maxConcurrency: updated.workspace.execution.maxConcurrency,
      maxConcurrencyPerRepo: updated.workspace.execution.maxConcurrencyPerRepo,
    });
    const fleet = resolveFleetAutomations(updated);
    fleetAutomationAcquirer.applyAutomations(fleet.automations);
    estimationAcquirer.applyEstimations(updated.estimations);

    if (updated.defaults.pollIntervalSeconds !== pollIntervalSeconds) {
      pollIntervalSeconds = updated.defaults.pollIntervalSeconds;
      console.log(`⏱️  [config] Poll interval is now ${pollIntervalSeconds}s`);
      for (const update of intervalUpdaters) update(pollIntervalSeconds);
    }
    eventReloadHooks.hooks?.reconcileMentionSweeps();
    eventReloadHooks.hooks?.reconcileConflictResolution();
  };

  // Live reload keeps queries, fixed team destinations, routing, repos,
  // automations, worker_task_args, and cadence live. Team identities and
  // credentials require rebuilding clients/detectors and therefore restart.
  const reloader = new WorkspaceConfigReloader({
    configPath,
    current: config,
    validate: (next, active) =>
      validateReloadedWorkspaceConfig(next, active, {
        multiTeam,
        sourceCount: sources.length,
      }),
    onApplied: applyReloadedConfig,
  });
  reloader.start();

  // Closed during onShutdown so the handover successor can rebind the port.
  let dashboardServer: ReturnType<typeof Bun.serve> | null = null;
  if (config.workspace.dashboard) {
    try {
      const { startDashboardServer } = await import("../../dashboard-server");
      // `schedule`: retries are drained by this worker's retry-queue acquirer
      // through the normal pipeline (never spawned from the workspace home);
      // automation "Run now" triggers go through the in-process scheduler.
      dashboardServer = startDashboardServer({
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
    `⚙️  Agent concurrency: ${config.workspace.execution.maxConcurrency} global, ` +
      `${config.workspace.execution.maxConcurrencyPerRepo} per repository`,
  );
  if (
    config.workspace.execution.maxConcurrency > 1 ||
    config.workspace.execution.maxConcurrencyPerRepo > 1
  ) {
    console.warn(
      "⚠️  Concurrent jobs share host ports, processes, Docker, caches, and linked Git metadata.",
    );
  }
  console.log(
    "🔄 Live config reload armed: edits to workspace.toml apply automatically (SIGHUP forces one)",
  );
  // Idle self-update: while the daemon runs for weeks, keep a global
  // npm/bun install current — checked at most daily, applied only when the
  // supervisor is idle, never touching source/local installs. Opt out with
  // [worker] auto_update = false (live-reloaded) or DEVINTERN_NO_UPDATE=1.
  let restartRequested = false;
  const autoUpdater = createIdleWorkerAutoUpdater({
    config,
    supervisor,
    cliVersion: options.cliVersion ?? "0.0.0",
    requestShutdown: () => {
      if (restartRequested) return;
      restartRequested = true;
      process.kill(process.pid, "SIGTERM");
    },
  });
  autoUpdater.start();

  const { startWorker } = await import("../../worker");
  await startWorker(
    {
      lock: createWorkspaceLock(workspaceDir),
      label: workspaceDir,
      // Capture logs in the workspace home: one daemon serves many repos, and
      // the dashboard's log tailer already searches this directory.
      logDir: workspaceDir,
      beforeAcquirersStart: options.beforeAcquirersStart,
      accessCheck: options.accessCheck,
      beginShutdown: () => supervisor.drain(),
      onShutdown: () => {
        reloader.stop();
        autoUpdater.stop();
        // Release the listening socket before finalExitCode: the handover
        // successor starts (binds the same dashboard port) while this
        // process is still alive, so a socket still bound here can fail it
        // with EADDRINUSE and leave the daemon down.
        if (dashboardServer) {
          try {
            dashboardServer.stop();
          } catch {
            // Already stopped.
          }
          dashboardServer = null;
        }
      },
      finalExitCode: () => autoUpdater.finalExitCode(),
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

/** Export shared workspace values into `process.env` and return derived defaults. */
function applyWorkspaceEnv(
  config: WorkspaceConfig,
  workspaceDir: string,
): { multiTeam: boolean; initialQuery: string | undefined; intervalSeconds: number } {
  // Shared workspace values serve GitHub/review consumers and the legacy
  // single-defaults tracker. Team clients use explicit composed env maps.
  applyWorkspaceProcessEnv(workspaceDir);
  const multiTeam = config.teams.length > 0;
  if (config.defaults.tracker) process.env.TASK_TRACKER = config.defaults.tracker;
  // In-process consumers (dashboard, run records) follow the fleet DB.
  process.env.WEBHOOK_QUEUE_DB = workspaceDbPath(workspaceDir);
  return {
    multiTeam,
    initialQuery: config.defaults.taskQuery,
    intervalSeconds: config.defaults.pollIntervalSeconds,
  };
}

/**
 * Exit when workspace mode has no work configured.
 *
 * Scheduled dashboard retries are the one exception: the worker can still run
 * to drain them.
 */
function assertWorkspaceHasWork(
  config: WorkspaceConfig,
  retryQueue: ScheduledRetryStore,
  multiTeam: boolean,
  initialQuery: string | undefined,
): void {
  const hasWork =
    multiTeam ||
    initialQuery ||
    config.automations.length > 0 ||
    config.estimations.length > 0 ||
    config.errorMonitors.some((source) => source.enabled);
  if (hasWork) return;

  if (retryQueue.hasPending()) {
    console.warn(
      "⚠️  No task query or automations configured; the worker will only drain scheduled dashboard retries.",
    );
    return;
  }
  console.error(
    "❌ Workspace mode needs a task query: set [defaults].task_query in workspace.toml.",
  );
  process.exit(1);
}

export {
  createFleetTaskExecutor,
  createWorkspaceTaskAcquirer,
  errorMonitorTaskArgs,
  fleetTaskArgs,
  resolveActionedSource,
  buildFleetEventAcquirers,
};
export type { FleetEventReloadHooks, FleetSourceRuntime, RepoManagerLike };
export type { FleetExecutorDeps, FleetTask, WorkspaceTaskAcquirerDeps } from "./fleet-executor";
