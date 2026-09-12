import type { CiProvider } from "../ci-provider";
import type { GitLabCiSnapshot, GitLabReviewsClient } from "./reviews";
import type { AgentPr } from "../../worker-state";

/** MR operations require an exact IID; CI and traces are scoped to project/SHA. */
export function createGitLabCiProvider(
  resolve: (
    key: string,
    number?: number,
  ) => {
    mr: AgentPr;
    client: Pick<
      GitLabReviewsClient,
      "getChangeRequest" | "getCiSnapshot" | "getJobTraces" | "postMergeRequestNote"
    >;
  },
): CiProvider {
  const snapshots = new Map<string, { sha: string; snapshot: GitLabCiSnapshot }>();
  return {
    async fetchChange(key, number) {
      const { mr, client } = resolve(key, number);
      try {
        const current = await client.getChangeRequest(mr.projectPath, number);
        return {
          data: {
            state: current.state === "opened" ? "open" : current.state,
            headSha: current.head.sha,
            headRepository: key,
          },
          notModified: false,
        };
      } catch (error) {
        if ((error as Error).message.includes("GitLab API error (404)")) {
          return { data: null, notModified: false, gone: true };
        }
        throw error;
      }
    },
    streams: [
      {
        // Preserve the deployed cursor suffix even though these are pipelines.
        key: "ciactions",
        async fetch(key, _number, sha) {
          const { mr, client } = resolve(key);
          const snapshot = await client.getCiSnapshot(mr.projectPath, sha);
          snapshots.set(key, { sha, snapshot });
          return {
            data: {
              state: snapshot.state,
              failures: snapshot.failures.map((failure) => ({
                externalId: `gitlab:${mr.instanceUrl}:${failure.externalId}`,
                name: failure.name,
                conclusion: failure.conclusion,
                detailsUrl: failure.detailsUrl,
              })),
            },
            notModified: false,
          };
        },
      },
    ],
    async fetchFailingJobLogs(key, sha) {
      const { mr, client } = resolve(key);
      const cached = snapshots.get(key);
      return client.getJobTraces(mr.projectPath, cached?.sha === sha ? cached.snapshot.jobIds : []);
    },
    async postComment(key, number, body) {
      const { mr, client } = resolve(key, number);
      await client.postMergeRequestNote(mr.projectId ?? mr.projectPath, number, body);
    },
  };
}
