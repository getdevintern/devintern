import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  assertAgentSandboxForTeamPrSync,
  isTeamAuthor,
  OPEN_PR_LIST_PAGE_SIZE,
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
    draft?: boolean;
    authorAssociation?: string;
    headSha?: string;
    baseSha?: string;
    baseIncluded?: boolean | null;
    prEtagHit?: boolean;
    listEtagHit?: boolean;
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
      allowedRepos?: string[];
      syncTeamPrsRepos?: string[];
      openPrs?: Array<{ number: number; draft?: boolean; author_association?: string }>;
    } = {},
  ) {
    const addressed: string[] = [];
    const resolved: string[] = [];
    const listCalls: Array<string | undefined> = [];
    const openPrs = options.openPrs;
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
              draft: gh.draft,
              author_association: gh.authorAssociation,
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
        ...(openPrs
          ? {
              async listOpenPullRequests(
                _repo: string,
                etag?: string,
              ): Promise<
                ConditionalResult<
                  Array<{ number: number; draft?: boolean; author_association?: string }>
                >
              > {
                listCalls.push(etag);
                if (gh.listEtagHit) {
                  return { data: null, etag, notModified: true };
                }
                return { data: openPrs, etag: 'W/"list-1"', notModified: false };
              },
            }
          : {}),
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
      allowedRepos: options.allowedRepos,
      syncTeamPrsRepos: options.syncTeamPrsRepos,
    });
    return { acquirer, addressed, resolved, listCalls };
  }

  const human = { login: "reviewer", type: "User" };
  const bot = { login: "devintern[bot]", type: "Bot" };
  const dirtyState = (): FakeGitHubState => ({
    prState: "open",
    mergeableState: "dirty",
    authorAssociation: "MEMBER",
    headSha: "head1",
    baseSha: "base1",
    reviews: [],
    comments: [],
  });

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

  test("clears the PR cache when a watched PR closes so re-watching hydrates fresh", async () => {
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
    expect(gh.seenPrEtag).toBeUndefined();

    gh.prState = "closed";
    await acquirer.tick();
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    gh.prState = "open";
    gh.seenPrEtag = "not-fetched";
    await acquirer.tick();

    expect(gh.seenPrEtag).toBeUndefined();
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

  test("every conflicting watched PR is synced in the same tick, not just one", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 2 });
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 3 });

    const resolved: string[] = [];
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      quietPeriodSeconds: 0,
      workerState,
      queue,
      github: {
        async fetchPr(_repo, n) {
          return {
            data: {
              state: "open",
              // All three conflict with their base; a stale API-reported
              // base SHA must not make any of them look "already included".
              mergeable_state: "dirty",
              head: {
                sha: `head${n}`,
                ref: "agent/task",
                repo: { full_name: "acme/widgets" },
              },
              base: { sha: "stale-base-sha", ref: "main" },
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
      },
      addressPr: async () => true,
      resolveConflicts: async (_repo, n) => {
        resolved.push(`acme/widgets#${n}`);
        return { outcome: "resolved", message: "pushed" };
      },
    });

    await acquirer.tick();

    expect(resolved.sort()).toEqual(["acme/widgets#1", "acme/widgets#2", "acme/widgets#3"]);
  });

  test("clean or unknown mergeability does not trigger; dirty and behind do", async () => {
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
    const { acquirer, resolved } = makeAcquirer(gh);
    await acquirer.tick();
    expect(resolved).toEqual([]);

    // GitHub recomputing after a push: wait.
    gh.mergeableState = "unknown";
    await acquirer.tick();
    expect(resolved).toEqual([]);

    gh.mergeableState = "behind";
    await acquirer.tick();
    expect(resolved).toEqual(["acme/widgets#42"]);
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
      },
      addressPr: async () => true,
      resolveConflicts: async (repo, n) => {
        resolved.push(`${repo}#${n}`);
        return { outcome: "clean", message: "merged" };
      },
    });
    await acquirer.tick();
    expect(resolved).toEqual([]);
    expect(queue.hasProcessed("github:base-sync", "base-sync:acme/widgets#42:base1:head1")).toBe(
      true,
    );
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
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")?.attempts).toBe(1);

    // Reopening all stores models a worker restart; attempts must survive.
    workerState.close();
    queue.close();
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath, maxRetries: 2 });
    made = makeAcquirer(gh, { resolveResults: failures });
    await made.acquirer.tick();
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(1);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")?.attempts).toBe(2);
    expect(queue.hasProcessed("github:base-sync", "base-sync:acme/widgets#42:base1:head1")).toBe(
      true,
    );
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
    // A moved head supersedes the old pending event with a fresh one.
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")).toBeNull();
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head2")?.attempts).toBe(0);
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
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")?.status).toBe("pending");

    now += 5_000;
    gh.baseSha = "base2";
    await made.acquirer.tick();

    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")).toBeNull();
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base2:head1")?.status).toBe("pending");
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
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")?.attempts).toBe(0);
    expect(queue.hasProcessed("github:base-sync", "base-sync:acme/widgets#42:base1:head1")).toBe(
      false,
    );
  });

  test("repeated defers eventually exhaust the event instead of retrying forever", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "behind",
      headSha: "head1",
      baseSha: "base1",
      baseIncluded: false,
      reviews: [],
      comments: [],
    };
    const made = makeAcquirer(gh, {
      resolveResults: [
        { outcome: "deferred", message: "stale sha one" },
        { outcome: "deferred", message: "stale sha two" },
        { outcome: "deferred", message: "stale sha three" },
        { outcome: "clean", message: "must not run" },
      ],
    });

    await made.acquirer.tick();
    await made.acquirer.tick();
    expect(queue.hasProcessed("github:base-sync", "base-sync:acme/widgets#42:base1:head1")).toBe(
      false,
    );

    // Third consecutive defer exhausts the event terminally.
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(3);
    expect(queue.hasProcessed("github:base-sync", "base-sync:acme/widgets#42:base1:head1")).toBe(
      true,
    );
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")?.status).toBe("failed");

    // A terminal defer means later ticks do not re-run the resolver at all.
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(3);

    // The base moving again opens a fresh event.
    gh.baseSha = "base2";
    await made.acquirer.tick();
    expect(made.resolved).toEqual([
      "acme/widgets#42",
      "acme/widgets#42",
      "acme/widgets#42",
      "acme/widgets#42",
    ]);
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
      },
      addressPr: async () => true,
      resolveConflicts: async (repo, n) => {
        resolved.push(`${repo}#${n}`);
        return { outcome: "clean", message: "merged" };
      },
    });
    await acquirer.tick();
    expect(resolved).toEqual([]);
    // The head race observed a new head; the stale event was superseded and
    // the fresh one stays pending without consuming an attempt.
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")).toBeNull();
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head2")?.attempts).toBe(0);
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

  test("start() unwatches open rows for repos outside allowedRepos", async () => {
    workerState.recordAgentPr({ repo: "getdevintern/devintern", prNumber: 45 });
    workerState.recordAgentPr({ repo: "danii1/devintern", prNumber: 199 });
    const { acquirer, addressed } = makeAcquirer(
      { prState: "open", reviews: [], comments: [] },
      { allowedRepos: ["getdevintern/devintern"] },
    );

    await acquirer.start();
    acquirer.stop();
    expect(addressed).toEqual([]);
    expect(workerState.listOpenAgentPrs().map((pr) => `${pr.repo}#${pr.prNumber}`)).toEqual([
      "getdevintern/devintern#45",
    ]);
  });

  test("tick skips foreign repos when allowedRepos is set", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    workerState.recordAgentPr({ repo: "danii1/devintern", prNumber: 199 });
    const { acquirer, addressed } = makeAcquirer(
      {
        prState: "open",
        reviews: [{ id: 1, state: "changes_requested", user: human }],
        comments: [],
      },
      { allowedRepos: ["acme/widgets"] },
    );

    await acquirer.tick();
    expect(addressed).toEqual(["acme/widgets#42"]);
  });

  test("foreign open PRs are not synced by default (WORKER_BASE_SYNC_TEAM_PRS off)", async () => {
    const gh = dirtyState();
    const made = makeAcquirer(gh, {
      openPrs: [{ number: 7, author_association: "MEMBER" }],
      allowedRepos: ["acme/widgets"],
    });

    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);
    // Discovery never runs when the feature is off.
    expect(made.listCalls).toEqual([]);
  });

  test("enabled: foreign open PRs are synced but their feedback is never addressed", async () => {
    const gh = dirtyState();
    gh.reviews = [{ id: 1, state: "changes_requested", user: human }];
    const made = makeAcquirer(gh, {
      syncTeamPrsRepos: ["acme/widgets"],
      openPrs: [{ number: 7, author_association: "MEMBER" }],
      allowedRepos: ["acme/widgets"],
    });

    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#7"]);
    expect(made.addressed).toEqual([]);
    // First discovery hydrates unconditionally.
    expect(made.listCalls).toEqual([undefined]);

    // Next tick reuses the list ETag and dedupes by base/head SHA.
    await made.acquirer.tick();
    expect(made.listCalls).toEqual([undefined, 'W/"list-1"']);
    expect(made.resolved).toHaveLength(1);

    // A moved base opens a fresh event for the foreign PR too.
    gh.baseSha = "base2";
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(2);
  });

  test("enabled: a 304 open-PR list reuses the previously hydrated item set", async () => {
    const gh = dirtyState();
    const made = makeAcquirer(gh, {
      syncTeamPrsRepos: ["acme/widgets"],
      openPrs: [{ number: 12, author_association: "MEMBER" }],
      allowedRepos: ["acme/widgets"],
    });
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#12"]);

    // Unchanged list: the conditional request 304s (rate-limit-free), and
    // the cached item set keeps driving per-PR base-sync polling.
    gh.listEtagHit = true;
    await made.acquirer.tick();
    expect(made.listCalls).toEqual([undefined, 'W/"list-1"']);
    expect(made.resolved).toHaveLength(1);

    // Still 304-ing, a moved base on the cached foreign PR resolves again.
    gh.baseSha = "base2";
    await made.acquirer.tick();
    expect(made.listCalls).toEqual([undefined, 'W/"list-1"', 'W/"list-1"']);
    expect(made.resolved).toEqual(["acme/widgets#12", "acme/widgets#12"]);
  });

  test("enabled: restart hydration refetches the open-PR list despite a stored ETag", async () => {
    // A previous process persisted the list ETag; the fresh acquirer's
    // in-memory item cache is empty, so the first sweep must fetch
    // unconditionally instead of trusting the stale ETag.
    workerState.setCursor("github:open-prs:acme/widgets", "state", 'W/"list-stale"');
    const made = makeAcquirer(dirtyState(), {
      syncTeamPrsRepos: ["acme/widgets"],
      openPrs: [{ number: 13, author_association: "MEMBER" }],
      allowedRepos: ["acme/widgets"],
    });

    await made.acquirer.tick();
    expect(made.listCalls).toEqual([undefined]);
    expect(made.resolved).toEqual(["acme/widgets#13"]);

    // Later ticks reuse the refreshed ETag.
    await made.acquirer.tick();
    expect(made.listCalls).toEqual([undefined, 'W/"list-1"']);
  });

  test("enabled: the agent's own PRs are polled once even when listed as open", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const made = makeAcquirer(dirtyState(), {
      syncTeamPrsRepos: ["acme/widgets"],
      openPrs: [
        { number: 42, author_association: "MEMBER" },
        { number: 43, author_association: "MEMBER" },
      ],
      allowedRepos: ["acme/widgets"],
    });

    await made.acquirer.tick();
    expect([...made.resolved].sort()).toEqual(["acme/widgets#42", "acme/widgets#43"]);
  });

  test("enabled: draft PRs are excluded from sync at discovery and per-PR polling", async () => {
    const gh = dirtyState();
    const made = makeAcquirer(gh, {
      syncTeamPrsRepos: ["acme/widgets"],
      openPrs: [
        { number: 8, draft: true, author_association: "MEMBER" },
        { number: 9, author_association: "MEMBER" },
      ],
      allowedRepos: ["acme/widgets"],
    });
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#9"]);

    // A PR that looks ready in the list but is a draft per-PR is skipped too.
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
              draft: true,
              head: { sha: "head1", ref: "feature", repo: { full_name: "acme/widgets" } },
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
        async listOpenPullRequests() {
          return { data: [{ number: 10, author_association: "MEMBER" }], notModified: false };
        },
      },
      addressPr: async () => true,
      resolveConflicts: async (repo, n) => {
        resolved.push(`${repo}#${n}`);
        return { outcome: "clean", message: "merged" };
      },
      syncTeamPrsRepos: ["acme/widgets"],
    });
    await acquirer.tick();
    expect(resolved).toEqual([]);
  });

  test("enabled: a closed foreign PR stops being polled and leaves the watch list", async () => {
    const gh = dirtyState();
    const openPrs = [{ number: 11, author_association: "MEMBER" }];
    const made = makeAcquirer(gh, {
      syncTeamPrsRepos: ["acme/widgets"],
      openPrs,
      allowedRepos: ["acme/widgets"],
    });
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(1);

    // Merged while a stale open list still shows it: per-PR polling stops at
    // the closed state — no new sync attempt even though the base moved on.
    gh.baseSha = "base2";
    gh.prState = "closed";
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(1);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#11:base2:head1")).toBeNull();

    // Gone from the refreshed open list: nothing further happens.
    openPrs.length = 0;
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(1);
  });

  test("enabled: a foreign fork PR is terminally skipped without invoking the resolver", async () => {
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
              author_association: "MEMBER",
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
        async listOpenPullRequests() {
          return { data: [{ number: 77, author_association: "MEMBER" }], notModified: false };
        },
      },
      addressPr: async () => true,
      resolveConflicts: async (repo, n) => {
        resolved.push(`${repo}#${n}`);
        return { outcome: "clean", message: "merged" };
      },
      syncTeamPrsRepos: ["acme/widgets"],
      allowedRepos: ["acme/widgets"],
    });
    await acquirer.tick();
    expect(resolved).toEqual([]);
    expect(queue.hasProcessed("github:base-sync", "base-sync:acme/widgets#77:base1:head1")).toBe(
      true,
    );
  });

  test("enabled without list support degrades to own-PR syncing only", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const made = makeAcquirer(dirtyState(), { syncTeamPrsRepos: ["acme/widgets"] });

    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#42"]);
  });

  test("foreign sync attempts are recorded as conflict_resolution runs", async () => {
    const gh = dirtyState();
    const runStore = new RunStore(dbPath);
    const made = makeAcquirer(gh, {
      syncTeamPrsRepos: ["acme/widgets"],
      openPrs: [{ number: 9, author_association: "MEMBER" }],
      allowedRepos: ["acme/widgets"],
      runStore,
    });

    await made.acquirer.tick();
    const [run] = runStore.listRuns();
    expect(run).toMatchObject({
      origin: "conflict_resolution",
      repo: "acme/widgets",
      prNumber: 9,
      status: "succeeded",
    });
    runStore.close();
  });

  test("enabled: PRs from outside authors are never discovered for sync", async () => {
    const gh = dirtyState();
    const made = makeAcquirer(gh, {
      syncTeamPrsRepos: ["acme/widgets"],
      openPrs: [
        { number: 20, author_association: "NONE" },
        { number: 21, author_association: "FIRST_TIME_CONTRIBUTOR" },
        { number: 22, author_association: "CONTRIBUTOR" },
        { number: 23, author_association: undefined },
        { number: 24, author_association: "COLLABORATOR" },
        { number: 25, author_association: "MAINTAIN" },
        { number: 26, author_association: "OWNER" },
      ],
      allowedRepos: ["acme/widgets"],
    });

    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#24", "acme/widgets#25", "acme/widgets#26"]);
  });

  test("enabled: the fresh per-PR author wins over a stale team-authored list entry", async () => {
    const gh = dirtyState();
    const made = makeAcquirer(gh, {
      syncTeamPrsRepos: ["acme/widgets"],
      openPrs: [{ number: 30, author_association: "MEMBER" }],
      allowedRepos: ["acme/widgets"],
    });

    // Eligible at first sight.
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#30"]);

    // Author association downgraded (e.g. collaborator access revoked):
    // the per-PR payload gates even when the cached list entry says MEMBER,
    // and a moved base does not open a new sync event.
    gh.authorAssociation = "NONE";
    gh.baseSha = "base2";
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#30"]);
  });

  test("team-PR base sync refuses to start without AGENT_SANDBOX", () => {
    const prev = process.env.AGENT_SANDBOX;
    try {
      delete process.env.AGENT_SANDBOX;
      expect(() => assertAgentSandboxForTeamPrSync()).toThrow(/AGENT_SANDBOX/);
      process.env.AGENT_SANDBOX = "none";
      expect(() => assertAgentSandboxForTeamPrSync()).toThrow(/AGENT_SANDBOX/);
      process.env.AGENT_SANDBOX = "docker";
      expect(() => assertAgentSandboxForTeamPrSync()).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.AGENT_SANDBOX;
      else process.env.AGENT_SANDBOX = prev;
    }
  });

  test("isTeamAuthor accepts GitHub's team associations case-insensitively", () => {
    expect(isTeamAuthor("MEMBER")).toBe(true);
    expect(isTeamAuthor("collaborator")).toBe(true);
    expect(isTeamAuthor("Maintain")).toBe(true);
    expect(isTeamAuthor("OWNER")).toBe(true);
    expect(isTeamAuthor("CONTRIBUTOR")).toBe(false);
    expect(isTeamAuthor("NONE")).toBe(false);
    expect(isTeamAuthor(undefined)).toBe(false);
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
if (behavior === "hang") setInterval(() => {}, 60_000);
if (behavior !== "malformed" && behavior !== "deferred-fallback" && behavior !== "hang") {
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

      // A hung subprocess is killed at the configured budget.
      const hung = await Promise.race([
        runResolveConflictsViaCli("acme/widgets", 6, {
          entrypoint: fixture,
          outputStdio: "ignore",
          timeoutMs: 300,
          env: { ...process.env, RESULT_BEHAVIOR: "hang" },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout not enforced")), 15_000),
        ),
      ]);
      expect(hung.outcome).toBe("failed");
      expect(hung.message).toContain("timed out");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
