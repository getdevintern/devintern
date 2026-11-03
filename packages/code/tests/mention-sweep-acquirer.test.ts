import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  MentionSweepAcquirer,
  botMentionAliases,
  botMentionCandidates,
  extractPrNumber,
  mentionsBot,
} from "../src/lib/acquirers/mention-sweep";
import type { SweptComment, SweptPrInfo } from "../src/lib/acquirers/mention-sweep";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";

describe("mentionsBot", () => {
  test("matches the full bot login", () => {
    expect(mentionsBot("hey @devintern[bot] fix this", "devintern[bot]")).toBe(true);
  });

  test("matches the bare name without the [bot] suffix", () => {
    expect(mentionsBot("hey @devintern fix this", "devintern[bot]")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(mentionsBot("@DevIntern please", "devintern[bot]")).toBe(true);
  });

  test("does not match other mentions or empty bodies", () => {
    expect(mentionsBot("@someoneelse fix this", "devintern[bot]")).toBe(false);
    expect(mentionsBot(null, "devintern[bot]")).toBe(false);
  });
});

describe("bot mention aliases", () => {
  const ALIAS_ENV = "GITHUB_BOT_ALIASES";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ALIAS_ENV];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ALIAS_ENV];
    } else {
      process.env[ALIAS_ENV] = saved;
    }
  });

  test("parses a comma-separated list and ignores blanks", () => {
    process.env[ALIAS_ENV] = "devintern-ai, devintern-internal [bot] ,,";
    expect(botMentionAliases()).toEqual(["devintern-ai", "devintern-internal [bot]"]);
  });

  test("returns empty without the env var", () => {
    delete process.env[ALIAS_ENV];
    expect(botMentionAliases()).toEqual([]);
  });

  test("candidates dedupe the resolved login with aliases", () => {
    process.env[ALIAS_ENV] = "devintern-ai,devintern[bot]";
    expect(botMentionCandidates("devintern[bot]")).toEqual(["devintern[bot]", "devintern-ai"]);
    expect(botMentionCandidates(null)).toEqual(["devintern-ai", "devintern[bot]"]);
  });

  test("aliases make the sweep work without resolvable App auth", async () => {
    process.env[ALIAS_ENV] = "devintern-ai";
    const dbPath = join(
      tmpdir(),
      `ms-alias-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const workerState = new WorkerState(dbPath);
    const queue = new WebhookQueue({ dbPath });
    const handled: Array<{ id: number; prNumber: number }> = [];
    const acquirer = new MentionSweepAcquirer({
      repo: "acme/widgets",
      intervalSeconds: 60,
      workerState,
      queue,
      github: {
        fetchIssueCommentsSince: async () => [
          {
            id: 7,
            body: "@devintern-ai relying on local envs is fragile",
            user: { login: "reviewer", type: "User" },
            created_at: new Date(Date.now() + 60_000).toISOString(),
            html_url: "https://github.com/acme/widgets/pull/5#issuecomment-7",
            issue_url: "https://api.github.com/repos/acme/widgets/issues/5",
          },
        ],
        fetchReviewCommentsSince: async () => [],
        getBotUsername: async () => null, // no App credentials locally
        getPr: async (prNumber) => ({ number: prNumber, state: "open" }),
        postComment: async () => {},
      },
      handleMention: async (c, prNumber) => {
        handled.push({ id: c.id, prNumber });
        return true;
      },
    });

    try {
      await acquirer.tick();
      expect(handled).toEqual([{ id: 7, prNumber: 5 }]);
    } finally {
      workerState.close();
      queue.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${dbPath}${suffix}`, { force: true });
      }
    }
  });
});

describe("extractPrNumber", () => {
  const base: Omit<SweptComment, "issue_url" | "pull_request_url"> = {
    id: 1,
    body: "x",
    user: { login: "u", type: "User" },
    created_at: "2026-07-03T10:00:00Z",
    html_url: "",
  };

  test("resolves from pull_request_url", () => {
    expect(
      extractPrNumber({
        ...base,
        pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/17",
      }),
    ).toBe(17);
  });

  test("resolves from issue_url", () => {
    expect(
      extractPrNumber({
        ...base,
        issue_url: "https://api.github.com/repos/acme/widgets/issues/23",
      }),
    ).toBe(23);
  });

  test("returns null without a URL", () => {
    expect(extractPrNumber({ ...base })).toBeNull();
  });
});

describe("MentionSweepAcquirer", () => {
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;

  beforeEach(() => {
    dbPath = join(tmpdir(), `ms-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function comment(overrides: Partial<SweptComment>): SweptComment {
    return {
      id: 1,
      body: "@devintern fix this",
      user: { login: "reviewer", type: "User" },
      created_at: new Date(Date.now() + 60_000).toISOString(), // after initial cursor
      html_url: "https://github.com/acme/widgets/pull/5#issuecomment-1",
      issue_url: "https://api.github.com/repos/acme/widgets/issues/5",
      ...overrides,
    };
  }

  function makeAcquirer(options: {
    issueComments?: SweptComment[];
    reviewComments?: SweptComment[];
    botName?: string | null;
    pr?: Partial<SweptPrInfo>;
    shouldPollFeedback?: () => boolean;
    feedbackFallbackIntervalSeconds?: number;
    feedbackMaxAttempts?: number;
    onMention?: (id: number) => Promise<boolean | "deferred" | "skipped" | "interrupted">;
  }) {
    const handled: Array<{ id: number; prNumber: number }> = [];
    const posted: string[] = [];
    const acquirer = new MentionSweepAcquirer({
      repo: "acme/widgets",
      intervalSeconds: 60,
      shouldPollFeedback: options.shouldPollFeedback,
      feedbackFallbackIntervalSeconds: options.feedbackFallbackIntervalSeconds,
      feedbackMaxAttempts: options.feedbackMaxAttempts,
      workerState,
      queue,
      github: {
        fetchIssueCommentsSince: async () => options.issueComments ?? [],
        fetchReviewCommentsSince: async () => options.reviewComments ?? [],
        getBotUsername: async () =>
          options.botName === undefined ? "devintern[bot]" : options.botName,
        getPr: async (prNumber) => ({
          number: prNumber,
          state: "open",
          headRepoFullName: "acme/widgets",
          ...options.pr,
        }),
        postComment: async (_n, body) => {
          posted.push(body);
        },
      },
      handleMention: async (c, prNumber) => {
        handled.push({ id: c.id, prNumber });
        return options.onMention ? options.onMention(c.id) : true;
      },
    });
    return { acquirer, handled, posted };
  }

  test("a mention on a PR is handled once and deduped on later ticks", async () => {
    const { acquirer, handled } = makeAcquirer({ issueComments: [comment({})] });

    await acquirer.tick();
    await acquirer.tick();
    expect(handled).toEqual([{ id: 1, prNumber: 5 }]);
  });

  test("an interrupted mention releases its claim and retries on the next sweep", async () => {
    const commentAt = new Date(Date.now() + 60_000).toISOString();
    const outcomes: Array<"interrupted" | "deferred" | true> = ["interrupted", true];
    const { acquirer, handled } = makeAcquirer({
      issueComments: [comment({ created_at: commentAt })],
      onMention: async () => outcomes.shift() ?? true,
    });

    await acquirer.tick();
    expect(handled).toHaveLength(1);
    // A shutdown drain killed the run: the comment must not stay handled, and
    // the cursor must not move past it.
    expect(queue.hasProcessed("github:mentions", "comment:1")).toBe(false);
    expect(
      workerState.getCursor("github:mention:issuecomments:acme/widgets")?.cursorValue,
    ).not.toBe(commentAt);

    // The next sweep re-fetches and runs the mention normally.
    await acquirer.tick();
    expect(handled).toHaveLength(2);
    expect(queue.hasProcessed("github:mentions", "comment:1")).toBe(true);
    expect(workerState.getCursor("github:mention:issuecomments:acme/widgets")?.cursorValue).toBe(
      commentAt,
    );
  });

  test("a deferred mention releases its claim and retries on the next sweep", async () => {
    const commentAt = new Date(Date.now() + 60_000).toISOString();
    const outcomes: Array<"interrupted" | "deferred" | true> = ["deferred", true];
    const { acquirer, handled } = makeAcquirer({
      issueComments: [comment({ created_at: commentAt })],
      onMention: async () => outcomes.shift() ?? true,
    });

    await acquirer.tick();
    expect(handled).toHaveLength(1);
    expect(queue.hasProcessed("github:mentions", "comment:1")).toBe(false);
    expect(
      workerState.getCursor("github:mention:issuecomments:acme/widgets")?.cursorValue,
    ).not.toBe(commentAt);

    await acquirer.tick();
    expect(handled).toHaveLength(2);
    expect(queue.hasProcessed("github:mentions", "comment:1")).toBe(true);
    expect(workerState.getCursor("github:mention:issuecomments:acme/widgets")?.cursorValue).toBe(
      commentAt,
    );
  });

  test("a thrown mention handler releases its claim and retries on the next sweep", async () => {
    const commentAt = new Date(Date.now() + 60_000).toISOString();
    let calls = 0;
    const { acquirer, handled } = makeAcquirer({
      issueComments: [comment({ created_at: commentAt })],
      feedbackMaxAttempts: 3,
      onMention: async () => {
        calls++;
        if (calls < 3) throw new Error("GitHub API error (403): rate limited");
        return true;
      },
    });

    await acquirer.tick();
    expect(calls).toBe(1);
    expect(handled).toHaveLength(1);
    // A throw is not proof the mention was addressed: release the claim and
    // hold the cursor so the next sweep retries it instead of dropping it.
    expect(queue.hasProcessed("github:mentions", "comment:1")).toBe(false);
    expect(
      workerState.getCursor("github:mention:issuecomments:acme/widgets")?.cursorValue,
    ).not.toBe(commentAt);

    await acquirer.tick();
    expect(calls).toBe(2);
    expect(queue.hasProcessed("github:mentions", "comment:1")).toBe(false);

    await acquirer.tick();
    expect(calls).toBe(3);
    expect(handled).toHaveLength(3);
    expect(queue.hasProcessed("github:mentions", "comment:1")).toBe(true);
    expect(workerState.getCursor("github:mention:issuecomments:acme/widgets")?.cursorValue).toBe(
      commentAt,
    );
  });

  test("a mention that keeps throwing becomes terminal after its budget", async () => {
    const commentAt = new Date(Date.now() + 60_000).toISOString();
    let calls = 0;
    const { acquirer } = makeAcquirer({
      issueComments: [comment({ created_at: commentAt })],
      feedbackMaxAttempts: 2,
      onMention: async () => {
        calls++;
        throw new Error("GitHub API error (403): forbidden");
      },
    });

    await acquirer.tick();
    expect(calls).toBe(1);
    expect(queue.hasProcessed("github:mentions", "comment:1")).toBe(false);

    await acquirer.tick();
    expect(calls).toBe(2);
    expect(queue.hasProcessed("github:mentions", "comment:1")).toBe(true);
    expect(workerState.getCursor("github:mention:issuecomments:acme/widgets")?.cursorValue).toBe(
      commentAt,
    );

    // Terminal feedback is not retried on a later sweep.
    await acquirer.tick();
    expect(calls).toBe(2);
  });

  test("healthy relay suppresses mention polling between safety sweeps", async () => {
    const { acquirer, handled } = makeAcquirer({
      issueComments: [comment({})],
      shouldPollFeedback: () => false,
    });

    await acquirer.tick();
    expect(handled).toEqual([]);
  });

  test("periodic fallback still sweeps mentions while relay is healthy", async () => {
    const { acquirer, handled } = makeAcquirer({
      issueComments: [comment({})],
      shouldPollFeedback: () => false,
      feedbackFallbackIntervalSeconds: 0,
    });

    await acquirer.tick();
    expect(handled).toEqual([{ id: 1, prNumber: 5 }]);
  });

  test("comments without a mention or from bots are ignored", async () => {
    const { acquirer, handled } = makeAcquirer({
      issueComments: [
        comment({ id: 1, body: "no mention here" }),
        comment({ id: 2, user: { login: "devintern[bot]", type: "Bot" } }),
      ],
    });

    await acquirer.tick();
    expect(handled).toEqual([]);
  });

  test("review-comment feed mentions resolve the PR from pull_request_url", async () => {
    const { acquirer, handled } = makeAcquirer({
      reviewComments: [
        comment({
          id: 3,
          issue_url: undefined,
          pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/9",
        }),
      ],
    });

    await acquirer.tick();
    expect(handled).toEqual([{ id: 3, prNumber: 9 }]);
  });

  test("closed PRs are skipped", async () => {
    const { acquirer, handled } = makeAcquirer({
      issueComments: [comment({})],
      pr: { state: "closed" },
    });

    await acquirer.tick();
    expect(handled).toEqual([]);
  });

  test("fork PRs without maintainer_can_modify are skipped with a comment", async () => {
    const { acquirer, handled, posted } = makeAcquirer({
      issueComments: [comment({})],
      pr: { headRepoFullName: "contributor/widgets", maintainerCanModify: false },
    });

    await acquirer.tick();
    expect(handled).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Allow edits by maintainers");
  });

  test("fork PRs with maintainer_can_modify are handled", async () => {
    const { acquirer, handled } = makeAcquirer({
      issueComments: [comment({})],
      pr: { headRepoFullName: "contributor/widgets", maintainerCanModify: true },
    });

    await acquirer.tick();
    expect(handled).toEqual([{ id: 1, prNumber: 5 }]);
  });

  test("sweep is dormant when no bot username is resolvable", async () => {
    const { acquirer, handled } = makeAcquirer({
      issueComments: [comment({})],
      botName: null,
    });

    await acquirer.tick();
    expect(handled).toEqual([]);
  });

  test("cursors advance past swept comments", async () => {
    const createdAt = new Date(Date.now() + 120_000).toISOString();
    const { acquirer } = makeAcquirer({
      issueComments: [comment({ created_at: createdAt, body: "not a mention" })],
    });

    await acquirer.tick();
    expect(workerState.getCursor("github:mention:issuecomments:acme/widgets")?.cursorValue).toBe(
      createdAt,
    );
  });
});
