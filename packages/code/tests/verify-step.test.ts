import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifactRegistry } from "../src/lib/artifacts/registry";
import { beginShutdown, resetShutdownState } from "../src/lib/cli/shutdown-state";
import { UsageLimitError } from "@devintern/agent-harness";
import {
  buildRepairPrompt,
  describeVerificationFailure,
  verifyImplementation,
} from "../src/lib/agent/verify";
import type { VerifyDependencies } from "../src/lib/agent/verify";
import {
  UNTRUSTED_CONTENT_NOTICE,
  untrustedContentBlock,
} from "../src/lib/prompts/untrusted-content";
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
    artifacts: new RunArtifactRegistry(outputDir, outputDir, join(outputDir, "artifacts.db")),
    taskContent: "Implement the feature",
    taskFile: join(outputDir, "task.md"),
    workingDir: process.cwd(),
    outputDir,
    prTargetBranch: "main",
    projectSettings: null,
    enableGit: true,
    createPr: false,
    allowNoChanges: false,
    skipComments: false,
    autoReview: false,
    autoReviewIterations: 5,
    maxTurns: 500,
    warnings: [],
    results: [],
    runAgentPrompt: async () => "",
    getDiff: () => "",
    parseReviewFeedback: () => feedback,
    filterByPriority: (items) => items,
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
    hookValidated: false,
    implementationStepSeen: false,
    noChanges: false,
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
  resetShutdownState();
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
      reason: describeVerificationFailure(feedback, feedback.items),
    });
    expect(run.pendingFeedback).toEqual(feedback);
    expect(buildRepairPrompt(run.context.taskContent, feedback)).toContain("Missing case");
  });

  test("supports halt and warn policies", async () => {
    // The reason carries the blocking findings, not only the summary: it is
    // what the tracker comment and the dashboard show the operator.
    const reason = describeVerificationFailure(feedback, feedback.items);
    expect(reason).toContain("Verification found 1 blocking finding(s)");
    expect(reason).toContain("Missing case");

    expect(await verifyImplementation(state({ onFail: "halt" }), deps())).toEqual({
      kind: "halt",
      reason,
    });
    expect(await verifyImplementation(state({ onFail: "warn" }), deps())).toEqual({
      kind: "warn",
      reason,
    });
  });

  test("stops retrying and reports an interruption while shutting down", async () => {
    // SIGTERM kills the agent child; retrying would spawn into a dying process
    // and the shutdown handler already owns the interruption report.
    const run = state({});
    let calls = 0;
    const interrupted: VerifyDependencies = {
      ...deps(),
      runAgent: async () => {
        calls += 1;
        throw new Error("Opencode exited with code 130: ");
      },
    };

    beginShutdown();
    try {
      expect(await verifyImplementation(run, interrupted)).toEqual({
        kind: "halt",
        haltKind: "stop",
        reason: "Interrupted during verification",
      });
      expect(calls).toBe(1);
    } finally {
      resetShutdownState();
    }
  });

  test("keeps the prompt and raw answer when no verdict can be parsed", async () => {
    const run = state({});
    const failing: VerifyDependencies = {
      ...deps(),
      runAgent: async () => "the agent wrote prose instead of JSON",
      parseFeedback: () => {
        throw new Error('No valid JSON object containing "approved" found in Agent response');
      },
    };

    expect(await verifyImplementation(run, failing)).toEqual({
      kind: "halt",
      reason:
        'Verification failed twice: No valid JSON object containing "approved" found in Agent response',
    });
    expect(existsSync(join(outputDir, "verify-prompt.txt"))).toBe(true);
    expect(readFileSync(join(outputDir, "verify-output.txt"), "utf8")).toBe(
      "the agent wrote prose instead of JSON",
    );
  });

  test("warns when Git delivery is disabled", async () => {
    const run = state({});
    run.enableGit = false;
    expect(await verifyImplementation(run, deps())).toEqual({
      kind: "warn",
      reason: "verify skipped: git workflow disabled",
    });
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

  test("halts after repeated verdicts that approve unresolved blocking findings", async () => {
    const injected = deps({ ...feedback, approved: true });
    let attempts = 0;
    injected.runAgent = async () => {
      attempts++;
      return "verdict";
    };
    const result = await verifyImplementation(state({}), injected);
    expect(result?.kind).toBe("halt");
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

  test("frames the raw diff without re-framing the task prompt", async () => {
    let captured = "";
    const injected = deps({ ...feedback, approved: true, items: [] });
    injected.runAgent = async (prompt) => {
      captured = prompt;
      return "verdict";
    };

    await verifyImplementation(state({}), injected);

    expect(captured).toContain(UNTRUSTED_CONTENT_NOTICE);
    expect(captured).toContain("<!-- BEGIN UNTRUSTED EXTERNAL CONTENT: implementation diff -->");
    expect(captured).toContain("Implement the feature");
    expect(captured).not.toContain("<!-- BEGIN UNTRUSTED EXTERNAL CONTENT: task -->");
  });

  test("does not nest or neutralize an already-framed task prompt", async () => {
    const framedTask = untrustedContentBlock("Implement the feature", "task description");
    let captured = "";
    const injected = deps({ ...feedback, approved: true, items: [] });
    injected.runAgent = async (prompt) => {
      captured = prompt;
      return "verdict";
    };

    const run = state({});
    run.context.taskContent = framedTask;
    await verifyImplementation(run, injected);

    expect(captured).toContain("<!-- BEGIN UNTRUSTED EXTERNAL CONTENT: task description -->");
    expect(captured).not.toContain("[neutralized untrusted-content boundary marker]");
    expect(captured).not.toContain("<!-- BEGIN UNTRUSTED EXTERNAL CONTENT: task -->");
  });

  test("frames findings and preserves the already-framed original task", () => {
    const framedTask = untrustedContentBlock("Implement the feature", "task description");
    const prompt = buildRepairPrompt(framedTask, feedback);

    expect(prompt).toContain(UNTRUSTED_CONTENT_NOTICE);
    expect(prompt).toContain("<!-- BEGIN UNTRUSTED EXTERNAL CONTENT: verification findings -->");
    expect(prompt).toContain("<!-- BEGIN UNTRUSTED EXTERNAL CONTENT: task description -->");
    expect(prompt).not.toContain("[neutralized untrusted-content boundary marker]");
    expect(prompt).not.toContain("<!-- BEGIN UNTRUSTED EXTERNAL CONTENT: task -->");
  });

  test("default instructions request confidence and evidence", async () => {
    let captured = "";
    const injected = deps({ ...feedback, approved: true, items: [] });
    injected.runAgent = async (prompt) => {
      captured = prompt;
      return "verdict";
    };

    await verifyImplementation(state({}), injected);

    expect(captured).toContain('"confidence":"high|medium|low"');
    expect(captured).toContain('"evidence":"command run and result, file:line, or unproven"');
  });

  test("propagates evidence/confidence into the repair prompt", () => {
    const withEvidence: ReviewFeedback = {
      summary: "unproven change",
      approved: false,
      items: [
        {
          priority: "high",
          category: "bug",
          issue: "Missing case",
          suggestion: "Handle it",
          confidence: "low",
          evidence: "unproven",
        },
      ],
    };
    const prompt = buildRepairPrompt("Implement the feature", withEvidence);

    expect(prompt).toContain("Confidence: low");
    expect(prompt).toContain("Evidence: unproven");
  });
});
