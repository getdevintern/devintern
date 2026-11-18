/**
 * `start()` on polling acquirers must not await their first tick.
 *
 * `startWorker` starts acquirers one after another, so a first tick that runs
 * agents (conflict resolution, CI fixes, merge reviews, task executions) used
 * to hold every later acquirer, the relay included, for as long as it took.
 * Each case below gates the first awaited dependency of the real `tick()` so
 * the tick stays pending, then checks that:
 *
 * - `start()` resolves while the first tick is still in flight;
 * - interval fires during that tick do not start a second, overlapping tick;
 * - `stop()` clears the armed interval while the in-flight tick finishes.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { AutoMergeWatcherAcquirer } from "../src/lib/acquirers/auto-merge-watcher";
import { CiFailureWatcherAcquirer } from "../src/lib/acquirers/ci-failure-watcher";
import { GitLabReviewPollingAcquirer } from "../src/lib/acquirers/gitlab-review-polling";
import { MentionSweepAcquirer } from "../src/lib/acquirers/mention-sweep";
import { ReviewPollingAcquirer } from "../src/lib/acquirers/review-polling";
import { TaskPollingAcquirer } from "../src/lib/acquirers/task-polling";
import { createGitHubCiProvider } from "../src/lib/code-host/github/ci-provider";
import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";
import type { AgentPr } from "../src/lib/state/worker-state";
import { resetWorkerFailover } from "../src/lib/worker/failover";
import { RetryQueueAcquirer } from "../src/lib/workspace/retry-acquirer";
import { startWorker } from "../src/worker";
import type { Acquirer } from "../src/worker";
import type { LockManager } from "../src/lib/lock-manager";

interface Gate {
  /** Times the gated dependency was entered (one per real tick reaching it). */
  calls: number;
  /** Entered by the gated dependency; resolves once `release()` runs. */
  wait(): Promise<void>;
  release(): void;
}

function makeGate(): Gate {
  let release!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- controlled tick gate.
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate: Gate = {
    calls: 0,
    wait: async () => {
      gate.calls++;
      await promise;
    },
    release,
  };
  return gate;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    // oxlint-disable-next-line promise/avoid-new -- polling delay.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Whether `promise` settles within `ms` (the gated tick never does). */
async function settlesWithin(promise: Promise<unknown>, ms = 500): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    // oxlint-disable-next-line promise/avoid-new -- race timeout.
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

const flush = () =>
  // oxlint-disable-next-line promise/avoid-new -- let queued microtasks/timers run.
  new Promise((resolve) => setTimeout(resolve, 20));

interface StartableAcquirer {
  start(): Promise<void>;
  stop(): void | Promise<void>;
}

let dir: string;
let workerState: WorkerState;
let queue: WebhookQueue;
let retryStore: ScheduledRetryStore;
let intervalCallbacks: Array<() => void>;
const intervalHandle = { fake: "interval" } as unknown as ReturnType<typeof setInterval>;
let clearIntervalSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetWorkerFailover();
  dir = mkdtempSync(join(tmpdir(), "acquirer-start-nonblocking-"));
  const dbPath = join(dir, "queue.db");
  workerState = new WorkerState(dbPath);
  queue = new WebhookQueue({ dbPath });
  retryStore = new ScheduledRetryStore(dbPath);
  intervalCallbacks = [];
  spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    intervalCallbacks.push(callback);
    return intervalHandle;
  }) as unknown as typeof setInterval);
  clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(
    (() => undefined) as unknown as typeof clearInterval,
  );
  spyOn(console, "log").mockImplementation(() => undefined);
  spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  mock.restore();
  workerState.close();
  queue.close();
  retryStore.close();
  rmSync(dir, { recursive: true, force: true });
  resetWorkerFailover();
});

function gitlabMr(): AgentPr {
  return {
    provider: "gitlab",
    instanceUrl: "https://gitlab.com",
    projectId: "42",
    projectPath: "acme/widgets",
    changeNumber: 17,
    webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
    repo: "acme/widgets",
    prNumber: 17,
    state: "open",
    createdAt: Date.parse("2026-09-09T00:00:00Z"),
    updatedAt: Date.parse("2026-09-09T00:00:00Z"),
  };
}

/** Builds each acquirer with its tick's first awaited dependency gated. */
const cases: Array<{ name: string; build: (gate: Gate) => StartableAcquirer }> = [
  {
    name: "ReviewPollingAcquirer",
    build: (gate) => {
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
      return new ReviewPollingAcquirer({
        intervalSeconds: 60,
        workerState,
        queue,
        github: {
          fetchPr: async () => {
            await gate.wait();
            // Gone: the tick unwatches the PR and ends without a second fetch.
            return { data: null, notModified: false, gone: true };
          },
          fetchReviews: async () => ({ data: [], notModified: false }),
          fetchReviewCommentsSince: async () => [],
        },
        addressPr: async () => true,
      });
    },
  },
  {
    name: "CiFailureWatcherAcquirer",
    build: (gate) => {
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
      return new CiFailureWatcherAcquirer({
        intervalSeconds: 60,
        workerState,
        queue,
        provider: createGitHubCiProvider({
          fetchPr: async () => {
            await gate.wait();
            return { data: null, notModified: true };
          },
          fetchWorkflowRuns: async () => ({ data: null, notModified: true }),
          fetchCommitStatus: async () => ({ data: null, notModified: true }),
          fetchFailingJobLogs: async () => null,
          postComment: async () => {},
        }),
        fixPr: async () => true,
        verbose: false,
      });
    },
  },
  {
    name: "AutoMergeWatcherAcquirer",
    build: (gate) => {
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
      return new AutoMergeWatcherAcquirer({
        intervalSeconds: 60,
        workerState,
        queue,
        enabled: () => true,
        quietSeconds: 0,
        fetchPr: async () => {
          await gate.wait();
          return { data: null, notModified: true };
        },
        mergePr: async () => ({ outcome: "merged", message: "ok", reviewed: false }),
        runStore: { createRun: () => 1, finishRun: () => {}, discardRun: () => {} },
      });
    },
  },
  {
    name: "MentionSweepAcquirer",
    build: (gate) =>
      new MentionSweepAcquirer({
        repo: "acme/widgets",
        intervalSeconds: 60,
        workerState,
        queue,
        github: {
          fetchIssueCommentsSince: async () => [],
          fetchReviewCommentsSince: async () => [],
          getBotUsername: async () => {
            await gate.wait();
            return null;
          },
          getPr: async (prNumber) => ({ number: prNumber, state: "open" }),
          postComment: async () => {},
        },
        handleMention: async () => true,
      }),
  },
  {
    name: "GitLabReviewPollingAcquirer",
    build: (gate) =>
      new GitLabReviewPollingAcquirer({
        intervalSeconds: 60,
        workerState: {
          listOpenAgentChangeRequests: () => [gitlabMr()],
          markAgentChangeRequestClosed: () => {},
        },
        queue: { hasProcessed: () => false, markProcessed: () => {} },
        clientFor: () => ({
          getPollingSnapshot: async () => {
            await gate.wait();
            // Failing after release also proves the backgrounded first tick's
            // rejection is caught rather than left unhandled.
            throw new Error("snapshot unavailable");
          },
          getMemberAccessLevel: async () => 30,
        }),
        addressMr: async () => true,
      }),
  },
  {
    name: "RetryQueueAcquirer",
    build: (gate) => {
      retryStore.schedule({ taskKey: "PROJ-1", actor: "a@x.com" });
      return new RetryQueueAcquirer({
        store: retryStore,
        isPaused: () => false,
        execute: async () => {
          await gate.wait();
          return true;
        },
        intervalSeconds: 60,
      });
    },
  },
  {
    name: "TaskPollingAcquirer",
    build: (gate) =>
      new TaskPollingAcquirer({
        trackerType: "markdown",
        query: "status=todo",
        intervalSeconds: 60,
        detector: {
          source: "markdown",
          changesSince: async () => {
            await gate.wait();
            return { changed: false, nextCursor: "1" };
          },
        },
        workerState,
        queue,
        searchTasks: async () => ({ tasks: [] }),
        executeTask: async () => true,
      }),
  },
];

describe.each(cases)("$name start()", ({ build }) => {
  test("resolves while the first tick is still pending", async () => {
    const gate = makeGate();
    const acquirer = build(gate);
    try {
      expect(await settlesWithin(acquirer.start())).toBe(true);
      // The immediate first tick still runs, and is still in flight.
      await waitFor(() => gate.calls === 1);
      expect(intervalCallbacks).toHaveLength(1);
    } finally {
      gate.release();
      await acquirer.stop();
      await flush();
    }
  });

  test("an interval fire during the slow first tick does not overlap it", async () => {
    const gate = makeGate();
    const acquirer = build(gate);
    try {
      await acquirer.start();
      await waitFor(() => gate.calls === 1);
      intervalCallbacks[0]!();
      intervalCallbacks[0]!();
      await flush();
      expect(gate.calls).toBe(1);
    } finally {
      gate.release();
      await acquirer.stop();
      await flush();
    }
  });

  test("stop() during the first tick lets it finish and arms no further tick", async () => {
    const gate = makeGate();
    const acquirer = build(gate);
    await acquirer.start();
    await waitFor(() => gate.calls === 1);

    await acquirer.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
    gate.release();
    await flush();
    expect(gate.calls).toBe(1);
    // No unhandled rejection surfaced from the backgrounded tick, and only
    // the one interval armed by start() exists.
    expect(intervalCallbacks).toHaveLength(1);
  });
});

test("a failing backgrounded first tick is logged, not left unhandled", async () => {
  const warn = console.warn as unknown as ReturnType<typeof spyOn>;
  const gate = makeGate();
  const acquirer = new RetryQueueAcquirer({
    store: retryStore,
    isPaused: () => false,
    execute: async () => true,
    intervalSeconds: 60,
  });
  // Force the first tick itself to reject (the real tick catches per-row
  // failures internally, so stub it to exercise the start() safety net).
  acquirer.tick = async () => {
    await gate.wait();
    throw new Error("store exploded");
  };
  await acquirer.start();
  gate.release();
  await waitFor(() =>
    warn.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes("[retry-queue] first poll failed: store exploded"),
    ),
  );
  acquirer.stop();
});

describe("startWorker", () => {
  test("starts a later acquirer without waiting for an earlier watcher's first tick", async () => {
    const gate = makeGate();
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const ciWatcher = new CiFailureWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      provider: createGitHubCiProvider({
        fetchPr: async () => {
          await gate.wait();
          return { data: null, notModified: true };
        },
        fetchWorkflowRuns: async () => ({ data: null, notModified: true }),
        fetchCommitStatus: async () => ({ data: null, notModified: true }),
        fetchFailingJobLogs: async () => null,
        postComment: async () => {},
      }),
      fixPr: async () => true,
      verbose: false,
    });
    let relayStarted = false;
    const relay: Acquirer = {
      name: "relay",
      start: () => {
        relayStarted = true;
      },
      stop: () => {},
    };
    const lock = {
      acquire: () => ({ success: true, message: "" }),
      release: () => {},
    } as unknown as LockManager;
    let started: string[] | undefined;

    // startWorker initializes error tracking once per process; keep that
    // one-shot latch untouched for sentry-init.test.ts in the same run.
    const sentryInit = await import("../src/lib/observability/sentry-init");
    spyOn(sentryInit, "initSentryOnce").mockImplementation(() => undefined);
    const sigint = process.listeners("SIGINT");
    const sigterm = process.listeners("SIGTERM");
    try {
      const startup = startWorker(
        {
          lock,
          onStarted: (names) => {
            started = names;
          },
        },
        [ciWatcher, relay],
      );
      expect(await settlesWithin(startup)).toBe(true);
      expect(relayStarted).toBe(true);
      expect(started).toEqual(["poll:ci-failures", "relay"]);
      // The CI watcher's first tick is still in flight.
      await waitFor(() => gate.calls === 1);
    } finally {
      gate.release();
      ciWatcher.stop();
      // Drop the SIGINT/SIGTERM shutdown handlers startWorker registered.
      for (const [signal, before] of [
        ["SIGINT", sigint],
        ["SIGTERM", sigterm],
      ] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before.includes(listener))
            (process as NodeJS.EventEmitter).removeListener(signal, listener);
        }
      }
      await flush();
    }
  });
});
