import { describe, expect, test } from "bun:test";
import { createGitLabCiProvider } from "../src/lib/code-host/gitlab/ci-provider";
import type { AgentPr } from "../src/lib/state/worker-state";
import type { GitLabReviewsClient, GitLabCiSnapshot } from "../src/lib/code-host/gitlab/reviews";

function fixture(state: GitLabCiSnapshot["state"] = "failure") {
  const calls: Array<[string, number | undefined]> = [];
  const traces: number[][] = [];
  const mr = {
    instanceUrl: "https://gitlab.example",
    projectPath: "group/project",
    projectId: "12",
    changeNumber: 17,
  } as AgentPr;
  let changeState = "opened";
  let gone = false;
  const client = {
    async getChangeRequest() {
      if (gone) throw new Error("GitLab API error (404)");
      return { state: changeState, head: { sha: "head" } };
    },
    async getCiSnapshot() {
      return {
        state,
        failures:
          state === "failure"
            ? [
                {
                  externalId: "12:head:9",
                  name: "test",
                  conclusion: "failure",
                  detailsUrl: "https://gitlab.example/job/9",
                },
              ]
            : [],
        jobIds: [9],
      };
    },
    async getJobTraces(_project: string, ids: number[]) {
      traces.push(ids);
      return "logs";
    },
    async postMergeRequestNote() {},
  } as unknown as Pick<
    GitLabReviewsClient,
    "getChangeRequest" | "getCiSnapshot" | "getJobTraces" | "postMergeRequestNote"
  >;
  const provider = createGitLabCiProvider((key, number) => {
    calls.push([key, number]);
    return { mr, client };
  });
  return {
    provider,
    calls,
    traces,
    close: () => {
      changeState = "closed";
    },
    remove: () => {
      gone = true;
    },
  };
}

describe("GitLab CI provider contract", () => {
  test.each(["pending", "success", "failure", "unknown"] as const)(
    "preserves %s observations",
    async (state) => {
      const { provider } = fixture(state);
      const result = await provider.streams[0].fetch("project", 17, "head");
      expect(result.data?.state).toBe(state);
      expect(result.notModified).toBe(false);
      expect(result.data?.failures).toHaveLength(state === "failure" ? 1 : 0);
      if (state === "failure") {
        expect(result.data?.failures[0].externalId).toBe("gitlab:https://gitlab.example:12:head:9");
      }
    },
  );

  test("change reads and comments resolve the exact MR", async () => {
    const { provider, calls, close, remove } = fixture();
    expect((await provider.fetchChange("project", 17)).data).toEqual({
      state: "open",
      headSha: "head",
      headRepository: "project",
    });
    close();
    expect((await provider.fetchChange("project", 18)).data?.state).toBe("closed");
    await provider.postComment("project", 18, "comment");
    expect(calls).toEqual([
      ["project", 17],
      ["project", 18],
      ["project", 18],
    ]);
    remove();
    expect((await provider.fetchChange("project", 17)).gone).toBe(true);
  });

  test("traces never reuse job IDs from a stale head", async () => {
    const { provider, traces } = fixture();
    await provider.streams[0].fetch("project", 17, "head");
    await provider.fetchFailingJobLogs("project", "new-head");
    await provider.fetchFailingJobLogs("project", "head");
    expect(traces).toEqual([[], [9]]);
  });
});
