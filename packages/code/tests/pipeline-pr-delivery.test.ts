/**
 * Pipeline-level coverage for a run whose branch was pushed but whose PR could
 * not be created: the harness leaves `prDeliveryFailure` on the active task
 * context and the pipeline must record the run `failed`, hand that status to
 * the worker through the hint file, keep a markdown task out of Done, and still
 * run the actioned and retry-state bookkeeping.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PR_DELIVERY_FAILED_REASON_PREFIX } from "../src/lib/agent/implementation-outcome";
import { runContext } from "../src/lib/cli/context";
import type { PrDeliveryFailure } from "../src/lib/cli/context";
import { RUN_ORIGIN_ENV } from "../src/lib/observability/analytics";
import { getRetryState, recordIncompleteAttempt } from "../src/lib/state/retry-state";
import { RunStore, beginRun, getActiveRunContext } from "../src/lib/state/run-recorder";
import { WorkerState } from "../src/lib/state/worker-state";
import { prDeliveryFailuresKey } from "../src/lib/task/actioned-without-pr";
import { settleImplementationRun } from "../src/lib/task/pipeline";
import type { TaskTrackerClient } from "../src/lib/trackers/client";
import { MarkdownTaskTrackerClient } from "../src/lib/trackers/markdown/markdown-task-tracker-client";
import { RUN_OUTCOME_FILE_ENV } from "../src/lib/worker/run-outcome-protocol";
import { ACTIONED_SOURCE_ENV } from "../src/lib/workspace/env";

const SOURCE = "test-pr-delivery";
const ENV_KEYS = [RUN_ORIGIN_ENV, RUN_OUTCOME_FILE_ENV, ACTIONED_SOURCE_ENV] as const;

let workDir: string;
let savedEnv: Record<string, string | undefined>;

const task = {
  key: "PROJ-PR",
  summary: "Ship it",
  status: "In Progress",
  labels: [],
  updated: "2026-11-18T00:00:00.000Z",
};

function trackerStub(): TaskTrackerClient {
  return {
    getTask: async () => task,
    extractDescriptionText: () => "description",
  } as unknown as TaskTrackerClient;
}

function markdownTrackerStub(doneCalls: string[]): MarkdownTaskTrackerClient {
  const tracker = new MarkdownTaskTrackerClient({ tasksDirectory: workDir });
  tracker.markDoneIfSuccessful = async (taskKey: string) => {
    doneCalls.push(taskKey);
  };
  tracker.getTask = async () => task as never;
  tracker.extractDescriptionText = () => "description";
  return tracker;
}

function startRun(taskKey: string, prDeliveryFailure: PrDeliveryFailure): number {
  beginRun({ origin: "task", taskKey });
  runContext.activeTaskContext = {
    taskKey,
    tracker: trackerStub(),
    projectKey: "PROJ",
    movedToInProgress: true,
    prDeliveryFailure,
    ...(prDeliveryFailure.permanent ? {} : { prCreationFailure: prDeliveryFailure.message }),
  };
  recordIncompleteAttempt(taskKey, "jira", "description");
  return getActiveRunContext()!.id;
}

function readRun(runId: number) {
  const store = new RunStore();
  try {
    return store.getRun(runId);
  } finally {
    store.close();
  }
}

function readHint(): { status: string; reason?: string } {
  return JSON.parse(readFileSync(join(workDir, "outcome.json"), "utf8")) as {
    status: string;
    reason?: string;
  };
}

function workerMeta(taskKey: string): { failures: string | null; actioned: boolean } {
  const state = new WorkerState();
  try {
    return {
      failures: state.getMeta(prDeliveryFailuresKey(SOURCE, taskKey)),
      actioned: state.getTaskActioned(SOURCE, taskKey) !== null,
    };
  } finally {
    state.close();
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pipeline-pr-delivery-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env[RUN_ORIGIN_ENV] = "worker";
  process.env[RUN_OUTCOME_FILE_ENV] = join(workDir, "outcome.json");
  process.env[ACTIONED_SOURCE_ENV] = SOURCE;
});

afterEach(() => {
  runContext.activeTaskContext = null;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("settleImplementationRun with a PR delivery failure", () => {
  test("permanent failure: run failed, hint failed, ticket marked actioned", async () => {
    const runId = startRun("PROJ-PERM", { message: "422 validation failed", permanent: true });

    await settleImplementationRun({
      tracker: trackerStub(),
      task: task as never,
      workflowKey: "PROJ-PERM",
      taskDir: workDir,
      incomplete: false,
      outcome: undefined,
    });

    const run = readRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.outcomeReason).toBe(`${PR_DELIVERY_FAILED_REASON_PREFIX}422 validation failed`);
    expect(readHint()).toEqual({
      status: "failed",
      reason: `${PR_DELIVERY_FAILED_REASON_PREFIX}422 validation failed`,
    });
    // No prCreationFailure: no retry counter, ticket recorded as actioned.
    expect(workerMeta("PROJ-PERM")).toEqual({ failures: null, actioned: true });
    expect(getRetryState("PROJ-PERM")).toBeNull();
    expect(runContext.activeTaskContext).toBeNull();
  });

  test("retryable failure: run failed, prCreationFailure counted, ticket left unmarked", async () => {
    const runId = startRun("PROJ-RETRY", { message: "502 bad gateway", permanent: false });

    await settleImplementationRun({
      tracker: trackerStub(),
      task: task as never,
      workflowKey: "PROJ-RETRY",
      taskDir: workDir,
      incomplete: false,
      outcome: undefined,
    });

    const run = readRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.outcomeReason).toBe(`${PR_DELIVERY_FAILED_REASON_PREFIX}502 bad gateway`);
    expect(readHint().status).toBe("failed");
    // recordActionedWithoutPr received prCreationFailure: first attempt counted.
    expect(workerMeta("PROJ-RETRY")).toEqual({ failures: "1", actioned: false });
    expect(getRetryState("PROJ-RETRY")).toBeNull();
  });

  test("markdown tracker is not marked Done when delivery failed", async () => {
    const doneCalls: string[] = [];
    const runId = startRun("PROJ-MD", { message: "push rejected PR", permanent: true });

    await settleImplementationRun({
      tracker: markdownTrackerStub(doneCalls),
      task: task as never,
      workflowKey: "PROJ-MD",
      taskDir: workDir,
      incomplete: false,
      outcome: undefined,
    });

    expect(doneCalls).toEqual([]);
    expect(readRun(runId)?.status).toBe("failed");
    expect(readHint().status).toBe("failed");
  });

  test("markdown tracker is marked Done and run succeeds without a delivery failure", async () => {
    const doneCalls: string[] = [];
    beginRun({ origin: "task", taskKey: "PROJ-MD-OK" });
    const runId = getActiveRunContext()!.id;

    await settleImplementationRun({
      tracker: markdownTrackerStub(doneCalls),
      task: task as never,
      workflowKey: "PROJ-MD-OK",
      taskDir: workDir,
      incomplete: false,
      outcome: undefined,
    });

    expect(doneCalls).toEqual(["PROJ-MD-OK"]);
    expect(readRun(runId)?.status).toBe("succeeded");
    expect(readHint()).toEqual({ status: "succeeded" });
  });
});
