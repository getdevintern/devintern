import { randomUUID } from "crypto";
import type { Acquirer } from "../../worker";
import { createGitLabCiProvider } from "../code-host/gitlab/ci-provider";
import { JobNotStartedError } from "../worker/supervisor";
import type { JobKind, TaskSupervisor } from "../worker/supervisor";
import type {
  AgentPr,
  AgentPrCloseReason,
  AgentPrMergeDetails,
  WorkerState,
} from "../state/worker-state";
import type { WorkspaceConfig, RepoConfig } from "./config";
import type { WorkspaceState } from "./state";
import type { RepoManagerLike } from "./fleet-executor";
import { buildFleetEventEnv } from "./env";
import { PR_JOB_FETCH_TIMEOUT_MS, prJobEnv } from "./fleet-events";

/**
 * Close the exact registered MR the GitLab CI watcher saw terminal, forwarding
 * the watcher's merge verdict so merged MRs land in the dashboard Merged tab.
 *
 * @param workerState - Registry holding the agent's change requests
 * @param ciRow - Looks up the registered MR row by project key and IID
 */
export function gitLabCiMarkClosed(
  workerState: Pick<WorkerState, "markAgentChangeRequestClosed">,
  ciRow: (key: string, number: number) => AgentPr | undefined,
): (key: string, number: number, reason?: AgentPrCloseReason, merge?: AgentPrMergeDetails) => void {
  return (key, number, reason, merge) => {
    const mr = ciRow(key, number);
    if (!mr) return;
    workerState.markAgentChangeRequestClosed(
      {
        provider: mr.provider,
        instanceUrl: mr.instanceUrl,
        projectId: mr.projectId,
        projectPath: mr.projectPath,
        number: mr.changeNumber,
        webUrl: mr.webUrl,
      },
      reason,
      merge,
    );
  };
}

/** Supervisor exclusive key for one GitLab MR (`<instance>:<group/project>!<iid>`). */
export function gitLabMrExclusiveKey(
  mr: Pick<AgentPr, "instanceUrl" | "projectPath" | "changeNumber">,
): string {
  return `${mr.instanceUrl}:${mr.projectPath}!${mr.changeNumber}`;
}

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
      await repoManager.fetch(repo.name, { timeoutMs: PR_JOB_FETCH_TIMEOUT_MS });
      // Never the base checkout: an automation may be using it while this MR
      // job runs. The PR-job checkout tracks the default branch.
      const base = await repoManager.ensurePrJobWorktree(repo);
      return execute(base, signal);
    };
    if (!options.supervisor) return run();
    return options.supervisor.schedule({
      id: randomUUID(),
      source,
      repo: repo.name,
      kind,
      label: `${mr.projectPath}!${mr.changeNumber}`,
      // Parallel across MRs (bounded by max_concurrency_per_repo), serialized
      // per MR by the same key the CLI runners use for serializePrRun.
      checkoutClass: "pr_worktree",
      exclusiveKey: gitLabMrExclusiveKey(mr),
      run,
    });
  }

  // GitLab polling is deliberately independent of GitHub credentials and
  // watches only provider-aware rows registered after successful MR creation.
  const { parseGitLabHostAliases, parseGitRemoteUrl, resolveGitLabCodeHostConfig } =
    await import("../code-host");
  const resolveGitLabRepo = (mr: import("../state/worker-state").AgentPr) =>
    config.repos.find((repo) => {
      const env = buildFleetEventEnv(config, repo, workspaceDir);
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
    const env = buildFleetEventEnv(config, repo, workspaceDir);
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
    const clientForGitLabMr = (mr: import("../state/worker-state").AgentPr) => {
      const repo = resolveGitLabRepo(mr);
      if (!repo) return null;
      const env = buildFleetEventEnv(config, repo, workspaceDir);
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
              env: prJobEnv(config, buildFleetEventEnv(config, repo, workspaceDir)),
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
          const agentSelection = config.workspace.conflictAgent;
          return runResolveConflictsUrlViaCli(
            mr.webUrl,
            `${mr.instanceUrl}:${mr.projectPath}!${mr.changeNumber}`,
            {
              cwd: base,
              signal,
              env: prJobEnv(
                config,
                buildFleetEventEnv(config, repo, workspaceDir, { agentSelection }),
              ),
              harnessPin: agentSelection?.harness,
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

    const gitlabCiRows = new Map<string, Map<number, import("../state/worker-state").AgentPr>>();
    const ciKey = (mr: import("../state/worker-state").AgentPr) =>
      `${mr.instanceUrl}:${mr.projectPath}`;
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
      markClosed: gitLabCiMarkClosed(state.workerState, ciRow),
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
            env: prJobEnv(config, buildFleetEventEnv(config, repo, workspaceDir)),
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
