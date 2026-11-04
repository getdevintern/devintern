import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearEstimationState,
  EstimationStateStore,
  getEstimationState,
  needsEstimation,
  recordEstimation,
  settleEstimationBaseline,
} from "../src/lib/state/estimation-state";

const CREATED = "2026-01-01T00:00:00.000Z";
const AFTER_FIRST_ESTIMATE = "2026-01-01T00:00:10.000Z";
const AFTER_USER_EDIT = "2026-01-01T00:00:20.000Z";

describe("needsEstimation", () => {
  test("skips when the durable baseline already covers the task timestamp", () => {
    // Asana shape: the story exposes only created_at, so the comment looks
    // older than the task's modified_at even though the estimate wrote both.
    expect(
      needsEstimation({
        taskUpdated: AFTER_FIRST_ESTIMATE,
        commentUpdated: CREATED,
        stateUpdated: AFTER_FIRST_ESTIMATE,
        skipComments: false,
      }),
    ).toBe(false);
  });

  test("skips --skip-comments sweeps using the durable baseline alone", () => {
    expect(
      needsEstimation({
        taskUpdated: AFTER_FIRST_ESTIMATE,
        stateUpdated: AFTER_FIRST_ESTIMATE,
        skipComments: true,
      }),
    ).toBe(false);
  });

  test("re-estimates when the task changed after the durable baseline", () => {
    expect(
      needsEstimation({
        taskUpdated: AFTER_USER_EDIT,
        commentUpdated: CREATED,
        stateUpdated: AFTER_FIRST_ESTIMATE,
        skipComments: false,
      }),
    ).toBe(true);
  });

  test("falls back to the comment timestamp for pre-state estimations", () => {
    expect(
      needsEstimation({
        taskUpdated: AFTER_FIRST_ESTIMATE,
        commentUpdated: AFTER_FIRST_ESTIMATE,
        skipComments: false,
      }),
    ).toBe(false);
  });

  test("re-estimates when a comment is expected but missing", () => {
    // Covers switching from --skip-comments to comment mode: recreate it
    // rather than trusting a baseline that has no published comment.
    expect(
      needsEstimation({
        taskUpdated: AFTER_FIRST_ESTIMATE,
        stateUpdated: AFTER_FIRST_ESTIMATE,
        skipComments: false,
      }),
    ).toBe(true);
  });

  test("fails open on an unusable timestamp", () => {
    expect(
      needsEstimation({
        taskUpdated: "",
        stateUpdated: AFTER_FIRST_ESTIMATE,
        skipComments: true,
      }),
    ).toBe(true);
  });

  test("ignores a baseline recorded by a different tracker for the same key", () => {
    // GitHub/GitLab/Azure DevOps use bare numeric keys, so the same project's
    // queue.db can hold e.g. GitHub #123 when GitLab #123 is swept.
    expect(
      needsEstimation({
        taskUpdated: AFTER_FIRST_ESTIMATE,
        stateUpdated: AFTER_FIRST_ESTIMATE,
        stateTracker: "github",
        tracker: "gitlab",
        skipComments: true,
      }),
    ).toBe(true);
  });

  test("uses the baseline when the tracker matches", () => {
    expect(
      needsEstimation({
        taskUpdated: AFTER_FIRST_ESTIMATE,
        stateUpdated: AFTER_FIRST_ESTIMATE,
        stateTracker: "gitlab",
        tracker: "gitlab",
        skipComments: true,
      }),
    ).toBe(false);
  });

  test("ignores a baseline whose tracker is unknown", () => {
    expect(
      needsEstimation({
        taskUpdated: AFTER_FIRST_ESTIMATE,
        stateUpdated: AFTER_FIRST_ESTIMATE,
        tracker: "gitlab",
        skipComments: true,
      }),
    ).toBe(true);
  });
});

describe("settleEstimationBaseline", () => {
  const TASK_KEY = "SETTLE-1";

  afterEach(() => {
    clearEstimationState(TASK_KEY);
  });

  test("records the refreshed task timestamp only when the tracker was written", () => {
    settleEstimationBaseline(TASK_KEY, "github", true, AFTER_USER_EDIT);

    expect(getEstimationState(TASK_KEY)).toMatchObject({
      taskKey: TASK_KEY,
      tracker: "github",
      taskUpdated: AFTER_USER_EDIT,
    });
    expect(
      needsEstimation({
        taskUpdated: AFTER_USER_EDIT,
        stateUpdated: AFTER_USER_EDIT,
        stateTracker: "github",
        tracker: "github",
        skipComments: true,
      }),
    ).toBe(false);
  });

  test("clears the baseline when nothing was written so the next sweep retries", () => {
    recordEstimation(TASK_KEY, "github", AFTER_FIRST_ESTIMATE);

    settleEstimationBaseline(TASK_KEY, "github", false, AFTER_FIRST_ESTIMATE);

    expect(getEstimationState(TASK_KEY)).toBeNull();
    expect(
      needsEstimation({
        taskUpdated: AFTER_FIRST_ESTIMATE,
        skipComments: true,
        tracker: "github",
      }),
    ).toBe(true);
  });

  test("retries the comment after a partial write clears the baseline", () => {
    recordEstimation(TASK_KEY, "github", AFTER_FIRST_ESTIMATE);
    // The field write bumped the task's updated timestamp, but the existing
    // comment update failed, so the comment still carries the older timestamp.
    settleEstimationBaseline(TASK_KEY, "github", false, AFTER_USER_EDIT);

    expect(getEstimationState(TASK_KEY)).toBeNull();
    expect(
      needsEstimation({
        taskUpdated: AFTER_USER_EDIT,
        commentUpdated: AFTER_FIRST_ESTIMATE,
        skipComments: false,
        tracker: "github",
      }),
    ).toBe(true);
  });
});

describe("EstimationStateStore", () => {
  let dir: string;
  let dbPath: string;
  let store: EstimationStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "estimation-state-"));
    dbPath = join(dir, "queue.db");
    store = new EstimationStateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("records, upserts, and clears a task baseline", () => {
    expect(store.getEstimationState("TEST-1")).toBeNull();

    store.recordEstimate("TEST-1", "jira", AFTER_FIRST_ESTIMATE);
    expect(store.getEstimationState("TEST-1")).toMatchObject({
      taskKey: "TEST-1",
      tracker: "jira",
      taskUpdated: AFTER_FIRST_ESTIMATE,
    });

    store.recordEstimate("TEST-1", "jira", AFTER_USER_EDIT);
    expect(store.getEstimationState("TEST-1")?.taskUpdated).toBe(AFTER_USER_EDIT);

    store.clearEstimationState("TEST-1");
    expect(store.getEstimationState("TEST-1")).toBeNull();
  });
});
