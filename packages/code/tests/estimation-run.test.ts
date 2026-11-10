/**
 * Behavior tests for `runEstimation`'s tracker-write reporting.
 *
 * The caller records the durable re-estimation baseline only when the
 * estimation actually wrote the tracker; a run that found no story-points
 * field and skipped comments must report `wroteTracker: false` so the next
 * sweep retries instead of skipping forever.
 *
 * `spawnAgent` is mocked at the harness seam; the tracker is a stub and the
 * real parsing/write branching in `runEstimation` runs unchanged.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentHarness } from "@devintern/agent-harness";
import type { TaskTrackerClient } from "../src/lib/trackers/client";
import type { ProjectSettings } from "../src/types/settings";

const realHarness = { ...(await import("@devintern/agent-harness")) };
const realSandbox = { ...(await import("../src/lib/agent/sandbox")) };

const ESTIMATION_JSON = JSON.stringify({
  storyPoints: 5,
  confidence: "high",
  implementationConfidence: 8,
  reasoning: "well scoped",
  risks: [],
  unclearAreas: [],
  summary: "moderate change",
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
}

let fieldId: string | undefined;
let updateFieldError: Error | undefined;
let commentError: Error | undefined;

mock.module("@devintern/agent-harness", () => ({
  ...realHarness,
  resolveExecutablePathWithRetry: async (path: string) => path,
  buildHarnessInvocation: async () => ({ args: [], env: {} }),
  buildPromptArgs: () => [],
  detectUsageLimit: () => ({ limited: false }),
  reapTree: () => {},
  spawnAgent: async () => {
    const child = new FakeChild();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(ESTIMATION_JSON));
      child.emit("close", 0);
    });
    return { child, cleanup: async () => {} };
  },
}));

mock.module("../src/lib/agent/sandbox", () => ({
  ...realSandbox,
  getSandbox: async () => null,
}));

const { classifyEstimationAttempt, runEstimation } =
  await import("../src/lib/automation/estimation");
const { accountEstimationAttempt } = await import("../src/lib/cli/run");

afterAll(() => {
  mock.module("@devintern/agent-harness", () => realHarness);
  mock.module("../src/lib/agent/sandbox", () => realSandbox);
});

const harness = {
  name: "fake",
  displayName: "Fake",
  supportsMaxTurns: false,
} as unknown as AgentHarness;

function createTracker(): TaskTrackerClient {
  return {
    discoverEstimationField: mock(async () => fieldId),
    updateEstimation: mock(async () => {
      if (updateFieldError) throw updateFieldError;
    }),
    postEstimationComment: mock(async () => {
      if (commentError) throw commentError;
    }),
    updateEstimationComment: mock(async () => {
      if (commentError) throw commentError;
    }),
  } as unknown as TaskTrackerClient;
}

let dir: string;
let estimationFile: string;

beforeEach(() => {
  fieldId = undefined;
  updateFieldError = undefined;
  commentError = undefined;
  dir = mkdtempSync(join(tmpdir(), "estimation-run-"));
  estimationFile = join(dir, "estimation.md");
  writeFileSync(estimationFile, "estimate this task");
  process.env.DEVINTERN_OUTPUT_DIR = dir;
});

afterEach(() => {
  delete process.env.DEVINTERN_OUTPUT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function estimate(
  skipComments: boolean,
  existingCommentId?: string,
  settings: ProjectSettings | null = null,
): ReturnType<typeof runEstimation> {
  return runEstimation({
    estimationFile,
    harness,
    executablePath: "/fake/agent",
    taskKey: "TEST-1",
    tracker: createTracker(),
    settings,
    skipComments,
    existingCommentId,
    runOptions: { maxTurns: 1, skipPermissions: true, workingDir: process.cwd() },
  });
}

describe("runEstimation tracker writes", () => {
  test("reports no tracker write when no field is found and comments are skipped", async () => {
    const outcome = await estimate(true);

    expect(outcome?.result.storyPoints).toBe(5);
    expect(outcome?.wroteTracker).toBe(false);
  });

  test("reports a tracker write when the story-points field is updated", async () => {
    fieldId = "customfield_1";

    const outcome = await estimate(true);

    expect(outcome?.wroteTracker).toBe(true);
  });

  test("reports no tracker write when the field update fails and comments are skipped", async () => {
    fieldId = "customfield_1";
    updateFieldError = new Error("field is read-only");

    const outcome = await estimate(true);

    expect(outcome?.wroteTracker).toBe(false);
  });

  test("reports a tracker write when only the estimation comment is posted", async () => {
    const outcome = await estimate(false);

    expect(outcome?.wroteTracker).toBe(true);
  });

  test("reports no tracker write when the comment post fails and no field exists", async () => {
    commentError = new Error("comments are locked");

    const outcome = await estimate(false);

    expect(outcome?.wroteTracker).toBe(false);
    expect(outcome?.canSettleBaseline).toBe(false);
  });

  test("does not settle the baseline when the field write succeeds but the existing comment update fails", async () => {
    // The field write bumps the task's `updated`, but the comment is still
    // stale. Recording that post-write baseline would make needsEstimation()
    // pick the newer durable state over the old comment timestamp and skip
    // forever, leaving the comment on the previous points.
    fieldId = "customfield_1";
    commentError = new Error("comments are locked");

    const outcome = await estimate(false, "comment-1");

    expect(outcome?.wroteField).toBe(true);
    expect(outcome?.wroteComment).toBe(false);
    expect(outcome?.wroteTracker).toBe(true);
    expect(outcome?.canSettleBaseline).toBe(false);
  });

  test("does not settle the baseline when the configured field write fails but the comment is written", async () => {
    // Comment-only success must not hide a failed story-points write: the
    // comment would show the new estimate while the field stayed stale, and
    // the settled baseline would skip every later retry.
    updateFieldError = new Error("field is read-only");
    const settings = {
      jira: { projects: { TEST: { storyPointsField: "customfield_1" } } },
    } satisfies ProjectSettings;

    const outcome = await estimate(false, "comment-1", settings);

    expect(outcome?.fieldAttempted).toBe(true);
    expect(outcome?.wroteField).toBe(false);
    expect(outcome?.wroteComment).toBe(true);
    expect(outcome?.wroteTracker).toBe(true);
    expect(outcome?.canSettleBaseline).toBe(false);
  });

  test("settles the baseline when both the field and the existing comment are written", async () => {
    fieldId = "customfield_1";

    const outcome = await estimate(false, "comment-1");

    expect(outcome?.wroteField).toBe(true);
    expect(outcome?.wroteComment).toBe(true);
    expect(outcome?.canSettleBaseline).toBe(true);
  });

  test("settles the baseline when comments are skipped and the field is written", async () => {
    fieldId = "customfield_1";

    const outcome = await estimate(true);

    expect(outcome?.wroteField).toBe(true);
    expect(outcome?.wroteComment).toBe(false);
    expect(outcome?.canSettleBaseline).toBe(true);
  });
});

describe("estimation batch accounting", () => {
  function emptyResults() {
    return { estimated: 0, failed: 0, errors: [] as Array<{ taskKey: string; error: string }> };
  }

  test("counts a zero-write outcome as failed and reports a failed run", async () => {
    // Real outcome from the no-field/--skip-comments path above.
    const attempt = classifyEstimationAttempt(await estimate(true));
    const results = emptyResults();

    const runOutcome = accountEstimationAttempt(results, "TEST-1", attempt);

    expect(results.estimated).toBe(0);
    expect(results.failed).toBe(1);
    expect(results.errors).toEqual([
      { taskKey: "TEST-1", error: "Estimation wrote nothing to the tracker" },
    ]);
    expect(runOutcome).toEqual({
      status: "failed",
      reason: "Estimation wrote nothing to the tracker",
    });
  });

  test("counts a field write as estimated and reports a successful run", async () => {
    fieldId = "customfield_1";
    const attempt = classifyEstimationAttempt(await estimate(true));
    const results = emptyResults();

    const runOutcome = accountEstimationAttempt(results, "TEST-1", attempt);

    expect(results.estimated).toBe(1);
    expect(results.failed).toBe(0);
    expect(results.errors).toEqual([]);
    expect(runOutcome).toEqual({ status: "succeeded" });
  });

  test("reports a partial field/comment write as failed", async () => {
    fieldId = "customfield_1";
    commentError = new Error("comments are locked");
    const attempt = classifyEstimationAttempt(await estimate(false, "comment-1"));
    const results = emptyResults();

    expect(accountEstimationAttempt(results, "TEST-1", attempt)).toEqual({
      status: "failed",
      reason: "Estimation only partially updated the tracker",
    });
    expect(results.failed).toBe(1);
    expect(results.estimated).toBe(0);
  });

  test("counts a missing outcome as a parse failure", () => {
    const attempt = classifyEstimationAttempt(null);
    const results = emptyResults();

    const runOutcome = accountEstimationAttempt(results, "TEST-1", attempt);

    expect(results.estimated).toBe(0);
    expect(results.failed).toBe(1);
    expect(results.errors).toEqual([
      { taskKey: "TEST-1", error: "Failed to parse estimation response" },
    ]);
    expect(runOutcome).toEqual({
      status: "failed",
      reason: "Failed to parse estimation response",
    });
  });
});
