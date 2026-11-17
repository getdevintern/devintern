import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { RUN_ORIGIN_ENV } from "../src/lib/observability/analytics";
import { actionedSourceKeyFromEnv } from "../src/lib/task/actioned-state";
import {
  isFinalPrDeliveryAttempt,
  MAX_PR_DELIVERY_ATTEMPTS,
  prDeliveryFailuresKey,
  recordActionedWithoutPr,
} from "../src/lib/task/actioned-without-pr";
import { WorkerState } from "../src/lib/state/worker-state";
import type { TaskTrackerClient } from "../src/lib/trackers/client";
import type { Task } from "../src/types/task-tracker";

const task: Task = {
  key: "PROJ-7",
  summary: "Add export",
  issueType: "Task",
  status: "In Progress",
  reporter: "alice",
  labels: ["intern"],
  components: [],
  fixVersions: [],
  created: "",
  updated: "2026-01-01T00:00:00Z",
  raw: { description: "Implement the export" },
};

function fakeTracker(getTask: () => Promise<Task> = async () => task): TaskTrackerClient {
  return {
    getTask,
    extractDescriptionText: () => "Implement the export",
  } as unknown as TaskTrackerClient;
}

describe("recordActionedWithoutPr", () => {
  let dir: string;
  let dbPath: string;
  const originalOrigin = process.env[RUN_ORIGIN_ENV];
  const open = () => new WorkerState(dbPath);
  const marker = () => {
    const state = open();
    try {
      return state.getTaskActioned(actionedSourceKeyFromEnv(), task.key);
    } finally {
      state.close();
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "actioned-without-pr-"));
    dbPath = join(dir, "queue.db");
    process.env[RUN_ORIGIN_ENV] = "worker";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalOrigin === undefined) delete process.env[RUN_ORIGIN_ENV];
    else process.env[RUN_ORIGIN_ENV] = originalOrigin;
  });

  test("records a verified marker for a worker run with no PR", async () => {
    const outcome = await recordActionedWithoutPr({
      tracker: fakeTracker(),
      task,
      taskKey: task.key,
      openWorkerState: open,
    });

    expect(outcome).toBe("marked");
    expect(marker()?.verified).toBe(true);
  });

  test("keeps an existing marker untouched", async () => {
    const state = open();
    state.markTaskActioned(actionedSourceKeyFromEnv(), task.key, "pr-signal", true, "pr-stamp");
    state.close();
    let reads = 0;

    const outcome = await recordActionedWithoutPr({
      tracker: fakeTracker(async () => {
        reads++;
        return task;
      }),
      task,
      taskKey: task.key,
      openWorkerState: open,
    });

    expect(outcome).toBe("already-marked");
    expect(reads).toBe(0);
    expect(marker()?.signal).toBe("pr-signal");
  });

  test("records an unverified marker when the tracker re-read fails", async () => {
    const outcome = await recordActionedWithoutPr({
      tracker: fakeTracker(async () => {
        throw new Error("503");
      }),
      task,
      taskKey: task.key,
      openWorkerState: open,
      rereadDelayMs: 0,
    });

    expect(outcome).toBe("marked");
    expect(marker()?.verified).toBe(false);
  });

  test("never throws when the state DB fails", async () => {
    const outcome = await recordActionedWithoutPr({
      tracker: fakeTracker(),
      task,
      taskKey: task.key,
      openWorkerState: () => {
        throw new Error("database is locked");
      },
    });

    expect(outcome).toBe("error");
  });

  test("skips interactive runs", async () => {
    delete process.env[RUN_ORIGIN_ENV];

    const outcome = await recordActionedWithoutPr({
      tracker: fakeTracker(),
      task,
      taskKey: task.key,
      openWorkerState: open,
    });

    expect(outcome).toBe("not-worker");
    expect(marker()).toBeNull();
  });

  test("leaves the ticket in the sweep after a retryable PR failure", async () => {
    const outcome = await recordActionedWithoutPr({
      tracker: fakeTracker(),
      task,
      taskKey: task.key,
      prCreationFailure: "GitHub API 502 Bad Gateway",
      openWorkerState: open,
    });

    expect(outcome).toBe("pr-failed");
    expect(marker()).toBeNull();
  });

  const failures = () => {
    const state = open();
    try {
      return state.getMeta(prDeliveryFailuresKey(actionedSourceKeyFromEnv(), task.key));
    } finally {
      state.close();
    }
  };
  const failedRun = () =>
    recordActionedWithoutPr({
      tracker: fakeTracker(),
      task,
      taskKey: task.key,
      prCreationFailure: "GitHub API 502 Bad Gateway",
      openWorkerState: open,
    });

  test("marks the ticket actioned once retryable PR failures hit the cap", async () => {
    const outcomes: string[] = [];
    for (let run = 0; run < MAX_PR_DELIVERY_ATTEMPTS; run++) outcomes.push(await failedRun());

    expect(outcomes).toEqual([
      ...Array.from({ length: MAX_PR_DELIVERY_ATTEMPTS - 1 }, () => "pr-failed"),
      "pr-failed-exhausted",
    ]);
    expect(marker()?.verified).toBe(true);
    expect(failures()).toBeNull();
  });

  test("isFinalPrDeliveryAttempt is true exactly on the run the cap marks actioned", async () => {
    const predicted: boolean[] = [];
    const outcomes: string[] = [];
    for (let run = 0; run < MAX_PR_DELIVERY_ATTEMPTS; run++) {
      predicted.push(isFinalPrDeliveryAttempt(task.key, open));
      outcomes.push(await failedRun());
    }

    expect(predicted).toEqual(outcomes.map((outcome) => outcome === "pr-failed-exhausted"));
    expect(predicted.at(-1)).toBe(true);
    expect(predicted.slice(0, -1).every((final) => !final)).toBe(true);
  });

  test("isFinalPrDeliveryAttempt is false outside worker runs", () => {
    const state = open();
    state.setMeta(
      prDeliveryFailuresKey(actionedSourceKeyFromEnv(), task.key),
      String(MAX_PR_DELIVERY_ATTEMPTS - 1),
    );
    state.close();
    delete process.env[RUN_ORIGIN_ENV];

    expect(isFinalPrDeliveryAttempt(task.key, open)).toBe(false);
  });

  test("a successful PR run after a transient failure resets the count", async () => {
    expect(await failedRun()).toBe("pr-failed");
    expect(failures()).toBe("1");

    // Second run: the PR succeeds and the PR path writes the marker first.
    const state = open();
    state.markTaskActioned(actionedSourceKeyFromEnv(), task.key, "pr-signal", true, "pr-stamp");
    state.close();
    const outcome = await recordActionedWithoutPr({
      tracker: fakeTracker(),
      task,
      taskKey: task.key,
      openWorkerState: open,
    });

    expect(outcome).toBe("already-marked");
    expect(marker()?.signal).toBe("pr-signal");
    expect(failures()).toBeNull();
  });
});
