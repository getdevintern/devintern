import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import { listNotifications } from "../src/lib/notifications/store";
import { baseSyncExhaustedGroupKey } from "../src/lib/notifications/base-sync";
import { NotificationEmitter } from "../src/lib/notifications/emitter";

import {
  baseSyncRetryBackoffMs,
  baseSyncReviveCooldownMs,
  OPEN_PR_LIST_PAGE_SIZE,
  ReviewPollingAcquirer,
  runResolveConflictsViaCli,
  teamPrStateCursorSource,
} from "../src/lib/acquirers/review-polling";
import type {
  AutomaticResolveResult,
  ConditionalResult,
  PolledComment,
  PolledPr,
  PolledPrListItem,
  PolledReview,
  ReviewPollingGitHub,
} from "../src/lib/acquirers/review-polling";
import type { CronOrIntervalSchedule } from "../src/lib/automation/config";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { RunStore } from "../src/lib/state/run-recorder";
import { WorkerState } from "../src/lib/state/worker-state";
import type { ConflictResolutionMode } from "../src/lib/workspace/config";
import { resetUnusableStateWarnings } from "../src/lib/review/agent-pr-reconciler";
import {
  getWorkerFailover,
  resetWorkerFailover,
  startWorkerFailover,
} from "../src/lib/worker/failover";

describe("ReviewPollingAcquirer", () => {
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;

  beforeEach(() => {
    resetUnusableStateWarnings();
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
    /** Base branch tip the fake reports (absent: the branch cannot be read). */
    baseTip?: string;
    branchTipFetches?: number;
  }

  function makeAcquirer(
    gh: FakeGitHubState,
    options: {
      resolveResults?: AutomaticResolveResult[];
      runStore?: RunStore;
      quietPeriodSeconds?: number;
      now?: () => number;
      allowedRepos?: string[];
      conflictSchedule?: CronOrIntervalSchedule;
      conflictWindowGraceMs?: number;
      conflictResolution?: ConflictResolutionMode;
      disableResolveConflicts?: boolean;
      resolveImpl?: (repo: string, prNumber: number) => Promise<AutomaticResolveResult>;
      shouldPollFeedback?: () => boolean;
      feedbackFallbackIntervalSeconds?: number;
    } = {},
  ) {
    const addressed: string[] = [];
    const resolved: string[] = [];
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      shouldPollFeedback: options.shouldPollFeedback,
      feedbackFallbackIntervalSeconds: options.feedbackFallbackIntervalSeconds,
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
        async fetchBranchHeadSha() {
          gh.branchTipFetches = (gh.branchTipFetches ?? 0) + 1;
          return gh.baseTip ?? null;
        },
      },
      addressPr: async (repo, n) => {
        addressed.push(`${repo}#${n}`);
        return true;
      },
      resolveConflicts: options.disableResolveConflicts
        ? undefined
        : options.resolveImpl
          ? options.resolveImpl
          : async (repo, n) => {
              resolved.push(`${repo}#${n}`);
              return options.resolveResults?.shift() ?? { outcome: "clean", message: "merged" };
            },
      quietPeriodSeconds: options.quietPeriodSeconds ?? 0,
      runStore: options.runStore,
      now: options.now,
      allowedRepos: options.allowedRepos,
      conflictSchedule: options.conflictSchedule,
      conflictWindowGraceMs: options.conflictWindowGraceMs,
      conflictResolution: options.conflictResolution,
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

  test("healthy relay suppresses feedback polling but not PR reconciliation", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      reviews: [{ id: 1, state: "changes_requested", user: human }],
      comments: [],
    };
    const { acquirer, addressed } = makeAcquirer(gh, {
      shouldPollFeedback: () => false,
    });

    await acquirer.tick();
    expect(gh.seenPrEtag).toBeUndefined();
    expect(gh.seenReviewsEtag).toBeUndefined();
    expect(addressed).toEqual([]);
  });

  test("periodic fallback still sweeps feedback while relay is healthy", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const { acquirer, addressed } = makeAcquirer(
      {
        prState: "open",
        reviews: [{ id: 1, state: "changes_requested", user: human }],
        comments: [],
      },
      { shouldPollFeedback: () => false, feedbackFallbackIntervalSeconds: 0 },
    );

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

  test("an unusable PR state keeps the row watched across ticks and warns once", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 77 });
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    const addressed: string[] = [];
    try {
      const acquirer = new ReviewPollingAcquirer({
        intervalSeconds: 60,
        workerState,
        queue,
        github: {
          async fetchPr() {
            return { data: {}, etag: 'W/"empty"', notModified: false };
          },
          async fetchReviews() {
            return { data: [], etag: 'W/"reviews"', notModified: false };
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
      await acquirer.tick();
    } finally {
      warn.mockRestore();
    }

    expect(workerState.listOpenAgentPrs().map((pr) => pr.prNumber)).toEqual([77]);
    expect(workerState.countAgentPrs()).toEqual({ open: 1, closed: 0 });
    expect(addressed).toEqual([]);
    expect(warnings.filter((message) => message.includes("unusable PR state"))).toHaveLength(1);
  });

  test("an unusable PR state defers feedback instead of marking it processed", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "draft",
      reviews: [{ id: 1, state: "changes_requested", user: human }],
      comments: [],
    };
    const { acquirer, addressed } = makeAcquirer(gh);

    await acquirer.tick();
    expect(addressed).toEqual([]);
    // The review must stay unprocessed so it is retried once state is usable.
    expect(queue.hasProcessed("github:reviews", "review:acme/widgets#42:1")).toBe(false);

    gh.prState = "open";
    await acquirer.tick();
    expect(addressed).toEqual(["acme/widgets#42"]);
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

  describe("background base syncs", () => {
    /** Three conflicting PRs whose resolutions block until released. */
    function makeBlockingAcquirer(maxConcurrentBaseSyncs?: number) {
      for (const prNumber of [1, 2, 3]) {
        workerState.recordAgentPr({ repo: "acme/widgets", prNumber });
      }
      const started: number[] = [];
      const release = new Map<number, () => void>();
      let polled = 0;
      const acquirer = new ReviewPollingAcquirer({
        intervalSeconds: 60,
        quietPeriodSeconds: 0,
        maxConcurrentBaseSyncs,
        workerState,
        queue,
        github: {
          async fetchPr(_repo, n) {
            polled++;
            return {
              data: {
                state: "open",
                mergeable_state: "dirty",
                head: {
                  sha: `head${n}`,
                  ref: `agent/task-${n}`,
                  repo: { full_name: "acme/widgets" },
                },
                base: { sha: "base-sha", ref: "main" },
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
        resolveConflicts: (_repo, n) => {
          started.push(n);
          return new Promise<AutomaticResolveResult>((resolve) => {
            release.set(n, () => resolve({ outcome: "resolved", message: "pushed" }));
          });
        },
      });
      return { acquirer, started, release, polledCount: () => polled };
    }

    test("a tick starts every conflicting PR's sync without waiting for the first", async () => {
      const { acquirer, started, release } = makeBlockingAcquirer(8);

      // Returns while all three resolutions are still running.
      await acquirer.tick();
      expect(started.sort()).toEqual([1, 2, 3]);

      for (const done of release.values()) done();
      await acquirer.waitForBaseSyncs();
      for (const n of [1, 2, 3]) {
        expect(
          queue.hasProcessed("github:base-sync", `base-sync:acme/widgets#${n}:base-sha:head${n}`),
        ).toBe(true);
      }
    });

    test("the limit caps running syncs and the rest start on later ticks", async () => {
      const { acquirer, started, release } = makeBlockingAcquirer(2);

      await acquirer.tick();
      expect(started.sort()).toEqual([1, 2]);

      // Still at the limit: nothing new starts, and running PRs are not restarted.
      await acquirer.tick();
      expect(started.sort()).toEqual([1, 2]);

      release.get(1)?.();
      await Bun.sleep(1); // let #1 settle and free its slot
      await acquirer.tick();
      expect(started.sort()).toEqual([1, 2, 3]);

      release.get(2)?.();
      release.get(3)?.();
      await acquirer.waitForBaseSyncs();
    });

    test("a running sync does not block polling the other PRs", async () => {
      const { acquirer, started, release, polledCount } = makeBlockingAcquirer(1);

      await acquirer.tick();
      expect(started).toEqual([1]);

      // The next tick polls every PR again while #1 is still resolving
      // (no pre-sync refetch: #1 is running and the limit is reached).
      const before = polledCount();
      await acquirer.tick();
      expect(polledCount() - before).toBe(3);
      expect(started).toEqual([1]);

      release.get(1)?.();
      await acquirer.waitForBaseSyncs();
    });
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

  test("an unknown or missing mergeability never clears a restart-exhaustion row", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = { ...conflictGh(), mergeableState: "unknown" };
    const { acquirer } = makeAcquirer(gh);
    await acquirer.tick();

    const writer = new Database(dbPath);
    try {
      new NotificationEmitter(writer).emit({
        kind: "escalated",
        severity: "high",
        groupKey: baseSyncExhaustedGroupKey("acme/widgets", 42),
        title: "Conflict resolution keeps getting cut off",
      });
    } finally {
      writer.close();
    }

    const unresolvedEscalations = (): number => {
      const reader = new Database(dbPath);
      try {
        return listNotifications(reader, {
          unresolved: true,
          includeMuted: true,
        }).notifications.filter((notification) => notification.kind === "escalated").length;
      } finally {
        reader.close();
      }
    };

    // GitHub is still recomputing: the PR may still conflict, so wait.
    await acquirer.tick();
    expect(unresolvedEscalations()).toBe(1);

    // A payload gap cannot prove the conflict is gone either.
    gh.mergeableState = undefined;
    await acquirer.tick();
    expect(unresolvedEscalations()).toBe(1);

    // Only a definitive verdict clears it.
    gh.mergeableState = "clean";
    await acquirer.tick();
    expect(unresolvedEscalations()).toBe(0);
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
    const eventKey = "base-sync:acme/widgets#42:base1:head1";
    try {
      const start = 1_750_000_000_000;
      setSystemTime(start);
      let made = makeAcquirer(gh, { resolveResults: failures });
      await made.acquirer.tick();
      expect(queue.getBaseSyncEvent(eventKey)?.attempts).toBe(1);

      // Reopening all stores models a worker restart; attempts and the
      // backoff anchor must survive.
      workerState.close();
      queue.close();
      workerState = new WorkerState(dbPath);
      queue = new WebhookQueue({ dbPath, maxRetries: 2 });
      made = makeAcquirer(gh, { resolveResults: failures });

      // Still inside the retry backoff window: nothing runs yet.
      setSystemTime(start + 5_000);
      await made.acquirer.tick();
      expect(made.resolved).toHaveLength(0);

      setSystemTime(start + 31_000);
      await made.acquirer.tick();
      // Second failure exhausts the configured limit of 2.
      expect(made.resolved).toHaveLength(1);
      expect(queue.getBaseSyncEvent(eventKey)?.attempts).toBe(2);
      expect(queue.hasProcessed("github:base-sync", eventKey)).toBe(true);

      setSystemTime(start + 120_000);
      await made.acquirer.tick();
      expect(made.resolved).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });

  test("an exhausted base sync gets one more attempt after its base branch moves", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    queue.close();
    queue = new WebhookQueue({ dbPath, maxRetries: 2 });
    // GitHub keeps reporting the PR's stale base.sha; only the branch tip moves.
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "dirty",
      headSha: "head1",
      baseSha: "base1",
      baseTip: "tipA",
      reviews: [],
      comments: [],
    };
    const results: AutomaticResolveResult[] = [
      { outcome: "failed", message: "worktree gone" },
      { outcome: "failed", message: "worktree gone" },
      { outcome: "failed", message: "still conflicting" },
      { outcome: "resolved", message: "pushed" },
    ];
    const eventKey = "base-sync:acme/widgets#42:base1:head1";
    const hour = 60 * 60_000;
    try {
      const start = 1_750_000_000_000;
      setSystemTime(start);
      const { acquirer, resolved } = makeAcquirer(gh, { resolveResults: results });
      await acquirer.tick();
      setSystemTime(start + 31_000);
      await acquirer.tick();
      expect(resolved).toHaveLength(2);
      expect(queue.hasProcessed("github:base-sync", eventKey)).toBe(true);
      const exhaustedAt = start + 31_000;

      // First sighting while exhausted only records the tip.
      setSystemTime(exhaustedAt + 60_000);
      await acquirer.tick();
      expect(resolved).toHaveLength(2);
      expect(queue.getBaseSyncEvent(eventKey)?.reviveBaseTip).toBe("tipA");

      // The base moves, but the 3-hour cooldown since the last failure has not passed.
      gh.baseTip = "tipB";
      setSystemTime(exhaustedAt + 2 * hour);
      await acquirer.tick();
      expect(resolved).toHaveLength(2);

      // After the cooldown: exactly one more attempt, which exhausts it again.
      setSystemTime(exhaustedAt + 3 * hour + 1_000);
      await acquirer.tick();
      await acquirer.waitForBaseSyncs();
      expect(resolved).toHaveLength(3);
      let event = queue.getBaseSyncEvent(eventKey);
      expect(event?.status).toBe("failed");
      expect(event?.revivals).toBe(1);
      expect(event?.reviveBaseTip).toBe("tipB");
      expect(queue.hasProcessed("github:base-sync", eventKey)).toBe(true);
      const secondFailureAt = exhaustedAt + 3 * hour + 1_000;

      // Same tip: no further attempts, however long it waits.
      setSystemTime(secondFailureAt + 30 * hour);
      await acquirer.tick();
      expect(resolved).toHaveLength(3);

      // A new tip after the doubled (6-hour) cooldown earns the next attempt.
      gh.baseTip = "tipC";
      await acquirer.tick();
      await acquirer.waitForBaseSyncs();
      expect(resolved).toHaveLength(4);
      event = queue.getBaseSyncEvent(eventKey);
      expect(event?.status).toBe("completed");

      // A completed event is never revived.
      gh.baseTip = "tipD";
      setSystemTime(secondFailureAt + 60 * hour);
      await acquirer.tick();
      expect(resolved).toHaveLength(4);
    } finally {
      setSystemTime();
    }
  });

  test("the revival cooldown doubles per revival and caps at a day", () => {
    const hour = 60 * 60_000;
    expect(baseSyncReviveCooldownMs(0)).toBe(3 * hour);
    expect(baseSyncReviveCooldownMs(1)).toBe(6 * hour);
    expect(baseSyncReviveCooldownMs(2)).toBe(12 * hour);
    expect(baseSyncReviveCooldownMs(3)).toBe(24 * hour);
    expect(baseSyncReviveCooldownMs(10)).toBe(24 * hour);
  });

  test("failed base-sync attempts wait out an exponential backoff before retrying", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const start = 1_750_000_000_000;
    try {
      setSystemTime(start);
      const gh: FakeGitHubState = {
        prState: "open",
        mergeableState: "dirty",
        headSha: "head1",
        baseSha: "base1",
        baseIncluded: false,
        reviews: [],
        comments: [],
      };
      const made = makeAcquirer(gh, {
        resolveResults: [
          { outcome: "failed", message: "boom" },
          { outcome: "clean", message: "second attempt" },
        ],
      });
      const eventKey = "base-sync:acme/widgets#42:base1:head1";

      await made.acquirer.tick();
      expect(made.resolved).toHaveLength(1);
      expect(queue.getBaseSyncEvent(eventKey)?.attempts).toBe(1);

      // A tick inside the 30s window after the failure is skipped entirely.
      setSystemTime(start + 5_000);
      await made.acquirer.tick();
      expect(made.resolved).toHaveLength(1);
      expect(queue.getBaseSyncEvent(eventKey)?.attempts).toBe(1);

      // Once the backoff has elapsed, the retry goes ahead.
      setSystemTime(start + 31_000);
      await made.acquirer.tick();
      expect(made.resolved).toHaveLength(2);
      expect(queue.getBaseSyncEvent(eventKey)?.status).toBe("completed");
    } finally {
      setSystemTime();
    }
  });

  test("orphaned base-sync attempts back off after each restart and stop at the cap", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    queue.close();
    queue = new WebhookQueue({ dbPath, maxRetries: 3 });
    const runStore = new RunStore(dbPath);
    const eventKey = "base-sync:acme/widgets#42:base1:head1";
    const start = 1_750_000_000_000;
    const gh: FakeGitHubState = {
      prState: "open",
      mergeableState: "dirty",
      headSha: "head1",
      baseSha: "base1",
      baseIncluded: false,
      reviews: [],
      comments: [],
    };
    let started = 0;
    const make = () =>
      makeAcquirer(gh, {
        runStore,
        resolveImpl: () => {
          started += 1;
          // The resolver never settles: the worker "dies" while it runs.
          return new Promise<AutomaticResolveResult>(() => {});
        },
      });
    try {
      setSystemTime(start);
      let made = make();
      await made.acquirer.tick();
      expect(started).toBe(1);

      let restartAt = start + 10 * 60_000;
      runStore.reapOrphanedRunIds({ maxRetries: 3, now: restartAt });
      let event = queue.getBaseSyncEvent(eventKey);
      expect(event?.status).toBe("pending");
      expect(event?.attempts).toBe(1);
      expect(event?.updatedAt).toBe(restartAt);

      // Inside the 30s backoff after the restart: no attempt yet.
      setSystemTime(restartAt + baseSyncRetryBackoffMs(1) - 1);
      made = make();
      await made.acquirer.tick();
      expect(started).toBe(1);

      // The backoff elapsed: attempt 2 starts, then dies with the worker.
      setSystemTime(restartAt + baseSyncRetryBackoffMs(1));
      made = make();
      await made.acquirer.tick();
      expect(started).toBe(2);
      let attemptStartedAt = restartAt + baseSyncRetryBackoffMs(1);
      restartAt = attemptStartedAt + 10 * 60_000;
      runStore.reapOrphanedRunIds({ maxRetries: 3, now: restartAt });
      event = queue.getBaseSyncEvent(eventKey);
      expect(event?.status).toBe("pending");
      expect(event?.attempts).toBe(2);
      expect(event?.updatedAt).toBe(restartAt);

      // The backoff doubles: still nothing inside 60s.
      setSystemTime(restartAt + baseSyncRetryBackoffMs(2) - 1);
      made = make();
      await made.acquirer.tick();
      expect(started).toBe(2);

      setSystemTime(restartAt + baseSyncRetryBackoffMs(2));
      made = make();
      await made.acquirer.tick();
      expect(started).toBe(3);
      attemptStartedAt = restartAt + baseSyncRetryBackoffMs(2);
      restartAt = attemptStartedAt + 10 * 60_000;
      runStore.reapOrphanedRunIds({ maxRetries: 3, now: restartAt });
      event = queue.getBaseSyncEvent(eventKey);
      expect(event?.status).toBe("failed");
      expect(event?.attempts).toBe(3);
      expect(queue.hasProcessed("github:base-sync", eventKey)).toBe(true);

      const latest = runStore.listRuns({ origin: "conflict_resolution" })[0];
      expect(latest?.outcomeReason).toContain(
        "conflict resolution keeps getting cut off by worker restarts",
      );

      // Exhausted: the cap stops further automatic attempts.
      setSystemTime(restartAt + 30 * 24 * 60 * 60_000);
      made = make();
      await made.acquirer.tick();
      expect(started).toBe(3);

      const reader = new Database(dbPath);
      try {
        const notifications = listNotifications(reader, { includeMuted: true }).notifications;
        const escalations = notifications.filter(
          (notification) => notification.kind === "escalated",
        );
        expect(escalations).toHaveLength(1);
        expect(escalations[0]?.title).toContain("acme/widgets#42");
      } finally {
        reader.close();
      }
    } finally {
      runStore.close();
      setSystemTime();
    }
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

  test("capacity defers wait for a harness instead of exhausting the event", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let clock = 1_000_000;
    const capacity: AutomaticResolveResult = {
      outcome: "deferred",
      message: "agent usage limit; waiting for a harness to become available",
      capacity: true,
    };
    const made = makeAcquirer(
      {
        prState: "open",
        mergeableState: "dirty",
        headSha: "head1",
        baseSha: "base1",
        baseIncluded: false,
        reviews: [],
        comments: [],
      },
      {
        now: () => clock,
        resolveResults: [
          { ...capacity, retryAt: clock + 60_000 },
          capacity,
          capacity,
          capacity,
          { outcome: "resolved", message: "merged base" },
        ],
      },
    );
    const externalId = "base-sync:acme/widgets#42:base1:head1";

    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(1);
    // Before the reported reset, the resolver is not relaunched.
    clock += 30_000;
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(1);

    // Past the cap of consecutive defers, the event stays pending and unprocessed.
    for (let i = 0; i < 3; i++) {
      clock += 6 * 60_000;
      await made.acquirer.tick();
    }
    expect(made.resolved).toHaveLength(4);
    expect(queue.getBaseSyncEvent(externalId)).toMatchObject({ status: "pending", attempts: 0 });
    expect(queue.hasProcessed("github:base-sync", externalId)).toBe(false);

    // Once a harness is back, the conflict is resolved.
    clock += 6 * 60_000;
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(5);
    expect(queue.getBaseSyncEvent(externalId)?.status).toBe("completed");
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
      prUrl: "https://github.com/acme/widgets/pull/42",
      branch: "agent/task",
      attempt: 1,
      status: "succeeded",
      outcomeReason: "merged",
    });
    expect(run?.harness).toBeTruthy();
    runStore.close();
  });

  test("a conflict run records the active failover harness, not the configured primary", async () => {
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "claude-code,codex",
      log: () => {},
    });
    try {
      const failover = getWorkerFailover()!;
      failover.reportFromHint({ untilMs: Date.now() + 60_000 }, "claude-code");
      expect(failover.activeName).toBe("codex");

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
      expect(runStore.listRuns()[0]?.harness).toBe("codex");
      runStore.close();
    } finally {
      resetWorkerFailover();
    }
  });

  const DAY_MS = 86_400_000;
  const dailySchedule: CronOrIntervalSchedule = { interval: "1d", intervalMs: DAY_MS };

  function conflictGh(): FakeGitHubState {
    return {
      prState: "open",
      mergeableState: "dirty",
      headSha: "head1",
      baseSha: "base1",
      reviews: [],
      comments: [],
    };
  }

  function windowState(): { nextWindowAt: number; windowOpenUntil: number; windowCapAt: number } {
    const raw = workerState.getCursor("worker:conflict-window")?.cursorValue;
    expect(raw).toBeTruthy();
    return JSON.parse(raw!);
  }

  test("scheduled mode queues conflicts without invoking the resolver before the window", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const start = 1_750_000_000_000;
    let now = start;
    const made = makeAcquirer(conflictGh(), {
      conflictSchedule: dailySchedule,
      conflictWindowGraceMs: 60 * 60_000,
      now: () => now,
    });

    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")?.status).toBe("pending");

    // Enabling scheduled mode only schedules the first window; nothing runs now.
    const state = windowState();
    expect(state.nextWindowAt).toBe(start + DAY_MS);
    expect(state.windowOpenUntil).toBe(0);
  });

  test("queued conflicts resolve when the window arrives and queue again after it closes", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let now = 1_750_000_000_000;
    const gh = conflictGh();
    const made = makeAcquirer(gh, {
      conflictSchedule: dailySchedule,
      conflictWindowGraceMs: 60 * 60_000,
      now: () => now,
    });
    const eventKey = "base-sync:acme/widgets#42:base1:head1";

    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);

    // The occurrence arrives: the queued conflict resolves in this tick.
    now += DAY_MS + 1;
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#42"]);
    expect(queue.getBaseSyncEvent(eventKey)?.status).toBe("completed");
    expect(windowState().nextWindowAt).toBe(now + DAY_MS);

    // A new conflict while the window's grace period is open resolves too.
    gh.baseSha = "base2";
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#42", "acme/widgets#42"]);

    // After the grace period closes, conflicts queue for the next window.
    now += 61 * 60_000;
    gh.baseSha = "base3";
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(2);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base3:head1")?.status).toBe("pending");
  });

  test("opening the window on demand resolves queued conflicts now and keeps the next occurrence", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const start = 1_750_000_000_000;
    let now = start;
    const made = makeAcquirer(conflictGh(), {
      conflictSchedule: dailySchedule,
      conflictWindowGraceMs: 60 * 60_000,
      now: () => now,
    });

    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);
    expect(made.acquirer.conflictWindowStatus()).toEqual({
      schedule: dailySchedule,
      nextWindowAt: start + DAY_MS,
      openUntil: undefined,
    });

    now += 5_000;
    expect(made.acquirer.openConflictWindowNow()).toEqual({ ok: true });
    expect(windowState()).toEqual({
      nextWindowAt: start + DAY_MS,
      windowOpenUntil: now + 60 * 60_000,
      windowCapAt: now + 120 * 60_000,
    });
    expect(made.acquirer.conflictWindowStatus()?.openUntil).toBe(now + 60 * 60_000);

    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#42"]);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")?.status).toBe(
      "completed",
    );
  });

  test("on-demand window is refused outside scheduled mode", () => {
    const auto = makeAcquirer(conflictGh());
    expect(auto.acquirer.conflictWindowStatus()).toBeNull();
    expect(auto.acquirer.openConflictWindowNow().ok).toBe(false);

    const disabled = makeAcquirer(conflictGh(), {
      conflictSchedule: dailySchedule,
      conflictResolution: "disabled",
    });
    expect(disabled.acquirer.conflictWindowStatus()).toBeNull();
    expect(disabled.acquirer.openConflictWindowNow()).toEqual({
      ok: false,
      reason: "conflict resolution is disabled in workspace.toml",
    });
  });

  test("a window missed while the worker was down catches up on the first tick after restart", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let now = 1_750_000_000_000;
    const gh = conflictGh();
    const made = makeAcquirer(gh, {
      conflictSchedule: dailySchedule,
      conflictWindowGraceMs: 60 * 60_000,
      now: () => now,
    });
    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);

    // Model a restart: a fresh acquirer over the same durable state, much later.
    now += 2 * DAY_MS;
    const restarted = makeAcquirer(gh, {
      conflictSchedule: dailySchedule,
      conflictWindowGraceMs: 60 * 60_000,
      now: () => now,
    });
    await restarted.acquirer.tick();
    expect(restarted.resolved).toEqual(["acme/widgets#42"]);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")?.status).toBe(
      "completed",
    );
  });

  test("a PR resolved manually never triggers the queued window run", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let now = 1_750_000_000_000;
    const gh = conflictGh();
    const made = makeAcquirer(gh, {
      conflictSchedule: dailySchedule,
      conflictWindowGraceMs: 60 * 60_000,
      now: () => now,
    });
    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);

    // Model an earlier restart loop that exhausted the automatic base sync.
    const writer = new Database(dbPath);
    try {
      new NotificationEmitter(writer, () => now).emit({
        kind: "escalated",
        severity: "high",
        groupKey: baseSyncExhaustedGroupKey("acme/widgets", 42),
        title: "Conflict resolution keeps getting cut off",
      });
      expect(
        listNotifications(writer, { unresolved: true, includeMuted: true }).notifications.filter(
          (notification) => notification.kind === "escalated",
        ),
      ).toHaveLength(1);
    } finally {
      writer.close();
    }

    // Someone (e.g. `devintern resolve-conflicts <pr-url>`) fixed it out of band.
    gh.mergeableState = "clean";
    now += DAY_MS + 1;
    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);

    const reader = new Database(dbPath);
    try {
      expect(
        listNotifications(reader, { unresolved: true, includeMuted: true }).notifications.filter(
          (notification) => notification.kind === "escalated",
        ),
      ).toHaveLength(0);
    } finally {
      reader.close();
    }
  });

  const MIN = 60_000;

  /** Scheduled acquirer whose first window opens (idle) at the returned `windowAt`. */
  async function openIdleWindow(gh: FakeGitHubState, clock: { now: number }, quiet = 0) {
    const made = makeAcquirer(gh, {
      conflictSchedule: dailySchedule,
      conflictWindowGraceMs: 60 * MIN,
      quietPeriodSeconds: quiet,
      now: () => clock.now,
    });
    await made.acquirer.tick();
    clock.now += DAY_MS;
    const windowAt = clock.now;
    await made.acquirer.tick();
    expect(windowState().windowOpenUntil).toBe(windowAt + 60 * MIN);
    return { ...made, windowAt };
  }

  test("a conflict observed late in the window keeps it open until it resolves", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const clock = { now: 1_750_000_000_000 };
    const gh = { ...conflictGh(), mergeableState: "clean" };
    const made = await openIdleWindow(gh, clock, 120);
    const { windowAt } = made;

    // A sibling merge conflicts the PR one minute before the nominal close.
    clock.now = windowAt + 59 * MIN;
    gh.mergeableState = "dirty";
    gh.baseSha = "base2";
    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);
    expect(made.acquirer.conflictWindowStatus()?.openUntil).toBe(windowAt + 74 * MIN);

    // Past the nominal close, the drain extension still lets it resolve.
    clock.now = windowAt + 62 * MIN;
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#42"]);
    expect(windowState().windowOpenUntil).toBe(windowAt + 77 * MIN);

    // The next conflict in the chain (after quiet period + CI + merge) is caught too.
    clock.now = windowAt + 72 * MIN;
    gh.baseSha = "base3";
    await made.acquirer.tick();
    clock.now = windowAt + 75 * MIN;
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#42", "acme/widgets#42"]);
  });

  test("a conflict after an idle window closes waits for the next window", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const clock = { now: 1_750_000_000_000 };
    const gh = { ...conflictGh(), mergeableState: "clean" };
    const made = await openIdleWindow(gh, clock);

    clock.now = made.windowAt + 61 * MIN;
    gh.mergeableState = "dirty";
    gh.baseSha = "base2";
    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base2:head1")?.status).toBe("pending");
    expect(made.acquirer.conflictWindowStatus()?.openUntil).toBeUndefined();
    expect(windowState().windowOpenUntil).toBe(made.windowAt + 60 * MIN);
  });

  test("drain extensions never keep the window open past twice its grace", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const clock = { now: 1_750_000_000_000 };
    const gh = { ...conflictGh(), mergeableState: "clean" };
    const made = await openIdleWindow(gh, clock);
    const { windowAt } = made;
    gh.mergeableState = "dirty";

    // A conflict that keeps reappearing every 10 minutes.
    for (let minute = 55; minute <= 115; minute += 10) {
      clock.now = windowAt + minute * MIN;
      gh.baseSha = `base-${minute}`;
      await made.acquirer.tick();
      expect(windowState().windowOpenUntil).toBe(windowAt + Math.min(minute + 15, 120) * MIN);
    }
    expect(made.resolved).toHaveLength(7);
    expect(windowState().windowCapAt).toBe(windowAt + 120 * MIN);

    clock.now = windowAt + 121 * MIN;
    gh.baseSha = "base-late";
    await made.acquirer.tick();
    expect(made.resolved).toHaveLength(7);
    expect(made.acquirer.conflictWindowStatus()?.openUntil).toBeUndefined();
  });

  test("a drain extension survives a worker restart", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const clock = { now: 1_750_000_000_000 };
    const gh = { ...conflictGh(), mergeableState: "clean" };
    const made = await openIdleWindow(gh, clock, 120);
    const { windowAt } = made;

    clock.now = windowAt + 59 * MIN;
    gh.mergeableState = "dirty";
    gh.baseSha = "base2";
    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);

    // Restart past the nominal close: the persisted extension still applies.
    clock.now = windowAt + 62 * MIN;
    const restarted = makeAcquirer(gh, {
      conflictSchedule: dailySchedule,
      conflictWindowGraceMs: 60 * MIN,
      quietPeriodSeconds: 120,
      now: () => clock.now,
    });
    await restarted.acquirer.tick();
    expect(restarted.resolved).toEqual(["acme/widgets#42"]);
    expect(windowState().windowCapAt).toBe(windowAt + 120 * MIN);
  });

  test("disabled mode never detects or resolves conflicts", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const made = makeAcquirer(conflictGh(), {
      disableResolveConflicts: true,
      conflictResolution: "disabled",
    });

    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")).toBeNull();
  });

  test("live reload can disable and re-enable conflict resolution", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const made = makeAcquirer(conflictGh());

    made.acquirer.updateConflictResolution("disabled");
    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);
    expect(queue.getBaseSyncEvent("base-sync:acme/widgets#42:base1:head1")).toBeNull();

    made.acquirer.updateConflictResolution("auto");
    await made.acquirer.tick();
    expect(made.resolved).toEqual(["acme/widgets#42"]);
  });

  test("start() surfaces the active conflict-resolution mode", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      const scheduled = makeAcquirer(
        { prState: "open", reviews: [], comments: [] },
        {
          conflictSchedule: { cron: "0 3 * * *" },
        },
      );
      await scheduled.acquirer.start();
      scheduled.acquirer.stop();

      const auto = makeAcquirer({ prState: "open", reviews: [], comments: [] });
      await auto.acquirer.start();
      auto.acquirer.stop();

      const disabled = makeAcquirer(
        { prState: "open", reviews: [], comments: [] },
        {
          disableResolveConflicts: true,
          conflictResolution: "disabled",
        },
      );
      await disabled.acquirer.start();
      disabled.acquirer.stop();
    } finally {
      console.log = original;
    }
    expect(
      logs.some((line) => line.includes('conflict resolution: scheduled (cron "0 3 * * *")')),
    ).toBe(true);
    expect(logs.some((line) => line.includes("conflict resolution: auto"))).toBe(true);
    expect(logs.some((line) => line.includes("conflict resolution: disabled"))).toBe(true);
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

  test("a 404 leaves the PR watched and skips feedback requests", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let inaccessible = true;
    let fetches = 0;
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      github: {
        // The workspace adapter maps 404 responses to `gone`.
        async fetchPr() {
          fetches++;
          return inaccessible
            ? { data: null, notModified: false, gone: true }
            : { data: { state: "open" }, notModified: false };
        },
        async fetchReviews() {
          if (inaccessible) throw new Error("must not be called for an inaccessible PR");
          return { data: [], notModified: false };
        },
        async fetchReviewCommentsSince() {
          if (inaccessible) throw new Error("must not be called for an inaccessible PR");
          return [];
        },
      },
      addressPr: async () => {
        throw new Error("must not be addressed");
      },
    });

    await acquirer.tick();
    expect(workerState.listOpenAgentPrs()).toHaveLength(1);
    expect(workerState.countAgentPrs().closed).toBe(0);
    expect(fetches).toBe(1);

    inaccessible = false;
    await acquirer.tick();
    expect(fetches).toBe(2);
    expect(workerState.listOpenAgentPrs()).toHaveLength(1);
  });

  test("reconciliation shares one PR fetch with the poll loop", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let prFetches = 0;
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      github: {
        async fetchPr() {
          prFetches += 1;
          return {
            data: { state: "open", mergeable_state: "clean" },
            etag: 'W/"pr-1"',
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
    });

    await acquirer.tick();
    // One reconciliation fetch feeds the poll loop; a second would double
    // the API cost of every tick.
    expect(prFetches).toBe(1);
  });

  test("rejected credentials warn once per hour instead of failing every PR tick", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 2 });

    // The shape of the error thrown by GitHubReviewsClient on a 401;
    // sent verbatim so the test documents the contract.
    const badCredentials = new Error(
      "GitHub API error (401): Bad credentials. Renew GITHUB_TOKEN.",
    );
    let now = 1_750_000_000_000;
    let warns = 0;
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns += 1;
      expect(args.join(" ")).toContain("401");
    };
    try {
      const acquirer = new ReviewPollingAcquirer({
        intervalSeconds: 60,
        now: () => now,
        workerState,
        queue,
        github: {
          async fetchPr() {
            throw badCredentials;
          },
          async fetchReviews() {
            throw new Error("must not be reached");
          },
          async fetchReviewCommentsSince() {
            throw new Error("must not be reached");
          },
        },
        addressPr: async () => {
          throw new Error("must not be addressed");
        },
      });

      // Both PRs hit the same permanent credential failure, but only the
      // first triggers a warning this hour.
      await acquirer.tick();
      expect(warns).toBe(1);

      now += 60_000;
      await acquirer.tick();
      expect(warns).toBe(1);

      now += 60 * 60_000;
      await acquirer.tick();
      expect(warns).toBe(2);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("403 permission denials are throttled like rejected credentials", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 2 });

    const forbidden = new Error(
      "GitHub API error (403): Resource not accessible by personal access token",
    );
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(" "));
    };
    try {
      const acquirer = new ReviewPollingAcquirer({
        intervalSeconds: 60,
        workerState,
        queue,
        github: {
          async fetchPr() {
            throw forbidden;
          },
          async fetchReviews() {
            throw new Error("must not be reached");
          },
          async fetchReviewCommentsSince() {
            throw new Error("must not be reached");
          },
        },
        addressPr: async () => true,
      });

      // Both PRs hit the same permanent permission failure, but only the
      // first triggers a warning this hour.
      await acquirer.tick();
      expect(warns).toHaveLength(1);
      // A 403 means the token may be valid but under-scoped, so the guidance
      // must not tell the operator to renew it.
      expect(warns[0]).toContain("lacks a permission");
      expect(warns[0]).not.toContain("invalid, expired, or revoked");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("fleet-mode credential failures are throttled per repository", async () => {
    workerState.recordAgentPr({ repo: "acme/a", prNumber: 1 });
    workerState.recordAgentPr({ repo: "acme/b", prNumber: 2 });
    let now = 1_000;
    const failures = new Map<string, Error>([
      [
        "acme/a",
        new Error("GitHub API error (403): Resource not accessible by personal access token"),
      ],
      ["acme/b", new Error("GitHub API error (401): Bad credentials")],
    ]);
    const warns: string[] = [];
    const logs: string[] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(" "));
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    const recoveryLines = (repo: string) =>
      logs.filter(
        (line) => line.includes("GitHub credential accepted again") && line.includes(repo),
      ).length;
    try {
      const acquirer = new ReviewPollingAcquirer({
        intervalSeconds: 60,
        now: () => now,
        workerState,
        queue,
        github: {
          async fetchPr(repo) {
            const failure = failures.get(repo);
            if (failure) throw failure;
            return { data: { state: "open" }, etag: 'W/"pr"', notModified: false };
          },
          async fetchReviews() {
            return { data: [], etag: 'W/"rev"', notModified: false };
          },
          async fetchReviewCommentsSince() {
            return [];
          },
        },
        addressPr: async () => true,
      });

      await acquirer.tick();
      // A 403 in repo A must not hide repo B's 401.
      expect(warns).toHaveLength(2);
      expect(warns.find((line) => line.includes("acme/a#1"))).toContain("lacks a permission");
      expect(warns.find((line) => line.includes("acme/b#2"))).toContain(
        "invalid, expired, or revoked",
      );

      now += 60_000;
      await acquirer.tick();
      expect(warns).toHaveLength(2);
      expect(recoveryLines("acme/a")).toBe(0);

      // Repo B recovers while repo A still fails: B rearms and reports
      // recovery, A stays throttled.
      failures.delete("acme/b");
      now += 60_000;
      await acquirer.tick();
      expect(warns).toHaveLength(2);
      expect(recoveryLines("acme/b")).toBe(1);
      expect(recoveryLines("acme/a")).toBe(0);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });

  test("metadata-only success does not clear a reviews/comments throttle", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let now = 1_000;
    let failReviews = true;
    let pollFeedback = true;
    const warns: string[] = [];
    const logs: string[] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(" "));
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    const recoveryLines = () =>
      logs.filter((line) => line.includes("GitHub credential accepted again")).length;
    try {
      const acquirer = new ReviewPollingAcquirer({
        intervalSeconds: 60,
        now: () => now,
        workerState,
        queue,
        shouldPollFeedback: () => pollFeedback,
        github: {
          async fetchPr() {
            return {
              data: { state: "open", mergeable_state: "clean" },
              etag: 'W/"pr"',
              notModified: false,
            };
          },
          async fetchReviews() {
            if (failReviews) {
              throw new Error(
                "GitHub API error (403): Resource not accessible by personal access token",
              );
            }
            return { data: [], etag: 'W/"rev"', notModified: false };
          },
          async fetchReviewCommentsSince() {
            return [];
          },
        },
        addressPr: async () => true,
      });

      // The PR-state read works; only the reviews endpoint is rejected.
      await acquirer.tick();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("reading reviews");

      // Relay healthy again and feedback polling skipped: the PR-state fetch
      // succeeds, but the reviews endpoint was never re-tested, so no recovery
      // may be announced and the throttle must stay armed.
      pollFeedback = false;
      now += 60_000;
      await acquirer.tick();
      expect(recoveryLines()).toBe(0);
      expect(warns).toHaveLength(1);

      // Feedback polling resumed but reviews still fail: the old throttle
      // holds, so no duplicate warning inside the hour.
      pollFeedback = true;
      now += 60_000;
      await acquirer.tick();
      expect(warns).toHaveLength(1);

      // The reviews endpoint finally succeeds → recovery claimed exactly once.
      failReviews = false;
      now += 60_000;
      await acquirer.tick();
      expect(recoveryLines()).toBe(1);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });

  test("non-credential 403s keep the normal per-PR capture path", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 2 });

    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(" "));
    };
    try {
      const acquirer = new ReviewPollingAcquirer({
        intervalSeconds: 60,
        workerState,
        queue,
        github: {
          async fetchPr() {
            throw new Error("GitHub API error (403): Repository was archived so is read-only.");
          },
          async fetchReviews() {
            throw new Error("must not be reached");
          },
          async fetchReviewCommentsSince() {
            throw new Error("must not be reached");
          },
        },
        addressPr: async () => true,
      });

      await acquirer.tick();
      expect(warns).toHaveLength(2);
      expect(warns.every((line) => !line.includes("lacks a permission"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("non-auth polling failures warn per PR as before", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 2 });

    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(" "));
    };
    try {
      const acquirer = new ReviewPollingAcquirer({
        intervalSeconds: 60,
        workerState,
        queue,
        github: {
          async fetchPr() {
            throw new Error("GitHub API error (429) ... showed as transient");
          },
          async fetchReviews() {
            throw new Error("must not be reached");
          },
          async fetchReviewCommentsSince() {
            throw new Error("must not be reached");
          },
        },
        addressPr: async () => true,
      });

      await acquirer.tick();
      expect(warns).toHaveLength(2);
      expect(warns.every((line) => !line.includes("Github rejected"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
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

describe("ReviewPollingAcquirer team-PR base sync (sync_team_prs)", () => {
  const REPO = "acme/widgets";
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;
  let logs: string[];
  let warns: string[];
  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetUnusableStateWarnings();
    dbPath = join(tmpdir(), `rp-team-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
    logs = [];
    warns = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    workerState.close();
    queue.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  interface FakePr {
    number: number;
    state?: string;
    draft?: boolean;
    association?: string;
    /** Head repo full name; defaults to the base repo (same-repo PR). */
    headRepo?: string;
    mergeable?: string;
    headSha?: string;
    baseSha?: string;
  }

  /** Multi-PR fake GitHub; ETags change whenever `version` is bumped. */
  class TeamGitHub {
    prs = new Map<number, FakePr>();
    version = 1;
    listCalls: Array<string | undefined> = [];
    prCalls: Array<{ n: number; etag?: string }> = [];
    reviewCalls: number[] = [];
    listError?: Error;
    listGone = false;
    /** Overrides the list payload (page-cap tests). */
    listOverride?: PolledPrListItem[];
    /** Called after each PR fetch (lets tests mutate state between fetches). */
    afterFetch?: (n: number, calls: number) => void;

    add(pr: FakePr): void {
      this.prs.set(pr.number, pr);
      this.version += 1;
    }

    private listEtag(): string {
      return `W/"list-${this.version}"`;
    }

    private payload(pr: FakePr): PolledPr {
      return {
        state: pr.state ?? "open",
        draft: pr.draft,
        author_association: pr.association,
        mergeable_state: pr.mergeable ?? "dirty",
        head: {
          sha: pr.headSha ?? `head${pr.number}`,
          ref: `feature/${pr.number}`,
          repo: { full_name: pr.headRepo ?? REPO },
        },
        base: { sha: pr.baseSha ?? "base1", ref: "main" },
      };
    }

    client(): ReviewPollingGitHub {
      return {
        fetchPr: async (_repo, n, etag) => {
          this.prCalls.push({ n, etag });
          const calls = this.prCalls.filter((call) => call.n === n).length;
          const pr = this.prs.get(n);
          try {
            if (!pr) return { data: null, notModified: false, gone: true };
            const current = `W/"pr-${n}-${this.version}"`;
            if (etag && etag === current) return { data: null, etag, notModified: true };
            return { data: this.payload(pr), etag: current, notModified: false };
          } finally {
            this.afterFetch?.(n, calls);
          }
        },
        fetchReviews: async (_repo, n) => {
          this.reviewCalls.push(n);
          return {
            data: [{ id: n, state: "CHANGES_REQUESTED", user: { login: "rev", type: "User" } }],
            notModified: false,
          };
        },
        fetchReviewCommentsSince: async () => [],
        listOpenPullRequests: async (_repo, etag) => {
          this.listCalls.push(etag);
          if (this.listError) throw this.listError;
          if (this.listGone) return { data: null, notModified: false, gone: true };
          const current = this.listEtag();
          if (etag && etag === current) return { data: null, etag, notModified: true };
          const data =
            this.listOverride ??
            [...this.prs.values()]
              .filter((pr) => (pr.state ?? "open") === "open")
              .map((pr) => ({
                number: pr.number,
                draft: pr.draft,
                author_association: pr.association,
                head: { repo: { full_name: pr.headRepo ?? REPO } },
              }));
          return { data, etag: current, notModified: false };
        },
      };
    }
  }

  function make(
    gh: TeamGitHub,
    options: {
      syncTeamPrsRepos?: string[] | (() => string[]);
      conflictResolution?: ConflictResolutionMode;
      conflictSchedule?: CronOrIntervalSchedule;
      now?: () => number;
      runStore?: RunStore;
    } = {},
  ) {
    const addressed: string[] = [];
    const resolved: string[] = [];
    const acquirer = new ReviewPollingAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      github: gh.client(),
      addressPr: async (repo, n) => {
        addressed.push(`${repo}#${n}`);
        return true;
      },
      resolveConflicts: async (repo, n) => {
        resolved.push(`${repo}#${n}`);
        return { outcome: "resolved", message: "merged base" };
      },
      quietPeriodSeconds: 0,
      allowedRepos: [REPO],
      syncTeamPrsRepos: "syncTeamPrsRepos" in options ? options.syncTeamPrsRepos : [REPO],
      conflictResolution: options.conflictResolution,
      conflictSchedule: options.conflictSchedule,
      conflictWindowGraceMs: 60 * 60_000,
      now: options.now,
      runStore: options.runStore,
    });
    return { acquirer, addressed, resolved };
  }

  function emitEscalation(prNumber: number): void {
    const writer = new Database(dbPath);
    try {
      new NotificationEmitter(writer).emit({
        kind: "escalated",
        severity: "high",
        groupKey: baseSyncExhaustedGroupKey(REPO, prNumber),
        title: "Conflict resolution keeps getting cut off",
      });
    } finally {
      writer.close();
    }
  }

  function unresolvedEscalations(): number {
    const reader = new Database(dbPath);
    try {
      return listNotifications(reader, {
        unresolved: true,
        includeMuted: true,
      }).notifications.filter((notification) => notification.kind === "escalated").length;
    } finally {
      reader.close();
    }
  }

  test("default off: no repo opted in sends no discovery requests", async () => {
    workerState.recordAgentPr({ repo: REPO, prNumber: 42 });
    for (const syncTeamPrsRepos of [undefined, [] as string[]]) {
      const gh = new TeamGitHub();
      gh.add({ number: 42, association: "MEMBER", mergeable: "clean" });
      gh.add({ number: 7, association: "MEMBER" });
      const made = make(gh, { syncTeamPrsRepos });
      await made.acquirer.tick();
      expect(gh.listCalls).toEqual([]);
      expect(gh.prCalls.map((call) => call.n)).toEqual([42]);
      expect(made.resolved).toEqual([]);
      expect(logs.some((line) => line.includes("team-PR base sync"))).toBe(false);
    }
  });

  test("a conflicting teammate PR is base-synced without feedback addressing", async () => {
    const runStore = new RunStore(dbPath);
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER" });
    const made = make(gh, { runStore });

    await made.acquirer.tick();

    expect(made.resolved).toEqual([`${REPO}#7`]);
    expect(made.addressed).toEqual([]);
    expect(gh.reviewCalls).toEqual([]);
    expect(logs).toContain(`👀 [poll:reviews] watching ${REPO}#7 (open PR) for base sync`);
    expect(logs.some((line) => line.includes(`syncing ${REPO}#7 (external PR)`))).toBe(true);
    expect(queue.getBaseSyncEvent(`base-sync:${REPO}#7:base1:head7`)?.status).toBe("completed");
    const runs = runStore.listRuns({ limit: 10 });
    expect(runs.map((run) => [run.origin, run.prNumber])).toEqual([["conflict_resolution", 7]]);
    runStore.close();

    // Deduped by base/head like the agent's own PRs.
    await made.acquirer.tick();
    expect(made.resolved).toEqual([`${REPO}#7`]);
  });

  test("a teammate PR leaving the open list clears its exhaustion row", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER", mergeable: "clean" });
    const made = make(gh);
    await made.acquirer.tick();

    // Model an earlier restart loop that exhausted the automatic base sync.
    const writer = new Database(dbPath);
    try {
      new NotificationEmitter(writer).emit({
        kind: "escalated",
        severity: "high",
        groupKey: baseSyncExhaustedGroupKey(REPO, 7),
        title: "Conflict resolution keeps getting cut off",
      });
    } finally {
      writer.close();
    }

    // Closed/merged: the PR drops out of the open list.
    gh.prs.delete(7);
    gh.version += 1;
    await made.acquirer.tick();

    const reader = new Database(dbPath);
    try {
      expect(
        listNotifications(reader, { unresolved: true, includeMuted: true }).notifications.filter(
          (notification) => notification.kind === "escalated",
        ),
      ).toHaveLength(0);
    } finally {
      reader.close();
    }
  });

  test("a team sweep does not clear an own PR's exhaustion row", async () => {
    workerState.recordAgentPr({ repo: REPO, prNumber: 42 });
    const gh = new TeamGitHub();
    // GitHub is recomputing, so the main poller leaves the row alone and the
    // team sweep is the only path that could clear it this tick.
    gh.add({ number: 42, association: "MEMBER", mergeable: "unknown" });
    const made = make(gh);
    emitEscalation(42);

    await made.acquirer.tick();

    // The main poller owns the PR and may have base-synced it, but the
    // restart-exhaustion row is not cleared by merely seeing it in the sweep.
    expect(gh.listCalls.length).toBeGreaterThan(0);
    expect(unresolvedEscalations()).toBe(1);
  });

  test("an unusable fresh PR state keeps the teammate escalation row", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER", mergeable: "clean" });
    const made = make(gh);
    await made.acquirer.tick();
    emitEscalation(7);

    // A transient payload gap must not read as "not open".
    gh.listOverride = [{ number: 7, author_association: "MEMBER" }];
    gh.prs.get(7)!.state = "";
    gh.version += 1;
    await made.acquirer.tick();

    expect(unresolvedEscalations()).toBe(1);
  });

  test("a missing fresh author association keeps the teammate escalation row", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER", mergeable: "clean" });
    const made = make(gh);
    await made.acquirer.tick();
    emitEscalation(7);

    // The list still identifies a teammate; the per-PR payload is incomplete.
    gh.listOverride = [{ number: 7, author_association: "MEMBER" }];
    gh.prs.get(7)!.association = undefined;
    gh.version += 1;
    await made.acquirer.tick();

    expect(unresolvedEscalations()).toBe(1);
  });

  test("a missing list association keeps the teammate escalation row", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER", mergeable: "clean" });
    const made = make(gh);
    await made.acquirer.tick();
    emitEscalation(7);

    // The list payload itself lost the association; that cannot prove the PR
    // left the team, so the escalation row must survive.
    gh.listOverride = [{ number: 7 }];
    gh.version += 1;
    await made.acquirer.tick();

    expect(unresolvedEscalations()).toBe(1);
  });

  test("non-team authors are skipped at discovery and logged once", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 8, association: "CONTRIBUTOR" });
    gh.add({ number: 9 });
    const made = make(gh);

    await made.acquirer.tick();
    await made.acquirer.tick();

    expect(made.resolved).toEqual([]);
    expect(gh.prCalls).toEqual([]);
    const skips = logs.filter((line) => line.includes("🚧"));
    expect(skips).toEqual([
      `🚧 [poll:reviews] skipping ${REPO}#8 for base sync (non-team author: CONTRIBUTOR)`,
      `🚧 [poll:reviews] skipping ${REPO}#9 for base sync (non-team author: unknown)`,
    ]);
  });

  test("the fresh per-PR payload re-checks the team gate", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER" });
    // The list entry is stale: the PR itself reports an outside author.
    gh.listOverride = [{ number: 7, author_association: "MEMBER" }];
    gh.prs.get(7)!.association = "NONE";
    const made = make(gh);

    await made.acquirer.tick();

    expect(gh.prCalls.map((call) => call.n)).toEqual([7]);
    expect(made.resolved).toEqual([]);
    expect(logs.some((line) => line.includes(`skipping ${REPO}#7`))).toBe(true);
  });

  test("eligibility is re-checked on the pre-execution refetch", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER" });
    gh.afterFetch = (n, calls) => {
      // Flip the PR to draft after the sweep's fetch, before the refetch.
      if (n === 7 && calls === 1) gh.prs.get(7)!.draft = true;
    };
    const made = make(gh);

    await made.acquirer.tick();

    expect(gh.prCalls.map((call) => call.n)).toEqual([7, 7]);
    expect(made.resolved).toEqual([]);
  });

  test("drafts and forks are skipped without per-PR requests", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 10, association: "MEMBER", draft: true });
    gh.add({ number: 11, association: "COLLABORATOR", headRepo: "someone/widgets" });
    const made = make(gh);

    await made.acquirer.tick();

    expect(gh.listCalls).toHaveLength(1);
    expect(gh.prCalls).toEqual([]);
    expect(made.resolved).toEqual([]);
    expect(logs.some((line) => line.includes("👀"))).toBe(false);
  });

  test("a PR that leaves the open list leaves the watch set", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER", mergeable: "clean" });
    const made = make(gh);

    await made.acquirer.tick();
    expect(logs.some((line) => line.includes(`watching ${REPO}#7`))).toBe(true);

    gh.prs.get(7)!.state = "closed";
    gh.version += 1;
    await made.acquirer.tick();
    expect(logs).toContain(`👋 [poll:reviews] ${REPO}#7 left the open-PR list; no longer watching`);
    const fetchesAfterClose = gh.prCalls.length;

    await made.acquirer.tick();
    expect(gh.prCalls).toHaveLength(fetchesAfterClose);
  });

  test("a 304 list reuses the cached PRs; a restart never sends a stored ETag first", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER", mergeable: "clean" });
    const made = make(gh);

    await made.acquirer.tick();
    expect(gh.listCalls).toEqual([undefined]);
    await made.acquirer.tick();
    expect(gh.listCalls).toEqual([undefined, 'W/"list-2"']);
    // The cached list still drives the per-PR poll, which revalidates too.
    expect(gh.prCalls).toEqual([
      { n: 7, etag: undefined },
      { n: 7, etag: 'W/"pr-7-2"' },
    ]);

    // Fresh process with the durable ETags in place: hydrate unconditionally.
    const restarted = make(gh);
    await restarted.acquirer.tick();
    expect(gh.listCalls.at(-1)).toBeUndefined();
    expect(gh.prCalls.at(-1)).toEqual({ n: 7, etag: undefined });
  });

  test("the agent's own PRs are not swept again", async () => {
    workerState.recordAgentPr({ repo: REPO, prNumber: 42 });
    const gh = new TeamGitHub();
    gh.add({ number: 42, association: "OWNER" });
    const made = make(gh);

    await made.acquirer.tick();

    expect(made.resolved).toEqual([`${REPO}#42`]);
    expect(made.addressed).toEqual([`${REPO}#42`]);
    expect(logs.some((line) => line.includes("👀"))).toBe(false);
    expect(logs.some((line) => line.includes("(external PR)"))).toBe(false);
    expect(workerState.getCursor(teamPrStateCursorSource(REPO, 42))).toBeNull();
  });

  test("disabled conflict resolution skips discovery and never syncs teammate PRs", async () => {
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER" });
    const made = make(gh, { conflictResolution: "disabled" });

    await made.acquirer.tick();

    expect(gh.listCalls).toEqual([]);
    expect(made.resolved).toEqual([]);
  });

  test("scheduled mode queues teammate conflicts until the window opens", async () => {
    const DAY_MS = 86_400_000;
    let now = 1_750_000_000_000;
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER" });
    const made = make(gh, {
      conflictResolution: "scheduled",
      conflictSchedule: { interval: "1d", intervalMs: DAY_MS },
      now: () => now,
    });

    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);
    expect(queue.getBaseSyncEvent(`base-sync:${REPO}#7:base1:head7`)?.status).toBe("pending");

    now += DAY_MS + 1;
    await made.acquirer.tick();
    expect(made.resolved).toEqual([`${REPO}#7`]);
  });

  test("a full open-PR page warns once until the list drops below the cap", async () => {
    const gh = new TeamGitHub();
    const page = (count: number): PolledPrListItem[] =>
      Array.from({ length: count }, (_, index) => ({ number: index + 1, draft: true }));
    gh.listOverride = page(OPEN_PR_LIST_PAGE_SIZE);
    const made = make(gh);
    const capWarnings = () => warns.filter((line) => line.includes("page cap")).length;

    await made.acquirer.tick();
    gh.version += 1;
    await made.acquirer.tick();
    expect(capWarnings()).toBe(1);

    gh.listOverride = page(OPEN_PR_LIST_PAGE_SIZE - 1);
    gh.version += 1;
    await made.acquirer.tick();
    gh.listOverride = page(OPEN_PR_LIST_PAGE_SIZE);
    gh.version += 1;
    await made.acquirer.tick();
    expect(capWarnings()).toBe(2);
  });

  test("credential failures listing open PRs are throttled per repo", async () => {
    let now = 1_750_000_000_000;
    const gh = new TeamGitHub();
    gh.listError = new Error("GitHub API error (401): Bad credentials. Renew GITHUB_TOKEN.");
    const made = make(gh, { now: () => now });

    await made.acquirer.tick();
    now += 60_000;
    await made.acquirer.tick();
    const credentialWarnings = () =>
      warns.filter((line) => line.includes("rejected the credential while listing open PRs"));
    expect(credentialWarnings()).toHaveLength(1);

    gh.listError = undefined;
    await made.acquirer.tick();
    expect(logs.some((line) => line.includes("listing open PRs recovered"))).toBe(true);
  });

  test("a 404 PR or list warns and does not sync", async () => {
    const gh = new TeamGitHub();
    gh.listOverride = [{ number: 99, author_association: "MEMBER" }];
    const made = make(gh);

    await made.acquirer.tick();
    expect(made.resolved).toEqual([]);
    expect(warns.some((line) => line.includes(`404 for ${REPO}#99`))).toBe(true);

    const listGone = new TeamGitHub();
    listGone.listGone = true;
    const other = make(listGone, { now: () => Date.now() + 2 * 60 * 60_000 });
    await other.acquirer.tick();
    expect(warns.some((line) => line.includes("404 listing open PRs"))).toBe(true);
  });

  test("live reload opting a repo out prunes state; opting back in re-hydrates", async () => {
    let opted = [REPO];
    const gh = new TeamGitHub();
    gh.add({ number: 7, association: "MEMBER", mergeable: "clean" });
    const made = make(gh, { syncTeamPrsRepos: () => opted });

    await made.acquirer.tick();
    expect(logs).toContain(`🌐 [poll:reviews] team-PR base sync enabled on: ${REPO}`);

    opted = [];
    await made.acquirer.tick();
    expect(logs).toContain("🌐 [poll:reviews] team-PR base sync disabled");
    expect(gh.listCalls).toHaveLength(1);

    opted = [REPO];
    await made.acquirer.tick();
    // Pruned caches mean no stored ETag is sent (no 304 against an empty cache).
    expect(gh.listCalls).toEqual([undefined, undefined]);
    expect(gh.prCalls.at(-1)).toEqual({ n: 7, etag: undefined });
    expect(logs.filter((line) => line.includes(`watching ${REPO}#7`))).toHaveLength(2);
  });
});
