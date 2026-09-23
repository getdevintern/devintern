import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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
import { ACTIONED_SOURCE_ENV, buildRepoEnv, buildTeamTaskEnv } from "../src/lib/workspace/env";
import type { RepoConfig, TeamConfig } from "../src/lib/workspace/config";
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

  test("an explicitly pinned source wins over the tracker/team env", () => {
    expect(
      actionedSourceKeyFromEnv({
        [ACTIONED_SOURCE_ENV]: "jira:Platform",
        TASK_TRACKER: "github",
        DEVINTERN_WORKSPACE_TEAM: "core",
      }),
    ).toBe("jira:Platform");
  });

  test("the composed task subprocess env and the workspace gate agree on one key", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "actioned-env-"));
    try {
      // A stale `.env` carries a tracker that disagrees with `[defaults]`; the
      // pinned actioned source must still be authoritative.
      writeFileSync(join(workspaceDir, ".env"), "TASK_TRACKER=github\n");
      const repo: RepoConfig = { name: "app", remote: "git@github.com:acme/app.git", env: {} };
      const team: TeamConfig = { name: "Platform", tracker: "jira", env: {} };

      const singleEnv = buildRepoEnv(repo, workspaceDir, {
        actionedSource: actionedSourceKey("jira"),
      });
      expect(actionedSourceKeyFromEnv(singleEnv)).toBe("jira");

      const teamEnv = buildTeamTaskEnv(repo, team, workspaceDir, {
        actionedSource: actionedSourceKey(team.tracker, team.name),
      });
      expect(actionedSourceKeyFromEnv(teamEnv)).toBe("jira:Platform");

      const dbPath = join(workspaceDir, "state.db");
      const state = new WorkerState(dbPath);
      try {
        let task = jiraTask({ status: "In Review", labels: ["intern", "in review"] });
        const tracker = fakeTracker(() => task, jiraDescribe);
        // The subprocess records under the env-derived key...
        await recordTaskActioned({
          workerState: state,
          source: actionedSourceKeyFromEnv(teamEnv),
          tracker,
          taskKey: "DEV-1",
          fallbackTask: task,
        });
        // ...and the workspace gate looks under the workspace-derived key.
        const gate = createTaskActionedGate({
          getTracker: () => tracker,
          workerState: state,
          source: actionedSourceKey(team.tracker, team.name),
        });
        expect(await gate("DEV-1", task.updated)).toBe(true);

        task = jiraTask({
          status: "To Do",
          labels: ["intern", "in review"],
          updated: "2026-02-02T00:00:00Z",
        });
        expect(await gate("DEV-1", task.updated)).toBe(false);
      } finally {
        state.close();
      }
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
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

  test("an unverified fallback record keeps suppressing until a read verifies it", async () => {
    const broken = {
      getTask: async () => {
        throw new Error("boom");
      },
      extractDescriptionText: githubDescribe,
    } as unknown as TaskTrackerClient;
    const source = "github";
    const ok = await recordTaskActioned({
      workerState,
      source,
      tracker: broken,
      taskKey: "42",
      fallbackTask: githubTask(),
    });
    expect(ok).toBe(true);
    const stored = workerState.getTaskActioned(source, "42");
    expect(stored?.verified).toBe(false);
    expect(stored?.signal).toBe(trackerActionedSignal(broken, githubTask()));

    // The tracker recovers with its post-transition state: a different signal
    // from the pre-run snapshot. The gate must not read that mismatch as a
    // human change and re-implement the ticket.
    const recoveredTask = githubTask({
      body: "Fix the login bug",
      state: "closed",
      labels: ["intern", "in review"],
    });
    const recovered = fakeTracker(() => recoveredTask, githubDescribe);
    const gate = createTaskActionedGate({ getTracker: () => recovered, workerState, source });
    expect(await gate("42")).toBe(true);
    expect(workerState.getTaskActioned(source, "42")?.verified).toBe(true);

    // Once verified, a genuine change re-arms the ticket.
    const changed = githubTask({ body: "Please also add 2FA", state: "closed" });
    const changing = fakeTracker(() => changed, githubDescribe);
    const verify = createTaskActionedGate({ getTracker: () => changing, workerState, source });
    expect(await verify("42")).toBe(false);
    expect(workerState.getTaskActioned(source, "42")).toBeNull();
  });

  test("the persisted update stamp survives a restart and skips the read", async () => {
    let reads = 0;
    const task = githubTask();
    const tracker = {
      getTask: async () => {
        reads++;
        return task;
      },
      extractDescriptionText: githubDescribe,
    } as unknown as TaskTrackerClient;
    const source = "github";
    await recordTaskActioned({ workerState, source, tracker, taskKey: "42", fallbackTask: task });
    expect(reads).toBe(1);

    // A fresh gate (simulating a worker restart with an empty in-memory cache)
    // reads the persisted stamp and skips the tracker call for the unchanged
    // ticket — no cold-start burst of one call per actioned ticket.
    const restarted = createTaskActionedGate({ getTracker: () => tracker, workerState, source });
    expect(await restarted("42", task.updated)).toBe(true);
    expect(reads).toBe(1);

    // A different stamp forces one fresh verification, then caches again.
    expect(await restarted("42", "stamp-b")).toBe(true);
    expect(reads).toBe(2);
    expect(await restarted("42", "stamp-b")).toBe(true);
    expect(reads).toBe(2);
  });
});
