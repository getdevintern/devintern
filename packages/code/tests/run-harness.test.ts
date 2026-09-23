/**
 * Behavior tests for `runAgentHarness` with a mocked agent harness.
 *
 * `spawnAgent` is the only real I/O seam: everything else the function touches
 * (tracker, git Utils, PR manager, detectors, state recorders) is stubbed via
 * `mock.module` so each test drives one exit branch and asserts the
 * resolve/reject polarity plus the tracker side effects.
 *
 * bun shares one module registry across test files, and `mock.restore()` does
 * not restore `mock.module` overrides, so we snapshot the real exports and
 * re-register them in `afterAll`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentHarness } from "@devintern/agent-harness";
import type { ReviewFeedback } from "../src/types/auto-review";
import { runContext } from "../src/lib/cli/context";

// --- snapshot real modules before any mock.module override ---
const realHarness = { ...(await import("@devintern/agent-harness")) };
const realUtils = { ...(await import("../src/lib/utils")) };
const realCodeHost = { ...(await import("../src/lib/code-host")) };
const realOutputDir = { ...(await import("../src/lib/config/output-dir")) };
const realProjectSettings = { ...(await import("../src/lib/config/project-settings")) };
const realAutoReview = { ...(await import("../src/lib/review/auto-review-loop")) };
const realRetryState = { ...(await import("../src/lib/state/retry-state")) };
const realRunRecorder = { ...(await import("../src/lib/state/run-recorder")) };
const realWorkerState = { ...(await import("../src/lib/state/worker-state")) };
const realImplComment = { ...(await import("../src/lib/task/implementation-comment")) };
const realGitHookFixer = { ...(await import("../src/lib/agent/git-hook-fixer")) };
const realModel = { ...(await import("../src/lib/agent/model")) };
const realPlan = { ...(await import("../src/lib/agent/plan")) };
const realSandbox = { ...(await import("../src/lib/agent/sandbox")) };
const realUtilsPkg = { ...(await import("@devintern/utils")) };

interface Scenario {
  stdout?: string;
  stderr?: string;
  closeCode?: number | null;
  spawnError?: NodeJS.ErrnoException;
  /** Emit `close` after this many ms (used to close after a timeout fires). */
  closeDelayMs?: number;
  usage?: { limited: boolean; resetsAt?: string; matchedLine?: string };
  maxTurns?: boolean;
  incomplete?: { incomplete: boolean; reasons: string[] };
  openQuestions?: { awaitingInput: boolean; questions: string[] };
}

let scenario: Scenario;
let outDir: string;
let taskFile: string;
let tracker: {
  postIncompleteImplementationComment: ReturnType<typeof mock>;
  transitionStatus: ReturnType<typeof mock>;
  postComment: ReturnType<typeof mock>;
  extractDescriptionText: () => string;
};
let commitResult: { success: boolean; message: string; hookError?: string };
let commitResults: Array<typeof commitResult>;
let commitCalls: number;
let pushResult: { success: boolean; message: string; hookError?: string };
let hookResult: { success: boolean; message: string; hookError?: string };
let hookCalls: number;
let autoReviewCalls: number;
let planPath: string | null;
let verifyVerdicts: ReviewFeedback[];
let verifyCalls: number;
let deliveryEvents: string[];
let prResult: { success: boolean; url?: string; message?: string; warnings?: string[] };
let postImplementationCommentMock: ReturnType<typeof mock>;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
}

mock.module("@devintern/agent-harness", () => ({
  ...realHarness,
  resolveExecutablePathWithRetry: async (path: string) => path,
  buildPromptArgs: () => [],
  reapTree: () => {},
  spawnAgent: async () => {
    const child = new FakeChild();
    const emitClose = () => {
      if (scenario.stdout) child.stdout.emit("data", Buffer.from(scenario.stdout));
      if (scenario.stderr) child.stderr.emit("data", Buffer.from(scenario.stderr));
      child.emit("close", scenario.closeCode ?? 0);
    };
    if (scenario.spawnError) {
      setImmediate(() => child.emit("error", scenario.spawnError));
    } else if (scenario.closeDelayMs !== undefined) {
      setTimeout(emitClose, scenario.closeDelayMs);
    } else {
      setImmediate(emitClose);
    }
    return { child, cleanup: async () => {} };
  },
  detectUsageLimit: () => scenario.usage ?? { limited: false },
  detectMaxTurnsReached: () => scenario.maxTurns ?? false,
  findMaxTurnsReachedLine: () => undefined,
  detectIncompleteImplementation: () => scenario.incomplete ?? { incomplete: false, reasons: [] },
  detectOpenQuestions: () => scenario.openQuestions ?? { awaitingInput: false, questions: [] },
}));

mock.module("../src/lib/utils", () => ({
  GIT_CLEAN_ARGS: realUtils.GIT_CLEAN_ARGS,
  Utils: {
    runPrePushHookLocally: async () => {
      hookCalls++;
      return hookResult;
    },
    pushCurrentBranch: async () => {
      deliveryEvents.push("push");
      return pushResult;
    },
    commitChanges: async () => {
      commitCalls++;
      deliveryEvents.push("commit");
      return commitResults.shift() ?? commitResult;
    },
    getCurrentBranch: async () => "feature/task-1",
    isProtectedBranch: async () => false,
    remoteBranchExists: async () => true,
    getMainBranchName: async () => "main",
  },
}));

mock.module("../src/lib/code-host", () => ({
  ...realCodeHost,
  PRManager: class {
    async createPullRequest() {
      return prResult;
    }
  },
}));

mock.module("../src/lib/config/output-dir", () => ({ resolveOutputDir: () => outDir }));
mock.module("../src/lib/config/project-settings", () => ({
  loadProjectSettings: () => ({}),
  getTodoStatusForProject: () => "To Do",
  getPrStatusForProject: () => "In Review",
  resolveProjectKey: () => "PROJ",
}));
mock.module("../src/lib/review/auto-review-loop", () => ({
  ...realAutoReview,
  runAutoReviewLoop: async () => {
    autoReviewCalls++;
    return { success: true, iterations: 1, finalFeedback: [] };
  },
  getPRDiff: () => "diff --git a/file b/file",
  runAgentPrompt: async () => {
    verifyCalls++;
    deliveryEvents.push("verify");
    return "verdict";
  },
  parseReviewFeedback: () =>
    verifyVerdicts.shift() ?? { summary: "approved", items: [], approved: true },
  filterByPriority: realAutoReview.filterByPriority,
}));
mock.module("../src/lib/state/retry-state", () => ({ recordIncompleteAttempt: () => {} }));
mock.module("../src/lib/state/run-recorder", () => ({
  recordRunPr: () => {},
  recordRunStage: () => {},
}));
mock.module("../src/lib/state/worker-state", () => ({
  parseGitHubPrUrl: () => ({ repo: "o/r", prNumber: 1 }),
  recordAgentPrFromUrl: () => {},
}));
mock.module("../src/lib/task/implementation-comment", () => ({
  postImplementationComment: (...args: unknown[]) => postImplementationCommentMock(...args),
}));
mock.module("../src/lib/agent/git-hook-fixer", () => ({
  isCommitAlreadyComplete: async () => false,
  runAgentHarnessToFixGitHook: async () => false,
}));
mock.module("../src/lib/agent/model", () => ({
  resolveAgentEffort: () => undefined,
  resolveAgentModel: () => undefined,
}));
mock.module("../src/lib/agent/plan", () => ({
  createPlanImplementationPrompt: () => "prompt",
  detectPlanOnlyBehavior: () => planPath,
  logHookErrorToFile: () => {},
}));
mock.module("../src/lib/agent/sandbox", () => ({ getSandbox: async () => null }));
mock.module("@devintern/utils", () => ({ ...realUtilsPkg, captureError: () => {} }));

const { runAgentHarness } = await import("../src/lib/agent/run-harness");

const harness = {
  name: "claude-code",
  displayName: "Claude Code",
  buildArgs: () => ["--flag"],
  supportsMaxTurns: true,
} as unknown as AgentHarness;
const task = { key: "TASK-1" } as never;

function baseInput() {
  return {
    taskFile,
    harness,
    executablePath: "/usr/bin/agent",
    taskKey: "TASK-1",
    taskSummary: "Do the thing",
    task,
    tracker: tracker as never,
    skipComments: false,
  };
}

beforeEach(() => {
  scenario = {};
  commitResult = { success: true, message: "committed" };
  commitResults = [];
  commitCalls = 0;
  pushResult = { success: true, message: "pushed" };
  hookResult = { success: true, message: "hook ok" };
  hookCalls = 0;
  autoReviewCalls = 0;
  planPath = null;
  verifyVerdicts = [];
  verifyCalls = 0;
  deliveryEvents = [];
  prResult = { success: true, url: "https://github.com/o/r/pull/1", warnings: [] };
  postImplementationCommentMock = mock(async () => {});
  outDir = mkdtempSync(join(tmpdir(), "run-harness-"));
  mkdirSync(join(outDir, "task-1"), { recursive: true });
  taskFile = join(outDir, "task.md");
  writeFileSync(taskFile, "implement the thing", "utf8");
  tracker = {
    postIncompleteImplementationComment: mock(async () => {}),
    transitionStatus: mock(async () => {}),
    postComment: mock(async () => {}),
    extractDescriptionText: () => "description",
  };
  runContext.options = { verbose: false } as never;
  delete process.env.AGENT_HARNESS_TIMEOUT_MINUTES;
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

afterAll(() => {
  mock.module("@devintern/agent-harness", () => ({ ...realHarness }));
  mock.module("../src/lib/utils", () => ({ ...realUtils }));
  mock.module("../src/lib/code-host", () => ({ ...realCodeHost }));
  mock.module("../src/lib/config/output-dir", () => ({ ...realOutputDir }));
  mock.module("../src/lib/config/project-settings", () => ({ ...realProjectSettings }));
  mock.module("../src/lib/review/auto-review-loop", () => ({ ...realAutoReview }));
  mock.module("../src/lib/state/retry-state", () => ({ ...realRetryState }));
  mock.module("../src/lib/state/run-recorder", () => ({ ...realRunRecorder }));
  mock.module("../src/lib/state/worker-state", () => ({ ...realWorkerState }));
  mock.module("../src/lib/task/implementation-comment", () => ({ ...realImplComment }));
  mock.module("../src/lib/agent/git-hook-fixer", () => ({ ...realGitHookFixer }));
  mock.module("../src/lib/agent/model", () => ({ ...realModel }));
  mock.module("../src/lib/agent/plan", () => ({ ...realPlan }));
  mock.module("../src/lib/agent/sandbox", () => ({ ...realSandbox }));
  mock.module("@devintern/utils", () => ({ ...realUtilsPkg }));
});

describe("runAgentHarness early failures", () => {
  test("rejects when the task file is missing", async () => {
    await expect(
      runAgentHarness({ ...baseInput(), taskFile: join(outDir, "missing.md") }),
    ).rejects.toThrow("Task file not found");
  });

  test("rejects with install guidance on spawn ENOENT", async () => {
    scenario.spawnError = Object.assign(new Error("spawn agent ENOENT"), { code: "ENOENT" });
    await expect(runAgentHarness(baseInput())).rejects.toThrow("CLI not found");
  });

  test("rejects with UsageLimitError when the harness hits a limit", async () => {
    scenario.usage = { limited: true, resetsAt: "10:00", matchedLine: "usage limit reached" };
    await expect(runAgentHarness(baseInput())).rejects.toThrow(realHarness.UsageLimitError);
  });

  test("rejects on a non-zero exit code", async () => {
    scenario.closeCode = 1;
    await expect(runAgentHarness(baseInput())).rejects.toThrow("Agent exited with code 1");
  });

  test("rejects when the agent times out", async () => {
    process.env.AGENT_HARNESS_TIMEOUT_MINUTES = "0";
    scenario.closeDelayMs = 20;
    await expect(runAgentHarness(baseInput())).rejects.toThrow("timed out");
  });
});

describe("runAgentHarness non-commit outcomes", () => {
  test("max-turns resolves, reports incomplete, and moves the task back to To Do", async () => {
    scenario.stdout = "partial work before the turn cap";
    scenario.maxTurns = true;

    await runAgentHarness(baseInput());

    expect(tracker.postIncompleteImplementationComment).toHaveBeenCalledTimes(1);
    expect(tracker.transitionStatus).toHaveBeenCalledWith("TASK-1", "To Do");
  });

  test("incomplete implementation resolves and reports without committing", async () => {
    scenario.stdout = "I could not finish this";
    scenario.incomplete = { incomplete: true, reasons: ["failure language"] };

    await runAgentHarness(baseInput());

    expect(tracker.postIncompleteImplementationComment).toHaveBeenCalledTimes(1);
    expect(tracker.transitionStatus).toHaveBeenCalledWith("TASK-1", "To Do");
  });

  test("open questions resolve and post the questions as a comment", async () => {
    scenario.stdout = "Which database should I use?";
    scenario.openQuestions = { awaitingInput: true, questions: ["Which database?"] };

    await runAgentHarness(baseInput());

    expect(tracker.postComment).toHaveBeenCalledTimes(1);
    expect(tracker.postIncompleteImplementationComment).not.toHaveBeenCalled();
  });

  test("success without git resolves and posts no tracker comments", async () => {
    scenario.stdout = "done";

    await runAgentHarness({ ...baseInput(), enableGit: false });

    expect(tracker.postComment).not.toHaveBeenCalled();
    expect(tracker.postIncompleteImplementationComment).not.toHaveBeenCalled();
  });
});

describe("runAgentHarness git delivery", () => {
  test("commits and posts the implementation summary when no PR is requested", async () => {
    scenario.stdout = "done";

    await runAgentHarness(baseInput());

    expect(postImplementationCommentMock).toHaveBeenCalledTimes(1);
    expect(tracker.transitionStatus).not.toHaveBeenCalled();
  });

  test("creates a PR and transitions the task to the PR status", async () => {
    scenario.stdout = "done";

    await runAgentHarness({ ...baseInput(), createPr: true });

    expect(postImplementationCommentMock).toHaveBeenCalledTimes(1);
    expect(tracker.transitionStatus).toHaveBeenCalledWith("TASK-1", "In Review");
  });

  test("retries a plan-only run and publishes the committed implementation", async () => {
    scenario.stdout = "Created a plan";
    planPath = "PLAN_DETECTED_NO_PATH";
    commitResults = [{ success: false, message: "No changes to commit" }];

    await runAgentHarness({ ...baseInput(), createPr: true, autoReview: true });

    expect(commitCalls).toBe(2);
    expect(hookCalls).toBe(1);
    expect(autoReviewCalls).toBe(0);
    expect(postImplementationCommentMock).toHaveBeenCalledTimes(1);
    expect(tracker.transitionStatus).toHaveBeenCalledWith("TASK-1", "In Review");
  });

  test("validates hooks before and after auto-review", async () => {
    scenario.stdout = "done";

    await runAgentHarness({ ...baseInput(), createPr: true, autoReview: true });

    expect(autoReviewCalls).toBe(1);
    expect(hookCalls).toBe(2);
    expect(tracker.transitionStatus).toHaveBeenCalledWith("TASK-1", "In Review");
  });

  test("verifies the committed diff before pushing", async () => {
    scenario.stdout = "done";

    await runAgentHarness({ ...baseInput(), createPr: true, verify: {} });

    expect(deliveryEvents).toEqual(["commit", "verify", "push"]);
    expect(tracker.transitionStatus).toHaveBeenCalledWith("TASK-1", "In Review");
  });

  test("halts a failed verdict and returns the ticket to To Do", async () => {
    scenario.stdout = "done";
    verifyVerdicts = [
      {
        summary: "Required behavior missing",
        approved: false,
        items: [{ priority: "high", category: "bug", issue: "Missing case", suggestion: "Fix it" }],
      },
    ];

    await runAgentHarness({ ...baseInput(), createPr: true, verify: { onFail: "halt" } });

    expect(deliveryEvents).toEqual(["commit", "verify"]);
    expect(tracker.postIncompleteImplementationComment).toHaveBeenCalledTimes(1);
    expect(tracker.transitionStatus).toHaveBeenCalledWith("TASK-1", "To Do");
  });

  test("repairs a failed verdict, recommits, and verifies before publishing", async () => {
    scenario.stdout = "done";
    verifyVerdicts = [
      {
        summary: "Required behavior missing",
        approved: false,
        items: [{ priority: "high", category: "bug", issue: "Missing case", suggestion: "Fix it" }],
      },
      { summary: "Approved", approved: true, items: [] },
    ];

    await runAgentHarness({ ...baseInput(), createPr: true, verify: { maxIterations: 2 } });

    expect(verifyCalls).toBe(2);
    expect(deliveryEvents).toEqual(["commit", "verify", "commit", "verify", "push"]);
    expect(tracker.transitionStatus).toHaveBeenCalledWith("TASK-1", "In Review");
  });
});
