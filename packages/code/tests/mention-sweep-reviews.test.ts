import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { MentionSweepAcquirer, collectReviewsSince } from "../src/lib/acquirers/mention-sweep";
import type { MentionSweepGitHub, SweptComment } from "../src/lib/acquirers/mention-sweep";
import type { MentionKind } from "../src/lib/review/mention-trigger";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";

describe("mention sweep kinds and the reviews feed", () => {
  let dir: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;
  let savedAliases: string | undefined;
  let handled: Array<{ id: number; prNumber: number; kind: MentionKind }>;
  const later = () => new Date(Date.now() + 60_000).toISOString();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mention-sweep-reviews-"));
    const dbPath = join(dir, "queue.db");
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
    savedAliases = process.env.GITHUB_BOT_ALIASES;
    process.env.GITHUB_BOT_ALIASES = "devintern-ai";
    handled = [];
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    if (savedAliases === undefined) delete process.env.GITHUB_BOT_ALIASES;
    else process.env.GITHUB_BOT_ALIASES = savedAliases;
    rmSync(dir, { recursive: true, force: true });
  });

  const item = (overrides: Partial<SweptComment>): SweptComment => ({
    id: 1,
    body: "@devintern-ai please",
    user: { login: "danii1", type: "User" },
    created_at: later(),
    html_url: "",
    ...overrides,
  });

  const sweep = (github: Partial<MentionSweepGitHub>) =>
    new MentionSweepAcquirer({
      repo: "acme/e2e",
      intervalSeconds: 60,
      workerState,
      queue,
      github: {
        fetchIssueCommentsSince: async () => [],
        fetchReviewCommentsSince: async () => [],
        getBotUsername: async () => null,
        getPr: async (prNumber) => ({ number: prNumber, state: "open" }),
        postComment: async () => {},
        ...github,
      },
      handleMention: async (comment, prNumber, kind) => {
        handled.push({ id: comment.id, prNumber, kind });
        return true;
      },
    });

  test("each feed hands its mention kind to the pipeline", async () => {
    const acquirer = sweep({
      fetchIssueCommentsSince: async () => [
        item({ id: 10, issue_url: "https://api.github.com/repos/acme/e2e/issues/47" }),
      ],
      fetchReviewCommentsSince: async () => [
        item({ id: 11, pull_request_url: "https://api.github.com/repos/acme/e2e/pulls/47" }),
      ],
      fetchReviewsSince: async () => [
        item({ id: 12, pull_request_url: "https://api.github.com/repos/acme/e2e/pulls/47" }),
      ],
    });
    await acquirer.tick();
    expect(handled).toEqual([
      { id: 10, prNumber: 47, kind: "issue_comment" },
      { id: 11, prNumber: 47, kind: "review_comment" },
      { id: 12, prNumber: 47, kind: "review" },
    ]);
    expect(queue.hasProcessed("github:mentions", "review:12")).toBe(true);
  });

  test("reviews without a mention and bot-authored items are skipped", async () => {
    const acquirer = sweep({
      fetchIssueCommentsSince: async () => [
        item({
          id: 20,
          user: { login: "devintern-ai[bot]", type: "Bot" },
          issue_url: "https://api.github.com/repos/acme/e2e/issues/47",
        }),
        item({
          id: 21,
          body: "<!-- devintern:stack-blocked --> @devintern-ai",
          issue_url: "https://api.github.com/repos/acme/e2e/issues/47",
        }),
      ],
      fetchReviewsSince: async () => [
        item({
          id: 22,
          body: "please fix",
          pull_request_url: "https://api.github.com/repos/acme/e2e/pulls/47",
        }),
      ],
    });
    await acquirer.tick();
    expect(handled).toEqual([]);
  });

  test("a review mention handled by the relay is not swept again", async () => {
    queue.markProcessed("github:mentions", "review:30");
    const acquirer = sweep({
      fetchReviewsSince: async () => [
        item({ id: 30, pull_request_url: "https://api.github.com/repos/acme/e2e/pulls/47" }),
      ],
    });
    await acquirer.tick();
    expect(handled).toEqual([]);
  });

  test("collectReviewsSince reads reviews of open PRs updated since the cursor", async () => {
    const since = "2026-11-26T10:00:00Z";
    const listed: number[] = [];
    const items = await collectReviewsSince(
      {
        listOpenPrsByUpdated: async () => [
          { number: 47, updated_at: "2026-11-26T10:05:00Z", url: "https://api/x/pulls/47" },
          { number: 12, updated_at: "2026-11-01T00:00:00Z", url: "https://api/x/pulls/12" },
        ],
        listReviews: async (prNumber) => {
          listed.push(prNumber);
          return [
            {
              id: 2,
              body: "@devintern-ai new",
              user: { login: "danii1" },
              submitted_at: "2026-11-26T10:04:00Z",
            },
            {
              id: 1,
              body: "@devintern-ai old",
              user: { login: "danii1" },
              submitted_at: "2026-11-25T10:00:00Z",
            },
            { id: 3, body: "pending", user: { login: "danii1" }, submitted_at: null },
          ];
        },
      },
      since,
    );
    expect(listed).toEqual([47]);
    expect(items.map((review) => [review.id, review.pull_request_url])).toEqual([
      [2, "https://api/x/pulls/47"],
    ]);
  });
});
