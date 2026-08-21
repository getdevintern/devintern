import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { ReviewPollingAcquirer } from "../src/lib/review-polling-acquirer";
import type {
  ConditionalResult,
  PolledComment,
  PolledPr,
  PolledReview,
} from "../src/lib/review-polling-acquirer";
import { WebhookQueue } from "../src/lib/webhook-queue";
import { RunStore } from "../src/lib/run-recorder";
import { WorkerState } from "../src/lib/worker-state";

describe("ReviewPollingAcquirer", () => {
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;

  beforeEach(() => {
    dbPath = join(tmpdir(), `rp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

  interface FakeGitHubState {
    prState: string;
    mergeableState?: string;
    headSha?: string;
    baseSha?: string;
    baseIncluded?: boolean | null;
    prEtagHit?: boolean;
    reviews: PolledReview[];
    reviewsEtagHit?: boolean;
    comments: PolledComment[];
    seenSince?: string;
    seenPrEtag?: string;
    seenReviewsEtag?: string;
  }

  function makeAcquirer(
    gh: FakeGitHubState,
    options: {
      resolveResults?: Array<{
        outcome: "clean" | "resolved" | "skipped" | "failed" | "deferred";
        message: string;
      }>;
      runStore?: RunStore;
      quietPeriodSeconds?: number;
      now?: () => number;
    } = {},
  ) {
    const addressed: string[] = [];
    const resolved: string[] = [];
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      github: {
        async fetchPr(_repo, _n, etag): Promise<ConditionalResult<PolledPr>> {
          gh.seenPrEtag = etag;
          if (gh.prEtagHit) {
            return { data: null, etag, notModified: true };
          }
          return {
            data: {
              state: gh.prState,
              mergeable_state: gh.mergeableState,
              head: gh.headSha
                ? { sha: gh.headSha, ref: "agent/task", repo: { full_name: "acme/widgets" } }
                : undefined,
              base: gh.baseSha ? { sha: gh.baseSha, ref: "main" } : undefined,
            },
            etag: 'W/"pr-1"',
            notModified: false,
          };
        },
        async fetchReviews(_repo, _n, etag): Promise<ConditionalResult<PolledReview[]>> {
          gh.seenReviewsEtag = etag;
          if (gh.reviewsEtagHit) {
            return { data: null, etag, notModified: true };
          }
          return { data: gh.reviews, etag: 'W/"rev-1"', notModified: false };
        },
        async fetchReviewCommentsSince(_repo, _n, sinceIso) {
          gh.seenSince = sinceIso;
          return gh.comments;
        },
        async isBaseIncluded() {
          return gh.baseIncluded ?? true;
        },
      },
      addressPr: async (repo, n) => {
        addressed.push(`${repo}#${n}`);
        return true;
      },
      resolveConflicts: async (repo, n) => {
        resolved.push(`${repo}#${n}`);
        return options.resolveResults?.shift() ?? { outcome: "clean", message: "merged" };
      },
      quietPeriodSeconds: options.quietPeriodSeconds ?? 0,
      runStore: options.runStore,
      now: options.now,
    });
    return { acquirer, addressed, resolved };
  }

  const human = { login: "reviewer", type: "User" };
  const bot = { login: "devintern[bot]", type: "Bot" };

  test("a new human changes_requested review triggers one address run", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const { acquirer, addressed } = makeAcquirer({
      prState: "open",
      reviews: [{ id: 1, state: "changes_requested", user: human }],
      comments: [],
    });

    await acquirer.tick();
    expect(addressed).toEqual(["acme/widgets#42"]);

    // Same review on the next tick is deduped.
    await acquirer.tick();
    expect(addressed).toEqual(["acme/widgets#42"]);
  });

  test("approved and bot reviews do not trigger", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const { acquirer, addressed } = makeAcquirer({
      prState: "open",
      reviews: [
        { id: 1, state: "approved", user: human },
        { id: 2, state: "changes_requested", user: bot },
      ],
      comments: [],
    });

    await acquirer.tick();
    expect(addressed).toEqual([]);
  });

  test("new human inline comments trigger and advance the since cursor", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    // Must postdate the PR's watchedSince (recorded at Date.now() above):
    // older comments are treated as already seen.
    const commentAt = new Date(Date.now() + 60_000).toISOString();
    const gh: FakeGitHubState = {
      prState: "open",
      reviews: [],
      comments: [{ id: 10, user: human, created_at: commentAt }],
    };
    const { acquirer, addressed } = makeAcquirer(gh);

    await acquirer.tick();
    expect(addressed).toEqual(["acme/widgets#42"]);
    expect(workerState.getCursor("github:prcomments:acme/widgets#42")?.cursorValue).toBe(commentAt);

    // Next tick queries from the advanced cursor.
    gh.comments = [];
    await acquirer.tick();
    expect(gh.seenSince).toBe(commentAt);
    expect(addressed).toHaveLength(1);
  });

  test("bot comments advance the cursor but do not trigger", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const commentAt = new Date(Date.now() + 60_000).toISOString();
    const { acquirer, addressed } = makeAcquirer({
      prState: "open",
      reviews: [],
      comments: [{ id: 11, user: bot, created_at: commentAt }],
    });

    await acquirer.tick();
    expect(addressed).toEqual([]);
    expect(workerState.getCursor("github:prcomments:acme/widgets#42")?.cursorValue).toBe(commentAt);
  });

  test("a closed PR is unwatched and skips further polling", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const { acquirer, addressed } = makeAcquirer({
      prState: "closed",
      reviews: [{ id: 1, state: "changes_requested", user: human }],
      comments: [],
    });

    await acquirer.tick();
    expect(addressed).toEqual([]);
    expect(workerState.listOpenAgentPrs()).toHaveLength(0);
  });

  test("stored ETags are sent on subsequent ticks and 304 skips review parsing", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = { prState: "open", reviews: [], comments: [] };
    const { acquirer } = makeAcquirer(gh);

    await acquirer.tick();
    expect(gh.seenPrEtag).toBeUndefined();

    gh.prEtagHit = true;
    gh.reviewsEtagHit = true;
    await acquirer.tick();
    expect(gh.seenPrEtag).toBeUndefined();
    expect(gh.seenReviewsEtag).toBe('W/"rev-1"');
  });

  test("multiple new signals on one PR trigger a single address run per tick", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const commentAt = new Date(Date.now() + 60_000).toISOString();
    const { acquirer, addressed } = makeAcquirer({
      prState: "open",
      reviews: [
        { id: 1, state: "changes_requested", user: human },
        { id: 2, state: "changes_requested", user: { login: "other", type: "User" } },
      ],
      comments: [{ id: 10, user: human, created_at: commentAt }],
    });

    await acquirer.tick();
    expect(addressed).toEqual(["acme/widgets#42"]);
  });

  test("one PR failing does not stop polling the others", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 2 });

    const addressed: string[] = [];
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      github: {
        async fetchPr(_repo, n) {
          if (n === 1) {
            throw new Error("boom");
          }
          return { data: { state: "open" }, notModified: false };
        },
        async fetchReviews() {
          return {
            data: [{ id: 5, state: "changes_requested", user: human }],
            notModified: false,
          };
        },
        async fetchReviewCommentsSince() {
          return [];
        },
      },
      addressPr: async (repo, n) => {
        addressed.push(`${repo}#${n}`);
        return true;
      },
    });

    await acquirer.tick();
    expect(addressed).toEqual(["acme/widgets#2"]);
  });

  test("a conflicting PR triggers one conflict resolution, deduped by base SHA", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "dirty",
      headSha: "head1",
      baseSha: "base1",
      baseIncluded: false,
      reviews: [],
      comments: [],
    };
    const { acquirer, resolved } = makeAcquirer(gh);

    await acquirer.tick();
    expect(resolved).toEqual(["acme/widgets#42"]);

    // Same SHAs on the next tick: no second attempt.
    await acquirer.tick();
    expect(resolved).toHaveLength(1);

    // Base moved again while still conflicting: retry.
    gh.baseSha = "base2";
    await acquirer.tick();
    expect(resolved).toHaveLength(2);
  });

  test("a cleanly-behind PR triggers while unknown mergeability defers", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "clean",
      headSha: "head1",
      baseSha: "base1",
      baseIncluded: false,
      reviews: [],
      comments: [],
    };
    const { acquirer, resolved } = makeAcquirer(gh);
    await acquirer.tick();

    expect(resolved).toEqual(["acme/widgets#42"]);

    gh.baseSha = "base2";
    gh.mergeableState = undefined;
    await acquirer.tick();
    expect(resolved).toHaveLength(1);
  });

  test("a head that already contains the base does not trigger", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const { acquirer, resolved } = makeAcquirer({
      prState: "open",
      mergeableState: "clean",
      headSha: "head1",
      baseSha: "base1",
      baseIncluded: true,
      reviews: [],
      comments: [],
    });
    await acquirer.tick();
    expect(resolved).toEqual([]);
  });

  test("a fork PR is terminally skipped without invoking the resolver", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const resolved: string[] = [];
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      quietPeriodSeconds: 0,
      workerState,
      queue,
      github: {
        async fetchPr() {
          return {
            data: {
              state: "open",
              mergeable_state: "dirty",
              head: { sha: "head1", ref: "feature", repo: { full_name: "contrib/widgets" } },
              base: { sha: "base1", ref: "main" },
            },
            notModified: false,
          };
        },
        async fetchReviews() {
          return { data: [], notModified: false };
        },
        async fetchReviewCommentsSince() {
          return [];
        },
        async isBaseIncluded() {
          return false;
        },
      },
      addressPr: async () => true,
      resolveConflicts: async (repo, n) => {
        resolved.push(`${repo}#${n}`);
        return { outcome: "clean", message: "merged" };
      },
    });
    await acquirer.tick();
    expect(resolved).toEqual([]);
    expect(queue.hasProcessed("github:base-sync", "base-sync:acme/widgets#42:base1")).toBe(true);
  });

  test("failed attempts persist across restart and stop at the configured limit", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    queue.close();
    queue = new WebhookQueue({ dbPath, maxRetries: 2 });
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "dirty",
      headSha: "head1",
      baseSha: "base1",
      baseIncluded: false,
      reviews: [],
      comments: [],
    };
    const failures = [
      { outcome: "failed" as const, message: "network" },
      { outcome: "failed" as const, message: "agent" },
      { outcome: "clean" as const, message: "must not run" },
    ];
    let made = makeAcquirer(gh, { resolveResults: failures });
    await made.acquirer.tick();
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1")?.attempts).toBe(1);

    // Reopening all stores models a worker restart; attempts must survive.
    workerState.close();
    queue.close();
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath, maxRetries: 2 });
    made = makeAcquirer(gh, { resolveResults: failures });
    await made.acquirer.tick();
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(1);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1")?.attempts).toBe(2);
    expect(queue.hasProcessed("github:base-sync", "base-sync:acme/widgets#42:base1")).toBe(true);
  });

  test("recent and changing heads defer without consuming attempts", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let now = 10_000;
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "behind",
      headSha: "head1",
      baseSha: "base1",
      baseIncluded: false,
      reviews: [],
      comments: [],
    };
    const made = makeAcquirer(gh, { quietPeriodSeconds: 10, now: () => now });
    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);

    now += 11_000;
    gh.headSha = "head2";
    await made.acquirer.tick();
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1")?.attempts).toBe(0);
    expect(made.resolved).toEqual([]);

    now += 11_000;
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#42"]);
  });

  test("resolver-detected concurrent movement defers without consuming an attempt", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const made = makeAcquirer(
      {
        prState: "open",
        mergeableState: "behind",
        headSha: "head1",
        baseSha: "base1",
        baseIncluded: false,
        reviews: [],
        comments: [],
      },
      {
        resolveResults: [{ outcome: "deferred", message: "PR head changed before execution" }],
      },
    );
    await made.acquirer.tick();
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1")?.attempts).toBe(0);
    expect(queue.hasProcessed("github:base-sync", "base-sync:acme/widgets#42:base1")).toBe(false);
  });

  test("a head race during pre-run revalidation stays pending without an attempt", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let fetches = 0;
    const resolved: string[] = [];
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      quietPeriodSeconds: 0,
      workerState,
      queue,
      github: {
        async fetchPr() {
          fetches += 1;
          return {
            data: {
              state: "open",
              mergeable_state: "dirty",
              head: {
                sha: fetches === 1 ? "head1" : "head2",
                ref: "agent/task",
                repo: { full_name: "acme/widgets" },
              },
              base: { sha: "base1", ref: "main" },
            },
            notModified: false,
          };
        },
        async fetchReviews() {
          return { data: [], notModified: false };
        },
        async fetchReviewCommentsSince() {
          return [];
        },
        async isBaseIncluded() {
          return false;
        },
      },
      addressPr: async () => true,
      resolveConflicts: async (repo, n) => {
        resolved.push(`${repo}#${n}`);
        return { outcome: "clean", message: "merged" };
      },
    });
    await acquirer.tick();
    expect(resolved).toEqual([]);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1")?.attempts).toBe(0);
  });

  test("automatic attempts record origin, metadata, attempt, and terminal reason", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42, branch: "agent/task" });
    const runStore = new RunStore(dbPath);
    const made = makeAcquirer(
      {
        prState: "open",
        mergeableState: "behind",
        headSha: "head1",
        baseSha: "base1",
        baseIncluded: false,
        reviews: [],
        comments: [],
      },
      { runStore },
    );
    await made.acquirer.tick();
    const [run] = runStore.listRuns();
    expect(run).toMatchObject({
      origin: "conflict_resolution",
      repo: "acme/widgets",
      prNumber: 42,
      branch: "agent/task",
      attempt: 1,
      status: "succeeded",
      outcomeReason: "merged",
    });
    expect(run?.harness).toBeTruthy();
    runStore.close();
  });
});
