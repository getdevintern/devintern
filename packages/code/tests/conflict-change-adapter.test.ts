import { afterEach, expect, spyOn, test } from "bun:test";
import { createConflictChangeAdapter } from "../src/lib/conflict-change-adapter";
import { GitLabReviewsClient } from "../src/lib/gitlab-reviews";

const savedFlag = process.env.DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST;
const savedToken = process.env.GITLAB_CODE_HOST_TOKEN;
const savedUrl = process.env.GITLAB_CODE_HOST_URL;
afterEach(() => {
  for (const [key, value] of [
    ["DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST", savedFlag],
    ["GITLAB_CODE_HOST_TOKEN", savedToken],
    ["GITLAB_CODE_HOST_URL", savedUrl],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});

test("GitLab conflict adapter retains instance, nested project, ID and IID", async () => {
  process.env.DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST = "1";
  process.env.GITLAB_CODE_HOST_TOKEN = "test-token";
  process.env.GITLAB_CODE_HOST_URL = "https://gitlab.example";
  const get = spyOn(GitLabReviewsClient.prototype, "getChangeRequest").mockResolvedValue({
    state: "opened",
    head: { ref: "feature", sha: "head" },
    base: { ref: "main", sha: "base" },
    mergeability: "conflicts",
  } as Awaited<ReturnType<GitLabReviewsClient["getChangeRequest"]>>);
  const post = spyOn(GitLabReviewsClient.prototype, "postMergeRequestNote").mockResolvedValue(
    undefined,
  );
  try {
    const adapter = createConflictChangeAdapter({
      provider: "gitlab",
      instanceUrl: "https://gitlab.example",
      projectPath: "group/sub/project",
      projectId: "42",
      number: 17,
      webUrl: "https://gitlab.example/group/sub/project/-/merge_requests/17",
    });
    const change = await adapter.fetchChange();
    expect(change.state).toBe("open");
    expect(change.mergeability).toBe("conflicts");
    expect(change.head.sha).toBe("head");
    expect(get).toHaveBeenCalledWith("group/sub/project", 17);
    await adapter.postComment("result");
    expect(post).toHaveBeenCalledWith("42", 17, "result");
    expect((get.mock.contexts[0] as GitLabReviewsClient).instanceUrl).toBe(
      "https://gitlab.example",
    );
  } finally {
    get.mockRestore();
    post.mockRestore();
  }
});
