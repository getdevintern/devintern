import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { VerifyStep } from "../src/lib/pipeline/steps/verify-step";
import type { VerifyStepDeps } from "../src/lib/pipeline/steps/verify-step";
import { StepExecutionError, StepStatus } from "../src/lib/pipeline/types";
import type { TaskContext } from "../src/lib/pipeline/types";

let taskDir: string;

beforeEach(() => {
  taskDir = mkdtempSync(join(tmpdir(), "devintern-verify-step-"));
});

afterEach(() => {
  rmSync(taskDir, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskKey: "TEST-1",
    taskSummary: "Test task",
    taskFile: join(taskDir, "task-details.md"),
    taskContent: "Implement the widget",
    taskDir,
    workingDir: taskDir,
    // oxlint-disable-next-line no-explicit-any
    harness: { displayName: "Fake Agent" } as any,
    executablePath: "/bin/true",
    maxTurns: 5,
    projectSettings: null,
    prTargetBranch: "main",
    hookRetries: 0,
    enableGit: true,
    createPr: false,
    skipComments: true,
    autoReview: false,
    autoReviewIterations: 1,
    skipClarityCheck: true,
    verbose: false,
    implementationOutput: "",
    isPlanRetry: false,
    commitSucceeded: true,
    autoReviewRan: false,
    hookValidated: false,
    results: [],
    warnings: [],
    ...overrides,
  };
}

function makeDeps(agentOutput: string): VerifyStepDeps {
  return {
    runAgentPrompt: async () => agentOutput,
    getPRDiff: () => "diff --git a/widget.ts b/widget.ts\n+export const widget = 1;",
  };
}

const PASS_OUTPUT = `\`\`\`json
{
  "summary": "All requirements satisfied.",
  "items": [],
  "approved": true
}
\`\`\``;

const FAIL_OUTPUT = `\`\`\`json
{
  "summary": "The widget is not wired up.",
  "items": [
    {
      "priority": "high",
      "category": "bug",
      "file": "widget.ts",
      "line": "1",
      "issue": "Widget is exported but never registered",
      "suggestion": "Register the widget in the registry"
    },
    {
      "priority": "low",
      "category": "style",
      "issue": "Minor naming nit",
      "suggestion": "Rename"
    }
  ],
  "approved": false
}
\`\`\``;

describe("VerifyStep", () => {
  test("passing verdict returns Continue", async () => {
    const step = new VerifyStep({}, makeDeps(PASS_OUTPUT));
    const result = await step.run(makeCtx());
    expect(result.status).toBe(StepStatus.Continue);
  });

  test("low-severity-only findings pass at the default 'high' threshold", async () => {
    const lowOnly = FAIL_OUTPUT.replace('"priority": "high"', '"priority": "low"');
    const step = new VerifyStep({}, makeDeps(lowOnly));
    const result = await step.run(makeCtx());
    expect(result.status).toBe(StepStatus.Continue);
  });

  test("failing verdict loops back to implement with the feedback payload", async () => {
    const step = new VerifyStep({ maxIterations: 2 }, makeDeps(FAIL_OUTPUT));
    const result = await step.run(makeCtx());

    expect(result.status).toBe(StepStatus.Loopback);
    expect(result.loopbackTo).toBe("implement");
    expect(result.maxLoopbacks).toBe(2);
    expect(result.loopbackFeedback?.summary).toBe("The widget is not wired up.");
    expect(result.loopbackFeedback?.items).toHaveLength(2);
    expect(result.loopbackFeedback?.approved).toBe(false);
  });

  test("minSeverity config controls what counts as a failure", async () => {
    // At minSeverity "critical", a "high" finding is not blocking.
    const step = new VerifyStep({ minSeverity: "critical" }, makeDeps(FAIL_OUTPUT));
    const result = await step.run(makeCtx());
    expect(result.status).toBe(StepStatus.Continue);
  });

  test("onFail 'halt' maps to an incomplete Halt with the verdict summary", async () => {
    const step = new VerifyStep({ onFail: "halt" }, makeDeps(FAIL_OUTPUT));
    const result = await step.run(makeCtx());
    expect(result.status).toBe(StepStatus.Halt);
    expect(result.haltKind).toBe("incomplete");
    expect(result.reason).toBe("The widget is not wired up.");
  });

  test("onFail 'warn' maps to WarnContinue", async () => {
    const step = new VerifyStep({ onFail: "warn" }, makeDeps(FAIL_OUTPUT));
    const result = await step.run(makeCtx());
    expect(result.status).toBe(StepStatus.WarnContinue);
    expect(result.reason).toBe("The widget is not wired up.");
  });

  test("unparseable JSON throws a retryable StepExecutionError", async () => {
    const step = new VerifyStep({}, makeDeps("I could not produce a verdict, sorry."));
    await expect(step.run(makeCtx())).rejects.toBeInstanceOf(StepExecutionError);
  });

  test("agent failure throws a retryable StepExecutionError", async () => {
    const step = new VerifyStep(
      {},
      {
        runAgentPrompt: async () => {
          throw new Error("agent exploded");
        },
        getPRDiff: () => "diff",
      },
    );
    await expect(step.run(makeCtx())).rejects.toBeInstanceOf(StepExecutionError);
  });

  test("diff failure throws a retryable StepExecutionError", async () => {
    const step = new VerifyStep(
      {},
      {
        runAgentPrompt: async () => PASS_OUTPUT,
        getPRDiff: () => {
          throw new Error("remote branch not found");
        },
      },
    );
    await expect(step.run(makeCtx())).rejects.toBeInstanceOf(StepExecutionError);
  });

  test("returns WarnContinue when git workflow is disabled", async () => {
    const step = new VerifyStep({}, makeDeps(PASS_OUTPUT));
    const result = await step.run(makeCtx({ enableGit: false }));
    expect(result.status).toBe(StepStatus.WarnContinue);
    expect(result.reason).toContain("git workflow disabled");
  });

  test("custom inline prompt is included in the agent prompt", async () => {
    let seenPrompt = "";
    const step = new VerifyStep(
      { prompt: "Check ONLY the accessibility requirements." },
      {
        runAgentPrompt: async (prompt) => {
          seenPrompt = prompt;
          return PASS_OUTPUT;
        },
        getPRDiff: () => "diff",
      },
    );
    await step.run(makeCtx());
    expect(seenPrompt).toContain("Check ONLY the accessibility requirements.");
    expect(seenPrompt).toContain("Implement the widget");
    expect(seenPrompt).toContain("Verdict Format");
  });
});
