import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { internalErrorGroupKey } from "../src/lib/notifications/run-rules";
import { listNotifications } from "../src/lib/notifications/store";
import type { Notification, NotificationKind } from "../src/lib/notifications/types";
import { RunStore } from "../src/lib/state/run-recorder";
import type { RunOutcomeDetail } from "../src/lib/state/run-recorder";

let dir: string;
let runs: RunStore;
let reader: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notification-internal-"));
  const dbPath = join(dir, "queue.db");
  runs = new RunStore(dbPath);
  reader = new Database(dbPath);
});

afterEach(() => {
  reader.close();
  runs.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(kind?: NotificationKind): Notification[] {
  const exists = reader
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notifications'")
    .get();
  if (!exists) return [];
  return listNotifications(reader, {
    ...(kind ? { kind } : {}),
    unresolved: true,
    includeMuted: true,
    limit: 200,
  }).notifications;
}

const VERIFY_FAILURE = (branch: string): RunOutcomeDetail => ({
  failure: {
    outcomeClass: "internal",
    stage: "verify",
    cause: `Remote branch refs/remotes/origin/feature/${branch} not found`,
  },
  work: { status: "saved", ref: `feature/${branch}` },
});

function finish(
  taskKey: string,
  status: "succeeded" | "failed" | "escalated",
  reason?: string,
  outcome?: RunOutcomeDetail,
): number {
  const id = runs.createRun({ origin: "local", taskKey, repo: "acme/web" });
  runs.finishRun(id, status, reason, outcome);
  return id;
}

describe("internal_error", () => {
  test("an internal failure raises a high internal_error, never an escalated row", () => {
    const id = finish("local-a", "escalated", "verify: …", VERIFY_FAILURE("a"));
    const [row] = open("internal_error");
    expect(row).toMatchObject({
      severity: "high",
      runId: id,
      title: "Likely DevIntern bug: verify failed",
    });
    expect(row?.body).toContain("Remote branch refs/remotes/origin/feature/a not found");
    expect(row?.body).toContain("Work saved on branch feature/a");
    expect(open("escalated")).toEqual([]);
    expect(open("retries_exhausted")).toEqual([]);
  });

  test("the same bug across runs and tasks rolls up with a count", () => {
    finish("local-a", "escalated", "x", VERIFY_FAILURE("a"));
    finish("local-b", "failed", "x", VERIFY_FAILURE("b"));
    finish("local-c", "escalated", "x", VERIFY_FAILURE("c"));
    // A different stage is a different bug.
    finish("local-d", "failed", "x", {
      failure: { outcomeClass: "internal", stage: "publish", cause: "push failed: boom" },
    });
    const rows = open("internal_error");
    expect(rows).toHaveLength(2);
    const verify = rows.find((row) => row.title.includes("verify"));
    expect(verify).toMatchObject({ count: 3, title: "Likely DevIntern bug: verify failed (×3)" });
    expect(verify?.groupKey).toBe(
      internalErrorGroupKey({
        failureStage: "verify",
        failureCause: "Remote branch refs/remotes/origin/feature/zzz not found",
      }),
    );
  });

  test("review holds stay escalations and never fold into a DevIntern problem", () => {
    const hold = runs.createRun({ origin: "auto_merge", repo: "acme/web", prNumber: 4 });
    runs.finishRun(hold, "escalated", "matches deny pattern a/**", {
      failure: { outcomeClass: "review_hold", stage: "auto_merge" },
    });
    finish("local-a", "escalated", "x", VERIFY_FAILURE("a"));
    expect(open("escalated")).toHaveLength(1);
    expect(open("internal_error")).toHaveLength(1);
    expect(open("escalated")[0]?.groupKey).not.toContain("internal_error");
  });

  test("auto-resolves once every affected task's latest run succeeded", () => {
    finish("local-a", "escalated", "x", VERIFY_FAILURE("a"));
    finish("local-b", "escalated", "x", VERIFY_FAILURE("b"));
    finish("local-a", "succeeded");
    // local-b is still broken: the grouped row stays open.
    expect(open("internal_error")).toHaveLength(1);
    finish("local-b", "succeeded");
    expect(open("internal_error")).toEqual([]);
  });

  test("an auto-merge failure resolves on the next success for the same PR", () => {
    const prUrl = "https://github.com/acme/web/pull/7";
    const failed = runs.createRun({ origin: "auto_merge", repo: "acme/web", prNumber: 7, prUrl });
    runs.finishRun(failed, "failed", "boom", {
      failure: { outcomeClass: "internal", stage: "auto_merge", cause: "merge API crashed" },
    });
    expect(open("internal_error")).toHaveLength(1);
    const merged = runs.createRun({ origin: "auto_merge", repo: "acme/web", prNumber: 7, prUrl });
    runs.finishRun(merged, "succeeded", "merged");
    expect(open("internal_error")).toEqual([]);
  });

  test("a self-retrying origin's internal failure resolves on its own next success", () => {
    const failed = runs.createRun({ origin: "estimate", taskKey: "TASK-1", repo: "acme/web" });
    runs.finishRun(failed, "failed", "x", VERIFY_FAILURE("e"));
    expect(open("internal_error")).toHaveLength(1);
    const ok = runs.createRun({ origin: "estimate", taskKey: "TASK-1", repo: "acme/web" });
    runs.finishRun(ok, "succeeded");
    expect(open("internal_error")).toEqual([]);
  });

  test("another origin's success on the same task does not resolve it", () => {
    const failed = runs.createRun({ origin: "estimate", taskKey: "TASK-2", repo: "acme/web" });
    runs.finishRun(failed, "failed", "x", VERIFY_FAILURE("e"));
    finish("TASK-2", "succeeded");
    expect(open("internal_error")).toHaveLength(1);
  });

  test("stays open while a task whose run fell out of the row's links is still broken", () => {
    const oldRun = finish("local-old", "escalated", "x", VERIFY_FAILURE("old"));
    // Enough repeats to push local-old's run out of the capped link list.
    for (let i = 0; i < 60; i++) finish(`local-n${i}`, "failed", "x", VERIFY_FAILURE(`n${i}`));
    expect(open("internal_error")[0]?.links.some((link) => link.runId === oldRun)).toBe(false);
    for (let i = 0; i < 60; i++) finish(`local-n${i}`, "succeeded");
    expect(open("internal_error")).toHaveLength(1);
    finish("local-old", "succeeded");
    expect(open("internal_error")).toEqual([]);
  });

  test("a success of an unrelated task resolves nothing", () => {
    finish("local-a", "escalated", "x", VERIFY_FAILURE("a"));
    finish("local-z", "succeeded");
    expect(open("internal_error")).toHaveLength(1);
  });
});

describe("other classes", () => {
  test("environment failures go to source_unhealthy and resolve on the task's success", () => {
    finish("local-e", "failed", "publish: HTTP 401 Bad credentials", {
      failure: { outcomeClass: "environment", stage: "publish", cause: "HTTP 401 Bad credentials" },
    });
    expect(open("source_unhealthy")).toHaveLength(1);
    expect(open("source_unhealthy")[0]?.severity).toBe("high");
    expect(open("retries_exhausted")).toEqual([]);
    finish("local-e", "succeeded");
    expect(open("source_unhealthy")).toEqual([]);
  });

  test("a grouped environment row stays open until every affected task recovered", () => {
    const revoked = {
      failure: {
        outcomeClass: "environment" as const,
        stage: "publish",
        cause: "HTTP 401 Bad credentials",
      },
    };
    finish("local-ea", "failed", "x", revoked);
    finish("local-eb", "failed", "x", revoked);
    expect(open("source_unhealthy")).toHaveLength(1);
    finish("local-eb", "succeeded");
    expect(open("source_unhealthy")).toHaveLength(1);
    finish("local-ea", "succeeded");
    expect(open("source_unhealthy")).toEqual([]);
  });

  test("agent escalations keep the escalated kind and say where the work went", () => {
    finish("local-g", "escalated", "implementation incomplete; handed back to a human", {
      failure: { outcomeClass: "agent", stage: "implementation" },
      work: { status: "discarded" },
    });
    const [row] = open("escalated");
    expect(row?.severity).toBe("high");
    expect(row?.body).toContain("Work discarded");
    expect(open("internal_error")).toEqual([]);
  });
});
