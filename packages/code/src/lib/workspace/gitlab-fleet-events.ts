import { randomUUID } from "crypto";
import type { Acquirer } from "../../worker";
import { createGitLabCiProvider } from "../code-host/gitlab/ci-provider";
import { JobNotStartedError } from "../task-supervisor";
import type { JobKind, TaskSupervisor } from "../task-supervisor";
import type { AgentPr } from "../worker-state";
import type { WorkspaceConfig, RepoConfig } from "./config";
import type { WorkspaceState } from "./state";
import type { RepoManagerLike } from "./workspace-worker";
import { buildRepoEnv } from "./env";

/** Registered GitLab polling and relay reconciliation share one live repository resolver. */
export async function buildGitLabFleetAcquirers(options: {
  config: WorkspaceConfig;
  workspaceDir: string;
  state: WorkspaceState;
  repoManager: RepoManagerLike;
  intervalSeconds: number;
  intervalUpdaters: Array<(seconds: number) => void>;
  supervisor?: TaskSupervisor;
  verbose?: boolean;
}) {
  const { config, workspaceDir, state, repoManager, intervalSeconds, intervalUpdaters, verbose } =
    options;
  const acquirers: Acquirer[] = [];

  async function runJob<T>(
    repo: RepoConfig,
    mr: AgentPr,
    kind: JobKind,
    source: string,
    execute: (base: string, signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const run = async (signal?: AbortSignal) => {
      if (signal?.aborted) throw new JobNotStartedError();
      await repoManager.ensureBareClone(repo);
      await repoManager.fetch(repo.name);
      const base = await repoManager.ensureBaseWorktree(repo);
      return execute(base, signal);
    };
    if (!options.supervisor) return run();
    return options.supervisor.schedule({
      id: randomUUID(),
      source,
      repo: repo.name,
      kind,
      label: `${mr.projectPath}!${mr.changeNumber}`,
      checkoutClass: "shared_base",
      run,
    });
  }

  // GitLab polling is deliberately independent of GitHub credentials and
  // watches only provider-aware rows registered after successful MR creation.
  const { parseGitLabHostAliases, parseGitRemoteUrl, resolveGitLabCodeHostConfig } =
    await import("../code-host");
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
        envelope: import("../relay/acquirer").RelayEnvelope & {
          codeHost: import("../relay/acquirer").RelayCodeHostIdentity;
        },
      ) => Promise<void>)
    | undefined;
  if (hasGitLabProfile) {
    const { CiFailureWatcherAcquirer, runCiFixViaCli } =
      await import("../acquirers/ci-failure-watcher");
    const { GitLabReviewPollingAcquirer } = await import("../acquirers/gitlab-review-polling");
    const { GitLabReviewsClient } = await import("../code-host/gitlab/reviews");
    const { runAddressReviewUrlViaCli, runResolveConflictsUrlViaCli } =
      await import("../acquirers/review-polling");
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
        const invoke = async (base: string, signal?: AbortSignal) => {
          return runAddressReviewUrlViaCli(
            mr.webUrl,
            `${mr.instanceUrl}:${mr.projectPath}!${mr.changeNumber}`,
            {
              cwd: base,
              signal,
              env: buildRepoEnv(repo, workspaceDir),
            },
          );
        };
        try {
          return await runJob(repo, mr, "review", "gitlab:feedback", invoke);
        } catch (error) {
          if (error instanceof JobNotStartedError) return "deferred";
          throw error;
        }
      },
      // Scheduled GitLab conflict windows need provider-neutral durable
      // scheduling state; until that lands, never violate a scheduled policy.
      shouldResolve: () => config.workspace.conflictResolution === "auto",
      resolveMr: async (mr, expected) => {
        const repo = resolveGitLabRepo(mr);
        if (!repo) return { outcome: "skipped", message: "repository is not configured" };
        const invoke = async (base: string, signal?: AbortSignal) => {
          return runResolveConflictsUrlViaCli(
            mr.webUrl,
            `${mr.instanceUrl}:${mr.projectPath}!${mr.changeNumber}`,
            {
              cwd: base,
              signal,
              env: buildRepoEnv(repo, workspaceDir),
              expectedHeadSha: expected.headSha,
              expectedBaseSha: expected.baseSha,
            },
          );
        };
        try {
          return await runJob(repo, mr, "conflict", "gitlab:conflict", invoke);
        } catch (error) {
          if (error instanceof JobNotStartedError) {
            return { outcome: "deferred", message: error.message };
          }
          throw error;
        }
      },
      reviewerAllowlist: (process.env.GITLAB_REVIEWER_ALLOWLIST ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    });
    acquirers.push(gitlabPoller);
    intervalUpdaters.push((seconds) => gitlabPoller.updateInterval(seconds));

    const gitlabCiRows = new Map<string, Map<number, import("../worker-state").AgentPr>>();
    const ciKey = (mr: import("../worker-state").AgentPr) => `${mr.instanceUrl}:${mr.projectPath}`;
    const ciRow = (key: string, number?: number) => {
      const rows = gitlabCiRows.get(key);
      // Project/SHA-scoped reads can use any row; MR operations require the exact IID.
      return number === undefined ? rows?.values().next().value : rows?.get(number);
    };
    const resolveCi = (key: string, number?: number) => {
      const mr = ciRow(key, number);
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
      feedbackRepository: (key) => ciRow(key)?.projectPath ?? key,
      describeChange: (key, n) => `${ciRow(key)?.projectPath ?? key}!${n}`,
      escalationRecoveryText: "Push a new commit and I will take another look.",
      watchedChanges: () => {
        gitlabCiRows.clear();
        return state.workerState
          .listOpenAgentChangeRequests()
          .filter((mr) => mr.provider === "gitlab" && Boolean(resolveGitLabRepo(mr)))
          .map((mr) => {
            const key = ciKey(mr);
            const rows = gitlabCiRows.get(key) ?? new Map();
            rows.set(mr.changeNumber, mr);
            gitlabCiRows.set(key, rows);
            return { repo: key, prNumber: mr.changeNumber };
          });
      },
      markClosed: (key, n) => {
        const mr = ciRow(key, n);
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
      provider: createGitLabCiProvider(resolveCi),
      fixPr: async (key, n, feedbackPath, expectedHeadSha) => {
        const { mr, client } = resolveCi(key, n);
        const current = await client.getChangeRequest(mr.projectPath, mr.changeNumber);
        if (current.state !== "opened" || current.head.sha !== expectedHeadSha) return false;
        const repo = resolveGitLabRepo(mr);
        if (!repo) return false;
        const invoke = async (base: string, signal?: AbortSignal) => {
          return runCiFixViaCli(mr.projectPath, mr.changeNumber, feedbackPath, {
            cwd: base,
            env: buildRepoEnv(repo, workspaceDir),
            webUrl: mr.webUrl,
            serializationKey: `${mr.instanceUrl}:${mr.projectPath}!${mr.changeNumber}`,
            expectedHeadSha,
            signal,
          });
        };
        try {
          return await runJob(repo, mr, "ci_fix", "gitlab:ci", invoke);
        } catch (error) {
          if (error instanceof JobNotStartedError) return "deferred";
          throw error;
        }
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
          await gitlabCiWatcher.reconcile(ciKey(mr), mr.changeNumber);
        } else {
          await gitlabPoller.reconcile(mr);
        }
      }
    };
  }

  return { acquirers, reconcile: reconcileGitLabRelay };
}
