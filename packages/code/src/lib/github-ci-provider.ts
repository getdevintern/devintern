import type {
  CiProvider,
  CiConditionalResult,
  CiObservation,
  CiFailure as PendingFailure,
} from "./ci-provider";
export interface PolledCiPr {
  state: string;
  head?: {
    sha: string;
    /** Head repository; differs from the base repo for fork PRs. */
    repo?: { full_name: string } | null;
  };
}

export interface WatchedWorkflowRun {
  id: number;
  /** Provider-native durable identifier when a numeric run id is insufficient. */
  externalId?: string;
  name?: string;
  /** `queued`, `in_progress`, `waiting`, or `completed`. */
  status: string;
  /** Terminal outcome; null while still executing. */
  conclusion: string | null;
  html_url?: string;
}

export interface WatchedStatusState {
  state: string;
  total_count: number;
  statuses: Array<{ id: number; state: string; context?: string; target_url?: string | null }>;
}

/** GitHub access used by the watcher (injected for tests). */
export interface CiFailureWatcherGitHub {
  fetchPr(repo: string, prNumber: number, etag?: string): Promise<CiConditionalResult<PolledCiPr>>;
  fetchWorkflowRuns(
    repo: string,
    sha: string,
    etag?: string,
  ): Promise<CiConditionalResult<WatchedWorkflowRun[]>>;
  fetchCommitStatus(
    repo: string,
    sha: string,
    etag?: string,
  ): Promise<CiConditionalResult<WatchedStatusState>>;
  /**
   * Fetch raw log text of the failing Actions jobs for a SHA (workflow runs
   * → jobs → job-log endpoint). Returns null on 403/404/scope problems.
   */
  fetchFailingJobLogs(repo: string, sha: string): Promise<string | null>;
  /** Best-effort escalation comment on the PR conversation. */
  postComment(repo: string, prNumber: number, body: string): Promise<void>;
}

function workflows(
  repo: string,
  prNumber: number,
  headSha: string,
  runs: WatchedWorkflowRun[],
): CiObservation {
  let sawActionSuccess = false;
  let sawActionPending = false;
  const actionFailures: PendingFailure[] = [];
  for (const run of runs) {
    if (run.status !== "completed") {
      sawActionPending = true;
      continue;
    }
    if (run.conclusion === "success") {
      sawActionSuccess = true;
      continue;
    }
    if (run.conclusion !== "failure" && run.conclusion !== "timed_out") {
      continue;
    }
    actionFailures.push({
      externalId: run.externalId ?? `action:${repo}#${prNumber}:${headSha}:${run.id}`,
      name: run.name ?? `workflow-run-${run.id}`,
      conclusion: run.conclusion,
      detailsUrl: run.html_url,
    });
  }
  const state =
    actionFailures.length > 0
      ? "failure"
      : sawActionPending
        ? "pending"
        : runs.length === 0
          ? "empty"
          : sawActionSuccess || runs.every((run) => run.status === "completed")
            ? "success"
            : "unknown";

  return { state, failures: actionFailures };
}
function statuses(
  repo: string,
  prNumber: number,
  headSha: string,
  statusResult: WatchedStatusState,
): CiObservation {
  const statusFailures: PendingFailure[] = [];
  for (const status of statusResult.statuses) {
    if (status.state !== "failure" && status.state !== "error") {
      continue;
    }
    statusFailures.push({
      externalId: `check:${repo}#${prNumber}:${headSha}:status:${status.context ?? status.id}`,
      name: status.context ?? `commit-status-${status.id}`,
      conclusion: status.state,
      detailsUrl: status.target_url ?? undefined,
    });
  }
  const state =
    statusFailures.length > 0
      ? "failure"
      : statusResult.total_count === 0
        ? "empty"
        : statusResult.state === "pending"
          ? "pending"
          : statusResult.state === "success"
            ? "success"
            : "unknown";

  return { state, failures: statusFailures };
}
/** Translate GitHub responses without changing persisted cursor or failure identities. */
export function createGitHubCiProvider(client: CiFailureWatcherGitHub): CiProvider {
  return {
    async fetchChange(repo, number, etag) {
      const result = await client.fetchPr(repo, number, etag);
      return {
        ...result,
        data: result.data
          ? {
              state: result.data.state,
              headSha: result.data.head?.sha,
              headRepository: result.data.head?.repo?.full_name,
            }
          : null,
      };
    },
    streams: [
      {
        key: "ciactions",
        async fetch(repo, number, sha, etag) {
          const result = await client.fetchWorkflowRuns(repo, sha, etag);
          return {
            ...result,
            data: result.data ? workflows(repo, number, sha, result.data) : null,
          };
        },
      },
      {
        key: "cistatus",
        async fetch(repo, number, sha, etag) {
          const result = await client.fetchCommitStatus(repo, sha, etag);
          return { ...result, data: result.data ? statuses(repo, number, sha, result.data) : null };
        },
      },
    ],
    fetchFailingJobLogs: (repo, sha) => client.fetchFailingJobLogs(repo, sha),
    postComment: (repo, number, body) => client.postComment(repo, number, body),
  };
}
