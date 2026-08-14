import { describe, expect, test } from "bun:test";
import { UsageLimitError } from "../src/lib/errors";
import { Pipeline } from "../src/lib/pipeline/pipeline";
import { StepExecutionError, StepStatus } from "../src/lib/pipeline/types";
import type { PipelineStep, StepResult, TaskContext } from "../src/lib/pipeline/types";

/** Minimal TaskContext for runner tests (no subprocess, no git). */
function makeCtx(): TaskContext {
  return {
    taskKey: "TEST-1",
    taskSummary: "Test task",
    taskFile: "/tmp/nonexistent-task.md",
    taskContent: "task content",
    taskDir: "/tmp/nonexistent-task-dir",
    workingDir: "/tmp",
    // oxlint-disable-next-line no-explicit-any
    harness: {} as any,
    executablePath: "/bin/true",
    maxTurns: 5,
    projectSettings: null,
    prTargetBranch: "main",
    hookRetries: 0,
    enableGit: false,
    createPr: false,
    skipComments: true,
    autoReview: false,
    autoReviewIterations: 1,
    skipClarityCheck: true,
    verbose: false,
    implementationOutput: "",
    isPlanRetry: false,
    commitSucceeded: false,
    autoReviewRan: false,
    hookValidated: false,
    results: [],
    warnings: [],
  };
}

/** Build a fake step that records calls and returns scripted results. */
function fakeStep(name: string, results: Array<StepResult | Error>, calls: string[]): PipelineStep {
  let call = 0;
  return {
    name,
    async run(): Promise<StepResult> {
      calls.push(name);
      const scripted = results[Math.min(call, results.length - 1)];
      call++;
      if (scripted instanceof Error) {
        throw scripted;
      }
      return scripted;
    },
  };
}

const CONTINUE: StepResult = { status: StepStatus.Continue };

describe("Pipeline runner", () => {
  test("runs steps in order on Continue", async () => {
    const calls: string[] = [];
    const pipeline = new Pipeline([
      fakeStep("one", [CONTINUE], calls),
      fakeStep("two", [CONTINUE], calls),
      fakeStep("three", [CONTINUE], calls),
    ]);
    const ctx = makeCtx();
    await pipeline.run(ctx);
    expect(calls).toEqual(["one", "two", "three"]);
    expect(ctx.results).toHaveLength(3);
  });

  test("WarnContinue records a warning and continues", async () => {
    const calls: string[] = [];
    const pipeline = new Pipeline([
      fakeStep("warned", [{ status: StepStatus.WarnContinue, reason: "soft failure" }], calls),
      fakeStep("after", [CONTINUE], calls),
    ]);
    const ctx = makeCtx();
    await pipeline.run(ctx);
    expect(calls).toEqual(["warned", "after"]);
    expect(ctx.warnings).toEqual(["warned: soft failure"]);
  });

  test("Halt stops the pipeline and invokes onHalt for incomplete halts", async () => {
    const calls: string[] = [];
    const halts: StepResult[] = [];
    const pipeline = new Pipeline(
      [
        fakeStep("halting", [{ status: StepStatus.Halt, reason: "did not finish" }], calls),
        fakeStep("never", [CONTINUE], calls),
      ],
      {
        onHalt: async (_ctx, result) => {
          halts.push(result);
        },
      },
    );
    await pipeline.run(makeCtx());
    expect(calls).toEqual(["halting"]);
    expect(halts).toHaveLength(1);
    expect(halts[0].reason).toBe("did not finish");
  });

  test("Halt with haltKind 'stop' does NOT invoke onHalt", async () => {
    const calls: string[] = [];
    const halts: StepResult[] = [];
    const pipeline = new Pipeline(
      [
        fakeStep("stopper", [{ status: StepStatus.Halt, haltKind: "stop" }], calls),
        fakeStep("never", [CONTINUE], calls),
      ],
      {
        onHalt: async (_ctx, result) => {
          halts.push(result);
        },
      },
    );
    await pipeline.run(makeCtx());
    expect(calls).toEqual(["stopper"]);
    expect(halts).toHaveLength(0);
  });

  test("retries a step on StepExecutionError up to the limit, then succeeds", async () => {
    const calls: string[] = [];
    const pipeline = new Pipeline(
      [
        fakeStep("flaky", [new StepExecutionError("transient"), CONTINUE], calls),
        fakeStep("after", [CONTINUE], calls),
      ],
      { maxStepRetries: 1 },
    );
    const ctx = makeCtx();
    await pipeline.run(ctx);
    expect(calls).toEqual(["flaky", "flaky", "after"]);
  });

  test("halts (incomplete) when retries are exhausted", async () => {
    const calls: string[] = [];
    const halts: StepResult[] = [];
    const pipeline = new Pipeline(
      [
        fakeStep("always-fails", [new StepExecutionError("boom")], calls),
        fakeStep("never", [CONTINUE], calls),
      ],
      {
        maxStepRetries: 2,
        onHalt: async (_ctx, result) => {
          halts.push(result);
        },
      },
    );
    await pipeline.run(makeCtx());
    expect(calls).toEqual(["always-fails", "always-fails", "always-fails"]);
    expect(halts).toHaveLength(1);
    expect(halts[0].reason).toContain("boom");
  });

  test("UsageLimitError is rethrown, never retried", async () => {
    const calls: string[] = [];
    const pipeline = new Pipeline([fakeStep("limited", [new UsageLimitError("tomorrow")], calls)], {
      maxStepRetries: 5,
    });
    await expect(pipeline.run(makeCtx())).rejects.toBeInstanceOf(UsageLimitError);
    expect(calls).toEqual(["limited"]);
  });

  test("non-StepExecutionError exceptions propagate", async () => {
    const calls: string[] = [];
    const pipeline = new Pipeline([
      fakeStep("crash", [new Error("agent exited with code 1")], calls),
    ]);
    await expect(pipeline.run(makeCtx())).rejects.toThrow("agent exited with code 1");
  });

  test("loopback jumps to the target step and carries feedback", async () => {
    const calls: string[] = [];
    const feedback = { summary: "not done", items: [], approved: false };
    const ctx = makeCtx();
    const seenFeedback: unknown[] = [];

    const implement: PipelineStep = {
      name: "implement",
      async run(c): Promise<StepResult> {
        calls.push("implement");
        seenFeedback.push(c.loopbackFeedback);
        c.loopbackFeedback = undefined; // implement consumes the feedback
        return CONTINUE;
      },
    };
    const verify = fakeStep(
      "verify",
      [
        {
          status: StepStatus.Loopback,
          loopbackTo: "implement",
          loopbackFeedback: feedback,
          maxLoopbacks: 3,
        },
        CONTINUE,
      ],
      calls,
    );

    const pipeline = new Pipeline([implement, verify]);
    await pipeline.run(ctx);
    expect(calls).toEqual(["implement", "verify", "implement", "verify"]);
    expect(seenFeedback).toEqual([undefined, feedback]);
  });

  test("loopback is bounded by maxLoopbacks, then halts via onHalt", async () => {
    const calls: string[] = [];
    const halts: StepResult[] = [];
    const feedback = { summary: "still failing", items: [], approved: false };

    const pipeline = new Pipeline(
      [
        fakeStep("implement", [CONTINUE], calls),
        fakeStep(
          "verify",
          [
            {
              status: StepStatus.Loopback,
              loopbackTo: "implement",
              loopbackFeedback: feedback,
              maxLoopbacks: 2,
              reason: "requirements unmet",
            },
          ],
          calls,
        ),
        fakeStep("finalize", [CONTINUE], calls),
      ],
      {
        onHalt: async (_ctx, result) => {
          halts.push(result);
        },
      },
    );

    await pipeline.run(makeCtx());
    // initial pass + 2 loopbacks, then the 3rd loopback attempt exceeds the bound
    expect(calls).toEqual(["implement", "verify", "implement", "verify", "implement", "verify"]);
    expect(calls).not.toContain("finalize");
    expect(halts).toHaveLength(1);
    expect(halts[0].reason).toBe("requirements unmet");
  });

  test("loopback to an unknown step halts", async () => {
    const calls: string[] = [];
    const halts: StepResult[] = [];
    const pipeline = new Pipeline(
      [fakeStep("verify", [{ status: StepStatus.Loopback, loopbackTo: "does-not-exist" }], calls)],
      {
        onHalt: async (_ctx, result) => {
          halts.push(result);
        },
      },
    );
    await pipeline.run(makeCtx());
    expect(halts).toHaveLength(1);
    expect(halts[0].reason).toContain("does-not-exist");
  });
});
