import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLimitError } from "@devintern/agent-harness";
import { buildRepairPrompt, verifyImplementation } from "../src/lib/agent/verify";
import type { VerifyDependencies } from "../src/lib/agent/verify";
import type { DeliveryState } from "../src/lib/agent/run-harness-finalize";
import type { FinalizeContext } from "../src/lib/agent/run-harness-git";
import type { ReviewFeedback } from "../src/types/auto-review";

let outputDir: string;
const feedback: ReviewFeedback = {
  summary: "A required behavior is missing",
  approved: false,
  items: [{ priority: "high", category: "bug", issue: "Missing case", suggestion: "Handle it" }],
};

function state(verify: FinalizeContext["verify"]): DeliveryState {
  return {
    taskContent: "Implement the feature",
    workingDir: process.cwd(),
    outputDir,
    prTargetBranch: "main",
    warnings: [],
    context: {
      verify,
      taskFile: join(outputDir, "task.md"),
      taskContent: "Implement the feature",
      prTargetBranch: "main",
      harness: { name: "codex", displayName: "Codex" },
      executablePath: "/usr/bin/agent",
    } as FinalizeContext,
    helpers: {} as DeliveryState["helpers"],
    output: "implementation output",
    committed: true,
    planRetry: false,
    autoReviewRan: false,
  };
}

function deps(verdict = feedback): VerifyDependencies {
  return {
    getDiff: () => "diff --git a/file b/file",
    runAgent: async () => "agent verdict",
    parseFeedback: () => verdict,
    filterItems: (items, severity) =>
      items.filter((item) =>
        severity === "high" ? item.priority === "high" || item.priority === "critical" : true,
      ),
  };
}

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), "verify-step-"));
});

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

describe("verifyImplementation", () => {
  test("passes when the verdict has no blocking findings", async () => {
    const run = state({});
    const verdict = { ...feedback, approved: true, items: [] };

    expect(await verifyImplementation(run, deps(verdict))).toBeUndefined();
    expect(run.pendingFeedback).toBeUndefined();
  });

  test("loops back with feedback and a bounded repair prompt", async () => {
    const run = state({ maxIterations: 2 });

    expect(await verifyImplementation(run, deps())).toEqual({
      kind: "repeat",
      from: "repair",
      maxRepeats: 2,
    });
    expect(run.pendingFeedback).toEqual(feedback);
    expect(buildRepairPrompt(run.context.taskContent, feedback)).toContain("Missing case");
  });

  test("supports halt and warn policies", async () => {
    expect(await verifyImplementation(state({ onFail: "halt" }), deps())).toEqual({
      kind: "halt",
      reason: feedback.summary,
    });
    expect(await verifyImplementation(state({ onFail: "warn" }), deps())).toBeUndefined();
  });

  test("retries a transient verifier error once", async () => {
    const run = state({});
    let attempts = 0;
    const injected = deps({ ...feedback, items: [] });
    injected.runAgent = async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient failure");
      return "verdict";
    };

    expect(await verifyImplementation(run, injected)).toBeUndefined();
    expect(attempts).toBe(2);
  });

  test("propagates usage limits without retrying", async () => {
    const injected = deps();
    let attempts = 0;
    injected.runAgent = async () => {
      attempts++;
      throw new UsageLimitError();
    };

    await expect(verifyImplementation(state({}), injected)).rejects.toThrow(UsageLimitError);
    expect(attempts).toBe(1);
  });

  test("rejects invalid bounds before invoking the agent", async () => {
    await expect(verifyImplementation(state({ maxIterations: 0 }), deps())).rejects.toThrow(
      "positive integer",
    );
  });
});
