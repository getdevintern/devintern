import { describe, test, expect } from "bun:test";

import { shouldSkipRetry } from "../src/lib/retry-gate";
import { hashDescription, type RetryState } from "../src/lib/retry-state";
import type { TaskTrackerClient } from "../src/lib/task-tracker-client";
import type { Comment } from "../src/types/task-tracker";

const REPORTED_AT = Date.parse("2026-01-10T12:00:00.000Z");
const DESCRIPTION = "Implement the login flow";

function state(overrides: Partial<RetryState> = {}): RetryState {
  return {
    taskKey: "PROJ-1",
    tracker: "jira",
    descriptionHash: hashDescription(DESCRIPTION),
    reportedAt: REPORTED_AT,
    attemptCount: 1,
    ...overrides,
  };
}

function comment(created: string): Comment {
  return {
    id: "1",
    author: "Alice",
    body: "some clarification",
    created,
    updated: created,
  };
}

function trackerWithMarker(markerPresent: boolean): TaskTrackerClient {
  return {
    hasIncompleteImplementationMarker: async () => markerPresent,
  } as unknown as TaskTrackerClient;
}

function gateInput(overrides: Partial<Parameters<typeof shouldSkipRetry>[0]> = {}) {
  return {
    taskKey: "PROJ-1",
    state: state(),
    description: DESCRIPTION,
    comments: [] as Comment[],
    tracker: trackerWithMarker(true),
    ...overrides,
  };
}

describe("shouldSkipRetry", () => {
  test("skips when nothing changed since the incomplete attempt", async () => {
    const decision = await shouldSkipRetry(gateInput());
    expect(decision.skip).toBe(true);
    expect(decision.reason).toContain("unchanged");
  });

  test("runs when there is no retry state on record", async () => {
    const decision = await shouldSkipRetry(gateInput({ state: null }));
    expect(decision.skip).toBe(false);
  });

  test("runs when the description changed", async () => {
    const decision = await shouldSkipRetry(gateInput({ description: "Updated description" }));
    expect(decision.skip).toBe(false);
    expect(decision.reason).toContain("description changed");
  });

  test("runs when a comment was posted after the incomplete attempt", async () => {
    const decision = await shouldSkipRetry(
      gateInput({ comments: [comment("2026-01-11T09:00:00.000Z")] }),
    );
    expect(decision.skip).toBe(false);
    expect(decision.reason).toContain("new comment");
  });

  test("still skips when all comments predate the incomplete attempt", async () => {
    const decision = await shouldSkipRetry(
      gateInput({ comments: [comment("2026-01-09T09:00:00.000Z")] }),
    );
    expect(decision.skip).toBe(true);
  });

  test("runs (fails open) when a comment timestamp is unparseable", async () => {
    const decision = await shouldSkipRetry(gateInput({ comments: [comment("not-a-date")] }));
    expect(decision.skip).toBe(false);
  });

  test("runs when the incomplete comment was removed from the ticket", async () => {
    const decision = await shouldSkipRetry(gateInput({ tracker: trackerWithMarker(false) }));
    expect(decision.skip).toBe(false);
    expect(decision.reason).toContain("no longer on ticket");
  });

  test("runs when forced", async () => {
    const decision = await shouldSkipRetry(gateInput({ force: true }));
    expect(decision.skip).toBe(false);
    expect(decision.reason).toContain("--force");
  });
});
