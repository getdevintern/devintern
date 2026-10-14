import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { RunStore } from "../src/lib/state/run-recorder";
import type { SessionPickupRunStore } from "../src/lib/state/session-pickup";
import {
  isPickupStatus,
  readImplementationReport,
  resolveSessionPickup,
} from "../src/lib/state/session-pickup";

describe("resolveSessionPickup", () => {
  let dbPath: string;
  let store: RunStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `pickup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function failedRunWithState(taskKey: string, branch?: string, report?: string): number {
    const runId = store.createRun({ origin: "task", taskKey, ...(branch ? { branch } : {}) });
    if (report !== undefined) {
      store.addStage(
        runId,
        "implementation",
        "succeeded",
        "implemented",
        JSON.stringify({ report }),
      );
    }
    store.finishRun(runId, "failed", "agent exited non-zero");
    return runId;
  }

  test("resumes the latest retriable run with branch, report, and landed work", async () => {
    const runId = failedRunWithState("PROJ-1", "feature/proj-1", "I added the parser");

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-1",
      branchExists: () => true,
      describeLanded: ({ branch }) => `commits on ${branch}`,
    });

    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.session).toMatchObject({
      runId,
      taskKey: "PROJ-1",
      status: "failed",
      branch: "feature/proj-1",
      report: "I added the parser",
      landed: "commits on feature/proj-1",
      outcomeReason: "agent exited non-zero",
    });
  });

  test("falls back when no prior attempt is on record", async () => {
    const decision = await resolveSessionPickup({ runStore: store, taskKey: "PROJ-2" });
    expect(decision).toEqual({ kind: "fresh", reason: "no prior attempt on record" });
  });

  test("falls back when the prior run did not end in a retriable status", async () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-3", branch: "feature/proj-3" });
    store.addStage(runId, "implementation", "succeeded", "done", JSON.stringify({ report: "x" }));
    store.finishRun(runId, "succeeded");

    const decision = await resolveSessionPickup({ runStore: store, taskKey: "PROJ-3" });
    expect(decision).toEqual({ kind: "fresh", reason: "prior run is succeeded" });
  });

  test("falls back when the prior run recorded no branch", async () => {
    failedRunWithState("PROJ-4", undefined, "report but no branch");
    const decision = await resolveSessionPickup({ runStore: store, taskKey: "PROJ-4" });
    expect(decision).toEqual({ kind: "fresh", reason: "prior run recorded no branch" });
  });

  test("falls back when the prior run recorded no implementation report", async () => {
    failedRunWithState("PROJ-5", "feature/proj-5");
    const decision = await resolveSessionPickup({ runStore: store, taskKey: "PROJ-5" });
    expect(decision).toEqual({
      kind: "fresh",
      reason: "prior run recorded no implementation report",
    });
  });

  test("falls back when the recorded branch no longer exists", async () => {
    failedRunWithState("PROJ-6", "feature/proj-6", "some report");
    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-6",
      branchExists: () => false,
    });
    expect(decision).toEqual({
      kind: "fresh",
      reason: "branch 'feature/proj-6' no longer exists",
    });
  });

  test("falls back when the branch probe throws", async () => {
    failedRunWithState("PROJ-6b", "feature/proj-6b", "some report");
    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-6b",
      branchExists: () => {
        throw new Error("git unavailable");
      },
    });
    expect(decision.kind).toBe("fresh");
  });

  test("ignores a non-JSON landed-work describer failure", async () => {
    failedRunWithState("PROJ-6c", "feature/proj-6c", "some report");
    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-6c",
      describeLanded: () => {
        throw new Error("git exploded");
      },
    });
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.session.landed).toBeUndefined();
  });

  test("prefers an explicitly requested run id", async () => {
    failedRunWithState("PROJ-7", "feature/proj-7", "first report");
    const newer = failedRunWithState("PROJ-7", "feature/proj-7-attempt-2", "second report");

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-7",
      runId: newer,
    });
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.session.runId).toBe(newer);
    expect(decision.session.branch).toBe("feature/proj-7-attempt-2");
    expect(decision.session.report).toBe("second report");
  });

  test("treats an unknown explicit run id as fresh", async () => {
    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-8",
      runId: 9999,
    });
    expect(decision).toEqual({ kind: "fresh", reason: "no prior attempt on record" });
  });

  test("degrades to fresh when the run store is unavailable", async () => {
    const broken: SessionPickupRunStore = {
      getRun: () => {
        throw new Error("db closed");
      },
      listRuns: () => {
        throw new Error("db closed");
      },
      listStages: () => [],
    };
    const decision = await resolveSessionPickup({ runStore: broken, taskKey: "PROJ-9" });
    expect(decision).toEqual({ kind: "fresh", reason: "run store unavailable" });
  });
});

describe("readImplementationReport", () => {
  let dbPath: string;
  let store: RunStore;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `pickup-report-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("returns the most recent valid implementation report", () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-1" });
    store.addStage(runId, "implementation", "failed", "first", JSON.stringify({ report: "old" }));
    store.addStage(
      runId,
      "implementation",
      "succeeded",
      "second",
      JSON.stringify({ report: "new" }),
    );
    expect(readImplementationReport(store, runId)).toBe("new");
  });

  test("ignores non-implementation stages, malformed JSON, and empty reports", () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-2" });
    store.addStage(runId, "feasibility", "succeeded", "ok", JSON.stringify({ report: "nope" }));
    store.addStage(runId, "implementation", "succeeded", "truncated", '{"report": "unterminated');
    store.addStage(runId, "implementation", "succeeded", "blank", JSON.stringify({ report: "  " }));
    expect(readImplementationReport(store, runId)).toBeUndefined();
  });

  test("returns undefined when there are no stages", () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-3" });
    expect(readImplementationReport(store, runId)).toBeUndefined();
  });
});

describe("isPickupStatus", () => {
  test("accepts terminal retriable statuses only", () => {
    expect(isPickupStatus("failed")).toBe(true);
    expect(isPickupStatus("escalated")).toBe(true);
    expect(isPickupStatus("abandoned")).toBe(true);
    expect(isPickupStatus("succeeded")).toBe(false);
    expect(isPickupStatus("in_progress")).toBe(false);
    expect(isPickupStatus("deferred")).toBe(false);
  });
});
