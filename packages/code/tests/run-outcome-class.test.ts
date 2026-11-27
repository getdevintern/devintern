import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deliveryHaltFailure, publishImplementation } from "../src/lib/agent/run-harness-finalize";
import type { DeliveryState } from "../src/lib/agent/run-harness-finalize";
import type { FinalizeContext } from "../src/lib/agent/run-harness-git";
import { verifyImplementation } from "../src/lib/agent/verify";
import { RunArtifactRegistry } from "../src/lib/artifacts/registry";
import {
  describeRunFailure,
  failureFromError,
  failureStageName,
  formatFailureCause,
  isEnvironmentError,
  tagOutcomeClass,
  taggedOutcomeClass,
} from "../src/lib/state/run-outcome";
import { baseSyncFailure } from "../src/lib/acquirers/review-polling";
import {
  RunStore,
  beginRun,
  endRun,
  getActiveRunContext,
  noteRunFailure,
  pendingRunFailure,
} from "../src/lib/state/run-recorder";
import { resolveQueueDbPath } from "../src/lib/state/webhook-queue";
import { composeOutcomeReason, finishTaskRun } from "../src/lib/state/task-run";
import { deliveryDispositionFailure } from "../src/lib/agent/implementation-outcome";
import { preservedWorkStatus } from "../src/lib/task/preserve-work";
import { AuthenticationError } from "../src/types/task-tracker-errors";
import { Utils } from "../src/lib/utils";
import { pushWithHookRetry as pushReviewFix } from "../src/lib/review/address";
import type { pushWithHookRetry as PushReviewFix } from "../src/lib/review/address";
import {
  describeRemotePushRejection,
  findRemotePushRejection,
} from "../src/lib/utils/git-push-rejection";

/** What `getPRDiff` threw in run 953 after the stacked base PR merged mid-run. */
const RUN_953_ERROR =
  "Remote branch refs/remotes/origin/feature/local-notification-center-backend-notification not found";

describe("outcome-class helpers", () => {
  test("a missing remote branch is DevIntern's problem, not the environment", () => {
    expect(isEnvironmentError(new Error(RUN_953_ERROR))).toBe(false);
    expect(failureFromError(new Error(RUN_953_ERROR), "__verify-2")).toEqual({
      outcomeClass: "internal",
      stage: "verify",
      cause: RUN_953_ERROR,
    });
  });

  test("credentials, network, rate limits, and missing tools are the environment", () => {
    for (const error of [
      new AuthenticationError(),
      Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
      new Error("HTTP 401: Bad credentials"),
      new Error("API rate limit exceeded (secondary rate limit)"),
      new Error("fatal: could not read Username for 'https://github.com'"),
      new Error("getaddrinfo ENOTFOUND api.github.com"),
      new Error("spawn gh ENOENT"),
    ]) {
      expect(failureFromError(error, "publish").outcomeClass).toBe("environment");
    }
    // An SSH key git rejects, at the end of the text or mid-message.
    expect(isEnvironmentError(new Error("git@github.com: Permission denied (publickey)."))).toBe(
      true,
    );
    expect(isEnvironmentError("Permission denied (publickey)")).toBe(true);
    // A line number that happens to be 429 is not a rate limit.
    expect(isEnvironmentError(new Error("TypeError at src/a.ts:429"))).toBe(false);
  });

  test("the caller's fallback class applies when the error is not environmental", () => {
    expect(failureFromError(new Error("hook rejected"), "publish", "agent").outcomeClass).toBe(
      "agent",
    );
  });

  test("stage names drop pipeline step decorations", () => {
    expect(failureStageName("__verify-3")).toBe("verify");
    expect(failureStageName("auto-review")).toBe("auto-review");
    expect(failureStageName("")).toBe("unknown");
  });

  test("causes are one redacted line, without error prefixes and git hints, truncated", () => {
    const cause = formatFailureCause(
      "fatal: push rejected for ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\nhint: pull first\nmore",
    );
    expect(cause).toStartWith("push rejected for ");
    expect(cause).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(cause).not.toContain("hint");
    const long = formatFailureCause(`word `.repeat(200), 50);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long).toEndWith("…");
  });

  test("the outcome reason names the stage and its cause", () => {
    expect(describeRunFailure({ outcomeClass: "internal", stage: "verify", cause: "boom" })).toBe(
      "verify: boom",
    );
    expect(describeRunFailure({ outcomeClass: "agent", stage: "implementation" })).toBeUndefined();
  });

  test("delivery halts: a closed stacked base is a review hold, others are the agent's", () => {
    expect(deliveryHaltFailure("publish", "anything", "base PR #4 closed")).toEqual({
      outcomeClass: "review_hold",
      stage: "stack_base",
    });
    expect(
      deliveryHaltFailure(
        "__verify-1",
        "Task step '__verify-1' exceeded its repeat limit (3)",
        undefined,
      ),
    ).toMatchObject({ outcomeClass: "agent", stage: "verify" });
  });

  test("a delivered run: blocked is the agent's, a failed PR is DevIntern's publish step", () => {
    expect(deliveryDispositionFailure("succeeded", undefined)).toBeUndefined();
    expect(deliveryDispositionFailure("escalated", undefined)).toEqual({
      outcomeClass: "agent",
      stage: "implementation",
    });
    expect(deliveryDispositionFailure("failed", "Validation Failed: base invalid")).toEqual({
      outcomeClass: "internal",
      stage: "publish",
    });
    expect(deliveryDispositionFailure("failed", "HTTP 401 Unauthorized")).toEqual({
      outcomeClass: "environment",
      stage: "publish",
    });
    // Permanent (missing config, 4xx validation): the user's setup must change.
    expect(
      deliveryDispositionFailure("failed", "A pull request already exists for x:y", true),
    ).toEqual({ outcomeClass: "environment", stage: "publish" });
  });

  test("a tagged error keeps its class through a generic catch block", () => {
    const exited = tagOutcomeClass(new Error("Agent exited with code 1: overloaded"), "agent");
    expect(taggedOutcomeClass(exited)).toBe("agent");
    expect(failureFromError(exited, "implementation").outcomeClass).toBe("agent");
    // An untagged error still falls back to internal.
    expect(failureFromError(new Error("boom"), "implementation").outcomeClass).toBe("internal");
    // A credential problem in an agent's failure is still the environment…
    const auth = tagOutcomeClass(new Error("Agent exited with code 1: HTTP 401"), "agent");
    expect(failureFromError(auth, "implementation").outcomeClass).toBe("environment");
    // …unless the tag is definite: hook output can print ECONNREFUSED itself.
    const hook = tagOutcomeClass(
      new Error("push failed: pre-push: connect ECONNREFUSED 127.0.0.1:5432"),
      "agent",
      { definite: true },
    );
    expect(failureFromError(hook, "publish").outcomeClass).toBe("agent");
  });

  test("a base sync the conflict agent could not resolve is the agent's", () => {
    expect(
      baseSyncFailure({ outcome: "failed", message: "merge aborted", failureKind: "aborted" }),
    ).toMatchObject({ outcomeClass: "agent", stage: "base_sync" });
    expect(
      baseSyncFailure({ outcome: "failed", message: "base fetch failed", failureKind: "setup" }),
    ).toMatchObject({ outcomeClass: "internal" });
    expect(
      baseSyncFailure({ outcome: "failed", message: "could not resolve host github.com" }),
    ).toMatchObject({ outcomeClass: "environment" });
  });

  test("preserved work maps to a work status", () => {
    expect(
      preservedWorkStatus({ kind: "pushed", branch: "feature/x", committed: true, note: "n" }),
    ).toEqual({ status: "saved", ref: "feature/x" });
    expect(preservedWorkStatus({ kind: "kept", path: "/w/t", detail: "d", note: "n" })).toEqual({
      status: "kept",
      ref: "/w/t",
    });
    expect(preservedWorkStatus({ kind: "none" })).toEqual({ status: "none" });
  });
});

describe("RunStore outcome columns", () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-outcome-class-"));
    store = new RunStore(join(dir, "queue.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("finishRun records class, stage, cause, and work status", () => {
    const id = store.createRun({ origin: "task", taskKey: "A-1" });
    store.finishRun(id, "escalated", "verify: boom", {
      failure: { outcomeClass: "internal", stage: "verify", cause: "boom" },
      work: { status: "saved", ref: "feature/a-1" },
    });
    expect(store.getRun(id)).toMatchObject({
      outcomeClass: "internal",
      failureStage: "verify",
      failureCause: "boom",
      workStatus: "saved",
      workRef: "feature/a-1",
    });
  });

  test("a success (re-)finish clears the classification; deferred records none", () => {
    const id = store.createRun({ origin: "task", taskKey: "A-2" });
    store.finishRun(id, "failed", "x", {
      failure: { outcomeClass: "internal", stage: "publish" },
      work: { status: "discarded" },
    });
    store.finishRun(id, "succeeded", undefined, {
      failure: { outcomeClass: "internal", stage: "publish" },
      work: { status: "discarded" },
    });
    const run = store.getRun(id);
    expect(run?.outcomeClass).toBeUndefined();
    expect(run?.workStatus).toBeUndefined();

    const deferred = store.createRun({ origin: "task", taskKey: "A-3" });
    store.finishRun(deferred, "deferred", "usage limit", {
      failure: { outcomeClass: "environment" },
    });
    expect(store.getRun(deferred)?.outcomeClass).toBeUndefined();
  });

  test("lists and counts runs by outcome class", () => {
    const internal = store.createRun({ origin: "task", taskKey: "B-1" });
    store.finishRun(internal, "escalated", "r", { failure: { outcomeClass: "internal" } });
    const agent = store.createRun({ origin: "task", taskKey: "B-2" });
    store.finishRun(agent, "escalated", "r", { failure: { outcomeClass: "agent" } });
    expect(store.listRuns({ outcomeClass: "internal" }).map((run) => run.id)).toEqual([internal]);
    expect(store.countFilteredRuns({ outcomeClass: "agent" })).toBe(1);
  });

  test("an old database gains the columns, and escalated auto-merge runs become review holds", () => {
    store.close();
    const legacyPath = join(dir, "legacy.db");
    const legacy = new Database(legacyPath);
    legacy.run(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, task_key TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress', outcome_reason TEXT,
      started_at INTEGER NOT NULL, finished_at INTEGER)`);
    legacy.run(
      `INSERT INTO runs (origin, status, outcome_reason, started_at) VALUES
        ('auto_merge', 'escalated', 'matches deny pattern a/**', 1),
        ('task', 'escalated', 'implementation incomplete; handed back to a human', 2),
        ('auto_merge', 'succeeded', NULL, 3)`,
    );
    legacy.close();
    store = new RunStore(legacyPath);
    const byId = new Map(store.listRuns().map((run) => [run.id, run.outcomeClass]));
    expect(byId.get(1)).toBe("review_hold");
    // Everything else predates classification and stays unclassified.
    expect(byId.get(2)).toBeUndefined();
    expect(byId.get(3)).toBeUndefined();
  });
});

describe("classifying the current run", () => {
  let reader: RunStore;

  beforeEach(() => {
    reader = new RunStore(resolveQueueDbPath());
  });

  afterEach(() => {
    if (getActiveRunContext()) endRun("failed", "test cleanup");
    reader.close();
  });

  test("the first noted failure wins and names the stage in the outcome reason", async () => {
    beginRun({ origin: "task", taskKey: "C-1" });
    const runId = getActiveRunContext()!.id;
    noteRunFailure({ outcomeClass: "internal", stage: "verify", cause: "diff failed" });
    noteRunFailure({ outcomeClass: "agent", stage: "implementation", cause: "later" });
    expect(pendingRunFailure()?.outcomeClass).toBe("internal");
    await finishTaskRun("escalated", "implementation incomplete; handed back to a human", {
      failure: { outcomeClass: "agent", stage: "implementation" },
      note: "work preserved on branch 'feature/c-1'",
      work: { status: "saved", ref: "feature/c-1" },
    });
    expect(reader.getRun(runId)).toMatchObject({
      status: "escalated",
      outcomeClass: "internal",
      failureStage: "verify",
      outcomeReason: "verify: diff failed; work preserved on branch 'feature/c-1'",
      workStatus: "saved",
      workRef: "feature/c-1",
    });
    // Cleared for the next run.
    expect(pendingRunFailure()).toBeUndefined();
  });

  test("a default without a cause keeps the caller's (prefix-bearing) reason", () => {
    expect(
      composeOutcomeReason("failed", "pushed but PR creation failed: 422", {
        failure: { outcomeClass: "internal", stage: "publish" },
      }),
    ).toBe("pushed but PR creation failed: 422");
    // A success never takes a failure's cause.
    expect(
      composeOutcomeReason("succeeded", "partial: x", {
        failure: { outcomeClass: "internal", stage: "verify", cause: "boom" },
      }),
    ).toBe("partial: x");
  });

  test("replay of run 953: verify's diff throws after the stacked base merged → internal", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "run-953-"));
    try {
      beginRun({ origin: "local", taskKey: "local-notification-center-backend-notification" });
      const runId = getActiveRunContext()!.id;
      const state = {
        artifacts: new RunArtifactRegistry(outputDir, outputDir, join(outputDir, "artifacts.db")),
        taskContent: "Implement the feature",
        outputDir,
        enableGit: true,
        committed: true,
        context: {
          verify: { onFail: "loopback" },
          taskFile: join(outputDir, "task.md"),
          taskContent: "Implement the feature",
          prTargetBranch: "origin/feature/local-notification-center-backend-notification",
          harness: { name: "codex", displayName: "Codex" },
          executablePath: "/usr/bin/agent",
        } as FinalizeContext,
      } as unknown as DeliveryState;
      const result = await verifyImplementation(state, {
        getDiff: () => {
          throw new Error(RUN_953_ERROR);
        },
        runAgent: async () => "",
        parseFeedback: () => {
          throw new Error("unreachable");
        },
        filterItems: (items) => items,
      });
      expect(result).toMatchObject({ kind: "halt" });
      // The pipeline then settles the halted run through its generic
      // "incomplete" escalation, which used to hide the real cause.
      await finishTaskRun("escalated", "implementation incomplete; handed back to a human", {
        failure: { outcomeClass: "agent", stage: "implementation" },
      });
      const run = reader.getRun(runId);
      expect(run?.outcomeClass).toBe("internal");
      expect(run?.failureStage).toBe("verify");
      expect(run?.failureCause).toBe(RUN_953_ERROR);
      expect(run?.outcomeReason).toBe(`verify: ${RUN_953_ERROR}`);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  async function publishWithFailedPush(result: Record<string, unknown>) {
    beginRun({ origin: "task", taskKey: "P-1" });
    const hasHook = spyOn(Utils, "hasPrePushHook").mockResolvedValue(true);
    try {
      const state = {
        hookValidated: true,
        output: "",
        context: { enableGit: true, taskKey: "P-1", taskSummary: "s", createPr: true, task: {} },
        helpers: { pushWithHookRetry: async () => ({ success: false, result }) },
      } as unknown as DeliveryState;
      const step = await publishImplementation(state);
      expect(step).toMatchObject({ kind: "halt", reason: "Push failed" });
      return pendingRunFailure();
    } finally {
      hasHook.mockRestore();
    }
  }

  test.each([
    "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope",
    "protected branch hook declined",
    "pre-receive hook declined",
    "cannot lock ref 'refs/heads/feature/p-1'",
  ])(
    "a server-side push refusal %p is the environment, even with a pre-push hook",
    async (reason) => {
      const rejection = findRemotePushRejection(
        ` ! [remote rejected] feature/p-1 -> feature/p-1 (${reason})`,
        "feature/p-1",
      )!;
      const failure = await publishWithFailedPush({
        success: false,
        message: describeRemotePushRejection(rejection, "feature/p-1"),
        remoteRejection: rejection,
      });
      expect(failure).toMatchObject({ outcomeClass: "environment", stage: "publish" });
    },
  );

  test("a pre-push hook failure stays the agent's", async () => {
    const failure = await publishWithFailedPush({
      success: false,
      message: "Failed to push branch: lint failed",
      hookError: "lint failed",
    });
    expect(failure?.outcomeClass).toBe("agent");
  });

  test("a review fix push the remote refused is the environment", async () => {
    const rejection = findRemotePushRejection(
      " ! [remote rejected] feature/p-1 -> feature/p-1 (protected branch hook declined)",
      "feature/p-1",
    )!;
    const push = spyOn(Utils, "pushCurrentBranch").mockResolvedValue({
      success: false,
      message: describeRemotePushRejection(rejection, "feature/p-1"),
      remoteRejection: rejection,
    });
    const hasHook = spyOn(Utils, "hasPrePushHook").mockResolvedValue(true);
    try {
      const thrown = await pushReviewFix({
        workDir: "/nonexistent",
        verbose: false,
        hookRetries: 2,
        harness: {} as Parameters<typeof PushReviewFix>[0]["harness"],
        executablePath: "/usr/bin/agent",
        maxTurns: 1,
        prBranch: "feature/p-1",
      }).catch((error: unknown) => error);
      expect(failureFromError(thrown, "publish").outcomeClass).toBe("environment");
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      push.mockRestore();
      hasHook.mockRestore();
    }
  });
});
