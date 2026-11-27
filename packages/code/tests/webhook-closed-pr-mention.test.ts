/**
 * Direct webhook server: an @mention on a merged or closed PR gets one reply
 * on the PR and starts no review run; a redelivery of the same webhook is
 * acknowledged as a duplicate; a comment without a mention posts nothing.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { IssueCommentEvent } from "../src/types/github-webhooks";

const realReviews = { ...(await import("../src/lib/code-host/github/reviews")) };

let prState: { state: "open" | "closed"; merged?: boolean } = { state: "closed", merged: true };
let pushAccess = true;
const posted: Array<{ prNumber: number; body: string }> = [];
const runStarts: number[] = [];

mock.module("../src/lib/code-host/github/reviews", () => ({
  ...realReviews,
  GitHubReviewsClient: class {
    async getPullRequest(_owner: string, _repo: string, prNumber: number) {
      return {
        number: prNumber,
        title: "Old PR",
        body: null,
        ...prState,
        html_url: `https://github.com/acme/widgets/pull/${prNumber}`,
        head: { ref: "feature/old", sha: "abc" },
        base: { ref: "main", sha: "def" },
      };
    }
    async getBotUsername() {
      return "devintern-ai[bot]";
    }
    async userHasPushAccessOrThrow() {
      return pushAccess;
    }
    async postPullRequestComment(_o: string, _r: string, prNumber: number, body: string) {
      posted.push({ prNumber, body });
    }
    async getPullRequestReviewComments(_o: string, _r: string, prNumber: number) {
      // First call of a real review run.
      runStarts.push(prNumber);
      return [];
    }
  },
}));

const { WebhookQueue } = await import("../src/lib/state/webhook-queue");
const { processIssueCommentWithPersistence } = await import("../src/lib/webhook/review-pipeline");
const { DEFAULT_CONFIG, runtime } = await import("../src/lib/webhook/runtime");

afterAll(() => {
  mock.module("../src/lib/code-host/github/reviews", () => ({ ...realReviews }));
});

function commentEvent(id: number, body: string): IssueCommentEvent {
  const user = { login: "maintainer", id: 1, avatar_url: "", type: "User" as const };
  const repository = {
    id: 1,
    name: "widgets",
    full_name: "acme/widgets",
    private: false,
    owner: { ...user, login: "acme" },
    html_url: "https://github.com/acme/widgets",
    default_branch: "main",
  };
  return {
    action: "created",
    issue: {
      number: 599,
      title: "Old PR",
      state: "closed",
      user,
      pull_request: { url: "", html_url: "" },
    },
    comment: { id, body, user, html_url: "", created_at: "2026-11-27T09:00:00Z" },
    repository,
    sender: user,
  };
}

describe("webhook mention on a closed PR", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webhook-closed-pr-"));
    runtime.queue = new WebhookQueue({ dbPath: join(dir, "queue.db") });
    prState = { state: "closed", merged: true };
    pushAccess = true;
    posted.length = 0;
    runStarts.length = 0;
  });

  afterEach(() => {
    runtime.queue?.close();
    runtime.queue = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a mention on a merged PR posts one reply, starts no run, and settles the delivery", async () => {
    const queue = runtime.queue!;
    expect(queue.beginDelivery("github", "d-1")).toBe("started");
    await processIssueCommentWithPersistence(
      undefined,
      commentEvent(1, "@devintern-ai one more fix please"),
      DEFAULT_CONFIG,
      { source: "github", externalId: "d-1" },
    );
    expect(runStarts).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.prNumber).toBe(599);
    expect(posted[0]!.body).toContain("already merged");
    // A redelivery of the same webhook is acknowledged as a duplicate.
    expect(queue.beginDelivery("github", "d-1")).toBe("handled");
  });

  test("a closed (unmerged) PR says closed", async () => {
    prState = { state: "closed", merged: false };
    await processIssueCommentWithPersistence(
      undefined,
      commentEvent(2, "@devintern-ai rebase"),
      DEFAULT_CONFIG,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("already closed");
  });

  test("a comment without a mention, or from a user without push access, posts nothing", async () => {
    await processIssueCommentWithPersistence(
      undefined,
      commentEvent(3, "thanks @someone-else"),
      DEFAULT_CONFIG,
    );
    pushAccess = false;
    await processIssueCommentWithPersistence(
      undefined,
      commentEvent(4, "@devintern-ai fix"),
      DEFAULT_CONFIG,
    );
    expect(posted).toEqual([]);
    expect(runStarts).toEqual([]);
  });
});
