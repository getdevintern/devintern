import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  ReviewPollingAcquirer,
  runResolveConflictsViaCli,
} from "../src/lib/review-polling-acquirer";
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
    comparisonCalls?: number;
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
          gh.comparisonCalls = (gh.comparisonCalls ?? 0) + 1;
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
    expect(gh.seenPrEtag).toBe('W/"pr-1"');
    expect(gh.seenReviewsEtag).toBe('W/"rev-1"');
  });

  test("removes PR and comparison caches when a watched PR closes", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "clean",
      headSha: "head1",
      baseSha: "base1",
      baseIncluded: true,
      reviews: [],
      comments: [],
    };
    const { acquirer } = makeAcquirer(gh);

    await acquirer.tick();
    expect(gh.comparisonCalls).toBe(1);

    gh.prState = "closed";
    await acquirer.tick();
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    gh.prState = "open";
    gh.seenPrEtag = "not-fetched";
    await acquirer.tick();

    expect(gh.seenPrEtag).toBeUndefined();
    expect(gh.comparisonCalls).toBe(2);
  });

  test("retains only the current comparison pair for each PR", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "clean",
      headSha: "head1",
      baseSha: "base1",
      baseIncluded: true,
      reviews: [],
      comments: [],
    };
    const { acquirer } = makeAcquirer(gh);

    await acquirer.tick();
    gh.baseSha = "base2";
    await acquirer.tick();
    gh.baseSha = "base1";
    await acquirer.tick();

    expect(gh.comparisonCalls).toBe(3);
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
    expect(gh.comparisonCalls).toBe(1);

    // Same SHAs on the next tick: no second attempt.
    await acquirer.tick();
    expect(resolved).toHaveLength(1);
    expect(gh.comparisonCalls).toBe(1);

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

  test("a failed base comparison does not prevent addressing new review feedback", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const addressed: string[] = [];
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      github: {
        async fetchPr() {
          return {
            data: {
              state: "open",
              mergeable_state: "dirty",
              head: {
                sha: "head1",
                ref: "agent/task",
                repo: { full_name: "acme/widgets" },
              },
              base: { sha: "base1", ref: "main" },
            },
            notModified: false,
          };
        },
        async fetchReviews() {
          return {
            data: [{ id: 1, state: "changes_requested", user: human }],
            notModified: false,
          };
        },
        async fetchReviewCommentsSince() {
          return [];
        },
        async isBaseIncluded() {
          throw new Error("compare unavailable");
        },
      },
      addressPr: async (repo, n) => {
        addressed.push(`${repo}#${n}`);
        return true;
      },
      resolveConflicts: async () => ({ outcome: "clean", message: "merged" }),
    });

    await acquirer.tick();

    expect(addressed).toEqual(["acme/widgets#42"]);
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

  test("a base advancing during the quiet period supersedes the old pending event", async () => {
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
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1")?.status).toBe("pending");

    now += 5_000;
    gh.baseSha = "base2";
    await made.acquirer.tick();

    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1")).toBeNull();
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base2")?.status).toBe("pending");
    expect(made.resolved).toEqual([]);
  });

  test("resolver-detected movement before push defers without consuming an attempt", async () => {
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
        resolveResults: [{ outcome: "deferred", message: "PR head changed before push" }],
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

describe("runResolveConflictsViaCli", () => {
  test("uses a bounded dedicated result channel", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "devintern-resolve-result-"));
    const fixture = join(testDir, "resolver-fixture.ts");
    writeFileSync(
      fixture,
      `import { writeSync } from "fs";
const behavior = process.env.RESULT_BEHAVIOR;
const fd = Number(process.env.DEVINTERN_RESULT_FD);
if (behavior === "large") process.stdout.write("x".repeat(2 * 1024 * 1024));
if (behavior === "spoof") console.log('DEVINTERN_RESOLVE_RESULT={"outcome":"failed","message":"spoof"}');
if (behavior === "malformed") writeSync(fd, "not-json\\n");
if (behavior !== "malformed" && behavior !== "deferred-fallback") {
  const outcome = behavior === "deferred" ? "deferred" : "clean";
  writeSync(fd, JSON.stringify({ outcome, message: behavior }) + "\\n");
}
process.exitCode = behavior === "deferred" || behavior === "deferred-fallback" ? 2 : behavior === "malformed" ? 1 : 0;
`,
    );

    const run = (behavior: string, prNumber: number) =>
      runResolveConflictsViaCli("acme/widgets", prNumber, {
        entrypoint: fixture,
        outputStdio: "ignore",
        env: { ...process.env, RESULT_BEHAVIOR: behavior },
      });

    try {
      expect(await run("deferred", 1)).toEqual({ outcome: "deferred", message: "deferred" });
      expect(await run("deferred-fallback", 2)).toEqual({
        outcome: "deferred",
        message: "resolver deferred",
      });
      expect((await run("large", 3)).outcome).toBe("clean");
      expect((await run("spoof", 4)).outcome).toBe("clean");
      expect(await run("malformed", 5)).toEqual({
        outcome: "failed",
        message: "resolver exited with code 1",
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
