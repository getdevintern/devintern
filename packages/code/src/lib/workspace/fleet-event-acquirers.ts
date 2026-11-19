import { createGitHubCiProvider } from "../code-host/github/ci-provider";
import { parseEnvInteger } from "../config/env-integer";
import { RunStore } from "../state/run-recorder";
import type { MergeStateAnswer } from "../dependencies/gate";
import type { TaskExecutionResult } from "../acquirers/task-polling";
import type {
  ConflictWindowStatus,
  ConflictWindowTriggerOutcome,
} from "../acquirers/review-polling";
import type { ChangeDetector } from "../acquirers/change-detector";
import type { TeamConfig, WorkspaceConfig } from "./config";
import { buildFleetEventEnv, gitHubSlugFromRemote } from "./env";
import { createGatedFleetTaskExecutor, resolveActionedSource } from "./fleet-executor";
import type { TrackerDependencyGate } from "./tracker-dependency-gate";
import { assertTeamPrSyncSandbox, teamPrSyncSlugs } from "./team-pr-sync";
import type { FleetTask, RepoManagerLike } from "./fleet-executor";
import type { openWorkspaceState } from "./state";
import type { TaskSupervisor } from "../worker/supervisor";
import type { TaskTrackerClient } from "../trackers/client";

type FleetGitHubClient = import("../code-host/github/reviews").GitHubReviewsClient;
type AutoMergeWatcherAcquirer = import("../acquirers/auto-merge-watcher").AutoMergeWatcherAcquirer;
type AutoMergeWatcherOptions = import("../acquirers/auto-merge-watcher").AutoMergeWatcherOptions;
type AutoMergeWatcherStatus = import("../acquirers/auto-merge-watcher").AutoMergeWatcherStatus;
type WorkerState = import("../state/worker-state").WorkerState;
type WebhookQueue = import("../state/webhook-queue").WebhookQueue;
type AutoMergeRunNowOutcome = import("../acquirers/auto-merge-watcher").AutoMergeRunNowOutcome;

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
  /** Scheduled conflict window state for the dashboard (null unless scheduled). */
  conflictWindowStatus(): ConflictWindowStatus | null;
  /** Dashboard "Run now": open the scheduled conflict window immediately. */
  openConflictWindowNow(): ConflictWindowTriggerOutcome;
  /** Auto-merge watcher status for the dashboard (null while disabled). */
  autoMergeStatus(): AutoMergeWatcherStatus | null;
  /** Dashboard "Run now": check every watched PR for auto-merge immediately. */
  runAutoMergeNow(): AutoMergeRunNowOutcome;
}

/** One tracker source served by the workspace worker. */
export interface FleetSourceRuntime {
  tracker: string;
  /** Initial team identity; live query/repo changes resolve by name from config. */
  team?: TeamConfig;
  query: () => string | undefined;
  searchTasks: (query: string) => Promise<{ tasks: FleetTask[] }>;
  detector: ChangeDetector;
  /**
   * Tracker client for the actioned gate. Present for multi-team sources
   * (built at startup); single-source workspaces resolve one lazily.
   */
  client?: TaskTrackerClient;
  /**
   * Actioned gate for relay task envelopes, wired by the workspace worker from
   * the same marker/source the polling acquirer uses. Absent in legacy
   * focused-test paths.
   */
  isTaskActionedUnchanged?: (taskKey: string, updated?: string) => Promise<boolean>;
  /**
   * Native-blocker gate shared with the polling acquirer, so a relayed
   * `task.changed` cannot start a ticket its blockers still hold back.
   */
  dependencyGate?: TrackerDependencyGate;
}

/**
 * Resolve the GitHub credential used for events in one workspace repository.
 *
 * Uses the same credentials as the follow-up runs that push to the PR
 * ({@link buildFleetEventEnv}), so API calls read PRs with the account that
 * pushed them.
 */
export function fleetGitHubTokenForRepo(
  config: WorkspaceConfig,
  workspaceDir: string,
  slug: string,
): string | undefined {
  const repo = config.repos.find(
    (candidate) =>
      (candidate.env.GITHUB_REPO ?? gitHubSlugFromRemote(candidate.remote))?.toLowerCase() ===
      slug.toLowerCase(),
  );
  if (!repo) return process.env.GITHUB_TOKEN;
  return buildFleetEventEnv(config, repo, workspaceDir).GITHUB_TOKEN;
}

export function createFleetGitHubClientResolver(
  config: WorkspaceConfig,
  workspaceDir: string,
  usesHostedApp: boolean,
  Client: typeof import("../code-host/github/reviews").GitHubReviewsClient,
): (slug: string) => import("../code-host/github/reviews").GitHubReviewsClient {
  const clients = new Map<
    string,
    { token: string | undefined; client: import("../code-host/github/reviews").GitHubReviewsClient }
  >();
  return (slug) => {
    const token = fleetGitHubTokenForRepo(config, workspaceDir, slug);
    const cached = clients.get(slug);
    if (cached && cached.token === token) return cached.client;
    const client = new Client({ authMode: usesHostedApp ? "token-only" : "app-first", token });
    clients.set(slug, { token, client });
    return client;
  };
}

function hasFleetGitHubCredentials(
  config: WorkspaceConfig,
  workspaceDir: string,
  slugs: string[],
  usesHostedApp: boolean,
): boolean {
  const hasCustomAppCredentials = Boolean(
    process.env.GITHUB_APP_ID &&
    (process.env.GITHUB_APP_PRIVATE_KEY_PATH || process.env.GITHUB_APP_PRIVATE_KEY_BASE64),
  );
  return (
    Boolean(process.env.GITHUB_TOKEN) ||
    (!usesHostedApp && hasCustomAppCredentials) ||
    slugs.some((slug) => Boolean(fleetGitHubTokenForRepo(config, workspaceDir, slug)))
  );
}

/** Build the CI provider used by the fleet's CI-failure watcher. */
function buildFleetCiProvider(
  gh: (slug: string) => FleetGitHubClient,
  ownerOf: (slug: string) => string,
  nameOf: (slug: string) => string,
  isGitHubNotFound: (error: unknown) => boolean,
) {
  return createGitHubCiProvider({
    fetchPr: async (repo, n, etag) => {
      try {
        return await gh(repo).conditionalGet(
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
      const result = await gh(repo).conditionalGet<{
        workflow_runs: import("../code-host/github/reviews-types").WorkflowRunSummary[];
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
      gh(repo).getCombinedStatus(ownerOf(repo), nameOf(repo), sha, etag),
    fetchFailingJobLogs: async (repo, sha) => {
      const owner = ownerOf(repo);
      const name = nameOf(repo);
      const runs = await gh(repo)
        .getWorkflowRunsForSha(owner, name, sha)
        .catch(() => []);
      const chunks: string[] = [];
      for (const run of runs.slice(0, 3)) {
        const jobs = await gh(repo)
          .getWorkflowRunJobs(owner, name, run.id)
          .catch(() => []);
        for (const job of jobs
          .filter(
            (candidate) =>
              candidate.conclusion === "failure" || candidate.conclusion === "timed_out",
          )
          .slice(0, 5)) {
          const log = await gh(repo)
            .getJobLogs(owner, name, job.id)
            .catch(() => null);
          if (log) chunks.push(`## Job: ${job.name}\n${log}`);
        }
      }
      return chunks.length > 0 ? chunks.join("\n\n") : null;
    },
    postComment: (repo, n, body) =>
      gh(repo).postPullRequestComment(ownerOf(repo), nameOf(repo), n, body),
  });
}

/**
 * Auto-merge watcher (off by default): same PR registry and supervisor as
 * reviews; the switch and policy are read live so reloads need no restart.
 */
async function buildAutoMergeWatcher(params: {
  config: WorkspaceConfig;
  workerState: WorkerState;
  queue: WebhookQueue;
  gh: (slug: string) => FleetGitHubClient;
  mergePr: AutoMergeWatcherOptions["mergePr"];
  runStore: RunStore;
  intervalSeconds: number;
  verbose: boolean | undefined;
  isStackedBase?: AutoMergeWatcherOptions["isStackedBase"];
}): Promise<AutoMergeWatcherAcquirer> {
  const { config, gh } = params;
  const { AutoMergeWatcherAcquirer: Watcher, DEFAULT_AUTO_MERGE_QUIET_SECONDS } =
    await import("../acquirers/auto-merge-watcher");
  const { parseHarnessList } = await import("@devintern/agent-harness");
  const { isGitHubNotFound } = await import("../code-host/github/github-errors");
  const { fleetAutoMergePolicyFingerprint } = await import("./fleet-events");
  const settings = config.workspace.autoMerge;
  if (
    settings.enabled &&
    !settings.review &&
    settings.safePaths.length === 0 &&
    config.repos.every((repo) => !repo.autoMergeSafePaths?.length)
  ) {
    console.warn(
      "⚠️  [workspace].auto_merge is on with auto_merge_review = false and no " +
        "auto_merge_safe_paths, so no pull request can ever qualify.",
    );
  }
  return new Watcher({
    intervalSeconds: params.intervalSeconds,
    enabled: () => config.workspace.autoMerge.enabled,
    workerState: params.workerState,
    queue: params.queue,
    fetchPr: async (repo, n, etag) => {
      const [owner = "", name = ""] = repo.split("/");
      try {
        return await gh(repo).conditionalGet(`/repos/${repo}/pulls/${n}`, owner, name, etag);
      } catch (error) {
        if (isGitHubNotFound(error)) return { data: null, notModified: false, gone: true };
        throw error;
      }
    },
    mergePr: params.mergePr,
    runStore: params.runStore,
    // Only a run that can reach the agent review names a harness.
    harness: () =>
      config.workspace.autoMerge.review
        ? (config.workspace.autoMerge.agent?.harness ??
          parseHarnessList(process.env.AGENT_HARNESS)[0])
        : undefined,
    policyFingerprint: (slug) => fleetAutoMergePolicyFingerprint(config, slug),
    isStackedBase: params.isStackedBase,
    quietSeconds: parseEnvInteger(
      "WORKER_AUTO_MERGE_QUIET_SECONDS",
      DEFAULT_AUTO_MERGE_QUIET_SECONDS,
      { min: 0 },
    ),
    verbose: params.verbose,
  });
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
  /** Stacked-base lookup for the auto-merge guard (see `stacked-pr-acquirer.ts`). */
  isStackedBase?: (slug: string, baseRef: string) => boolean;
  /** Shared admission supervisor for every fleet execution path. */
  supervisor?: TaskSupervisor;
}): Promise<import("../../worker").Acquirer[]> {
  const { config, workspaceDir, state, repoManager, intervalSeconds, verbose } = options;
  const taskSources: Array<
    Pick<
      FleetSourceRuntime,
      "tracker" | "team" | "query" | "searchTasks" | "isTaskActionedUnchanged" | "dependencyGate"
    >
  > =
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

  // `sync_team_prs` hands teammates' code to the coding agent; refuse to
  // start unless every opted-in repo's effective env names a sandbox.
  assertTeamPrSyncSandbox(config, workspaceDir);

  const {
    createFleetAddressPr,
    createFleetAutoMerge,
    createFleetCiFix,
    coalescePrFeedbackRuns,
    createFleetResolveConflicts,
    createFleetMentionHandler,
    createFleetRelayTaskDispatcher,
    createFleetTaskEvaluator,
    fleetGitHubSlugs,
  } = await import("./fleet-events");

  const { hasGitHubRelayRouting, loadRelayState, RELAY_BOT_LOGIN } =
    await import("../relay/connect");
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
  const { GITHUB_AUTH_MODE_ENV, GitHubReviewsClient } = await import("../code-host/github/reviews");
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

  const slugs = fleetGitHubSlugs(config);
  const hasGitHubCreds = hasFleetGitHubCredentials(config, workspaceDir, slugs, usesHostedApp);
  let githubFor: ((slug: string) => FleetGitHubClient) | undefined;
  let addressPr: ((repo: string, prNumber: number) => Promise<TaskExecutionResult>) | undefined;
  let handleMention:
    | ((
        repo: string,
        comment: { user: { login: string } },
        prNumber: number,
      ) => Promise<TaskExecutionResult>)
    | undefined;

  // Built whenever credentials exist — even with zero GitHub repos today —
  // so a repo added to the config at runtime gets full event coverage.
  if (hasGitHubCreds) {
    githubFor = createFleetGitHubClientResolver(
      config,
      workspaceDir,
      usesHostedApp,
      GitHubReviewsClient,
    );
    const gh = githubFor;
    const ownerOf = (slug: string) => slug.split("/")[0] as string;
    const nameOf = (slug: string) => slug.split("/")[1] as string;

    const eventDeps = {
      config,
      workspaceDir,
      repoManager,
      userHasPushAccess: (owner: string, repo: string, user: string) =>
        // Throwing variant: a transient permission-API error must be retried by
        // the relay / mention sweep, not treated as a denial.
        gh(`${owner}/${repo}`).userHasPushAccessOrThrow(owner, repo, user),
      verbose,
      supervisor: options.supervisor,
    };
    const fleetAddressPr = coalescePrFeedbackRuns(createFleetAddressPr(eventDeps));
    addressPr = fleetAddressPr;
    const resolveConflicts = createFleetResolveConflicts(eventDeps);
    const fleetHandleMention = createFleetMentionHandler(eventDeps, fleetAddressPr);
    handleMention = fleetHandleMention;

    // Tier 1: the agent's own PRs (central agent_prs registry is repo-keyed,
    // so one acquirer covers the whole fleet).
    const { ReviewPollingAcquirer, OPEN_PR_LIST_PAGE_SIZE } =
      await import("../acquirers/review-polling");
    const { isGitHubNotFound } = await import("../code-host/github/github-errors");
    const runStore = new RunStore(state.dbPath);
    const reviewAcquirer = new ReviewPollingAcquirer({
      intervalSeconds,
      shouldPollFeedback,
      workerState: state.workerState,
      queue: state.queue,
      github: {
        fetchPr: async (repo, n, etag) => {
          try {
            return await gh(repo).conditionalGet(
              `/repos/${repo}/pulls/${n}`,
              ownerOf(repo),
              nameOf(repo),
              etag,
            );
          } catch (error) {
            if (isGitHubNotFound(error)) {
              // Deletion and missing repository access both return 404.
              // Preserve the watch until a closed PR state is confirmed.
              return { data: null, notModified: false, gone: true };
            }
            throw error;
          }
        },
        fetchReviews: (repo, n, etag) =>
          gh(repo).conditionalGet(
            `/repos/${repo}/pulls/${n}/reviews?per_page=100`,
            ownerOf(repo),
            nameOf(repo),
            etag,
          ),
        fetchReviewCommentsSince: async (repo, n, sinceIso) => {
          const result = await gh(repo).conditionalGet<
            Array<{ id: number; user: { login: string; type: string }; created_at: string }>
          >(
            `/repos/${repo}/pulls/${n}/comments?since=${encodeURIComponent(sinceIso)}&per_page=100`,
            ownerOf(repo),
            nameOf(repo),
          );
          return result.data ?? [];
        },
        listOpenPullRequests: async (repo, etag) => {
          try {
            return await gh(repo).conditionalGet(
              `/repos/${repo}/pulls?state=open&per_page=${OPEN_PR_LIST_PAGE_SIZE}`,
              ownerOf(repo),
              nameOf(repo),
              etag,
            );
          } catch (error) {
            if (isGitHubNotFound(error)) return { data: null, notModified: false, gone: true };
            throw error;
          }
        },
      },
      addressPr: fleetAddressPr,
      resolveConflicts,
      conflictSchedule: config.workspace.conflictSchedule,
      conflictResolution: config.workspace.conflictResolution,
      quietPeriodSeconds: parseEnvInteger("WORKER_BASE_SYNC_QUIET_SECONDS", 30, { min: 0 }),
      // Syncs run in the background; the supervisor admits them as
      // `pr_worktree` jobs (per-repo limit, one job per PR). Without a
      // supervisor nothing else bounds them, so keep them one at a time.
      maxConcurrentBaseSyncs: () =>
        options.supervisor ? config.workspace.execution.maxConcurrency : 1,
      runStore,
      // Factory form: repos added at runtime become watchable without a
      // restart (a static list would pin the startup slug set).
      allowedRepos: () => fleetGitHubSlugs(config),
      // Factory form for the same reason: reloads toggling `sync_team_prs`
      // apply on the next tick (and prune per-repo state when turned off).
      syncTeamPrsRepos: () => teamPrSyncSlugs(config),
      verbose,
    });
    acquirers.push(reviewAcquirer);

    // CI failure repair uses the same durable agent-PR registry, repo
    // worktree, per-PR lock, and workspace supervisor as reviews.
    const { CiFailureWatcherAcquirer } = await import("../acquirers/ci-failure-watcher");
    const fixPr = createFleetCiFix(eventDeps);
    const ciWatcher = new CiFailureWatcherAcquirer({
      intervalSeconds,
      enabled: () => config.workspace.ciFailureFix,
      workerState: state.workerState,
      queue: state.queue,
      provider: buildFleetCiProvider(gh, ownerOf, nameOf, isGitHubNotFound),
      fixPr,
      verbose,
    });
    acquirers.push(ciWatcher);
    intervalUpdaters.push((seconds) => ciWatcher.updateInterval(seconds));

    const autoMergeWatcher = await buildAutoMergeWatcher({
      config,
      workerState: state.workerState,
      queue: state.queue,
      gh,
      mergePr: createFleetAutoMerge(eventDeps),
      runStore,
      intervalSeconds,
      verbose,
      isStackedBase: options.isStackedBase,
    });
    acquirers.push(autoMergeWatcher);
    intervalUpdaters.push((seconds) => autoMergeWatcher.updateInterval(seconds));

    // Tier 2: one mention sweep per GitHub repo (cursor sources are already
    // namespaced by slug). The permission gate runs in the fleet handler.
    // Sweeps are map-managed so live config reloads can attach sweeps for
    // newly added repos and stop them for removed ones.
    const { MentionSweepAcquirer } = await import("../acquirers/mention-sweep");
    type MentionSweep = import("../acquirers/mention-sweep").MentionSweepAcquirer;
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
            const result = await gh(slug).conditionalGet<
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
            const result = await gh(slug).conditionalGet<
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
          getBotUsername: () => gh(slug).getBotUsername(repoOwner, repoName),
          getPr: async (prNumber) => {
            const pr = await gh(slug).getPullRequest(repoOwner, repoName, prNumber);
            return {
              number: pr.number,
              state: pr.state,
              headRepoFullName: pr.head.repo?.full_name,
              maintainerCanModify: pr.maintainer_can_modify,
            };
          },
          postComment: async (prNumber, body) => {
            await gh(slug).postPullRequestComment(repoOwner, repoName, prNumber, body);
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
          for (const [slug, sweep] of mentionSweeps) {
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
        conflictWindowStatus: () => reviewAcquirer.conflictWindowStatus(),
        openConflictWindowNow: () => reviewAcquirer.openConflictWindowNow(),
        autoMergeStatus: () => autoMergeWatcher.status(),
        runAutoMergeNow: () => autoMergeWatcher.runNow(),
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

  const { buildGitLabFleetAcquirers } = await import("./gitlab-fleet-events");
  const gitlabEvents = await buildGitLabFleetAcquirers({
    config,
    workspaceDir,
    state,
    repoManager,
    intervalSeconds,
    intervalUpdaters,
    supervisor: options.supervisor,
    verbose,
  });
  acquirers.push(...gitlabEvents.acquirers);
  const reconcileGitLabRelay = gitlabEvents.reconcile;

  // Mode 2 relay is independent of GitHub polling credentials: tracker
  // envelopes only need the active tracker client. PR envelopes use the
  // GitHub handlers when those credentials are available.
  if (relayState || process.env.WORKER_RELAY_URL) {
    if (!relayToken) {
      console.warn(
        "⚠️  Relay is configured but no relay token is stored in the workspace — re-run `devintern worker init`. Polling continues.",
      );
    } else if (relayUrl) {
      const { RelayAcquirer } = await import("../relay/acquirer");
      const { botMentionCandidates, mentionsAnyBot } = await import("../acquirers/mention-sweep");
      const relayTaskSources = taskSources.map((source) => {
        const execute = createGatedFleetTaskExecutor(
          {
            config,
            workspaceDir,
            skips: state.skips,
            repoManager,
            team: source.team,
            actionedSource: resolveActionedSource(config, source.team),
            supervisor: options.supervisor,
          },
          {
            source: source.team
              ? `relay:${source.tracker}:${source.team.name}`
              : `relay:${source.tracker}`,
            dependencyGate: source.dependencyGate,
          },
        );
        return {
          tracker: source.tracker,
          label: source.team?.name,
          evaluate: createFleetTaskEvaluator({
            query: source.query,
            searchTasks: source.searchTasks,
            execute,
            isTaskActionedUnchanged: source.isTaskActionedUnchanged,
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
              if (!githubFor || !handleMention) {
                if (verbose) {
                  console.log(
                    `   [relay] ignoring comment on ${repo}#${prNumber}: no GitHub credentials ` +
                      "(GITHUB_TOKEN is not set in this relay-backed workspace).",
                  );
                }
                return "skipped";
              }
              const [repoOwner, repoName] = repo.split("/") as [string, string];
              const { data: comment } = await githubFor(repo).conditionalGet<{
                id: number;
                body: string | null;
                user: { login: string; type: string };
                created_at: string;
                html_url: string;
              }>(`/repos/${repo}/issues/comments/${commentId}`, repoOwner, repoName);
              if (!comment) return "skipped";
              const botName = await githubFor(repo).getBotUsername(repoOwner, repoName);
              const botNames = botMentionCandidates(botName);
              if (botNames.length === 0 || !mentionsAnyBot(comment.body, botNames)) {
                return "skipped";
              }
              return handleMention(repo, comment, prNumber);
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

/**
 * Build the injected-task acquirer's merge-state lookup: ask GitHub whether a
 * dependency PR the gate waits on (closed with an unknown reason, or still
 * `open` in the registry, or merged without a host merge time the gate needs
 * to order stacked merges) merged or closed, and record the answer (with
 * GitHub's `merged_at` and base ref for a merge) in `agent_prs`, so the
 * dependency gate (and later readers) never ask again.
 * The open case covers workspaces where no review poller watches the PR
 * (e.g. no fleet GitHub credentials). An open PR returns `null`.
 *
 * Only GitHub repos are looked up; GitLab pollers record the outcome when they
 * observe the close, and anything unresolvable (e.g. Bitbucket) stays unknown
 * (the dependent keeps waiting). Auth follows the mode the event wiring chose
 * (`token-only` for relay-hosted workspaces, else `app-first`).
 */
export function createDependencyMergeStateResolver(options: {
  config: WorkspaceConfig;
  workspaceDir: string;
  workerState: Pick<WorkerState, "markAgentPrClosed">;
}): (lookup: { repo: string; pr: { number: number } }) => Promise<MergeStateAnswer | null> {
  const { config, workspaceDir, workerState } = options;
  let resolver: ((slug: string) => FleetGitHubClient) | undefined;
  return async ({ repo, pr }) => {
    const repoConfig = config.repos.find((candidate) => candidate.name === repo);
    const slug = repoConfig
      ? (repoConfig.env.GITHUB_REPO ?? gitHubSlugFromRemote(repoConfig.remote))
      : undefined;
    if (!slug) return null;
    const { GITHUB_AUTH_MODE_ENV, GitHubReviewsClient } =
      await import("../code-host/github/reviews");
    const { closeReasonFromPr, mergeDetailsFromPr } = await import("../review/agent-pr-reconciler");
    resolver ??= createFleetGitHubClientResolver(
      config,
      workspaceDir,
      process.env[GITHUB_AUTH_MODE_ENV] === "token-only",
      GitHubReviewsClient,
    );
    const [owner = "", name = ""] = slug.split("/");
    const result = await resolver(slug).conditionalGet<
      import("../review/agent-pr-reconciler").PolledPr
    >(`/repos/${slug}/pulls/${pr.number}`, owner, name);
    if (!result.data) return null;
    const reason = closeReasonFromPr("closed", result.data);
    if (!reason || result.data.state === "open") return null;
    const merge = reason === "merged" ? mergeDetailsFromPr(result.data) : undefined;
    workerState.markAgentPrClosed(slug, pr.number, reason, merge);
    return { state: reason, ...merge };
  };
}
