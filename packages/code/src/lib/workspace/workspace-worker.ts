/**
 * Worker workspace (fleet) mode.
 *
 * One `devintern worker` process drives every repo in the workspace: a
 * single fleet task acquirer polls the tracker with the workspace query,
 * routes each ready task to its repo (never guessing), and executes it in a
 * disposable worktree with a per-repo environment. All durable state lives
 * in the central workspace DB.
 */

import { LockManager } from "../lock-manager";
import { TaskPollingAcquirer, runTaskViaCli, workerTaskArgs } from "../task-polling-acquirer";
import type { ChangeDetector } from "../change-detector";
import type { WebhookQueue } from "../webhook-queue";
import type { WorkerState } from "../worker-state";
import { findRepo, loadWorkspaceConfig } from "./config";
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
import { createRepoRunLock, createWorkspaceLock, openWorkspaceState } from "./state";
import type { RoutingSkipStore } from "./state";
import { RepoManager } from "./repo-manager";

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

  const executeTask = (taskKey: string): Promise<boolean> =>
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

    const lock = repoLock(repo.name);
    const lockResult = lock.acquire();
    if (!lockResult.success) {
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
 * one fleet task acquirer under the workspace-wide lock.
 *
 * The caller has already passed the license and team-automation gates.
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
  if (!query) {
    console.error(
      "❌ Workspace mode needs a task query: set [defaults].task_query in workspace.toml " +
        "or pass --query.",
    );
    process.exit(1);
  }

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

  const state = openWorkspaceState(workspaceDir);
  const repoManager = new RepoManager(workspaceDir);

  for (const repo of config.repos) {
    const removed = await repoManager.sweepStaleWorktrees(
      repo.name,
      config.workspace.worktreesTtlDays,
    );
    if (removed.length > 0) {
      console.log(`🧹 [fleet] swept ${removed.length} stale worktree(s) for ${repo.name}`);
    }
  }

  const acquirers: import("../../worker").Acquirer[] = [
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
    }),
  ];

  acquirers.push(
    ...(await buildFleetEventAcquirers({
      config,
      workspaceDir,
      state,
      repoManager,
      searchTasks: (q) => tracker.searchTasks(q),
      query,
      intervalSeconds: options.intervalSeconds,
      verbose: options.verbose,
    })),
  );

  if (options.ui) {
    const { startDashboardServer } = await import("../../dashboard-server");
    startDashboardServer({ port: options.uiPort });
  }

  console.log(`🗂️  Workspace: ${configPath} (${config.repos.length} repo(s))`);
  const { startWorker } = await import("../../worker");
  await startWorker(
    {
      listen: false,
      intervalSeconds: options.intervalSeconds,
      verbose: options.verbose,
      lock: createWorkspaceLock(workspaceDir),
      label: workspaceDir,
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
    createFleetCiFix,
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
      userHasPushAccess: (owner: string, repo: string, user: string) =>
        gh.userHasPushAccess(owner, repo, user),
      verbose,
    };
    const addressPr = createFleetAddressPr(eventDeps);
    const handleMention = createFleetMentionHandler(eventDeps);

    // Tier 1: the agent's own PRs (central agent_prs registry is repo-keyed,
    // so one acquirer covers the whole fleet).
    const { ReviewPollingAcquirer } = await import("../review-polling-acquirer");
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
        verbose,
      }),
    );

    // Tier 1: auto-fix CI failures on those same PRs. Fix runs execute as
    // CLI subprocesses in each repo's base worktree with per-repo env.
    const { CiFailureWatcherAcquirer } = await import("../ci-failure-watcher-acquirer");
    const fixPr = createFleetCiFix(eventDeps);
    acquirers.push(
      new CiFailureWatcherAcquirer({
        intervalSeconds,
        workerState: state.workerState,
        queue: state.queue,
        github: {
          fetchPr: (repo, n, etag) =>
            gh.conditionalGet(`/repos/${repo}/pulls/${n}`, ownerOf(repo), nameOf(repo), etag),
          fetchCheckRuns: (repo, sha, etag) =>
            gh.getCheckRuns(ownerOf(repo), nameOf(repo), sha, etag),
          fetchCommitStatus: (repo, sha, etag) =>
            gh.getCombinedStatus(ownerOf(repo), nameOf(repo), sha, etag),
          fetchFailingJobLogs: async (repo, sha) => {
            const [owner, name] = repo.split("/") as [string, string];
            const runs = await gh
              .getWorkflowRunsForSha(owner, name, sha)
              .catch(() => [] as Awaited<ReturnType<typeof gh.getWorkflowRunsForSha>>);
            const chunks: string[] = [];
            for (const run of runs.slice(0, 3)) {
              const jobs = await gh.getWorkflowRunJobs(owner, name, run.id).catch(() => []);
              for (const job of jobs.filter((j) => j.conclusion === "failure").slice(0, 5)) {
                if (!job.logs_url) {
                  continue;
                }
                const text = await gh.getJobLogs(owner, name, job.logs_url).catch(() => null);
                if (text) {
                  chunks.push(`## Job: ${job.name}\n${text}`);
                }
              }
            }
            return chunks.length > 0 ? chunks.join("\n\n") : null;
          },
          fetchCheckRunDetails: async (repo, checkRunId) => {
            try {
              const annotations = await gh.getCheckRunAnnotations(
                ownerOf(repo),
                nameOf(repo),
                checkRunId,
              );
              if (annotations.length === 0) {
                return null;
              }
              return annotations
                .map((a) => `${a.path ? `${a.path}: ` : ""}${a.message}`)
                .join("\n");
            } catch {
              return null;
            }
          },
          postComment: async (repo, n, body) => {
            await gh.postPullRequestComment(ownerOf(repo), nameOf(repo), n, body);
          },
        },
        fixPr: (slug, prNumber, feedbackPath) => fixPr(slug, prNumber, feedbackPath),
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
