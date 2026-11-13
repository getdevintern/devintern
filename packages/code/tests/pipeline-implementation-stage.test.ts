/**
 * Pipeline-level coverage for the implementation stage: the harness records
 * success before finalize, and a verify halt that writes the incomplete summary
 * afterwards must correct that record instead of leaving a succeeded stage on
 * an escalated run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RunStore,
  beginRun,
  endRun,
  getActiveRunContext,
  recordRunStage,
} from "../src/lib/state/run-recorder";
import type { RunStageRecord } from "../src/lib/state/run-recorder";
import { recordImplementationStage } from "../src/lib/task/pipeline";

let taskDir: string;
let activeRun = false;

function implementationStages(runId: number): RunStageRecord[] {
  const reader = new RunStore();
  try {
    return reader.listStages(runId).filter((stage) => stage.stage === "implementation");
  } finally {
    reader.close();
  }
}

beforeEach(() => {
  taskDir = join(tmpdir(), `pipeline-stage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(taskDir, { recursive: true });
});

afterEach(() => {
  if (activeRun) {
    endRun("failed", "test cleanup");
    activeRun = false;
  }
  rmSync(taskDir, { recursive: true, force: true });
});

describe("recordImplementationStage", () => {
  test("corrects an early succeeded stage to failed when finalize reports a halt", () => {
    beginRun({ origin: "task", taskKey: "PROJ-STAGE-1" });
    activeRun = true;
    const runId = getActiveRunContext()!.id;
    recordRunStage("implementation", {
      status: "succeeded",
      summary: "implemented early",
      detail: { harness: "Test Harness", durationMs: 1, report: "agent success report" },
    });
    writeFileSync(
      join(taskDir, "implementation-summary-incomplete.md"),
      "verification failed: tests did not pass",
      "utf8",
    );

    const result = recordImplementationStage(taskDir, Date.now() - 10_000, "Test Harness");

    expect(result.incomplete).toBe(true);
    const stages = implementationStages(runId);
    // The early success record is replaced, not duplicated.
    expect(stages).toHaveLength(1);
    expect(stages[0]?.status).toBe("failed");
    const detail = JSON.parse(stages[0]!.detail!) as Record<string, unknown>;
    expect(detail.report).toBe("verification failed: tests did not pass");
    expect(detail.agentReport).toBe("agent success report");
  });

  test("records a failed stage when the halted session never wrote an early stage", () => {
    beginRun({ origin: "task", taskKey: "PROJ-STAGE-2" });
    activeRun = true;
    const runId = getActiveRunContext()!.id;
    writeFileSync(
      join(taskDir, "implementation-summary-incomplete.md"),
      "verification failed before the early write",
      "utf8",
    );

    const result = recordImplementationStage(taskDir, Date.now() - 10_000, "Test Harness");

    expect(result.incomplete).toBe(true);
    const stages = implementationStages(runId);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.status).toBe("failed");
  });

  test("replaces the early report when a verify repair rewrites the summary", () => {
    beginRun({ origin: "task", taskKey: "PROJ-STAGE-4" });
    activeRun = true;
    const runId = getActiveRunContext()!.id;
    recordRunStage("implementation", {
      status: "succeeded",
      summary: "implemented early",
      detail: { harness: "Test Harness", durationMs: 1, report: "ORIGINAL agent report" },
    });
    // A successful verify/plan repair rewrites the success summary in place.
    writeFileSync(join(taskDir, "implementation-summary.md"), "REPAIRED final report", "utf8");

    const result = recordImplementationStage(taskDir, Date.now() - 10_000, "Test Harness");

    expect(result.incomplete).toBe(false);
    const stages = implementationStages(runId);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.status).toBe("succeeded");
    const detail = JSON.parse(stages[0]!.detail!) as Record<string, unknown>;
    expect(detail.report).toBe("REPAIRED final report");
    expect(detail.agentReport).toBe("ORIGINAL agent report");
  });

  test("leaves an early success stage alone when no incomplete summary exists", () => {
    beginRun({ origin: "task", taskKey: "PROJ-STAGE-3" });
    activeRun = true;
    const runId = getActiveRunContext()!.id;
    recordRunStage("implementation", {
      status: "succeeded",
      summary: "implemented early",
      detail: { harness: "Test Harness", durationMs: 1, report: "agent success report" },
    });
    writeFileSync(join(taskDir, "implementation-summary.md"), "agent success report", "utf8");

    const result = recordImplementationStage(taskDir, Date.now() - 10_000, "Test Harness");

    expect(result.incomplete).toBe(false);
    const stages = implementationStages(runId);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.status).toBe("succeeded");
  });
});
