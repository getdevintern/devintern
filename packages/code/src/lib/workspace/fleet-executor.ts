import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";

import { TaskPollingAcquirer, runTaskViaCli, workerTaskArgs } from "../acquirers/task-polling";
import type { TaskExecutionResult, TaskPollOutcome } from "../acquirers/task-polling";
import type { ChangeDetector } from "../acquirers/change-detector";
import type { PickupGate } from "../worker/schedule";
import type { WebhookQueue } from "../state/webhook-queue";
import type { WorkerState } from "../state/worker-state";
import type { RoutingSkipStore } from "./state";
import { getWorkerFailover, harnessChainBlockedUntil } from "../worker/failover";
import { createTaskSupervisor, JobNotStartedError } from "../worker/supervisor";
import type { TaskSupervisor } from "../worker/supervisor";
import { findRepo, findTeam, resolveWorkspacePipelinePath } from "./config";
import type { RepoConfig, TeamConfig, WorkspaceConfig } from "./config";
import { buildRepoRunEnv, buildTeamTaskEnv } from "./env";
import { effectiveRoutingRules, routeTask, routeTaskWithRules, toRoutableTask } from "./router";
import type { RoutableTask } from "./router";
import { RUN_ORIGIN_ENV } from "../observability/analytics";
import { AUTOMATION_ID_ENV } from "../automation/acquirer";
import { INJECTED_CREATED_AT_ENV, PICKUP_RUN_ID_ENV } from "../state/session-pickup";
import { actionedSourceKey } from "../task/actioned-state";
import { QUEUE_CLAIM_ENV } from "./queue-failure-reason";
import { workspaceDbPath } from "./paths";
import { RunStore } from "../state/run-recorder";
import { resolveRunIdentity } from "../task/run-identity";
import type { StackBase } from "../dependencies/gate";
import { encodeStackBaseEnv, STACKED_ON_ENV } from "../dependencies/stacked-base";
import { worktreeKeepReason } from "../utils/worktree-keep";
import { failureFromError } from "../state/run-outcome";
import type { TrackerDependencyGate } from "./tracker-dependency-gate";

/** Cap the description snapshot read from an ad-hoc task file. */
const MAX_SETUP_FAILURE_DESCRIPTION = 20_000;

/**
 * Record a failed run for a task whose worktree setup failed before the task
 * subprocess (which normally owns the run record) could start.
 *
 * Best-effort: recording must never mask the setup failure itself.
 */
function recordSetupFailedRun(input: {
  dbPath: string;
  env: NodeJS.ProcessEnv;
  taskKey: string;
  repo: string;
  queueClaim?: string;
  /** Ad-hoc task markdown; its text becomes the run's title/description. */
  descriptionFile?: string;
  reason: string;
  /** The setup error, for the run's outcome class. */
  error?: unknown;
}): void {
  let store: RunStore | undefined;
  try {
    store = new RunStore(input.dbPath);
    const identity = resolveRunIdentity(input.env);
    const runId = store.createRun({
      origin: identity.origin,
      tracker: identity.tracker,
      team: identity.team,
      repo: input.repo,
      taskKey: input.taskKey,
      ...(input.queueClaim ? { queueClaim: input.queueClaim } : {}),
      ...(identity.automationId ? { automationId: identity.automationId } : {}),
    });
    if (input.descriptionFile && existsSync(input.descriptionFile)) {
      const description = readFileSync(input.descriptionFile, "utf8").slice(
        0,
        MAX_SETUP_FAILURE_DESCRIPTION,
      );
      store.setRunTicket(runId, { description });
    }
    store.finishRun(runId, "failed", input.reason, {
      failure: failureFromError(input.error ?? input.reason, "worktree_setup"),
    });
  } catch (error) {
    console.warn(
      `⚠️  could not record setup failure for ${input.taskKey}: ${(error as Error).message}`,
    );
  } finally {
    try {
      store?.close();
    } catch {
      // Closing a best-effort recorder must not mask the setup failure.
    }
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
  fetch(repoName: string, options?: { timeoutMs?: number }): Promise<void>;
  ensureBaseWorktree(repo: RepoConfig): Promise<string>;
  ensurePrJobWorktree(repo: RepoConfig): Promise<string>;
  createTaskWorktree(repo: RepoConfig, taskKey: string): Promise<string>;
  removeTaskWorktree(repoName: string, worktreePath: string): Promise<void>;
  sweepStaleWorktrees(repoName: string, ttlDays: number): Promise<string[]>;
  /** Bound the debug worktrees kept for one task (optional for test fakes). */
  pruneTaskWorktrees?(
    repoName: string,
    taskKey: string,
    options: { keep: number; inUse?: ReadonlySet<string> },
  ): Promise<string[]>;
}

/**
 * Debug worktrees kept per task after failed or deferred runs. A task that
 * keeps failing the same way (an agent CLI that cannot start) would otherwise
 * leave one repository copy per attempt.
 */
export const MAX_DEBUG_WORKTREES_PER_TASK = 2;

/** Task worktrees a run in this process still owns; pruning never touches them. */
const activeTaskWorktrees = new Set<string>();

export interface WorkspaceTaskAcquirerDeps {
  config: WorkspaceConfig;
  workspaceDir: string;
  workerState: WorkerState;
  queue: WebhookQueue;
  skips: RoutingSkipStore;
  repoManager: RepoManagerLike;
  detector: ChangeDetector;
  searchTasks: (query: string) => Promise<{ tasks: FleetTask[] }>;
  /**
   * Actioned gate: `true` when a task already produced a PR and has not
   * changed since. Built by the workspace wiring with tracker access.
   */
  isTaskActionedUnchanged?: (taskKey: string, updated?: string) => Promise<boolean>;
  /**
   * Keys of this source's tickets a scheduled dashboard retry owns (pending
   * or running); the poller never starts them. See `heldTaskKeys` on
   * {@link TaskPollingAcquirer}.
   */
  heldTaskKeys?: () => ReadonlySet<string>;
  /**
   * Explicit actioned-ticket source key pinned into each task subprocess (see
   * `ACTIONED_SOURCE_ENV`), so the recorder and gate can never disagree.
   */
  actionedSource?: string;
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
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
      signal?: AbortSignal;
      isDraining?: () => boolean;
      onChildSpawn?: (pid: number) => void;
    },
  ) => Promise<TaskExecutionResult>;
  /** Shared admission supervisor. A local instance is created only for focused tests. */
  supervisor?: TaskSupervisor;
  /**
   * Harness-chain gate: `true` when no chain entry can start a run (every entry
   * usage-limited or cooling down after a startup failure). Injected for tests;
   * defaults to the worker's failover controller.
   */
  isHarnessExhausted?: () => boolean;
  /**
   * Polling pause gate: resume time while every harness is usage-limited.
   * Injected for tests; defaults to the worker's failover controller.
   */
  harnessBlockedUntil?: () => number | undefined;
  /**
   * Native-blocker gate for this source's tickets (trackers whose capability
   * declares `dependencies`). A held-back ticket is reported `"waiting"` and
   * re-evaluated on the next poll.
   */
  dependencyGate?: TrackerDependencyGate;
  /** Called with the keys each poll search returned (clears stale waits). */
  onPolledTasks?: (keys: ReadonlySet<string>) => void;
}

/** Per-task CLI args from `[defaults].worker_task_args`, else `--create-pr`. */
export function fleetTaskArgs(config: WorkspaceConfig): string[] {
  const raw = config.defaults.workerTaskArgs;
  if (raw && raw.trim()) {
    return raw.trim().split(/\s+/);
  }
  return workerTaskArgs();
}

/**
 * Give a task run its repo's `default_branch` as `--pr-target-branch` unless
 * the configured args already choose one.
 *
 * `RepoManager.createTaskWorktree` cuts the worktree from `origin/<branch>`, and
 * the pipeline cuts the feature branch from `options.prTargetBranch`; passing
 * the same branch keeps the worktree base, the feature branch, and the PR base
 * in agreement. An explicit flag stays authoritative.
 */
export function repoTaskArgs(args: string[], repo: RepoConfig): string[] {
  const branch = repo.defaultBranch;
  if (!branch) return args;
  if (args.some((arg) => arg === "--pr-target-branch" || arg.startsWith("--pr-target-branch="))) {
    return args;
  }
  return [...args, "--pr-target-branch", branch];
}

/**
 * Build the CLI args for an error-monitor remediation run.
 *
 * The monitor already qualified the error group, so the generic feasibility
 * pass is skipped. A remediation that concludes no code change is needed (the
 * issue was already fixed, is not reproducible, or belongs to the
 * environment) is a legitimate outcome: without `--allow-no-changes` delivery
 * fails the run with "Implementation was not committed", and that failure is
 * reported back to the same Sentry issue, inflating it and feeding the next
 * remediation attempt.
 */
export function errorMonitorTaskArgs(config: WorkspaceConfig): string[] {
  const args = fleetTaskArgs(config);
  const withClarity = args.includes("--skip-clarity-check")
    ? args
    : [...args, "--skip-clarity-check"];
  return withClarity.includes("--allow-no-changes")
    ? withClarity
    : [...withClarity, "--allow-no-changes"];
}

/**
 * Resolve the actioned-ticket source key for a workspace source/team.
 *
 * The polling gate and every executor path (poll, retry, relay) derive the key
 * here so the task subprocess's `DEVINTERN_ACTIONED_SOURCE` pin and the gate
 * can never disagree. `team` is the already-resolved team, if any.
 */
export function resolveActionedSource(config: WorkspaceConfig, team?: TeamConfig): string {
  return actionedSourceKey(team?.tracker ?? config.defaults.tracker, team?.name);
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
  const execute = createGatedFleetTaskExecutor(deps, {
    source: team ? `poll:${team.tracker}:${team.name}` : `poll:${config.defaults.tracker}`,
    dependencyGate: deps.dependencyGate,
  });

  // The acquirer's executeTask only receives the task key; remember each
  // task's routing fields from the evaluate step of the same tick.
  const routables = new Map<string, RoutableTask>();

  const executeTask = (taskKey: string): Promise<TaskPollOutcome> =>
    execute(
      taskKey,
      routables.get(taskKey) ?? toRoutableTask({ key: taskKey, labels: [], components: [] }),
    );

  const supervisor = deps.supervisor;
  const capacity = supervisor
    ? () => {
        const stats = supervisor.stats();
        return { available: stats.available, inFlight: stats.running };
      }
    : undefined;

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
      try {
        deps.onPolledTasks?.(new Set(tasks.map((task) => task.key)));
      } catch (error) {
        console.warn(`⚠️  could not refresh dependency waits: ${(error as Error).message}`);
      }
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
    capacity,
    verbose,
    harnessBlockedUntil: deps.harnessBlockedUntil ?? (() => harnessChainBlockedUntil()),
    isTaskActionedUnchanged: deps.isTaskActionedUnchanged
      ? (task) => deps.isTaskActionedUnchanged!(task.key, task.updated)
      : undefined,
    heldTaskKeys: deps.heldTaskKeys,
  });
}

/** Routed-execution slice of {@link WorkspaceTaskAcquirerDeps}. */
export type FleetExecutorDeps = Pick<
  WorkspaceTaskAcquirerDeps,
  | "config"
  | "workspaceDir"
  | "skips"
  | "repoManager"
  | "runTask"
  | "team"
  | "supervisor"
  | "actionedSource"
  | "isHarnessExhausted"
>;

/** Options for {@link createFleetTaskExecutor} / {@link createGatedFleetTaskExecutor}. */
export type FleetExecutorOptions = {
  extraArgs?: string[] | (() => string[]);
  repo?: string;
  runOrigin?: "worker" | "error_monitor" | "local";
  source?: string;
  /**
   * Task reference passed to the CLI subprocess when it differs from the
   * task key (e.g. an injected task's markdown file path). The key still
   * names the worktree and supervisor label.
   */
  taskRef?: string;
  /**
   * Run a retry targets (persisted on the scheduled-retry row). Threaded to
   * the task subprocess as `DEVINTERN_PICKUP_RUN_ID` so session pickup
   * resolves from that specific run.
   */
  pickupRunId?: number;
  /**
   * Enqueue time (epoch ms) of the injected row this run serves. Threaded to
   * the task subprocess as `DEVINTERN_INJECTED_CREATED_AT` so session pickup
   * only reopens a succeeded run of that same row.
   */
  injectedCreatedAt?: number;
  /** Unique queue execution whose run record should receive this outcome. */
  queueClaim?: string;
  /**
   * Team whose credentials a run without an acquiring team borrows (an
   * ad-hoc task for a repo with a fixed team, or `worker add --team`). Only
   * the credential layers apply; see {@link buildRepoRunEnv}. Ignored when
   * `deps.team` is set.
   */
  credentialTeam?: TeamConfig;
  /**
   * Called with the task child pid after it spawns. Used by the injected-task
   * queue to persist the pid for interrupt recovery.
   */
  onChildSpawn?: (pid: number) => void;
  /**
   * Native-blocker gate, run after routing and before any git or tracker
   * side effect. A ticket it holds back returns `"waiting"`; a stacked
   * verdict hands its base to the task subprocess via `STACKED_ON_ENV`.
   */
  dependencyGate?: TrackerDependencyGate;
};

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
  options: Omit<FleetExecutorOptions, "dependencyGate"> = {},
): (taskKey: string, routable: RoutableTask) => Promise<TaskExecutionResult> {
  const execute = createGatedFleetTaskExecutor(deps, options);
  return async (taskKey, routable) => {
    const result = await execute(taskKey, routable);
    // Only a dependency gate produces "waiting"; never report work that did
    // not start as done.
    return result === "waiting" ? "deferred" : result;
  };
}

/** Best-effort: drop a task's older debug worktrees beyond {@link MAX_DEBUG_WORKTREES_PER_TASK}. */
async function pruneDebugWorktrees(
  repoManager: RepoManagerLike,
  repoName: string,
  taskKey: string,
  scope: string,
): Promise<void> {
  if (!repoManager.pruneTaskWorktrees) return;
  try {
    const removed = await repoManager.pruneTaskWorktrees(repoName, taskKey, {
      keep: MAX_DEBUG_WORKTREES_PER_TASK,
      inUse: activeTaskWorktrees,
    });
    if (removed.length > 0) {
      console.log(
        `🧹 ${scope} removed ${removed.length} older debug worktree(s) of ${taskKey} ` +
          `(keeping the newest ${MAX_DEBUG_WORKTREES_PER_TASK})`,
      );
    }
  } catch (error) {
    console.warn(
      `⚠️  ${scope} could not prune old worktrees of ${taskKey}: ${(error as Error).message}`,
    );
  }
}

/**
 * {@link createFleetTaskExecutor} with an optional native-blocker gate
 * (`options.dependencyGate`): a held-back ticket resolves to `"waiting"`.
 */
export function createGatedFleetTaskExecutor(
  deps: FleetExecutorDeps,
  options: FleetExecutorOptions = {},
): (taskKey: string, routable: RoutableTask) => Promise<TaskPollOutcome> {
  const { config, workspaceDir, skips, repoManager } = deps;
  const runTask = deps.runTask ?? runTaskViaCli;
  const isHarnessExhausted =
    deps.isHarnessExhausted ?? (() => getWorkerFailover()?.allExhausted() ?? false);
  const supervisor =
    deps.supervisor ??
    createTaskSupervisor({
      maxConcurrency: config.workspace.execution.maxConcurrency,
      maxConcurrencyPerRepo: config.workspace.execution.maxConcurrencyPerRepo,
    });

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

    // Defer before touching git: when the whole harness chain is usage-limited
    // or cooling down, the CLI child would exit without starting work, yet the
    // worktree created for it is kept "for debugging". Poll retries would then
    // leak one disposable worktree per tick until the limit window ends.
    if (isHarnessExhausted()) {
      return "deferred";
    }

    let stackedOn: StackBase | undefined;
    if (options.dependencyGate) {
      const gate = await options.dependencyGate(taskKey, repo.name);
      if (gate.kind !== "ready") return "waiting";
      stackedOn = gate.stackedOn;
    }

    try {
      return await supervisor.schedule({
        id: randomUUID(),
        source: options.source ?? options.runOrigin ?? (team ? `poll:${team.name}` : "worker"),
        repo: repo.name,
        kind: "task",
        label: taskKey,
        checkoutClass: "task_worktree",
        run: async (signal) => {
          // Read per run so a live-reloaded `[defaults].pipeline_file` applies
          // to subsequent tasks.
          const pipelineDefaultFile = config.defaults.pipelineFile
            ? resolveWorkspacePipelinePath(workspaceDir, config.defaults.pipelineFile)
            : undefined;

          const env = team
            ? buildTeamTaskEnv(repo, team, workspaceDir, {
                actionedSource: deps.actionedSource,
                pipelineDefaultFile,
              })
            : buildRepoRunEnv(repo, options.credentialTeam, workspaceDir, {
                actionedSource: deps.actionedSource,
                pipelineDefaultFile,
              });
          if (options.runOrigin === "local") {
            // An injected task is never an automation run. A marker leaked from
            // the worker's parent env would make the pipeline record a
            // `scheduled` origin/automationId, which no longer matches the
            // local scope startup recovery looks runs up by.
            delete env[AUTOMATION_ID_ENV];
          }
          const childEnv = {
            ...env,
            [RUN_ORIGIN_ENV]: options.runOrigin ?? "worker",
            [QUEUE_CLAIM_ENV]: options.queueClaim,
            // Always set (possibly to undefined) so a value never leaks from
            // the worker's own environment into an unstacked run.
            [STACKED_ON_ENV]: stackedOn ? encodeStackBaseEnv(stackedOn) : undefined,
            ...(options.pickupRunId !== undefined
              ? { [PICKUP_RUN_ID_ENV]: String(options.pickupRunId) }
              : {}),
            ...(options.injectedCreatedAt !== undefined
              ? { [INJECTED_CREATED_AT_ENV]: String(options.injectedCreatedAt) }
              : {}),
          };

          let worktree: string;
          try {
            await repoManager.ensureBareClone(repo);
            await repoManager.fetch(repo.name);
            worktree = await repoManager.createTaskWorktree(repo, taskKey);
          } catch (error) {
            // The task subprocess records the run, so a failure before it
            // spawns would otherwise leave no run: the task would be invisible
            // in the dashboard and its queue row would keep only a generic
            // reason. Record the attempt here instead.
            recordSetupFailedRun({
              dbPath: workspaceDbPath(workspaceDir),
              env: childEnv,
              taskKey,
              repo: repo.name,
              queueClaim: options.queueClaim,
              descriptionFile: options.runOrigin === "local" ? options.taskRef : undefined,
              reason: `Worktree setup failed: ${(error as Error).message}`,
              error,
            });
            throw error;
          }
          console.log(`🏗️  ${scope} ${taskKey} → ${repo.name} (${worktree})`);

          activeTaskWorktrees.add(worktree);
          let ok: TaskExecutionResult;
          try {
            ok = await runTask(options.taskRef ?? taskKey, repoTaskArgs(extraArgs, repo), {
              cwd: worktree,
              env: childEnv,
              signal,
              isDraining: () => supervisor.isDraining(),
              ...(options.onChildSpawn ? { onChildSpawn: options.onChildSpawn } : {}),
            });
          } finally {
            activeTaskWorktrees.delete(worktree);
          }

          // A retry-gate skip is a clean outcome: no run was started, so the
          // disposable worktree holds no work to debug.
          // An escalated run also exits 0; one whose unfinished work could
          // not be pushed marks its worktree to be kept (see preserve-work.ts).
          const keepReason =
            ok === true || ok === "skipped" ? await worktreeKeepReason(worktree) : undefined;
          if (keepReason) {
            console.warn(
              `⚠️  ${scope} keeping worktree with ${taskKey}'s unsaved work: ${worktree} (${keepReason})`,
            );
          } else if (ok === true || ok === "skipped") {
            await repoManager.removeTaskWorktree(repo.name, worktree);
          } else {
            console.warn(`⚠️  ${scope} keeping worktree for debugging: ${worktree}`);
            await pruneDebugWorktrees(repoManager, repo.name, taskKey, scope);
          }
          return ok;
        },
      });
    } catch (error) {
      if (error instanceof JobNotStartedError) return "deferred";
      console.error(
        `❌ ${scope} ${taskKey} failed in repo "${repo.name}": ${(error as Error).message}`,
      );
      return false;
    }
  };
}
