import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import definition from "../plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../../shared/harness";
import type { PipelineContext, TaskStep } from "@getdevintern/code/pipeline";

let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("report-execution-example-");
});

afterEach(() => {
  removeTempDir(workdir);
});

interface Capture {
  kind?: string;
  data?: Record<string, unknown>;
  reason?: string;
}

function captureStep(capture: Capture): TaskStep<PipelineContext> {
  return {
    name: "capture-report",
    run: async (context) => {
      const record = context.results.find((entry) => entry.step === "report-execution");
      capture.kind = record?.result.kind;
      capture.data = record?.result.data;
      capture.reason = record?.result.kind === "warn" ? record.result.reason : undefined;
    },
  };
}

function warnStep(reason: string): TaskStep<PipelineContext> {
  return {
    name: "emit-warning",
    run: async () => ({ kind: "warn", reason }),
  };
}

describe("report-execution plugin", () => {
  test("prepares a redacted report when a prior step warned", async () => {
    const capture: Capture = {};
    const context = createTestContext({ workingDir: workdir, taskKey: "DEMO-1" });
    const outcome = await runDefinition(definition, context, {
      before: [warnStep("verify found a mismatch for DEMO-1 with ghp_abcdefghijklmnopqrstuvwxyz")],
      after: [captureStep(capture)],
      config: { on: "warn", dryRun: true },
    });

    expect(outcome.kind).toBe("completed");
    expect(capture.kind).toBe("continue");
    const payload = capture.data?.report as
      | { title?: string; context?: { evidence?: Array<{ text: string }> } }
      | undefined;
    expect(payload?.title).toContain("Pipeline warnings");
    const evidence = payload?.context?.evidence?.map((item) => item.text).join("\n") ?? "";
    expect(evidence).not.toContain("ghp_");
    expect(evidence).not.toContain("DEMO-1");
  });

  test("does nothing on a clean run with on: warn", async () => {
    const capture: Capture = {};
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      after: [captureStep(capture)],
      config: { on: "warn", dryRun: true },
    });

    expect(outcome.kind).toBe("completed");
    expect(capture.kind).toBe("continue");
    expect(capture.data?.report).toBeUndefined();
  });

  test("reports every run with on: always", async () => {
    const capture: Capture = {};
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      after: [captureStep(capture)],
      config: { on: "always", dryRun: true },
    });

    expect(outcome.kind).toBe("completed");
    const payload = capture.data?.report as { title?: string } | undefined;
    expect(payload?.title).toContain("Pipeline run report");
  });

  test("turns a submission failure into a warning instead of a halt", async () => {
    const capture: Capture = {};
    const failingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      before: [warnStep("something to report")],
      after: [captureStep(capture)],
      config: { on: "warn", dryRun: false, fetchImpl: failingFetch },
    });

    expect(outcome.kind).toBe("completed");
    expect(capture.kind).toBe("warn");
    expect(capture.reason).toContain("could not file a report");
  });

  test("rejects an invalid on value at creation time", () => {
    expect(() => definition.create({ on: "sometimes" })).toThrow("'warn' or 'always'");
  });
});
