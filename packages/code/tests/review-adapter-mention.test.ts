import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { createReviewAdapter } from "../src/lib/code-host/review-provider-factory";
import { GitHubReviewsClient } from "../src/lib/code-host/github/reviews";
import type { MentionTrigger } from "../src/lib/review/mention-trigger";
import {
  formatMentionArg,
  isBotAuthored,
  parseMentionArg,
} from "../src/lib/review/mention-trigger";
import { WorkerState } from "../src/lib/state/worker-state";

type Review = Awaited<ReturnType<GitHubReviewsClient["getReviews"]>>[number];
type ReviewComment = Awaited<
  ReturnType<GitHubReviewsClient["getPullRequestReviewComments"]>
>[number];

let dir: string;
let saved: Record<string, string | undefined>;
/** Payloads `conditionalGet` returns, by API path. */
let byPath: Record<string, unknown>;
let reviews: Review[];
let reviewComments: ReviewComment[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-adapter-mention-"));
  const values = {
    WEBHOOK_QUEUE_DB: join(dir, "queue.db"),
    GITHUB_TOKEN: "test-token",
    GITHUB_BOT_ALIASES: "devintern-ai",
  };
  saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  byPath = {};
  reviews = [];
  reviewComments = [];
  spyOn(GitHubReviewsClient.prototype, "getPullRequest").mockResolvedValue({
    title: "Human change",
    state: "open",
    head: { ref: "human-branch", sha: "head" },
  } as Awaited<ReturnType<GitHubReviewsClient["getPullRequest"]>>);
  spyOn(GitHubReviewsClient.prototype, "getBotUsername").mockResolvedValue(null);
  spyOn(GitHubReviewsClient.prototype, "getReviews").mockImplementation(async () => reviews);
  spyOn(GitHubReviewsClient.prototype, "getPullRequestReviewComments").mockImplementation(
    async () => reviewComments,
  );
  spyOn(GitHubReviewsClient.prototype, "getIssueComments").mockResolvedValue([]);
  spyOn(GitHubReviewsClient.prototype, "addReactionToComment").mockResolvedValue(undefined);
  spyOn(GitHubReviewsClient.prototype, "addReactionToIssueComment").mockResolvedValue(undefined);
  spyOn(GitHubReviewsClient.prototype, "conditionalGet").mockImplementation((async (
    path: string,
  ) => {
    if (!(path in byPath)) throw new Error(`GitHub API error (404): Not Found ${path}`);
    return { data: byPath[path], notModified: false };
  }) as GitHubReviewsClient["conditionalGet"]);
});

afterEach(() => {
  mock.restore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const adapterFor = (mention?: MentionTrigger) =>
  createReviewAdapter(
    {
      provider: "github",
      instanceUrl: "https://github.com",
      projectPath: "acme/project",
      number: 47,
      webUrl: "https://github.com/acme/project/pull/47",
    },
    false,
    { mention },
  );

const isAddressed = (type: "review" | "conversation" | "review_body", id: number): boolean => {
  const state = new WorkerState();
  try {
    return state.isCommentAddressed("acme/project", type, id);
  } finally {
    state.close();
  }
};

describe("--mention argument", () => {
  test("round-trips and rejects malformed values", () => {
    expect(parseMentionArg(formatMentionArg({ kind: "review", id: 9 }))).toEqual({
      kind: "review",
      id: 9,
    });
    expect(parseMentionArg("issue_comment:123")).toEqual({ kind: "issue_comment", id: 123 });
    expect(parseMentionArg("comment:1")).toBeUndefined();
    expect(parseMentionArg("review:")).toBeUndefined();
    expect(parseMentionArg("review:0")).toBeUndefined();
  });

  test("bot-authored detection covers Bot users, bot logins, and worker markers", () => {
    expect(isBotAuthored({ user: { login: "devintern-ai[bot]", type: "Bot" } })).toBe(true);
    expect(isBotAuthored({ user: { login: "my-app[bot]" } })).toBe(true);
    expect(isBotAuthored({ user: { login: "devintern-ai" } }, ["devintern-ai[bot]"])).toBe(true);
    expect(
      isBotAuthored({ user: { login: "danii1" }, body: "<!-- devintern:auto-merge-status -->" }),
    ).toBe(true);
    expect(isBotAuthored({ user: { login: "danii1" }, body: "@devintern-ai do it" })).toBe(false);
  });
});

describe("GitHub adapter with a mention trigger", () => {
  test("a conversation-comment mention on a PR without reviews is the feedback", async () => {
    byPath["/repos/acme/project/issues/comments/501"] = {
      id: 501,
      body: "@devintern-ai please add a second line to relay-X.md",
      user: { login: "danii1", type: "User" },
      created_at: "2026-11-26T10:00:00Z",
      issue_url: "https://api.github.com/repos/acme/project/issues/47",
    };

    // Without the trigger the run finds nothing (the reported bug).
    expect(await (await adapterFor()).loadFeedback()).toBeNull();

    const adapter = await adapterFor({ kind: "issue_comment", id: 501 });
    const selection = await adapter.loadFeedback();
    expect(selection?.feedback.reviewer).toBe("danii1");
    expect(selection?.feedback.reviewState).toBe("commented");
    expect(selection?.feedback.conversationComments).toEqual([
      {
        id: 501,
        body: "@devintern-ai please add a second line to relay-X.md",
        author: "danii1",
        createdAt: "2026-11-26T10:00:00Z",
      },
    ]);
    expect(selection?.stageDetail.mention).toEqual({ kind: "issue_comment", id: 501 });

    await adapter.acknowledge("done");
    expect(isAddressed("conversation", 501)).toBe(true);
    // Dedupe: the same mention never runs twice.
    expect(await (await adapterFor({ kind: "issue_comment", id: 501 })).loadFeedback()).toBeNull();
  });

  test("keeps the existing changes_requested review collection alongside the mention", async () => {
    reviews = [
      {
        id: 10,
        state: "CHANGES_REQUESTED",
        body: "fix a.ts",
        submitted_at: "2026-11-26T09:00:00Z",
        user: { login: "alice" },
      },
    ];
    reviewComments = [
      { id: 1, pull_request_review_id: 10, body: "here", user: { login: "alice" }, path: "a.ts" },
    ] as ReviewComment[];
    byPath["/repos/acme/project/issues/comments/502"] = {
      id: 502,
      body: "@devintern-ai also bump the version",
      user: { login: "danii1", type: "User" },
      created_at: "2026-11-26T10:00:00Z",
    };
    const selection = await (await adapterFor({ kind: "issue_comment", id: 502 })).loadFeedback();
    expect(selection?.feedback.reviewer).toBe("alice");
    expect(selection?.feedback.comments.map((c) => c.id)).toEqual([1]);
    expect(selection?.feedback.conversationComments?.map((c) => c.id)).toEqual([502]);
  });

  test("a commented review without a mention does not ride along with a comment mention", async () => {
    reviews = [
      {
        id: 11,
        state: "COMMENTED",
        body: "looks fine",
        submitted_at: "2026-11-26T09:00:00Z",
        user: { login: "bob" },
      },
    ];
    reviewComments = [
      { id: 3, pull_request_review_id: 11, body: "nit", user: { login: "bob" }, path: "b.ts" },
    ] as ReviewComment[];
    byPath["/repos/acme/project/issues/comments/503"] = {
      id: 503,
      body: "@devintern-ai rename foo",
      user: { login: "danii1" },
      created_at: "2026-11-26T10:00:00Z",
    };
    const selection = await (await adapterFor({ kind: "issue_comment", id: 503 })).loadFeedback();
    expect(selection?.feedback.reviewer).toBe("danii1");
    expect(selection?.feedback.comments).toEqual([]);
    expect(selection?.feedback.conversationComments?.map((c) => c.id)).toEqual([503]);
  });

  test("a review-body mention is addressed even without line comments, once", async () => {
    byPath["/repos/acme/project/pulls/47/reviews/77"] = {
      id: 77,
      state: "COMMENTED",
      body: "@devintern-ai please add a second line to relay-X.md",
      user: { login: "danii1", type: "User" },
      submitted_at: "2026-11-26T10:00:00Z",
    };
    const adapter = await adapterFor({ kind: "review", id: 77 });
    const selection = await adapter.loadFeedback();
    expect(selection?.feedback.reviewBody).toBe(
      "@devintern-ai please add a second line to relay-X.md",
    );
    expect(selection?.feedback.comments).toEqual([]);
    await adapter.acknowledge("done");
    expect(isAddressed("review_body", 77)).toBe(true);
    expect(await (await adapterFor({ kind: "review", id: 77 })).loadFeedback()).toBeNull();
  });

  test("a review mention includes that review's line comments", async () => {
    byPath["/repos/acme/project/pulls/47/reviews/78"] = {
      id: 78,
      state: "COMMENTED",
      body: "",
      user: { login: "danii1" },
      submitted_at: "2026-11-26T10:00:00Z",
    };
    reviewComments = [
      {
        id: 4,
        pull_request_review_id: 78,
        body: "@devintern-ai fix this",
        user: { login: "danii1" },
        path: "c.ts",
      },
    ] as ReviewComment[];
    const selection = await (await adapterFor({ kind: "review", id: 78 })).loadFeedback();
    expect(selection?.feedback.comments.map((c) => c.id)).toEqual([4]);
  });

  test("a review-comment mention is in scope by id", async () => {
    byPath["/repos/acme/project/pulls/comments/5"] = {
      id: 5,
      body: "@devintern-ai rename",
      user: { login: "danii1" },
      created_at: "2026-11-26T10:00:00Z",
      pull_request_url: "https://api.github.com/repos/acme/project/pulls/47",
    };
    reviewComments = [
      {
        id: 5,
        pull_request_review_id: 90,
        body: "@devintern-ai rename",
        user: { login: "danii1" },
        path: "d.ts",
      },
    ] as ReviewComment[];
    const selection = await (await adapterFor({ kind: "review_comment", id: 5 })).loadFeedback();
    expect(selection?.feedback.comments.map((c) => c.id)).toEqual([5]);
  });

  test("never acts on a mention written by the bot or the worker", async () => {
    byPath["/repos/acme/project/issues/comments/504"] = {
      id: 504,
      body: "@devintern-ai done",
      user: { login: "devintern-ai[bot]", type: "Bot" },
      created_at: "2026-11-26T10:00:00Z",
    };
    byPath["/repos/acme/project/issues/comments/505"] = {
      id: 505,
      body: "<!-- devintern:stack-blocked --> waiting on @devintern-ai",
      user: { login: "danii1" },
      created_at: "2026-11-26T10:00:00Z",
    };
    expect(await (await adapterFor({ kind: "issue_comment", id: 504 })).loadFeedback()).toBeNull();
    expect(await (await adapterFor({ kind: "issue_comment", id: 505 })).loadFeedback()).toBeNull();
  });

  test("a deleted mention or one on another PR is skipped", async () => {
    expect(await (await adapterFor({ kind: "issue_comment", id: 999 })).loadFeedback()).toBeNull();
    byPath["/repos/acme/project/issues/comments/506"] = {
      id: 506,
      body: "@devintern-ai go",
      user: { login: "danii1" },
      created_at: "2026-11-26T10:00:00Z",
      issue_url: "https://api.github.com/repos/acme/project/issues/48",
    };
    expect(await (await adapterFor({ kind: "issue_comment", id: 506 })).loadFeedback()).toBeNull();
  });
});
