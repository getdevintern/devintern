import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createReviewAdapter } from "../src/lib/review-provider-factory";
import { GitHubReviewsClient } from "../src/lib/github-reviews";
import { GitLabReviewsClient } from "../src/lib/gitlab-reviews";
import type { GitLabReviewContext } from "../src/lib/gitlab-reviews";
import { WorkerState } from "../src/lib/worker-state";

let dir: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-adapter-"));
  const values = {
    WEBHOOK_QUEUE_DB: join(dir, "queue.db"),
    GITHUB_TOKEN: "test-token",
    GITHUB_BOT_ALIASES: "",
    DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
    GITLAB_CODE_HOST_URL: "https://gitlab.example",
    GITLAB_CODE_HOST_TOKEN: "test-token",
    GITLAB_CODE_HOST_CA_FILE: "",
    GITLAB_CODE_HOST_PROXY: "",
  };
  saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
});
afterEach(() => {
  mock.restore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("GitLab adapter dedupes selected notes, retains discussion identity, and guards the original head", async () => {
  spyOn(GitLabReviewsClient.prototype, "getReviewContext").mockResolvedValue({
    projectId: 42,
    projectPath: "group/sub/project",
    mergeRequest: { title: "Change", state: "opened", source_branch: "feature", sha: "head" },
    feedback: {
      reviewer: "alice",
      comments: [
        { id: 1, body: "fix", reviewer: "alice" },
        { id: 2, body: "done" },
      ],
      conversationComments: [{ id: 3, body: "also fix", author: "alice" }],
    },
    discussionIds: ["thread-a", "thread-b"],
    noteIds: [1, 2, 3],
    discussionByNoteId: { 1: "thread-a", 2: "thread-b", 3: "thread-a" },
  } as unknown as GitLabReviewContext);
  const guard = spyOn(GitLabReviewsClient.prototype, "assertHeadSha").mockResolvedValue(undefined);
  const reply = spyOn(GitLabReviewsClient.prototype, "replyToDiscussions").mockResolvedValue({
    replied: 0,
    failures: ["thread-a"],
  });
  const state = new WorkerState();
  const key = "gitlab:https://gitlab.example:group/sub/project";
  try {
    state.markCommentsAddressed(key, "review", [2]);
    const adapter = await createReviewAdapter(
      {
        provider: "gitlab",
        instanceUrl: "https://gitlab.example",
        projectPath: "group/sub/project",
        number: 17,
        webUrl: "https://gitlab.example/group/sub/project/-/merge_requests/17",
      },
      false,
    );
    const selection = await adapter.loadFeedback();
    expect(selection?.feedback.comments.map((c) => c.id)).toEqual([1]);
    expect(selection?.feedback.conversationComments?.map((c) => c.id)).toEqual([3]);
    expect(state.isCommentAddressed(key, "review", 1)).toBe(false);
    await adapter.beforePush();
    expect(guard).toHaveBeenCalledWith(42, 17, "head");
    await adapter.acknowledge("done");
    expect(reply.mock.calls[0]?.slice(0, 3)).toEqual([42, 17, ["thread-a"]]);
    // Preserve existing semantics: failed visual replies do not rerun completed agent work.
    expect(state.isCommentAddressed(key, "review", 1)).toBe(true);
    expect(state.isCommentAddressed(key, "conversation", 3)).toBe(true);
    expect(await adapter.loadFeedback()).toBeNull();
  } finally {
    state.close();
  }
});

test.each(["CHANGES_REQUESTED", "COMMENTED"])(
  "GitHub adapter preserves %s selection and acknowledgement",
  async (reviewState) => {
    spyOn(GitHubReviewsClient.prototype, "getPullRequest").mockResolvedValue({
      title: "Change",
      state: "open",
      head: { ref: "feature", sha: "head" },
    } as Awaited<ReturnType<GitHubReviewsClient["getPullRequest"]>>);
    spyOn(GitHubReviewsClient.prototype, "getReviews").mockResolvedValue([
      {
        id: 10,
        state: reviewState,
        body: "please fix",
        submitted_at: "2026-01-01T00:00:00Z",
        user: { login: "alice" },
      },
    ] as Awaited<ReturnType<GitHubReviewsClient["getReviews"]>>);
    spyOn(GitHubReviewsClient.prototype, "getPullRequestReviewComments").mockResolvedValue([
      { id: 1, pull_request_review_id: 10, body: "fix", user: { login: "alice" }, path: "a.ts" },
      {
        id: 2,
        pull_request_review_id: 11,
        body: "unrelated",
        user: { login: "bob" },
        path: "b.ts",
      },
    ] as Awaited<ReturnType<GitHubReviewsClient["getPullRequestReviewComments"]>>);
    spyOn(GitHubReviewsClient.prototype, "getBotUsername").mockResolvedValue("bot");
    spyOn(GitHubReviewsClient.prototype, "getIssueComments").mockResolvedValue([]);
    const reaction = spyOn(GitHubReviewsClient.prototype, "addReactionToComment").mockRejectedValue(
      new Error("not accessible by integration"),
    );
    const adapter = await createReviewAdapter(
      {
        provider: "github",
        instanceUrl: "https://github.com",
        projectPath: "acme/project",
        number: 17,
        webUrl: "https://github.com/acme/project/pull/17",
      },
      false,
    );
    const selection = await adapter.loadFeedback();
    if (reviewState === "COMMENTED") {
      expect(selection).toBeNull();
      expect(reaction).not.toHaveBeenCalled();
    } else {
      expect(selection?.feedback.comments.map((c) => c.id)).toEqual([1]);
      await adapter.acknowledge("done");
      expect(reaction).toHaveBeenCalledWith("acme", "project", 1, "hooray");
      const state = new WorkerState();
      try {
        expect(state.isCommentAddressed("acme/project", "review", 1)).toBe(true);
        expect(state.isCommentAddressed("acme/project", "review", 2)).toBe(false);
      } finally {
        state.close();
      }
    }
  },
);
