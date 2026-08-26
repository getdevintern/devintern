/**
 * Worker workspace (fleet) mode.
 *
 * One `devintern worker` process drives every repo in the workspace: a
 * single fleet task acquirer polls the tracker with the workspace query,
 * routes each ready task to its repo (never guessing), and executes it in a
 * disposable worktree with a per-repo environment. All durable state lives
 * in the central workspace DB.
 */

import { join } from "path";

import { LockManager } from "../lock-manager";
import { parseEnvInteger } from "../env-integer";
import {
  TaskPollingAcquirer,
  processedTaskId,
  runTaskViaCli,
  workerTaskArgs,
} from "../task-polling-acquirer";
import type { ReadyTask } from "../task-polling-acquirer";
import type { ChangeDetector } from "../change-detector";
import type { WebhookQueue } from "../webhook-queue";
import type { WorkerState } from "../worker-state";
import { effectiveMaxConcurrency, findRepo, loadWorkspaceConfig } from "./config";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { buildRepoEnv, parseEnvFile } from "./env";
import {
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceDbPath,
  workspaceEnvPath,
} from "./paths";
import { routeTask, toRoutableTask } from "./router";
import type { RoutableTask } from "./router";
import { RepoBusyError, SchedulerStoppedError, WorkspaceScheduler } from "./scheduler";
import { createRepoRunLock, createWorkspaceLock, openWorkspaceState } from "./state";
import type { RoutingSkipStore } from "./state";
import { RepoManager } from "./repo-manager";
import { AutomationAcquirer } from "../automation-acquirer";
import type { AutomationConfig } from "../automation-config";

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
  query: string;
  intervalSeconds: number;
  verbose?: boolean;
  /**
   * Shared fleet scheduler. When provided, ready tasks are dispatched
   * through it (per-repo lanes + global concurrency limit); when omitted,
   * the acquirer executes strictly sequentially.
   */
  scheduler?: WorkspaceScheduler;
  /** Task runner (injected for tests; defaults to the CLI subprocess). */
  runTask?: (
    taskKey: string,
    extraArgs: string[],
    opts: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<boolean>;
  /** Repo run lock factory (injected for tests). */
  repoLock?: (repoName: string) => LockManager;
}

interface RepoRunLockLike {
  acquire(): { success: boolean; message: string; pid?: number };
  release(): void;
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

/** Per-task CLI args: workspace defaults win, then the usual env/default. */
export function fleetTaskArgs(config: WorkspaceConfig): string[] {
  const raw = config.defaults.workerTaskArgs;
  if (raw && raw.trim()) {
    return raw.trim().split(/\s+/);
  }
  return workerTaskArgs();
}

/**
 * Build the fleet task acquirer: detect-then-evaluate (reusing
 * {@link TaskPollingAcquirer}) with routing between evaluate and execute.
 *
 * With a scheduler, each tick's ready batch is marked and dispatched
 * together: different repos' runs overlap up to the configured global limit,
 * while same-repo work stays FIFO inside its lane. Without one, tasks run
 * strictly sequentially — the historical behavior.
 *
 * Ambiguous/unrouted tasks are recorded as routing skips and count as
 * handled: the acquirer's dedupe keeps them out of the loop until the task
 * changes again — the same policy as failing tasks.
 */
export function createWorkspaceTaskAcquirer(deps: WorkspaceTaskAcquirerDeps): TaskPollingAcquirer {
  const { config, workerState, queue, detector, searchTasks, query, intervalSeconds, verbose } =
    deps;
  const execute = createFleetTaskExecutor(deps);

  // The acquirer's executeTask only receives the task key; remember each
  // task's routing fields from the evaluate step of the same tick.
  const routables = new Map<string, RoutableTask>();

  const routableFor = (taskKey: string): RoutableTask =>
    routables.get(taskKey) ?? toRoutableTask({ key: taskKey, labels: [], components: [] });

  const executeTask = (taskKey: string): Promise<boolean> => execute(taskKey, routableFor(taskKey));

  const sourceLabel = `poll:${config.defaults.tracker}`;

  return new TaskPollingAcquirer({
    trackerType: config.defaults.tracker,
    query,
    intervalSeconds,
    detector,
    workerState,
    queue,
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
    executeBatch: deps.scheduler
      ? (tasks, helpers) =>
          dispatchBatchViaScheduler(tasks, helpers, deps.scheduler!, sourceLabel, (taskKey) =>
            execute(taskKey, routableFor(taskKey)),
          )
      : undefined,
    verbose,
  });
}

/**
 * Fleet tick strategy: mark every ready task version, then submit all of
 * them to the scheduler and await settlement. The cursor advances only after
 * the whole batch is settled (completed, failed, or deferred to a later
 * start), so nothing accepted is silently dropped by an early exit.
 *
 * Lock contention never reaches this function as a failure: scheduled work
 * parks inside the scheduler until the repo frees up. A cancellation at
 * shutdown rolls back the dedupe mark so the next start re-acquires the task.
 */
export async function dispatchBatchViaScheduler(
  tasks: ReadyTask[],
  helpers: {
    markProcessed: (externalId: string) => void;
    removeProcessed: (externalId: string) => void;
  },
  scheduler: WorkspaceScheduler,
  sourceLabel: string,
  run: (taskKey: string) => Promise<boolean>,
): Promise<void> {
  await Promise.all(
    tasks.map(async (task) => {
      const externalId = processedTaskId(task);
      // Mark before executing (same convention as serial mode): a
      // persistently failing task must not loop every tick. A shutdown that
      // cancels the queued work rolls the mark back below.
      helpers.markProcessed(externalId);
      console.log(`\n📌 [${sourceLabel}] picking up ${task.key}`);
      try {
        const ok = await run(task.key);
        console.log(
          ok
            ? `✅ [${sourceLabel}] ${task.key} completed`
            : `⚠️  [${sourceLabel}] ${task.key} did not complete cleanly`,
        );
      } catch (error) {
        if (error instanceof SchedulerStoppedError) {
          helpers.removeProcessed(externalId);
          console.warn(
            `⏸️  [${sourceLabel}] ${task.key} deferred to next start (worker shutting down)`,
          );
          return;
        }
        console.warn(`⚠️  [${sourceLabel}] ${task.key} failed: ${(error as Error).message}`);
      }
    }),
  );
}

/** Routed-execution slice of {@link WorkspaceTaskAcquirerDeps}. */
export type FleetExecutorDeps = Pick<
  WorkspaceTaskAcquirerDeps,
  "config" | "workspaceDir" | "skips" | "repoManager" | "runTask" | "repoLock"
> & {
  /**
   * Shared fleet scheduler. Routing happens BEFORE scheduling: the task is
   * routed to its repo, then queued under that repo's lane so different
   * repos may run concurrently while same-repo work stays FIFO and serial.
   */
  scheduler?: WorkspaceScheduler;
};

/**
 * Build the fleet execute step: route a task to its repo and run it in a
 * disposable worktree. Shared by the polling acquirer, the relay's task
 * evaluation, and (via {@link WorkspaceScheduler}) every other fleet event
 * path, which acquire work differently but execute identically.
 *
 * The per-repo run lock (`createRepoRunLock`) remains the cross-process
 * safety boundary: contention with another process defers the scheduled work
 * (the dedupe record is not consumed) instead of counting it as an attempt.
 *
 * Ambiguous/unrouted tasks are recorded as routing skips and count as
 * handled: dedupe keeps them out of the loop until the task changes again,
 * the same policy as failing tasks.
 */
export function createFleetTaskExecutor(
  deps: FleetExecutorDeps,
): (taskKey: string, routable: RoutableTask) => Promise<boolean> {
  const { config, workspaceDir, skips, repoManager } = deps;
  const runTask = deps.runTask ?? runTaskViaCli;
  const repoLock = deps.repoLock ?? ((name: string) => createRepoRunLock(name, workspaceDir));
  const extraArgs = fleetTaskArgs(config);

  return async (taskKey, routable) => {
    const decision = routeTask(routable, config);

    if (decision.kind !== "routed") {
      const candidates = decision.kind === "ambiguous" ? decision.candidates : [];
      skips.record({
        taskKey,
        reason: decision.kind,
        candidates,
        taskUpdated: undefined,
      });
      console.warn(
        decision.kind === "ambiguous"
          ? `⚠️  [fleet] ${taskKey} matches rules for multiple repos (${candidates.join(", ")}); skipping - fix the routing rules. Recorded in routing skips.`
          : `⚠️  [fleet] ${taskKey} matches no routing rule; skipping. Recorded in routing skips.`,
      );
      // Handled: dedupe keeps it out until the task is updated again.
      return true;
    }

    const repo = findRepo(config, decision.repo);
    if (!repo) {
      // Config validation makes this unreachable; guard anyway.
      console.error(`❌ [fleet] routed ${taskKey} to unknown repo "${decision.repo}"`);
      return false;
    }

    const runInRepo = async (): Promise<boolean> => {
      const lock = repoLock(repo.name);
      const lockResult = lock.acquire();
      if (!lockResult.success) {
        if (deps.scheduler) {
          // Cross-process contention: defer through the scheduler's retry
          // lane instead of consuming the task's only dedupe slot.
          throw new RepoBusyError(repo.name, lockResult.message);
        }
        console.warn(
          `⚠️  [fleet] repo "${repo.name}" is busy (${lockResult.message}); ${taskKey} will retry when the task changes.`,
        );
        return false;
      }

      try {
        await repoManager.ensureBareClone(repo);
        await repoManager.fetch(repo.name);
        const worktree = await repoManager.createTaskWorktree(repo, taskKey);
        console.log(`🏗️  [fleet] ${taskKey} → ${repo.name} (${worktree})`);

        const ok = await runTask(taskKey, extraArgs, {
          cwd: worktree,
          env: buildRepoEnv(repo, workspaceDir),
        });

        if (ok) {
          await repoManager.removeTaskWorktree(repo.name, worktree);
        } else {
          console.warn(`⚠️  [fleet] keeping worktree for debugging: ${worktree}`);
        }
        return ok;
      } catch (error) {
        console.error(
          `❌ [fleet] ${taskKey} failed in repo "${repo.name}": ${(error as Error).message}`,
        );
        return false;
      } finally {
        lock.release();
      }
    };

    if (!deps.scheduler) {
      return runInRepo();
    }
    return deps.scheduler.schedule<boolean>(repo.name, { label: taskKey }, runInRepo);
  };
}

export interface RunWorkspaceWorkerOptions {
  /** Explicit workspace.toml path (defaults to the workspace home). */
  workspacePath?: string;
  /** Fleet query override (`--query` / `WORKER_TASK_QUERY` beat the config). */
  query?: string;
  intervalSeconds: number;
  verbose?: boolean;
  /** Also serve the local observability dashboard. */
  ui?: boolean;
  uiPort?: number;
}

/**
 * Assemble and start the worker in workspace (fleet) mode.
 *
 * Loads the workspace config and shared `.env` (applied to this process so
 * the tracker client can be constructed), sweeps stale worktrees, and runs
 * one fleet task acquirer under the workspace-wide lock. Every execution
 * path — polling tasks, relay task events, PR reviews, mention runs — is
 * dispatched through one bounded scheduler: serial by default, or concurrent
 * across repos up to `[workspace].max_concurrency` when
 * `[workspace].parallel_across_repos` is enabled.
 *
 * The caller has already passed the license gate.
 */
export async function runWorkspaceWorker(options: RunWorkspaceWorkerOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();
  const configPath = options.workspacePath ?? workspaceConfigPath(workspaceDir);
  const config = loadWorkspaceConfig(configPath);

  if (config.repos.length === 0) {
    console.error(
      `❌ No repos configured in ${configPath}.\n` +
        "   Add [[repos]] entries (or run `devintern workspace import` inside an existing repo).",
    );
    process.exit(1);
  }

  // The parent process needs tracker credentials to run the fleet query;
  // fleet config wins over whatever repo .env the shell happened to load.
  for (const [key, value] of Object.entries(parseEnvFile(workspaceEnvPath(workspaceDir)))) {
    process.env[key] = value;
  }
  process.env.TASK_TRACKER = config.defaults.tracker;
  // In-process consumers (dashboard, run records) follow the fleet DB.
  process.env.WEBHOOK_QUEUE_DB = workspaceDbPath(workspaceDir);

  const query = options.query ?? config.defaults.taskQuery;
  if (!query && config.automations.length === 0) {
    console.error(
      "❌ Workspace mode needs a task query: set [defaults].task_query in workspace.toml " +
        "or pass --query.",
    );
    process.exit(1);
  }

  const state = openWorkspaceState(workspaceDir);
  const repoManager = new RepoManager(workspaceDir);

  // Bounded fleet execution: serial (limit 1) by default, or overlapping
  // repos up to the configured cap. One scheduler instance funnels every
  // acquirer, so independent repos never overlap work in the same repo.
  const scheduler = new WorkspaceScheduler({ maxConcurrent: effectiveMaxConcurrency(config) });

  // Persist the per-repo activity snapshot on every scheduler transition so
  // `GET /api/worker` and the dashboard can show what each repo is doing.
  const repoNames = config.repos.map((repo) => repo.name);
  const persistActivity = (): void => {
    try {
      const status = scheduler.status(repoNames);
      state.activity.save({
        rows: status.repos.map((repo) => ({
          repo: repo.repo,
          status: repo.status,
          label: repo.label,
          startedAt: repo.startedAt,
        })),
        pid: process.pid,
        maxConcurrency: status.max,
        parallel: config.workspace.parallelAcrossRepos,
      });
    } catch (error) {
      console.warn(`⚠️  [fleet] could not persist activity: ${(error as Error).message}`);
    }
  };
  scheduler.onChange = persistActivity;
  persistActivity();

  for (const repo of config.repos) {
    const removed = await repoManager.sweepStaleWorktrees(
      repo.name,
      config.workspace.worktreesTtlDays,
    );
    if (removed.length > 0) {
      console.log(`🧹 [fleet] swept ${removed.length} stale worktree(s) for ${repo.name}`);
    }
  }

  const acquirers: import("../../worker").Acquirer[] = [];

  if (config.automations.length > 0) {
    const semanticErrors: string[] = [];
    for (const automation of config.automations) {
      if (!automation.repo && config.repos.length !== 1) {
        semanticErrors.push(
          `Automation "${automation.id}" must set repo when the workspace has multiple repositories.`,
        );
      }
    }
    if (semanticErrors.length > 0) {
      throw new Error(`Invalid ${configPath}:\n- ${semanticErrors.join("\n- ")}`);
    }

    acquirers.push(
      new AutomationAcquirer({
        automations: config.automations,
        dbPath: state.dbPath,
        resolveContext: (automation) =>
          resolveWorkspaceAutomationContext(automation, config, workspaceDir, repoManager),
      }),
    );
  }

  if (query) {
    const { TaskTrackerManager } = await import("../task-tracker-manager");
    const { createChangeDetector } = await import("../change-detector");
    const tracker = new TaskTrackerManager().getClient();
    const detector = createChangeDetector(config.defaults.tracker, (q) => tracker.searchTasks(q));
    if (!detector) {
      console.error(
        `❌ Could not initialize the ${config.defaults.tracker} change detector. ` +
          "Check the tracker's required variables in the workspace .env.",
      );
      process.exit(1);
    }
    acquirers.push(
      createWorkspaceTaskAcquirer({
        config,
        workspaceDir,
        workerState: state.workerState,
        queue: state.queue,
        skips: state.skips,
        repoManager,
        detector,
        searchTasks: (q) => tracker.searchTasks(q),
        query,
        intervalSeconds: options.intervalSeconds,
        verbose: options.verbose,
        scheduler,
      }),
    );
    acquirers.push(
      ...(await buildFleetEventAcquirers({
        config,
        workspaceDir,
        state,
        repoManager,
        scheduler,
        searchTasks: (q) => tracker.searchTasks(q),
        query,
        intervalSeconds: options.intervalSeconds,
        verbose: options.verbose,
      })),
    );
  }

  if (options.ui) {
    const { startDashboardServer } = await import("../../dashboard-server");
    startDashboardServer({ port: options.uiPort, workingDir: workspaceDir });
  }

  console.log(`🗂️  Workspace: ${configPath} (${config.repos.length} repo(s))`);
  console.log(
    config.workspace.parallelAcrossRepos
      ? `🚀 Parallel across repos: enabled (up to ${scheduler.capacity} concurrent run(s))`
      : "🚂 Serial execution: one task at a time ([workspace].parallel_across_repos = true to overlap repos)",
  );
  const { startWorker } = await import("../../worker");
  await startWorker(
    {
      listen: false,
      intervalSeconds: options.intervalSeconds,
      verbose: options.verbose,
      lock: createWorkspaceLock(workspaceDir),
      label: workspaceDir,
      onShutdown: async () => {
        // Stop admissions, roll back never-started tasks' dedupe marks, and
        // drain in-flight runs so every per-repo lock is released cleanly.
        const summary = await scheduler.drain();
        if (summary.cancelled > 0 || summary.drained > 0) {
          console.log(
            `   [fleet] drained ${summary.drained} in-flight run(s); deferred ${summary.cancelled} queued task(s) to next start`,
          );
        }
        try {
          state.activity.clear();
          state.close();
        } catch (error) {
          console.warn(`⚠️  [fleet] state close failed: ${(error as Error).message}`);
        }
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
async function buildFleetEventAcquirers(options: {
  config: WorkspaceConfig;
  workspaceDir: string;
  state: ReturnType<typeof openWorkspaceState>;
  repoManager: RepoManagerLike;
  scheduler: WorkspaceScheduler;
  searchTasks: (query: string) => Promise<{ tasks: FleetTask[] }>;
  query: string;
  intervalSeconds: number;
  verbose?: boolean;
}): Promise<import("../../worker").Acquirer[]> {
  const {
    config,
    workspaceDir,
    state,
    repoManager,
    scheduler,
    searchTasks,
    query,
    intervalSeconds,
    verbose,
  } = options;
  const acquirers: import("../../worker").Acquirer[] = [];

  const {
    createFleetAddressPr,
    createFleetResolveConflicts,
    createFleetMentionHandler,
    createFleetTaskEvaluator,
    fleetGitHubSlugs,
  } = await import("./fleet-events");

  const hasGitHubCreds = Boolean(process.env.GITHUB_TOKEN || process.env.GITHUB_APP_ID);
  const slugs = fleetGitHubSlugs(config);

  if (hasGitHubCreds && slugs.length > 0) {
    const { GitHubReviewsClient } = await import("../github-reviews");
    const gh = new GitHubReviewsClient({ preferAppAuth: true });
    const ownerOf = (slug: string) => slug.split("/")[0] as string;
    const nameOf = (slug: string) => slug.split("/")[1] as string;

    const eventDeps = {
      config,
      workspaceDir,
      repoManager,
      // Review and mention runs join the same per-repo lanes as task runs,
      // so a review can never overlap a task in one repo.
      scheduler,
      userHasPushAccess: (owner: string, repo: string, user: string) =>
        gh.userHasPushAccess(owner, repo, user),
      verbose,
    };
    const addressPr = createFleetAddressPr(eventDeps);
    const resolveConflicts = createFleetResolveConflicts(eventDeps);
    const handleMention = createFleetMentionHandler(eventDeps);

    // Tier 1: the agent's own PRs (central agent_prs registry is repo-keyed,
    // so one acquirer covers the whole fleet).
    const { ReviewPollingAcquirer } = await import("../review-polling-acquirer");
    const { RunStore } = await import("../run-recorder");
    const runStore = new RunStore(state.dbPath);
    const reapedRuns = runStore.reapOrphanedRuns();
    if (reapedRuns > 0) {
      console.warn(
        `⚠️  Marked ${reapedRuns} in-progress run(s) as failed: previous worker exited before they finished`,
      );
    }
    acquirers.push(
      new ReviewPollingAcquirer({
        intervalSeconds,
        workerState: state.workerState,
        queue: state.queue,
        github: {
          fetchPr: (repo, n, etag) =>
            gh.conditionalGet(`/repos/${repo}/pulls/${n}`, ownerOf(repo), nameOf(repo), etag),
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
        addressPr,
        resolveConflicts,
        quietPeriodSeconds: parseEnvInteger("WORKER_BASE_SYNC_QUIET_SECONDS", 30, { min: 0 }),
        runStore,
        allowedRepos: slugs,
        verbose,
      }),
    );

    // Tier 2: one mention sweep per GitHub repo (cursor sources are already
    // namespaced by slug). The permission gate runs in the fleet handler.
    const { MentionSweepAcquirer } = await import("../mention-sweep-acquirer");
    for (const slug of slugs) {
      const [repoOwner, repoName] = slug.split("/") as [string, string];
      acquirers.push(
        new MentionSweepAcquirer({
          repo: slug,
          intervalSeconds,
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
            postComment: (prNumber, body) =>
              gh.postPullRequestComment(repoOwner, repoName, prNumber, body).then(() => {}),
          },
          handleMention: (comment, prNumber) => handleMention(slug, comment, prNumber),
          verbose,
        }),
      );
    }

    // Mode 2 relay: envelopes carry the repo slug; route through the same
    // fleet handlers and the shared task executor. Connect state lives under
    // the workspace home (not a git checkout).
    const { loadRelayState } = await import("../relay-connect");
    const relayState = loadRelayState(workspaceDir);
    if (relayState || process.env.WORKER_RELAY_URL) {
      const relayToken = relayState?.relayToken;
      const relayUrl =
        process.env.WORKER_RELAY_URL?.replace(/\/+$/, "") || (relayState?.relayUrl ?? "");
      if (!relayToken) {
        console.warn(
          "⚠️  Relay is configured but no relay token is stored — run `devintern worker connect` while signed in (`devintern login`). Mode 1 polling continues.",
        );
      } else if (relayUrl) {
        const { RelayAcquirer } = await import("../relay-acquirer");
        const { mentionsBot } = await import("../mention-sweep-acquirer");
        const execute = createFleetTaskExecutor({
          config,
          workspaceDir,
          skips: state.skips,
          repoManager,
          scheduler,
        });
        const evaluateTask = createFleetTaskEvaluator({ query, searchTasks, execute, verbose });

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
                await addressPr(repo, prNumber);
              },
              handlePrComment: async (repo, prNumber, commentId) => {
                const [repoOwner, repoName] = repo.split("/") as [string, string];
                const { data: comment } = await gh.conditionalGet<{
                  id: number;
                  body: string | null;
                  user: { login: string; type: string };
                  created_at: string;
                  html_url: string;
                }>(`/repos/${repo}/issues/comments/${commentId}`, repoOwner, repoName);
                if (!comment) {
                  return;
                }
                const botName = await gh.getBotUsername(repoOwner, repoName);
                if (!botName || !mentionsBot(comment.body, botName)) {
                  return;
                }
                await handleMention(repo, comment, prNumber);
              },
              evaluateTask,
            },
            verbose,
          }),
        );
      }
    }
  } else if (verbose) {
    console.log(
      hasGitHubCreds
        ? "   [fleet] no GitHub repos in the workspace; review/mention acquirers disabled."
        : "   [fleet] GITHUB_TOKEN/GITHUB_APP_ID not set; review/mention acquirers disabled.",
    );
  }

  return acquirers;
}
