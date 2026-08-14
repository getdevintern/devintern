import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_PIPELINE, resolvePipelineSteps } from "../src/lib/pipeline/config";
import { __resetStepsForTests, getStep, registerStep } from "../src/lib/pipeline/registry";
import { StepStatus } from "../src/lib/pipeline/types";
import type { PipelineStep, StepResult } from "../src/lib/pipeline/types";

afterEach(() => {
  __resetStepsForTests();
});

describe("Pipeline config", () => {
  test("default pipeline is implement -> commit -> auto-review -> finalize", () => {
    expect(DEFAULT_PIPELINE.map((s) => s.use)).toEqual([
      "implement",
      "commit",
      "auto-review",
      "finalize",
    ]);
  });

  test("resolves the default pipeline when steps are unset", () => {
    const steps = resolvePipelineSteps(undefined);
    expect(steps.map((s) => s.name)).toEqual(["implement", "commit", "auto-review", "finalize"]);
  });

  test("resolves the default pipeline when steps are an empty list", () => {
    const steps = resolvePipelineSteps([]);
    expect(steps.map((s) => s.name)).toEqual(["implement", "commit", "auto-review", "finalize"]);
  });

  test("passes { use, ...config } entries to the step factory without 'use'", () => {
    const captured: Record<string, unknown>[] = [];
    registerStep({
      name: "config-capture-step",
      create(config): PipelineStep {
        captured.push(config);
        return {
          name: "config-capture-step",
          async run(): Promise<StepResult> {
            return { status: StepStatus.Continue };
          },
        };
      },
    });

    const steps = resolvePipelineSteps([
      { use: "config-capture-step", threshold: 0.9, onFail: "warn" },
    ]);

    expect(steps).toHaveLength(1);
    expect(captured).toEqual([{ threshold: 0.9, onFail: "warn" }]);
  });

  test("resolves built-in steps with per-instance config", () => {
    const steps = resolvePipelineSteps([
      { use: "implement" },
      { use: "commit" },
      { use: "verify", onFail: "warn", minSeverity: "low" },
      { use: "finalize" },
    ]);
    expect(steps.map((s) => s.name)).toEqual(["implement", "commit", "verify", "finalize"]);
  });

  test("throws a clear error listing available steps for an unknown step", () => {
    expect(() => resolvePipelineSteps([{ use: "nonexistent-step" }])).toThrow(
      /Unknown pipeline step 'nonexistent-step'/,
    );
    expect(() => resolvePipelineSteps([{ use: "nonexistent-step" }])).toThrow(/implement/);
    expect(() => resolvePipelineSteps([{ use: "nonexistent-step" }])).toThrow(/finalize/);
  });

  test("throws on a malformed entry without a 'use' field", () => {
    // oxlint-disable-next-line no-explicit-any
    expect(() => resolvePipelineSteps([{ foo: "bar" } as any])).toThrow(/'use' field/);
  });

  test("built-in steps are registered", () => {
    for (const name of ["clarity", "implement", "commit", "auto-review", "verify", "finalize"]) {
      expect(getStep(name)?.name).toBe(name);
    }
  });
});
