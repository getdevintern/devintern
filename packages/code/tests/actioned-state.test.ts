import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  actionedSourceKey,
  actionedSourceKeyFromEnv,
  computeActionedSignal,
  createTaskActionedGate,
  recordTaskActioned,
  trackerActionedSignal,
} from "../src/lib/task/actioned-state";
import type { TaskTrackerClient } from "../src/lib/trackers/client";
import { WorkerState } from "../src/lib/state/worker-state";
import type { Task } from "../src/types/task-tracker";

/** GitHub-shaped task: description lives in `raw.body`. */
function githubTask(overrides: Partial<Task> & { body?: string; state?: string } = {}): Task {
  const { body = "Fix the login bug", state = "open", ...rest } = overrides;
  return {
    key: "42",
    summary: "Login is broken",
    issueType: "Issue",
    status: state,
    reporter: "octocat",
    labels: ["intern"],
    components: [],
    fixVersions: [],
    created: "",
    updated: "2026-01-01T00:00:00Z",
    raw: { number: 42, title: "Login is broken", body, state, labels: [{ name: "intern" }] },
    ...rest,
  } as Task;
}

/** Jira-shaped task: description is a plain-text field on `raw`. */
function jiraTask(overrides: Partial<Task> & { description?: string } = {}): Task {
  const { description = "Implement the export", ...rest } = overrides;
  return {
    key: "DEV-1",
    summary: "Add export",
    issueType: "Task",
    status: "To Do",
    reporter: "alice",
    labels: ["intern"],
    components: [],
    fixVersions: [],
    created: "",
    updated: "2026-01-01T00:00:00Z",
    raw: { description },
    ...rest,
  } as Task;
}

function fakeTracker(getCurrent: () => Task, describe: (task: Task) => string): TaskTrackerClient {
  return {
    getTask: async () => getCurrent(),
    extractDescriptionText: describe,
  } as unknown as TaskTrackerClient;
}

const githubDescribe = (task: Task) => (task.raw as { body?: string }).body ?? "";
const jiraDescribe = (task: Task) => (task.raw as { description?: string }).description ?? "";

describe("computeActionedSignal", () => {
  test("is label-order and label-case insensitive", () => {
    const a = computeActionedSignal({
      summary: "x",
      description: "y",
      status: "Open",
      labels: ["Intern", "bug"],
    });
    const b = computeActionedSignal({
      summary: "x",
      description: "y",
      status: "open",
      labels: ["bug", "intern"],
    });
    expect(a).toBe(b);
  });

  test("changes when the description, summary, status, or labels change", () => {
    const base = { summary: "s", description: "d", status: "open", labels: ["intern"] };
    const signal = computeActionedSignal(base);
    expect(computeActionedSignal({ ...base, description: "d2" })).not.toBe(signal);
    expect(computeActionedSignal({ ...base, summary: "s2" })).not.toBe(signal);
    expect(computeActionedSignal({ ...base, status: "closed" })).not.toBe(signal);
    expect(computeActionedSignal({ ...base, labels: ["intern", "urgent"] })).not.toBe(signal);
  });
});

describe("actionedSourceKey", () => {
  test("namespaces by team and normalizes case", () => {
    expect(actionedSourceKey("GitHub")).toBe("github");
    expect(actionedSourceKey("jira", "Platform")).toBe("jira:Platform");
    expect(actionedSourceKey(undefined)).toBe("jira");
  });

  test("derives the same key from a task subprocess env", () => {
    expect(actionedSourceKeyFromEnv({ TASK_TRACKER: "github" })).toBe("github");
    expect(
      actionedSourceKeyFromEnv({ TASK_TRACKER: "github", DEVINTERN_WORKSPACE_TEAM: "core" }),
    ).toBe("github:core");
  });
});

describe("recordTaskActioned + createTaskActionedGate", () => {
  let dbPath: string;
  let workerState: WorkerState;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `actioned-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    workerState = new WorkerState(dbPath);
  });

  afterEach(() => {
    workerState.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("a GitHub ticket stays actioned until its description changes", async () => {
    let task = githubTask();
    const tracker = fakeTracker(() => task, githubDescribe);
    const source = actionedSourceKey("github");

    expect(
      await recordTaskActioned({ workerState, source, tracker, taskKey: "42", fallbackTask: task }),
    ).toBe(true);

    const gate = createTaskActionedGate({ getTracker: () => tracker, workerState, source });
    expect(await gate("42")).toBe(true);

    // A human edits the description: re-arm and clear the local marker.
    task = githubTask({ body: "Please fix login and add 2FA" });
    expect(await gate("42")).toBe(false);
    expect(workerState.getTaskActioned(source, "42")).toBeNull();
  });

  test("a Jira ticket stays actioned until its status changes (reopen)", async () => {
    let task = jiraTask({ status: "In Review", labels: ["intern", "in review"] });
    const tracker = fakeTracker(() => task, jiraDescribe);
    const source = actionedSourceKey("jira");

    await recordTaskActioned({
      workerState,
      source,
      tracker,
      taskKey: "DEV-1",
      fallbackTask: task,
    });
    const gate = createTaskActionedGate({ getTracker: () => tracker, workerState, source });
    expect(await gate("DEV-1")).toBe(true);

    task = jiraTask({ status: "To Do", labels: ["intern", "in review"] });
    expect(await gate("DEV-1")).toBe(false);
  });

  test("re-labelling an actioned ticket re-arms it", async () => {
    let task = githubTask();
    const tracker = fakeTracker(() => task, githubDescribe);
    const source = actionedSourceKey("github");
    await recordTaskActioned({ workerState, source, tracker, taskKey: "42", fallbackTask: task });
    const gate = createTaskActionedGate({ getTracker: () => tracker, workerState, source });
    expect(await gate("42")).toBe(true);

    task = githubTask({ labels: ["intern", "priority"] });
    expect(await gate("42")).toBe(false);
  });

  test("a gate with no record lets the ticket through", async () => {
    const tracker = fakeTracker(githubTask, githubDescribe);
    const gate = createTaskActionedGate({
      getTracker: () => tracker,
      workerState,
      source: "github",
    });
    expect(await gate("99")).toBe(false);
  });

  test("a read failure fails safe (stays actioned) to avoid a duplicate PR", async () => {
    const tracker = fakeTracker(githubTask, githubDescribe);
    const source = "github";
    await recordTaskActioned({
      workerState,
      source,
      tracker,
      taskKey: "42",
      fallbackTask: githubTask(),
    });
    const broken = {
      getTask: async () => {
        throw new Error("tracker down");
      },
      extractDescriptionText: githubDescribe,
    } as unknown as TaskTrackerClient;
    const gate = createTaskActionedGate({ getTracker: () => broken, workerState, source });
    expect(await gate("42")).toBe(true);
  });

  test("recordTaskActioned falls back to the run's snapshot when re-read fails", async () => {
    const broken = {
      getTask: async () => {
        throw new Error("boom");
      },
      extractDescriptionText: githubDescribe,
    } as unknown as TaskTrackerClient;
    const ok = await recordTaskActioned({
      workerState,
      source: "github",
      tracker: broken,
      taskKey: "42",
      fallbackTask: githubTask(),
    });
    expect(ok).toBe(true);
    expect(workerState.getTaskActioned("github", "42")?.signal).toBe(
      trackerActionedSignal(broken, githubTask()),
    );
  });
});
