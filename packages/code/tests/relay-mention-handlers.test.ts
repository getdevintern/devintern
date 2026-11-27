import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { TaskExecutionResult } from "../src/lib/acquirers/task-polling";
import { createRelayMentionHandlers } from "../src/lib/relay/mention-handlers";
import type { RelayMentionGitHub, RelayMentionItem } from "../src/lib/relay/mention-handlers";
import type { MentionKind } from "../src/lib/review/mention-trigger";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { createFleetMentionHandler } from "../src/lib/workspace/fleet-events";
import type { FleetEventDeps } from "../src/lib/workspace/fleet-events";

type Review = RelayMentionItem & { submitted_at?: string | null };

describe("relay mention handlers", () => {
  let dir: string;
  let queue: WebhookQueue;
  let savedAliases: string | undefined;
  let comments: Record<number, RelayMentionItem>;
  let reviews: Review[];
  let reviewComments: Record<number, RelayMentionItem[]>;
  let handled: Array<{ repo: string; id: number; pr: number; kind: MentionKind }>;
  let outcome: TaskExecutionResult;

  const github: RelayMentionGitHub = {
    getIssueComment: async (id) => comments[id] ?? null,
    listReviews: async () => reviews,
    listReviewComments: async (_pr, reviewId) => reviewComments[reviewId] ?? [],
    getBotUsername: async () => null,
  };

  const handlers = () =>
    createRelayMentionHandlers({
      github: () => github,
      queue,
      handleMention: async (repo, comment, pr, kind) => {
        handled.push({ repo, id: comment.id, pr, kind });
        return outcome;
      },
      now: () => Date.parse("2026-11-26T10:05:00Z"),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-mentions-"));
    queue = new WebhookQueue({ dbPath: join(dir, "queue.db") });
    savedAliases = process.env.GITHUB_BOT_ALIASES;
    process.env.GITHUB_BOT_ALIASES = "devintern-ai";
    comments = {};
    reviews = [];
    reviewComments = {};
    handled = [];
    outcome = true;
  });

  afterEach(() => {
    queue.close();
    if (savedAliases === undefined) delete process.env.GITHUB_BOT_ALIASES;
    else process.env.GITHUB_BOT_ALIASES = savedAliases;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a conversation-comment mention runs once with its id and kind", async () => {
    comments[501] = {
      id: 501,
      body: "@devintern-ai please add a line",
      user: { login: "danii1", type: "User" },
    };
    const { handlePrComment } = handlers();
    expect(await handlePrComment("acme/e2e", 47, 501)).toBe(true);
    expect(handled).toEqual([{ repo: "acme/e2e", id: 501, pr: 47, kind: "issue_comment" }]);
    // Shared with the mention sweep's dedupe ids.
    expect(queue.hasProcessed("github:mentions", "comment:501")).toBe(true);
    expect(await handlePrComment("acme/e2e", 47, 501)).toBe("skipped");
    expect(handled).toHaveLength(1);
  });

  test("a mention on a merged PR replies once across redeliveries and starts no run", async () => {
    const posted: Array<{ pr: number; body: string }> = [];
    const runs: number[] = [];
    const fleetHandler = createFleetMentionHandler(
      {
        userHasPushAccess: async () => true,
        closedPrMentions: {
          getPrState: async () => ({ state: "closed", merged: true }),
          postPrComment: async (_slug: string, pr: number, body: string) => {
            posted.push({ pr, body });
          },
        },
      } as unknown as FleetEventDeps,
      async (_slug, pr) => {
        runs.push(pr);
        return true;
      },
    );
    const { handlePrComment } = createRelayMentionHandlers({
      github: () => github,
      queue,
      handleMention: fleetHandler,
    });
    comments[701] = { id: 701, body: "@devintern-ai one more fix", user: { login: "danii1" } };
    comments[702] = { id: 702, body: "thanks, merged", user: { login: "danii1" } };

    expect(await handlePrComment("acme/e2e", 599, 701)).toBe("skipped");
    expect(await handlePrComment("acme/e2e", 599, 701)).toBe("skipped");
    expect(await handlePrComment("acme/e2e", 599, 702)).toBe("skipped");
    expect(runs).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ pr: 599 });
    expect(posted[0].body).toContain("already merged");
    // The sweep shares this id, so it will not reply a second time.
    expect(queue.hasProcessed("github:mentions", "comment:701")).toBe(true);
  });

  test("comments without a mention, deleted, or bot-authored are skipped", async () => {
    comments[1] = { id: 1, body: "lgtm", user: { login: "danii1" } };
    comments[2] = { id: 2, body: "@devintern-ai done", user: { login: "x[bot]", type: "Bot" } };
    const { handlePrComment } = handlers();
    expect(await handlePrComment("acme/e2e", 47, 1)).toBe("skipped");
    expect(await handlePrComment("acme/e2e", 47, 2)).toBe("skipped");
    expect(await handlePrComment("acme/e2e", 47, 3)).toBe("skipped");
    expect(handled).toEqual([]);
  });

  test("a deferred run is not recorded, so a redelivery retries it", async () => {
    comments[9] = { id: 9, body: "@devintern-ai go", user: { login: "danii1" } };
    const { handlePrComment } = handlers();
    outcome = "deferred";
    expect(await handlePrComment("acme/e2e", 47, 9)).toBe("deferred");
    expect(queue.hasProcessed("github:mentions", "comment:9")).toBe(false);
    outcome = true;
    expect(await handlePrComment("acme/e2e", 47, 9)).toBe(true);
    expect(handled).toHaveLength(2);
  });

  test("a review whose body mentions the bot is handled as a review mention", async () => {
    reviews = [
      {
        id: 77,
        body: "@devintern-ai please add a second line",
        user: { login: "danii1" },
        submitted_at: "2026-11-26T10:00:00Z",
      },
    ];
    const { handlePrReview } = handlers();
    expect(await handlePrReview("acme/e2e", 47, "2026-11-26T10:00:00Z")).toBe(true);
    expect(handled).toEqual([{ repo: "acme/e2e", id: 77, pr: 47, kind: "review" }]);
    expect(queue.hasProcessed("github:mentions", "review:77")).toBe(true);
    // Redelivery or the sweep: already handled.
    expect(await handlePrReview("acme/e2e", 47, "2026-11-26T10:00:00Z")).toBe("skipped");
    expect(handled).toHaveLength(1);
  });

  test("a review whose line comment mentions the bot is handled too", async () => {
    reviews = [
      { id: 78, body: "", user: { login: "danii1" }, submitted_at: "2026-11-26T10:00:00Z" },
    ];
    reviewComments[78] = [{ id: 4, body: "@devintern-ai rename", user: { login: "danii1" } }];
    expect(await handlers().handlePrReview("acme/e2e", 47, "2026-11-26T10:00:00Z")).toBe(true);
    expect(handled).toEqual([{ repo: "acme/e2e", id: 78, pr: 47, kind: "review" }]);
    expect(queue.hasProcessed("github:mentions", "comment:4")).toBe(true);
  });

  test("a review without a mention on a human PR stays ignored", async () => {
    reviews = [
      {
        id: 79,
        body: "please fix this",
        user: { login: "danii1" },
        submitted_at: "2026-11-26T10:00:00Z",
      },
    ];
    expect(await handlers().handlePrReview("acme/e2e", 47, "2026-11-26T10:00:00Z")).toBe("skipped");
    expect(handled).toEqual([]);
  });

  test("bot-authored and older reviews are not acted on", async () => {
    reviews = [
      {
        id: 80,
        body: "@devintern-ai summary",
        user: { login: "devintern-ai[bot]", type: "Bot" },
        submitted_at: "2026-11-26T10:00:00Z",
      },
      {
        id: 81,
        body: "@devintern-ai old ask",
        user: { login: "danii1" },
        submitted_at: "2026-11-20T10:00:00Z",
      },
    ];
    expect(await handlers().handlePrReview("acme/e2e", 47, "2026-11-26T10:00:00Z")).toBe("skipped");
    expect(handled).toEqual([]);
  });
});
