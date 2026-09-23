import { randomUUID } from "crypto";

import { TaskPollingAcquirer, runTaskViaCli, workerTaskArgs } from "../acquirers/task-polling";
import type { TaskExecutionResult } from "../acquirers/task-polling";
import type { ChangeDetector } from "../acquirers/change-detector";
import type { PickupGate } from "../worker/schedule";
import type { WebhookQueue } from "../state/webhook-queue";
import type { WorkerState } from "../state/worker-state";
import type { RoutingSkipStore } from "./state";
import { createTaskSupervisor, JobNotStartedError } from "../worker/supervisor";
import type { TaskSupervisor } from "../worker/supervisor";
import { findRepo, findTeam } from "./config";
import type { RepoConfig, TeamConfig, WorkspaceConfig } from "./config";
import { buildRepoEnv, buildTeamTaskEnv } from "./env";
import { effectiveRoutingRules, routeTask, routeTaskWithRules, toRoutableTask } from "./router";
import type { RoutableTask } from "./router";
import { RUN_ORIGIN_ENV } from "../observability/analytics";
import { actionedSourceKey } from "../task/actioned-state";

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
  /**
   * Actioned gate: `true` when a task already produced a PR and has not
   * changed since. Built by the workspace wiring with tracker access.
   */
  isTaskActionedUnchanged?: (taskKey: string, updated?: string) => Promise<boolean>;
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
    opts: { cwd: string; env: Record<string, string | undefined>; signal?: AbortSignal },
  ) => Promise<TaskExecutionResult>;
  /** Shared admission supervisor. A local instance is created only for focused tests. */
  supervisor?: TaskSupervisor;
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
  const execute = createFleetTaskExecutor(deps, {
    source: team ? `poll:${team.tracker}:${team.name}` : `poll:${config.defaults.tracker}`,
  });

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
    isTaskActionedUnchanged: deps.isTaskActionedUnchanged
      ? (task) => deps.isTaskActionedUnchanged!(task.key, task.updated)
      : undefined,
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
>;

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
    source?: string;
  } = {},
): (taskKey: string, routable: RoutableTask) => Promise<TaskExecutionResult> {
  const { config, workspaceDir, skips, repoManager } = deps;
  const runTask = deps.runTask ?? runTaskViaCli;
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

    try {
      return await supervisor.schedule({
        id: randomUUID(),
        source: options.source ?? options.runOrigin ?? (team ? `poll:${team.name}` : "worker"),
        repo: repo.name,
        kind: "task",
        label: taskKey,
        checkoutClass: "task_worktree",
        run: async (signal) => {
          await repoManager.ensureBareClone(repo);
          await repoManager.fetch(repo.name);
          const worktree = await repoManager.createTaskWorktree(repo, taskKey);
          console.log(`🏗️  ${scope} ${taskKey} → ${repo.name} (${worktree})`);

          const ok = await runTask(taskKey, extraArgs, {
            cwd: worktree,
            env: {
              ...(team
                ? buildTeamTaskEnv(repo, team, workspaceDir, {
                    actionedSource: deps.actionedSource,
                  })
                : buildRepoEnv(repo, workspaceDir, { actionedSource: deps.actionedSource })),
              [RUN_ORIGIN_ENV]: options.runOrigin ?? "worker",
            },
            signal,
          });

          if (ok === true) {
            await repoManager.removeTaskWorktree(repo.name, worktree);
          } else {
            console.warn(`⚠️  ${scope} keeping worktree for debugging: ${worktree}`);
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
