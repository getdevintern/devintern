import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { RetryStateStore, hashDescription } from "../src/lib/retry-state";

describe("RetryStateStore", () => {
  let tempDir: string;
  let store: RetryStateStore;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "devintern-retry-state-"));
    store = new RetryStateStore(path.join(tempDir, "queue.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns null when no incomplete attempt is on record", () => {
    expect(store.getRetryState("PROJ-1")).toBeNull();
  });

  test("records and reads back an incomplete attempt", () => {
    const before = Date.now();
    store.recordIncompleteAttempt("PROJ-1", "jira", "the description");

    const state = store.getRetryState("PROJ-1");
    expect(state).not.toBeNull();
    expect(state!.taskKey).toBe("PROJ-1");
    expect(state!.tracker).toBe("jira");
    expect(state!.descriptionHash).toBe(hashDescription("the description"));
    expect(state!.reportedAt).toBeGreaterThanOrEqual(before);
    expect(state!.attemptCount).toBe(1);
  });

  test("increments attempt count and refreshes hash on repeated records", () => {
    store.recordIncompleteAttempt("PROJ-1", "jira", "v1");
    store.recordIncompleteAttempt("PROJ-1", "jira", "v2");

    const state = store.getRetryState("PROJ-1");
    expect(state!.attemptCount).toBe(2);
    expect(state!.descriptionHash).toBe(hashDescription("v2"));
  });

  test("clearRetryState removes the record", () => {
    store.recordIncompleteAttempt("PROJ-1", "jira", "desc");
    store.clearRetryState("PROJ-1");
    expect(store.getRetryState("PROJ-1")).toBeNull();
  });

  test("tasks are isolated from each other", () => {
    store.recordIncompleteAttempt("PROJ-1", "jira", "desc");
    expect(store.getRetryState("PROJ-2")).toBeNull();
  });

  test("hashDescription is stable and collision-sensitive", () => {
    expect(hashDescription("a")).toBe(hashDescription("a"));
    expect(hashDescription("a")).not.toBe(hashDescription("b"));
  });
});
