/**
 * Worker workspace (fleet) mode.
 *
 * One `devintern worker` process drives every repo in the workspace: a
 * single fleet task acquirer polls the tracker with the workspace query,
 * routes each ready task to its repo (never guessing), and executes it in a
 * disposable worktree with a per-repo environment. All durable state lives
 * in the central workspace DB.
 */

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

import { LockManager } from "../lock-manager";
import { parseEnvInteger } from "../env-integer";
import { TaskPollingAcquirer, runTaskViaCli, workerTaskArgs } from "../task-polling-acquirer";
import type { TaskExecutionResult } from "../task-polling-acquirer";
import type { ChangeDetector } from "../change-detector";
import type { WebhookQueue } from "../webhook-queue";
import type { WorkerState } from "../worker-state";
import {
  loadProjectSettingsFrom,
  recoverOrphanedTaskRuns,
  resolveStatusName,
} from "../orphan-recovery";
import { RunStore } from "../run-recorder";
import { RetryStateStore } from "../retry-state";
import type { TaskTrackerClient } from "../task-tracker-client";
import { findRepo, loadWorkspaceConfig } from "./config";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { buildRepoEnv, parseEnvFile } from "./env";
import {
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceDbPath,
  workspaceEnvPath,
  worktreesDir,
} from "./paths";
import { routeTask, toRoutableTask } from "./router";
import type { RoutableTask } from "./router";
import { createRepoRunLock, createWorkspaceLock, openWorkspaceState } from "./state";
import type { RoutingSkipStore } from "./state";
import { BASE_WORKTREE_NAME, RepoManager } from "./repo-manager";
import { probePushAccess } from "../github-push-probe";
import { AutomationAcquirer } from "../automation-acquirer";
import type { AutomationConfig } from "../automation-config";
import { flushAnalytics, RUN_ORIGIN_ENV, trackWorkerStarted } from "../analytics";

/** Orphaned-run feedback cutoff: `WORKER_ORPHAN_MAX_AGE_HOURS`, default 7 days. */
function orphanMaxAgeMs(): number {
  return parseEnvInteger("WORKER_ORPHAN_MAX_AGE_HOURS", 24 * 7, { min: 0 }) * 60 * 60 * 1000;
}

/**
 * Recover task runs left in progress by a previous (dead) worker before any
 * acquirer picks up new tickets: reap them and give their tickets the
 * graceful-shutdown feedback (failure comment + move back to To Do).
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
    if (hasTaskOrphans) {
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
    const trackerType = config.defaults.tracker;
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
  query: string;
  intervalSeconds: number;
  verbose?: boolean;
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

/** Per-task CLI args from `[defaults].worker_task_args`, else `--create-pr`. */
export function fleetTaskArgs(config: WorkspaceConfig): string[] {
  const raw = config.defaults.workerTaskArgs;
  if (raw && raw.trim()) {
    return raw.trim().split(/\s+/);
  }
  return workerTaskArgs();
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
 * Build the fleet task acquirer: detect-then-evaluate (reusing
 * {@link TaskPollingAcquirer}) with routing between evaluate and execute.
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

  const executeTask = (taskKey: string): Promise<TaskExecutionResult> =>
    execute(
      taskKey,
      routables.get(taskKey) ?? toRoutableTask({ key: taskKey, labels: [], components: [] }),
    );

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
    verbose,
  });
}

/** Routed-execution slice of {@link WorkspaceTaskAcquirerDeps}. */
export type FleetExecutorDeps = Pick<
  WorkspaceTaskAcquirerDeps,
  "config" | "workspaceDir" | "skips" | "repoManager" | "runTask" | "repoLock"
>;

/**
 * Build the fleet execute step: route a task to its repo and run it in a
 * disposable worktree. Shared by the polling acquirer and the relay's task
 * evaluation, which acquire tasks differently but execute identically.
 *
 * Ambiguous/unrouted tasks are recorded as routing skips and count as
 * handled: dedupe keeps them out of the loop until the task changes again,
 * the same policy as failing tasks.
 */
export function createFleetTaskExecutor(
  deps: FleetExecutorDeps,
): (taskKey: string, routable: RoutableTask) => Promise<TaskExecutionResult> {
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

    const lock = repoLock(repo.name);
    const lockResult = lock.acquire();
    if (!lockResult.success) {
      console.warn(
        `⚠️  [fleet] repo "${repo.name}" is busy (${lockResult.message}); ${taskKey} deferred.`,
      );
      return "deferred";
    }

    try {
      await repoManager.ensureBareClone(repo);
      await repoManager.fetch(repo.name);
      const worktree = await repoManager.createTaskWorktree(repo, taskKey);
      console.log(`🏗️  [fleet] ${taskKey} → ${repo.name} (${worktree})`);

      const ok = await runTask(taskKey, extraArgs, {
        cwd: worktree,
        env: {
          ...buildRepoEnv(repo, workspaceDir),
          [RUN_ORIGIN_ENV]: "worker",
        },
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
}

export interface RunWorkspaceWorkerOptions {
  /** Explicit workspace.toml path (defaults to the workspace home). */
  workspacePath?: string;
  verbose?: boolean;
  /** CLI release attached to anonymous worker startup analytics. */
  cliVersion?: string;
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

  const query = config.defaults.taskQuery;
  const intervalSeconds = config.defaults.pollIntervalSeconds;
  if (!query && config.automations.length === 0) {
    console.error(
      "❌ Workspace mode needs a task query: set [defaults].task_query in workspace.toml.",
    );
    process.exit(1);
  }

  const state = openWorkspaceState(workspaceDir);
  const repoManager = new RepoManager(workspaceDir);

  // Recover what the previous worker left behind before acquiring new work.
  await recoverOrphanedWorkspaceRuns({
    config,
    workspaceDir,
    dbPath: state.dbPath,
  });

  for (const repo of config.repos) {
    const removed = await repoManager.sweepStaleWorktrees(
      repo.name,
      config.workspace.worktreesTtlDays,
    );
    if (removed.length > 0) {
      console.log(`🧹 [fleet] swept ${removed.length} stale worktree(s) for ${repo.name}`);
    }
  }

  await warnOnPushAuthIssues(config, repoManager);

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
        extraArgs: fleetTaskArgs(config),
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
        intervalSeconds,
        verbose: options.verbose,
      }),
    );
    acquirers.push(
      ...(await buildFleetEventAcquirers({
        config,
        workspaceDir,
        state,
        repoManager,
        searchTasks: (q) => tracker.searchTasks(q),
        query,
        intervalSeconds,
        verbose: options.verbose,
      })),
    );
  }

  if (config.workspace.dashboard) {
    try {
      const { startDashboardServer } = await import("../../dashboard-server");
      startDashboardServer({ port: config.workspace.dashboardPort });
    } catch (error) {
      console.warn(
        `⚠️  Dashboard could not start (${(error as Error).message}); the worker will continue.`,
      );
    }
  }

  console.log(`🗂️  Workspace: ${configPath} (${config.repos.length} repo(s))`);
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
          tracker: config.defaults.tracker,
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
  searchTasks: (query: string) => Promise<{ tasks: FleetTask[] }>;
  query: string;
  intervalSeconds: number;
  verbose?: boolean;
}): Promise<import("../../worker").Acquirer[]> {
  const { config, workspaceDir, state, repoManager, searchTasks, query, intervalSeconds, verbose } =
    options;
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
  let github: import("../github-reviews").GitHubReviewsClient | undefined;
  let addressPr: ((repo: string, prNumber: number) => Promise<boolean>) | undefined;
  let handleMention:
    | ((repo: string, comment: { user: { login: string } }, prNumber: number) => Promise<void>)
    | undefined;

  if (hasGitHubCreds && slugs.length > 0) {
    const { GitHubReviewsClient } = await import("../github-reviews");
    github = new GitHubReviewsClient({ preferAppAuth: true });
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
    };
    const fleetAddressPr = createFleetAddressPr(eventDeps);
    addressPr = fleetAddressPr;
    const resolveConflicts = createFleetResolveConflicts(eventDeps);
    const fleetHandleMention = createFleetMentionHandler(eventDeps);
    handleMention = fleetHandleMention;

    // Tier 1: the agent's own PRs (central agent_prs registry is repo-keyed,
    // so one acquirer covers the whole fleet).
    const { ReviewPollingAcquirer } = await import("../review-polling-acquirer");
    const { isGitHubNotFound } = await import("../github-reviews");
    const runStore = new RunStore(state.dbPath);
    acquirers.push(
      new ReviewPollingAcquirer({
        intervalSeconds,
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
            postComment: async (prNumber, body) => {
              await gh.postPullRequestComment(repoOwner, repoName, prNumber, body);
            },
          },
          handleMention: (comment, prNumber) => fleetHandleMention(slug, comment, prNumber),
          verbose,
        }),
      );
    }
  } else if (verbose) {
    console.log(
      hasGitHubCreds
        ? "   [fleet] no GitHub repos in the workspace; review/mention acquirers disabled."
        : "   [fleet] GITHUB_TOKEN/GITHUB_APP_ID not set; review/mention acquirers disabled.",
    );
  }

  // Mode 2 relay is independent of GitHub polling credentials: tracker
  // envelopes only need the active tracker client. PR envelopes use the
  // GitHub handlers when those credentials are available.
  const { loadRelayState } = await import("../relay-connect");
  const relayState = loadRelayState(workspaceDir);
  if (relayState || process.env.WORKER_RELAY_URL) {
    const relayToken = relayState?.relayToken;
    const relayUrl =
      process.env.WORKER_RELAY_URL?.replace(/\/+$/, "") || (relayState?.relayUrl ?? "");
    if (!relayToken) {
      console.warn(
        "⚠️  Relay is configured but no relay token is stored in the workspace — re-run `devintern worker init`. Polling continues.",
      );
    } else if (relayUrl) {
      const { RelayAcquirer } = await import("../relay-acquirer");
      const { mentionsBot } = await import("../mention-sweep-acquirer");
      const execute = createFleetTaskExecutor({
        config,
        workspaceDir,
        skips: state.skips,
        repoManager,
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
              if (addressPr) await addressPr(repo, prNumber);
            },
            handlePrComment: async (repo, prNumber, commentId) => {
              if (!github || !handleMention) return;
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
              if (!botName || !mentionsBot(comment.body, botName)) return;
              await handleMention(repo, comment, prNumber);
            },
            evaluateTask,
          },
          verbose,
        }),
      );
    }
  }

  return acquirers;
}
