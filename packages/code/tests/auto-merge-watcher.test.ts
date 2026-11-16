import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  AUTO_MERGE_SOURCE,
  AutoMergeWatcherAcquirer,
  autoMergeDecisionKey,
} from "../src/lib/acquirers/auto-merge-watcher";
import type { AutoMergePolledPr } from "../src/lib/acquirers/auto-merge-watcher";
import { autoMergeCliArgs, parseAutoMergeResultLine } from "../src/lib/acquirers/auto-merge-cli";
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
  let calls: Array<{ prNumber: number; sha: string }>;
  let results: AutoMergeResult[];
  let enabled: boolean;
  let runs: Array<{ origin: string; status?: string }>;

  const watcher = (extra: { quietSeconds?: number } = {}) =>
    new AutoMergeWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      enabled: () => enabled,
      now: () => now,
      quietSeconds: extra.quietSeconds ?? 0,
      fetchPr: async () => ({ data: pr, notModified: false }),
      mergePr: async (_repo, prNumber, sha) => {
        calls.push({ prNumber, sha });
        return results.shift() ?? { outcome: "merged", message: "ok", reviewed: false };
      },
      runStore: {
        createRun: (meta) => {
          runs.push({ origin: meta.origin });
          return runs.length;
        },
        finishRun: (id, status) => {
          (runs[id - 1] as { status?: string }).status = status;
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
    expect(runs).toHaveLength(1); // the second (merged) attempt only
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
    expect(queue.hasProcessed(AUTO_MERGE_SOURCE, autoMergeDecisionKey(REPO, 7, HEAD))).toBe(true);
  });
});

describe("auto-merge CLI protocol", () => {
  test("policy round-trips into flags", () => {
    expect(
      autoMergeCliArgs(
        { safePaths: ["docs/**"], denyPaths: ["db/**"], review: false, method: "merge" },
        HEAD,
      ),
    ).toEqual([
      "--expected-head",
      HEAD,
      "--method",
      "merge",
      "--no-review",
      "--safe-path",
      "docs/**",
      "--deny-path",
      "db/**",
    ]);
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
