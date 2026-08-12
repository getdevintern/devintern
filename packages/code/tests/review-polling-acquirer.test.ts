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
    prEtagHit?: boolean;
    reviews: PolledReview[];
    reviewsEtagHit?: boolean;
    comments: PolledComment[];
    seenSince?: string;
    seenPrEtag?: string;
    seenReviewsEtag?: string;
  }

  function makeAcquirer(gh: FakeGitHubState) {
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
              head: gh.headSha ? { sha: gh.headSha } : undefined,
              base: gh.baseSha ? { sha: gh.baseSha } : undefined,
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
      },
      addressPr: async (repo, n) => {
        addressed.push(`${repo}#${n}`);
        return true;
      },
      resolveConflicts: async (repo, n) => {
        resolved.push(`${repo}#${n}`);
        return true;
      },
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
    expect(gh.seenPrEtag).toBe('W/"pr-1"');
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

  test("a conflicting PR triggers one conflict resolution, deduped per SHA pair", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "dirty",
      headSha: "head1",
      baseSha: "base1",
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

  test("clean and unknown merge states do not trigger conflict resolution", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "clean",
      headSha: "head1",
      baseSha: "base1",
      reviews: [],
      comments: [],
    };
    const { acquirer, resolved } = makeAcquirer(gh);
    await acquirer.tick();

    gh.mergeableState = undefined;
    await acquirer.tick();
    expect(resolved).toEqual([]);
  });
});
