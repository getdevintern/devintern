import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  AUTO_MERGE_SOURCE,
  AutoMergeWatcherAcquirer,
  autoMergeDecisionKey,
  autoMergePrDecisionKey,
} from "../src/lib/acquirers/auto-merge-watcher";
import type { AutoMergePolledPr } from "../src/lib/acquirers/auto-merge-watcher";
import {
  autoMergeCliArgs,
  parseAutoMergeResultLine,
  runAutoMergeViaCli,
  usageLimitRetryAt,
} from "../src/lib/acquirers/auto-merge-cli";
import type { AutoMergeResult } from "../src/lib/review/auto-merge";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";

const REPO = "acme/widgets";
const HEAD = "a".repeat(40);

describe("AutoMergeWatcherAcquirer", () => {
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;
  let now: number;
  let pr: AutoMergePolledPr;
  let calls: Array<{
    prNumber: number;
    sha: string;
    lastAttempt?: boolean;
    ciWaitPosted?: string;
  }>;
  let results: AutoMergeResult[];
  let enabled: boolean;
  let runs: Array<{ origin: string; status?: string; harness?: string } | null>;
  let statusDuringMerge: Array<string | undefined>;
  let fingerprint: string | undefined;

  const liveRuns = () => runs.filter((run) => run !== null);
  const watcher = (
    extra: { quietSeconds?: number; harness?: string; recheckOnPush?: boolean } = {},
  ) =>
    new AutoMergeWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      enabled: () => enabled,
      now: () => now,
      quietSeconds: extra.quietSeconds ?? 0,
      fetchPr: async () => ({ data: pr, notModified: false }),
      mergePr: async (_repo, prNumber, sha, { lastAttempt, ciWaitPosted }) => {
        calls.push({
          prNumber,
          sha,
          ...(lastAttempt ? { lastAttempt } : {}),
          ...(ciWaitPosted !== undefined ? { ciWaitPosted } : {}),
        });
        statusDuringMerge.push(runs.at(-1)?.status);
        return results.shift() ?? { outcome: "merged", message: "ok", reviewed: false };
      },
      harness: () => extra.harness,
      policyFingerprint: () => fingerprint ?? "",
      ...(extra.recheckOnPush !== undefined
        ? { recheckOnPush: () => extra.recheckOnPush as boolean }
        : {}),
      runStore: {
        createRun: (meta) => {
          runs.push({
            origin: meta.origin,
            status: "in_progress",
            ...(meta.harness ? { harness: meta.harness } : {}),
          });
          return runs.length;
        },
        finishRun: (id, status) => {
          (runs[id - 1] as { status?: string }).status = status;
        },
        discardRun: (id) => {
          runs[id - 1] = null;
        },
      },
    });

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `auto-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
    workerState.recordAgentPr({ repo: REPO, prNumber: 7 });
    now = 1_000_000;
    pr = {
      state: "open",
      mergeable_state: "clean",
      head: { sha: HEAD, repo: { full_name: REPO } },
    };
    calls = [];
    results = [];
    enabled = true;
    runs = [];
    statusDuringMerge = [];
    fingerprint = undefined;
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });

  test("does nothing while disabled", async () => {
    enabled = false;
    await watcher().tick();
    expect(calls).toHaveLength(0);
  });

  describe("stacked-base guard", () => {
    test("never merges a PR whose base is another agent PR's branch", async () => {
      workerState.recordAgentPr({ repo: REPO, prNumber: 6, branch: "feature/local-a" });
      pr = {
        ...pr,
        base: { sha: "b".repeat(40), ref: "feature/local-a", repo: { default_branch: "main" } },
      };
      await watcher().tick();
      expect(calls).toHaveLength(0);
    });

    test("never merges a PR whose base is a tracked stacked base", async () => {
      pr = { ...pr, base: { sha: "b".repeat(40), ref: "feature/human-base" } };
      const w = new AutoMergeWatcherAcquirer({
        intervalSeconds: 60,
        workerState,
        queue,
        enabled: () => true,
        now: () => now,
        quietSeconds: 0,
        fetchPr: async () => ({ data: pr, notModified: false }),
        mergePr: async (_repo, prNumber, sha) => {
          calls.push({ prNumber, sha });
          return { outcome: "merged", message: "ok", reviewed: false };
        },
        isStackedBase: (repo, ref) => repo === REPO && ref === "feature/human-base",
      });
      await w.tick();
      expect(calls).toHaveLength(0);
    });

    test("considers the PR once it targets the default branch", async () => {
      // The base merged (its row is closed, its branch still recorded).
      workerState.recordAgentPr({ repo: REPO, prNumber: 6, branch: "feature/local-a" });
      workerState.markAgentPrClosed(REPO, 6, "merged");
      pr = {
        ...pr,
        base: { sha: "b".repeat(40), ref: "feature/local-a", repo: { default_branch: "main" } },
      };
      const w = watcher();
      await w.tick();
      expect(calls).toHaveLength(0);
      pr = { ...pr, base: { sha: "c".repeat(40), ref: "main", repo: { default_branch: "main" } } };
      await w.tick();
      expect(calls).toEqual([{ prNumber: 7, sha: HEAD }]);
    });

    test("a non-default target that is no stacked base (explicit Target branch) still merges", async () => {
      pr = {
        ...pr,
        base: { sha: "b".repeat(40), ref: "release/2.0", repo: { default_branch: "main" } },
      };
      await watcher().tick();
      expect(calls).toEqual([{ prNumber: 7, sha: HEAD }]);
    });
  });

  test("evaluates a clean PR once per head and records the decision", async () => {
    const w = watcher();
    await w.tick();
    await w.tick();
    expect(calls).toEqual([{ prNumber: 7, sha: HEAD }]);
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergeDecisionKey(REPO, 7, HEAD))).toBe(true);
    expect(runs).toEqual([{ origin: "auto_merge", status: "succeeded" }]);
    // The run existed (in progress) while the evaluation ran.
    expect(statusDuringMerge).toEqual(["in_progress"]);
  });

  test("a successful merge is recorded in the registry immediately", async () => {
    await watcher().tick();
    expect(workerState.listOpenAgentPrs()).toHaveLength(0);
    const merged = workerState.listMergedAgentChangeRequests(10);
    expect(merged.map((row) => row.prNumber)).toEqual([7]);
    expect(merged[0]?.mergedAt).toBe(now);
  });

  test("a rejected merge leaves the PR open and unmerged", async () => {
    results = [{ outcome: "rejected", message: "no", reviewed: false }];
    await watcher().tick();
    expect(workerState.listOpenAgentPrs()).toHaveLength(1);
    expect(workerState.listMergedAgentChangeRequests(10)).toEqual([]);
  });

  test("hands the open run's id to the merge check so its transcript is filed under it", async () => {
    const runIds: Array<number | undefined> = [];
    const w = new AutoMergeWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      enabled: () => true,
      now: () => now,
      quietSeconds: 0,
      fetchPr: async () => ({ data: pr, notModified: false }),
      mergePr: async (_repo, _prNumber, _sha, { runId }) => {
        runIds.push(runId);
        return { outcome: "merged", message: "ok", reviewed: false };
      },
      runStore: { createRun: () => 41, finishRun: () => {}, discardRun: () => {} },
    });
    await w.tick();
    expect(runIds).toEqual([41]);
  });

  test("marks the run as waiting for a slot until the check is admitted", async () => {
    const steps: string[] = [];
    const seen: Array<{ before: string | undefined; after: string | undefined }> = [];
    const w = new AutoMergeWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      enabled: () => true,
      now: () => now,
      quietSeconds: 0,
      fetchPr: async () => ({ data: pr, notModified: false }),
      mergePr: async (_repo, _prNumber, _sha, { onStart }) => {
        const before = steps.at(-1);
        // The fleet runner calls onStart once the supervisor admits the job.
        onStart?.();
        seen.push({ before, after: steps.at(-1) });
        return { outcome: "merged", message: "ok", reviewed: false };
      },
      runStore: {
        createRun: () => 1,
        finishRun: () => {},
        discardRun: () => {},
        startStep: (_id, step) => {
          steps.push(step);
          return now;
        },
      },
    });
    await w.tick();
    expect(seen).toEqual([{ before: "waiting-for-slot", after: "auto-merge" }]);
  });

  test.each([
    [{ mergeable_state: "dirty" }],
    [{ mergeable_state: "behind" }],
    [{ draft: true }],
    [{ state: "closed" }],
    [{ head: { sha: HEAD, repo: { full_name: "fork/widgets" } } }],
  ])("skips PRs that are not ready: %o", async (overrides) => {
    pr = { ...pr, ...overrides };
    await watcher().tick();
    expect(calls).toHaveLength(0);
  });

  test("an unstable PR with a failing check is evaluated and its CI wait recorded", async () => {
    pr = { ...pr, mergeable_state: "unstable" };
    const failing = {
      outcome: "waiting" as const,
      message: "Ready gate: CI check failing on this commit: lint (failure).",
      reviewed: false,
      ciWait: true,
    };
    results = [failing, failing];
    const w = watcher({ quietSeconds: 300 });
    await w.tick();
    // The quiet window still applies to held PRs.
    expect(calls).toHaveLength(0);
    now += 301_000;
    await w.tick();
    expect(calls).toHaveLength(1);
    expect(liveRuns()).toEqual([{ origin: "auto_merge", status: "escalated" }]);
    // Still failing: checked again after the backoff, passing the posted wait.
    now += 10 * 60_000 + 1;
    await w.tick();
    expect(calls.map((call) => call.ciWaitPosted)).toEqual([undefined, failing.message]);
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergeDecisionKey(REPO, 7, HEAD))).toBe(false);
  });

  test("a blocked PR not held by its checks is not re-evaluated until its state changes", async () => {
    pr = { ...pr, mergeable_state: "blocked" };
    results = [{ outcome: "waiting", message: "blocked by branch protection", reviewed: false }];
    const w = watcher();
    await w.tick();
    expect(calls).toHaveLength(1);
    // Two backoffs, still inside the 30-minute recheck window.
    for (let i = 0; i < 2; i++) {
      now += 10 * 60_000 + 1;
      await w.tick();
    }
    expect(calls).toHaveLength(1);
    expect(liveRuns()).toEqual([]);
    // Approved: GitHub now reports it clean, so it is evaluated again.
    pr = { ...pr, mergeable_state: "clean" };
    await w.tick();
    expect(calls).toHaveLength(2);
  });

  test("a blocked non-CI hold is re-evaluated once the finding ages (a late check fails)", async () => {
    pr = { ...pr, mergeable_state: "blocked" };
    const failing = {
      outcome: "waiting" as const,
      message: "Ready gate: CI check failed: unit tests.",
      reviewed: false,
      ciWait: true,
    };
    results = [
      { outcome: "waiting", message: "blocked by branch protection", reviewed: false },
      failing,
    ];
    const w = watcher();
    await w.tick();
    now += 29 * 60_000;
    await w.tick();
    expect(calls).toHaveLength(1);
    now += 60_000 + 1;
    await w.tick();
    // Still blocked, but the required check now fails: the CI wait is posted.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.ciWaitPosted).toBeUndefined();
  });

  test("a blocked PR whose checks could not be read is retried at the next backoff", async () => {
    pr = { ...pr, mergeable_state: "blocked" };
    results = [
      { outcome: "waiting", message: "blocked", reviewed: false, ciChecksUnread: true },
      { outcome: "waiting", message: "blocked", reviewed: false },
    ];
    const w = watcher();
    await w.tick();
    now += 10 * 60_000 + 1;
    await w.tick();
    expect(calls).toHaveLength(2);
    // The second read succeeded and found no CI reason: back to the long hold.
    now += 10 * 60_000 + 1;
    await w.tick();
    expect(calls).toHaveLength(2);
  });

  test("an unreadable check status keeps the posted CI wait for the next check", async () => {
    pr = { ...pr, mergeable_state: "blocked" };
    const pending = {
      outcome: "waiting" as const,
      message: "Ready gate: CI checks are still pending: test.",
      reviewed: false,
      ciWait: true,
    };
    results = [
      pending,
      { outcome: "waiting", message: "blocked", reviewed: false, ciChecksUnread: true },
      { outcome: "waiting", message: "blocked", reviewed: false },
    ];
    const w = watcher();
    for (let i = 0; i < 3; i++) {
      await w.tick();
      now += 10 * 60_000 + 1;
    }
    // The third check still knows the PR shows the CI wait, so it can replace it.
    expect(calls.map((call) => call.ciWaitPosted)).toEqual([
      undefined,
      pending.message,
      pending.message,
    ]);
  });

  test("waits for the head to stay quiet", async () => {
    const w = watcher({ quietSeconds: 300 });
    await w.tick();
    expect(calls).toHaveLength(0);
    now += 301_000;
    await w.tick();
    expect(calls).toHaveLength(1);
  });

  test("a rejection is terminal for the head, but new commits are re-evaluated", async () => {
    results = [{ outcome: "rejected", message: "outside safe paths", reviewed: true }];
    const w = watcher();
    await w.tick();
    await w.tick();
    expect(calls).toHaveLength(1);
    expect(runs[0]?.status).toBe("escalated");
    pr = { ...pr, head: { sha: "f".repeat(40), repo: null } };
    await w.tick();
    expect(calls).toHaveLength(2);
  });

  test("no recheck on push: a reviewed PR is not re-checked after new commits", async () => {
    results = [{ outcome: "rejected", message: "outside safe paths", reviewed: true }];
    const w = watcher({ recheckOnPush: false });
    await w.tick();
    expect(calls).toHaveLength(1);
    pr = { ...pr, head: { sha: "f".repeat(40), repo: null } };
    await w.tick();
    expect(calls).toHaveLength(1);
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergePrDecisionKey(REPO, 7, ""))).toBe(true);
  });

  test("no recheck on push: a rejection without an agent review is re-checked on new commits", async () => {
    results = [
      { outcome: "rejected", message: "src/x.ts matches deny pattern src/**", reviewed: false },
      { outcome: "rejected", message: "agent review: risky", reviewed: true },
    ];
    const w = watcher({ recheckOnPush: false });
    await w.tick();
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergePrDecisionKey(REPO, 7, ""))).toBe(false);
    pr = { ...pr, head: { sha: "f".repeat(40), repo: null } };
    await w.tick();
    expect(calls).toHaveLength(2);
    // The agent review is final for the PR.
    pr = { ...pr, head: { sha: "e".repeat(40), repo: null } };
    await w.tick();
    expect(calls).toHaveLength(2);
  });

  test("no recheck on push: a policy change still re-checks the PR", async () => {
    results = [{ outcome: "rejected", message: "outside safe paths", reviewed: true }];
    const w = watcher({ recheckOnPush: false });
    await w.tick();
    pr = { ...pr, head: { sha: "f".repeat(40), repo: null } };
    fingerprint = "widened";
    await w.tick();
    expect(calls).toHaveLength(2);
  });

  test("no recheck on push: waiting and failures below the cap are not a decision", async () => {
    results = [
      { outcome: "waiting", message: "changes requested", reviewed: false },
      { outcome: "failed", message: "boom", reviewed: false },
    ];
    const w = watcher({ recheckOnPush: false });
    await w.tick();
    now += 10 * 60_000 + 1;
    await w.tick();
    now += 5 * 60_000 + 1;
    pr = { ...pr, head: { sha: "f".repeat(40), repo: null } };
    await w.tick();
    expect(calls).toHaveLength(3);
  });

  test("no recheck on push: exhausting the failure cap gives up on the head, not the PR", async () => {
    results = Array.from({ length: 3 }, () => ({
      outcome: "failed" as const,
      message: "boom",
      reviewed: false,
    }));
    const w = watcher({ recheckOnPush: false });
    for (let i = 0; i < 4; i++) {
      await w.tick();
      now += 60 * 60_000;
    }
    expect(calls).toHaveLength(3);
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergeDecisionKey(REPO, 7, HEAD, ""))).toBe(
      true,
    );
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergePrDecisionKey(REPO, 7, ""))).toBe(false);
    // A new commit gets one real decision, which then is final for the PR.
    pr = { ...pr, head: { sha: "f".repeat(40), repo: null } };
    results = [{ outcome: "rejected", message: "outside safe paths", reviewed: true }];
    await w.tick();
    expect(calls).toHaveLength(4);
    expect(calls[3]?.sha).toBe("f".repeat(40));
    pr = { ...pr, head: { sha: "e".repeat(40), repo: null } };
    now += 60 * 60_000;
    await w.tick();
    expect(calls).toHaveLength(4);
  });

  test("no recheck on push: turning it off skips PRs reviewed while it was on", async () => {
    let recheckOnPush = true;
    results = [{ outcome: "rejected", message: "no", reviewed: true }];
    const w = new AutoMergeWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      enabled: () => true,
      now: () => now,
      quietSeconds: 0,
      recheckOnPush: () => recheckOnPush,
      fetchPr: async () => ({ data: pr, notModified: false }),
      mergePr: async (_repo, prNumber, sha) => {
        calls.push({ prNumber, sha });
        return results.shift() ?? { outcome: "rejected", message: "no", reviewed: true };
      },
    });
    await w.tick();
    recheckOnPush = false;
    pr = { ...pr, head: { sha: "f".repeat(40), repo: null } };
    await w.tick();
    expect(calls).toHaveLength(1);
  });

  test("waiting backs off without recording a decision or a run", async () => {
    results = [{ outcome: "waiting", message: "changes requested", reviewed: false }];
    const w = watcher();
    await w.tick();
    now += 60_000;
    await w.tick();
    expect(calls).toHaveLength(1);
    now += 10 * 60_000;
    await w.tick();
    expect(calls).toHaveLength(2);
    // The waiting check was shown live, then discarded.
    expect(liveRuns()).toEqual([{ origin: "auto_merge", status: "succeeded" }]);
  });

  test("a CI wait stays waiting on the same head and is kept on the dashboard once", async () => {
    const noChecks = {
      outcome: "waiting" as const,
      message:
        "Ready gate: No CI checks reported for this commit; auto-merge needs at least one passing check.",
      reviewed: false,
      ciWait: true,
    };
    results = [noChecks, noChecks, { outcome: "merged", message: "ok", reviewed: false }];
    const w = watcher();
    await w.tick();
    now += 10 * 60_000 + 1;
    await w.tick();
    // Not a decision: the same head is checked again and can merge once CI passes.
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergeDecisionKey(REPO, 7, HEAD))).toBe(false);
    now += 10 * 60_000 + 1;
    await w.tick();
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.sha === HEAD)).toBe(true);
    // Re-checks pass the wait the PR already shows, so it is not re-posted.
    expect(calls.map((call) => call.ciWaitPosted)).toEqual([
      undefined,
      noChecks.message,
      noChecks.message,
    ]);
    // The first CI wait is kept with its reason; the identical repeat is discarded.
    expect(liveRuns()).toEqual([
      { origin: "auto_merge", status: "escalated" },
      { origin: "auto_merge", status: "succeeded" },
    ]);
  });

  test("a pending-checks wait is quiet: no escalated run, and a shrinking list is one wait", async () => {
    pr = { ...pr, mergeable_state: "unstable" };
    const pending = (names: string) => ({
      outcome: "waiting" as const,
      message: `Ready gate: CI checks are still pending: ${names}.`,
      reviewed: false,
      ciWait: true,
      ciWaitProblem: "pending" as const,
    });
    results = [
      pending("lint, test"),
      pending("test"),
      {
        outcome: "waiting",
        message: "Ready gate: CI check failed: test.",
        reviewed: false,
        ciWait: true,
        ciWaitProblem: "failing",
      },
    ];
    const w = watcher();
    await w.tick();
    now += 10 * 60_000 + 1;
    await w.tick();
    now += 10 * 60_000 + 1;
    await w.tick();
    expect(calls).toHaveLength(3);
    // Both pending checks pass the same key, so the comment is not re-posted.
    expect(calls.map((call) => call.ciWaitPosted)).toEqual([undefined, "ci-pending", "ci-pending"]);
    // Only the failure is an escalation; the pending checks were discarded.
    expect(liveRuns()).toEqual([{ origin: "auto_merge", status: "escalated" }]);
  });

  test("a no-checks wait on the same head backs off 10, 20, 40, then 60 minutes", async () => {
    const noChecks = {
      outcome: "waiting" as const,
      message:
        "Ready gate: No CI checks reported for this commit; auto-merge needs at least one passing check.",
      reviewed: false,
      ciWait: true,
      ciWaitProblem: "no-checks" as const,
    };
    results = Array.from({ length: 6 }, () => noChecks);
    const w = watcher();
    await w.tick();
    expect(calls).toHaveLength(1);
    const gaps: number[] = [];
    let last = now;
    for (let minute = 1; minute <= 200 && calls.length < 6; minute++) {
      now += 60_000;
      const before = calls.length;
      await w.tick();
      if (calls.length > before) {
        gaps.push((now - last) / 60_000);
        last = now;
      }
    }
    expect(gaps).toEqual([10, 20, 40, 60, 60]);
    // Mid-backoff, a check starting (state change) is evaluated right away...
    now += 60_000;
    pr = { ...pr, mergeable_state: "unstable" };
    results = [noChecks];
    await w.tick();
    expect(calls).toHaveLength(7);
    // ...and so is a push (a new head, which also starts over at 10 minutes).
    now += 60_000;
    pr = { ...pr, head: { ...pr.head, sha: "b".repeat(40) } };
    results = [noChecks, noChecks];
    await w.tick();
    expect(calls.at(-1)?.sha).toBe("b".repeat(40));
    now += 10 * 60_000;
    await w.tick();
    expect(calls).toHaveLength(9);
  });

  test("a policy change ends a no-checks backoff early", async () => {
    const noChecks = {
      outcome: "waiting" as const,
      message:
        "Ready gate: No CI checks reported for this commit; auto-merge needs at least one passing check.",
      reviewed: false,
      ciWait: true,
      ciWaitProblem: "no-checks" as const,
    };
    fingerprint = "p1";
    results = [noChecks, noChecks, noChecks];
    const w = watcher();
    await w.tick();
    now += 10 * 60_000;
    await w.tick();
    now += 20 * 60_000;
    await w.tick();
    expect(calls).toHaveLength(3);
    // Inside the 40-minute backoff, the same policy keeps the PR held...
    now += 60_000;
    await w.tick();
    expect(calls).toHaveLength(3);
    // ...and a policy change (e.g. require_checks turned on) re-checks it now.
    fingerprint = "p2";
    now += 60_000;
    await w.tick();
    expect(calls).toHaveLength(4);
  });

  test("a failing-check wait backs off like a static wait and ends early when CI turns green", async () => {
    pr = { ...pr, mergeable_state: "unstable" };
    const failing = {
      outcome: "waiting" as const,
      message: "Ready gate: CI check failing on this commit: lint (failure).",
      reviewed: false,
      ciWait: true,
      ciWaitProblem: "failing" as const,
    };
    results = Array.from({ length: 4 }, () => failing);
    const w = watcher();
    await w.tick();
    const gaps: number[] = [];
    let last = now;
    for (let minute = 1; minute <= 200 && calls.length < 4; minute++) {
      now += 60_000;
      const before = calls.length;
      await w.tick();
      if (calls.length > before) {
        gaps.push((now - last) / 60_000);
        last = now;
      }
    }
    expect(gaps).toEqual([10, 20, 40]);
    // A re-run passes: GitHub reports the PR clean, evaluated mid-backoff.
    now += 60_000;
    pr = { ...pr, mergeable_state: "clean" };
    await w.tick();
    expect(calls).toHaveLength(5);
  });

  test("a repeated blocked non-CI hold rechecks after 30, 60, then 120 minutes", async () => {
    pr = { ...pr, mergeable_state: "blocked" };
    results = Array.from({ length: 5 }, () => ({
      outcome: "waiting" as const,
      message: "blocked by branch protection",
      reviewed: false,
    }));
    const w = watcher();
    await w.tick();
    const gaps: number[] = [];
    let last = now;
    for (let minute = 1; minute <= 400 && calls.length < 5; minute++) {
      now += 60_000;
      const before = calls.length;
      await w.tick();
      if (calls.length > before) {
        gaps.push((now - last) / 60_000);
        last = now;
      }
    }
    expect(gaps).toEqual([30, 60, 120, 120]);
  });

  test("a changes-requested wait keeps the plain backoff and is not fetched during it", async () => {
    let fetches = 0;
    results = [{ outcome: "waiting", message: "changes requested", reviewed: false }];
    const w = new AutoMergeWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      enabled: () => true,
      now: () => now,
      quietSeconds: 0,
      fetchPr: async () => {
        fetches++;
        return { data: pr, notModified: false };
      },
      mergePr: async () => results.shift() ?? { outcome: "merged", message: "ok", reviewed: false },
    });
    await w.tick();
    now += 60_000;
    pr = { ...pr, mergeable_state: "unstable" };
    await w.tick();
    expect(fetches).toBe(1);
  });

  test("failures retry with backoff and give up after the cap", async () => {
    results = Array.from({ length: 5 }, () => ({
      outcome: "failed" as const,
      message: "boom",
      reviewed: false,
    }));
    const w = watcher();
    for (let i = 0; i < 6; i++) {
      await w.tick();
      now += 60 * 60_000;
    }
    expect(calls).toHaveLength(3);
    // Only the final attempt is flagged, so only it states the failure on the PR.
    expect(calls.map((call) => call.lastAttempt ?? false)).toEqual([false, false, true]);
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergeDecisionKey(REPO, 7, HEAD))).toBe(true);
  });

  test("a usage limit waits for the quota reset, keeps the PR, and shows as deferred", async () => {
    const resetAt = now + 3 * 60 * 60_000;
    results = [
      { outcome: "deferred", message: "agent usage limit", reviewed: false, retryAt: resetAt },
    ];
    const w = watcher();
    await w.tick();
    expect(calls).toHaveLength(1);
    expect(liveRuns()).toEqual([{ origin: "auto_merge", status: "deferred" }]);
    // Hourly passes before the reset never relaunch the check into the limit.
    for (let i = 0; i < 2; i++) {
      now += 60 * 60_000;
      await w.tick();
    }
    expect(calls).toHaveLength(1);
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergeDecisionKey(REPO, 7, HEAD))).toBe(false);
    // The first pass after the reset reviews it; the deferral cost no attempt.
    now = resetAt + 1;
    await w.tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.lastAttempt).toBeUndefined();
  });

  test("a deferral without a reset time retries after the floor and is not kept as a run", async () => {
    results = [{ outcome: "deferred", message: "queue full", reviewed: false }];
    const w = watcher();
    await w.tick();
    expect(liveRuns()).toEqual([]);
    now += 5 * 60_000 + 1;
    await w.tick();
    expect(calls).toHaveLength(2);
  });
});

describe("AutoMergeWatcherAcquirer dashboard hooks", () => {
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;
  let calls: number;
  let enabled: boolean;
  let fingerprint: string;
  let now: number;

  const make = (quietSeconds = 300) =>
    new AutoMergeWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      enabled: () => enabled,
      now: () => now,
      quietSeconds,
      policyFingerprint: () => fingerprint,
      fetchPr: async () => ({
        data: { state: "open", mergeable_state: "clean", head: { sha: HEAD, repo: null } },
        notModified: false,
      }),
      mergePr: async () => {
        calls += 1;
        return { outcome: "rejected", message: "outside safe paths", reviewed: false };
      },
    });

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `auto-merge-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
    workerState.recordAgentPr({ repo: REPO, prNumber: 7 });
    calls = 0;
    enabled = true;
    fingerprint = "p1";
    now = 1_000_000;
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });

  test("status is null while disabled and Run now refuses", () => {
    enabled = false;
    const w = make();
    expect(w.status()).toBeNull();
    expect(w.runNow()).toEqual({ ok: false, reason: expect.stringContaining("disabled") });
  });

  test("Run now skips the quiet period", async () => {
    const w = make();
    await w.tick();
    expect(calls).toBe(0); // head not quiet yet
    expect(w.runNow()).toEqual({ ok: true });
    await Bun.sleep(0);
    await w.tick(); // settle the triggered pass
    expect(calls).toBe(1);
    expect(w.status()).toMatchObject({ intervalSeconds: 60, running: false });
  });

  test("a policy change re-evaluates a PR decided under the old policy", async () => {
    const w = make(0);
    await w.tick();
    await w.tick();
    expect(calls).toBe(1);
    fingerprint = "p2";
    await w.tick();
    expect(calls).toBe(2);
  });
});

describe("auto-merge CLI protocol", () => {
  test("retry time comes from the child's usage-limit hint", () => {
    const now = 1_000_000;
    expect(usageLimitRetryAt({ untilMs: now + 5_000 }, now)).toBe(now + 5_000);
    // A stale hint falls back to the period floor, then the generic fallback.
    expect(usageLimitRetryAt({ untilMs: now - 1, period: "daily" }, now)).toBe(
      now + 4 * 60 * 60_000,
    );
    expect(usageLimitRetryAt({}, now)).toBe(now + 60 * 60_000);
  });

  test("a pinned harness's usage limit defers until the child's reset hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-merge-cli-"));
    const entrypoint = join(dir, "stub-cli.ts");
    // Stands in for `devintern auto-merge`: reports a usage limit like the CLI does.
    writeFileSync(
      entrypoint,
      `import { writeFileSync } from "fs";
writeFileSync(process.env.DEVINTERN_USAGE_LIMIT_FILE!, JSON.stringify({ untilMs: 4102444800000 }));
process.exit(75);
`,
    );
    try {
      const result = await runAutoMergeViaCli("acme/pinned", 1, {
        policy: { safePaths: [], denyPaths: [], review: true, method: "squash" },
        expectedHeadSha: HEAD,
        harnessPin: "claude-code",
        entrypoint,
        env: { ...process.env },
      });
      expect(result).toMatchObject({ outcome: "deferred", retryAt: 4102444800000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("policy round-trips into flags", () => {
    expect(
      autoMergeCliArgs(
        { safePaths: ["docs/**"], denyPaths: ["db/**"], review: false, method: "merge" },
        HEAD,
        { lastAttempt: true },
      ),
    ).toEqual([
      "--expected-head",
      HEAD,
      "--last-attempt",
      "--method",
      "merge",
      "--no-review",
      "--safe-path",
      "docs/**",
      "--deny-path",
      "db/**",
    ]);
  });

  test("the review label maps to --review-label, empty to --no-review-label", () => {
    const policy = { safePaths: [], denyPaths: [], review: true, method: "squash" as const };
    expect(autoMergeCliArgs({ ...policy, reviewLabel: "triage" }, HEAD).slice(-2)).toEqual([
      "--review-label",
      "triage",
    ]);
    expect(autoMergeCliArgs({ ...policy, reviewLabel: "" }, HEAD).at(-1)).toBe("--no-review-label");
    expect(autoMergeCliArgs(policy, HEAD)).not.toContain("--review-label");
  });

  test("recheckOnPush false maps to --no-recheck-on-push", () => {
    const policy = { safePaths: [], denyPaths: [], review: true, method: "squash" as const };
    const flag = "--no-recheck-on-push";
    expect(autoMergeCliArgs({ ...policy, recheckOnPush: false }, HEAD)).toContain(flag);
    expect(autoMergeCliArgs({ ...policy, recheckOnPush: true }, HEAD)).not.toContain(flag);
    expect(autoMergeCliArgs(policy, HEAD)).not.toContain(flag);
  });

  test("review policy and instructions map to --policy and --review-instructions=", () => {
    const policy = { safePaths: [], denyPaths: [], review: true, method: "squash" as const };
    expect(autoMergeCliArgs(policy, HEAD)).not.toContain("--policy");
    const args = autoMergeCliArgs(
      { ...policy, reviewPolicy: "standard", reviewInstructions: "- keep billing/ manual" },
      HEAD,
    );
    expect(args).toContain("--policy");
    expect(args[args.indexOf("--policy") + 1]).toBe("standard");
    expect(args).toContain("--review-instructions=- keep billing/ manual");
  });

  test("parses the last valid result record", () => {
    expect(
      parseAutoMergeResultLine(
        'garbage\n{"outcome":"waiting","message":"x"}\n{"outcome":"merged","message":"ok","reviewed":true}\n',
      ),
    ).toEqual({ outcome: "merged", message: "ok", reviewed: true });
    expect(parseAutoMergeResultLine('{"outcome":"approved","message":"x"}')).toBeNull();
  });
});
