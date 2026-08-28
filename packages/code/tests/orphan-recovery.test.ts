import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  DEFAULT_ORPHAN_MAX_AGE_MS,
  ORPHANED_RUN_REASON,
  defaultProjectKeyFor,
  loadProjectSettingsFrom,
  recoverOrphanedTaskRuns,
  resolveStatusName,
} from "../src/lib/orphan-recovery";
import { RunStore } from "../src/lib/run-recorder";
import { RetryStateStore, hashDescription } from "../src/lib/retry-state";
import type { TaskTrackerClient } from "../src/lib/task-tracker-client";
import type { Task, TaskTrackerCommentContent } from "../src/types/task-tracker";

describe("recoverOrphanedTaskRuns", () => {
  let dbPath: string;
  let store: RunStore;
  let retryStore: RetryStateStore;
  let posted: Array<{ key: string; body: string }> = [];
  let transitions: Array<{ key: string; status: string }> = [];
  let tasksByKey: Record<string, Task> = {};
  let getTaskFailures: Record<string, boolean> = {};

  function ticket(key: string, status: string): Task {
    return {
      key,
      summary: `Summary of ${key}`,
      issueType: "Task",
      status,
      reporter: "Alice",
      created: "",
      updated: "",
      labels: [],
      components: [],
      fixVersions: [],
      raw: null,
    };
  }

  function fakeTracker(): TaskTrackerClient {
    return {
      getTask: async (key: string) => {
        if (getTaskFailures[key]) {
          throw new Error("tracker down");
        }
        return tasksByKey[key] ?? ticket(key, "In Progress");
      },
      postComment: async (key: string, content: TaskTrackerCommentContent) => {
        posted.push({ key, body: content.body });
      },
      transitionStatus: async (key: string, status: string) => {
        transitions.push({ key, status });
      },
      extractDescriptionText: (t: Task): string => `description of ${t.summary}`,
    } as unknown as TaskTrackerClient;
  }

  interface RecoveryOptions {
    inProgressStatus?: string;
    todoStatus?: string | null;
    tracker?: TaskTrackerClient | null;
    now?: number;
    maxAgeMs?: number;
  }

  function recover({
    inProgressStatus = "In Progress",
    todoStatus = "To Do",
    tracker = fakeTracker() as TaskTrackerClient | null,
    now = Date.now(),
    maxAgeMs = DEFAULT_ORPHAN_MAX_AGE_MS,
  }: RecoveryOptions = {}) {
    return recoverOrphanedTaskRuns({
      runStore: store,
      tracker: tracker ?? undefined,
      trackerType: "jira",
      getInProgressStatus: () => inProgressStatus,
      getTodoStatus: () => todoStatus,
      recordAttempt: (key, type, description) =>
        retryStore.recordIncompleteAttempt(key, type, description),
      maxAgeMs,
      now,
      log: () => {},
      warn: () => {},
    });
  }

  beforeEach(() => {
    dbPath = join(tmpdir(), `orphan-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new RunStore(dbPath);
    retryStore = new RetryStateStore(dbPath);
    posted = [];
    transitions = [];
    tasksByKey = {};
    getTaskFailures = {};
  });

  afterEach(() => {
    store.close();
    retryStore.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("crash mid-run: recovery on next start requeues the ticket and records the attempt", async () => {
    // Simulate a crash between the transition to In Progress and completion:
    // the previous process recorded an in-progress run and died.
    const crashed = new RunStore(dbPath);
    crashed.createRun({ origin: "task", taskKey: "PROJ-1", tracker: "jira" });
    crashed.close();

    const result = await recover();

    expect(result.reaped).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.skipped).toBe(0);

    // The orphaned run is marked failed with the crash reason.
    const run = new RunStore(dbPath).listRuns({ taskKey: "PROJ-1" })[0];
    expect(run?.status).toBe("failed");
    expect(run?.outcomeReason).toContain("orphaned");
    expect(run?.finishedAt).toBeGreaterThan(0);

    // The ticket got the failure comment and moved back to To Do.
    expect(posted).toHaveLength(1);
    expect(posted[0]?.key).toBe("PROJ-1");
    expect(posted[0]?.body).toContain("Automated implementation did not complete");
    expect(posted[0]?.body).toContain("exited unexpectedly");
    expect(transitions).toEqual([{ key: "PROJ-1", status: "To Do" }]);

    // The retry gate records the attempt, so the requeued ticket is not
    // double-processed on the next pickup.
    const state = retryStore.getRetryState("PROJ-1");
    expect(state).not.toBeNull();
    expect(state?.descriptionHash).toBe(hashDescription("description of Summary of PROJ-1"));
  });

  test("does not clobber a ticket that moved on after the crash", async () => {
    store.createRun({ origin: "task", taskKey: "PROJ-2" });
    tasksByKey["PROJ-2"] = ticket("PROJ-2", "Done");

    const result = await recover();

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(posted).toHaveLength(0);
    expect(transitions).toHaveLength(0);
    expect(retryStore.getRetryState("PROJ-2")).toBeNull();
  });

  test("skips orphans older than the cutoff instead of notifying", async () => {
    store.createRun({ origin: "task", taskKey: "PROJ-3" });

    const result = await recover({
      now: Date.now() + DEFAULT_ORPHAN_MAX_AGE_MS + 60_000,
    });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(posted).toHaveLength(0);
    expect(transitions).toHaveLength(0);
  });

  test("respects a custom maxAgeMs", async () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-3b" });

    await recover({ maxAgeMs: 1000, now: Date.now() + 2000 });
    expect(store.getRun(runId)?.status).toBe("failed");
    expect(posted).toHaveLength(0);
  });

  test("reaps every origin but only notifies task runs", async () => {
    store.createRun({ origin: "task", taskKey: "PROJ-4" });
    store.createRun({ origin: "pr_mention", repo: "acme/widgets", prNumber: 1 });
    store.createRun({ origin: "conflict_resolution" });
    store.createRun({ origin: "scheduled", automationId: "tidy" });

    const result = await recover();

    expect(result.reaped).toBe(4);
    expect(result.recovered).toBe(1);
    expect(posted.map((p) => p.key)).toEqual(["PROJ-4"]);
  });

  test("skips markdown task keys (local files, recovered by automations themselves)", async () => {
    store.createRun({ origin: "task", taskKey: "/tmp/devintern-tasks/note.md" });

    const result = await recover();

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(posted).toHaveLength(0);
  });

  test("comments without transitioning when the ticket was never In Progress", async () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-5" });

    const result = await recover({ inProgressStatus: "" });

    expect(result.recovered).toBe(1);
    expect(posted).toHaveLength(1);
    expect(transitions).toHaveLength(0);
    expect(store.getRun(runId)?.status).toBe("failed");
  });

  test("skips the transition when no To Do status is configured", async () => {
    store.createRun({ origin: "task", taskKey: "PROJ-6" });

    const result = await recover({ todoStatus: null });

    expect(result.recovered).toBe(1);
    expect(posted).toHaveLength(1);
    expect(transitions).toHaveLength(0);
  });

  test("degrades to reap-only when no tracker client is available", async () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-7" });

    const result = await recover({ tracker: null });

    expect(result.reaped).toBe(1);
    expect(result.recovered).toBe(0);
    expect(posted).toHaveLength(0);
    expect(store.getRun(runId)?.status).toBe("failed");
  });

  test("skips a ticket whose details cannot be fetched, without throwing", async () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-8" });
    getTaskFailures["PROJ-8"] = true;

    const result = await recover();

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(posted).toHaveLength(0);
    // The reap still happened.
    expect(store.getRun(runId)?.status).toBe("failed");
  });

  test("notifies each stranded ticket once even with several orphaned attempts", async () => {
    store.createRun({ origin: "task", taskKey: "PROJ-9" });
    store.createRun({ origin: "task", taskKey: "PROJ-9" });

    const result = await recover();

    expect(result.reaped).toBe(2);
    expect(result.recovered).toBe(1);
    expect(posted).toHaveLength(1);
  });

  test("does nothing when no runs were orphaned", async () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-10" });
    store.finishRun(runId, "succeeded");

    const result = await recover();

    expect(result).toEqual({ reaped: 0, recovered: 0, skipped: 0 });
    expect(posted).toHaveLength(0);
  });

  test("reason text explains the crash and the retry path", () => {
    expect(ORPHANED_RUN_REASON).toContain("exited unexpectedly");
    expect(ORPHANED_RUN_REASON).toContain("pull request");
  });
});

describe("defaultProjectKeyFor", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  test("falls back to the task key prefix", () => {
    delete process.env.GITHUB_REPO;
    process.env.TASK_TRACKER = "jira";
    expect(defaultProjectKeyFor("PROJ-42")).toBe("PROJ");
  });

  test("uses the tracker env project when set", () => {
    process.env.TASK_TRACKER = "github";
    process.env.GITHUB_REPO = "acme/widgets";
    expect(defaultProjectKeyFor("42")).toBe("acme/widgets");
  });
});

describe("settings resolution", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = join(tmpdir(), `orphan-settings-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dirB = join(tmpdir(), `orphan-settings-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dirA, ".devintern-code"), { recursive: true });
    mkdirSync(join(dirB, ".devintern-code"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  test("merges tracker sections from repo settings dirs, first dir wins", () => {
    writeFileSync(
      join(dirA, ".devintern-code", "settings.json"),
      JSON.stringify({
        jira: { projects: { PROJ: { inProgressStatus: "Doing", todoStatus: "Backlog" } } },
      }),
    );
    writeFileSync(
      join(dirB, ".devintern-code", "settings.json"),
      JSON.stringify({
        jira: {
          projects: { PROJ: { inProgressStatus: "Overridden" }, OTHER: { todoStatus: "To Do" } },
        },
        linear: { projects: { ENG: { inProgressStatus: "Started" } } },
      }),
    );

    const settings = loadProjectSettingsFrom([dirA, dirB]);
    expect(resolveStatusName(settings, "jira", "PROJ", "inProgressStatus")).toBe("Doing");
    expect(resolveStatusName(settings, "jira", "PROJ", "todoStatus")).toBe("Backlog");
    expect(resolveStatusName(settings, "jira", "OTHER", "todoStatus")).toBe("To Do");
    expect(resolveStatusName(settings, "linear", "ENG", "inProgressStatus")).toBe("Started");
  });

  test("falls back to the legacy top-level projects map for Jira", () => {
    writeFileSync(
      join(dirA, ".devintern-code", "settings.json"),
      JSON.stringify({
        projects: { LEG: { inProgressStatus: "In Progress", todoStatus: "To Do" } },
      }),
    );

    const settings = loadProjectSettingsFrom([dirA]);
    expect(resolveStatusName(settings, "jira", "LEG", "inProgressStatus")).toBe("In Progress");
    expect(resolveStatusName(settings, "linear", "LEG", "todoStatus")).toBeUndefined();
  });

  test("returns null when no directory has settings", () => {
    expect(loadProjectSettingsFrom([dirA, dirB])).toBeNull();
    expect(resolveStatusName(null, "jira", "PROJ", "todoStatus")).toBeUndefined();
  });
});
