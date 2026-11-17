import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  AUTO_MERGE_SOURCE,
  AutoMergeWatcherAcquirer,
  autoMergeDecisionKey,
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
  let calls: Array<{ prNumber: number; sha: string; lastAttempt?: boolean }>;
  let results: AutoMergeResult[];
  let enabled: boolean;
  let runs: Array<{ origin: string; status?: string; harness?: string } | null>;
  let statusDuringMerge: Array<string | undefined>;
  let fingerprint: string | undefined;

  const liveRuns = () => runs.filter((run) => run !== null);
  const watcher = (extra: { quietSeconds?: number; harness?: string } = {}) =>
    new AutoMergeWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      enabled: () => enabled,
      now: () => now,
      quietSeconds: extra.quietSeconds ?? 0,
      fetchPr: async () => ({ data: pr, notModified: false }),
      mergePr: async (_repo, prNumber, sha, { lastAttempt }) => {
        calls.push({ prNumber, sha, ...(lastAttempt ? { lastAttempt } : {}) });
        statusDuringMerge.push(runs.at(-1)?.status);
        return results.shift() ?? { outcome: "merged", message: "ok", reviewed: false };
      },
      harness: () => extra.harness,
      policyFingerprint: () => fingerprint ?? "",
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
    [{ mergeable_state: "unstable" }],
    [{ mergeable_state: "blocked" }],
    [{ draft: true }],
    [{ state: "closed" }],
    [{ head: { sha: HEAD, repo: { full_name: "fork/widgets" } } }],
  ])("skips PRs that are not ready: %o", async (overrides) => {
    pr = { ...pr, ...overrides };
    await watcher().tick();
    expect(calls).toHaveLength(0);
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

  test("parses the last valid result record", () => {
    expect(
      parseAutoMergeResultLine(
        'garbage\n{"outcome":"waiting","message":"x"}\n{"outcome":"merged","message":"ok","reviewed":true}\n',
      ),
    ).toEqual({ outcome: "merged", message: "ok", reviewed: true });
    expect(parseAutoMergeResultLine('{"outcome":"approved","message":"x"}')).toBeNull();
  });
});
