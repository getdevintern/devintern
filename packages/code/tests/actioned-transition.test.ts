import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { RUN_ORIGIN_ENV } from "../src/lib/observability/analytics";
import { applyActionedTransition } from "../src/lib/task/actioned-transition";
import { actionedSourceKeyFromEnv, createTaskActionedGate } from "../src/lib/task/actioned-state";
import { MarkdownTaskTrackerClient } from "../src/lib/trackers/markdown/markdown-task-tracker-client";
import { WorkerState } from "../src/lib/state/worker-state";
import type { TaskTrackerClient } from "../src/lib/trackers/client";
import type { Task } from "../src/types/task-tracker";
import type { ProjectSettings } from "../src/types/settings";

const task: Task = {
  key: "PROJ-1",
  summary: "Add export",
  issueType: "Task",
  status: "To Do",
  reporter: "alice",
  labels: ["intern"],
  components: [],
  fixVersions: [],
  created: "",
  updated: "2026-01-01T00:00:00Z",
  raw: { description: "Implement the export" },
};

function fakeTracker(overrides: Partial<TaskTrackerClient> = {}): TaskTrackerClient {
  return {
    getTask: async () => task,
    extractDescriptionText: () => "Implement the export",
    transitionStatus: async () => {},
    ...overrides,
  } as unknown as TaskTrackerClient;
}

describe("applyActionedTransition", () => {
  let dbPath: string;
  let workerState: WorkerState;
  const originalOrigin = process.env[RUN_ORIGIN_ENV];

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `actioned-transition-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    workerState = new WorkerState(dbPath);
  });

  afterEach(() => {
    workerState.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
    if (originalOrigin === undefined) delete process.env[RUN_ORIGIN_ENV];
    else process.env[RUN_ORIGIN_ENV] = originalOrigin;
  });

  test("transitions to prStatus and records the ticket as actioned", async () => {
    const calls: Array<[string, string]> = [];
    await applyActionedTransition({
      tracker: fakeTracker({
        transitionStatus: async (key, status) => {
          calls.push([key, status]);
        },
      }),
      task,
      taskKey: "PROJ-1",
      skipComments: false,
      projectSettings: { jira: { projects: { PROJ: { prStatus: "In Review" } } } },
      workerState,
    });

    expect(calls).toEqual([["PROJ-1", "In Review"]]);
    expect(workerState.getTaskActioned(actionedSourceKeyFromEnv(), "PROJ-1")).not.toBeNull();
  });

  test("holds a provisional marker while the transition emits a relay event", async () => {
    let reads = 0;
    const tracker = fakeTracker({
      getTask: async () => {
        reads++;
        return { ...task, status: "In Review", updated: "2026-01-02T00:00:00Z" };
      },
      transitionStatus: async () => {
        const gate = createTaskActionedGate({
          getTracker: () => tracker,
          workerState,
          source: actionedSourceKeyFromEnv(),
        });
        expect(await gate("PROJ-1", "2026-01-02T00:00:00Z")).toBe(true);
        expect(reads).toBe(0);
      },
    });
    await applyActionedTransition({
      tracker,
      task,
      taskKey: "PROJ-1",
      skipComments: false,
      projectSettings: { jira: { projects: { PROJ: { prStatus: "In Review" } } } },
      workerState,
    });
    expect(reads).toBe(1);
    expect(workerState.getTaskActioned(actionedSourceKeyFromEnv(), "PROJ-1")?.pending).toBe(false);
  });

  test("a failed transition still records the ticket locally and does not throw", async () => {
    await applyActionedTransition({
      tracker: fakeTracker({
        transitionStatus: async () => {
          throw new Error('Label "In Review" not found');
        },
      }),
      task,
      taskKey: "PROJ-1",
      skipComments: false,
      projectSettings: { jira: { projects: { PROJ: { prStatus: "In Review" } } } },
      workerState,
    });

    expect(workerState.getTaskActioned(actionedSourceKeyFromEnv(), "PROJ-1")).not.toBeNull();
  });

  test("with no prStatus the ticket is still recorded (and the worker warns)", async () => {
    process.env[RUN_ORIGIN_ENV] = "worker";
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await applyActionedTransition({
        tracker: fakeTracker(),
        task,
        taskKey: "PROJ-1",
        skipComments: false,
        projectSettings: { jira: { projects: { PROJ: {} } } },
        workerState,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((line) => line.includes("No prStatus configured"))).toBe(true);
    expect(workerState.getTaskActioned(actionedSourceKeyFromEnv(), "PROJ-1")).not.toBeNull();
  });

  test("--skip-comments records locally without touching the tracker", async () => {
    let transitioned = false;
    await applyActionedTransition({
      tracker: fakeTracker({
        transitionStatus: async () => {
          transitioned = true;
        },
      }),
      task,
      taskKey: "PROJ-1",
      skipComments: true,
      projectSettings: { jira: { projects: { PROJ: { prStatus: "In Review" } } } },
      workerState,
    });

    expect(transitioned).toBe(false);
    expect(workerState.getTaskActioned(actionedSourceKeyFromEnv(), "PROJ-1")).not.toBeNull();
  });

  test("markdown tasks are left to the pipeline", async () => {
    const markdown = new MarkdownTaskTrackerClient();
    await applyActionedTransition({
      tracker: markdown,
      task,
      taskKey: "PROJ-1",
      skipComments: false,
      projectSettings: { markdown: { projects: { PROJ: { prStatus: "Done" } } } },
      workerState,
    });
    // The pipeline records markdown actioned state after markDoneIfSuccessful.
    expect(workerState.getTaskActioned(actionedSourceKeyFromEnv(), "PROJ-1")).toBeNull();
  });

  test("never throws when settings resolution fails", async () => {
    // Opening/reading the state DB can throw ("disk I/O error"); the PR is
    // already created, so the caller must never see a rejection it would
    // misreport as a PR-creation failure.
    const throwingSettings = new Proxy({} as ProjectSettings, {
      get() {
        throw new Error("disk I/O error");
      },
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await applyActionedTransition({
        tracker: fakeTracker(),
        task,
        taskKey: "PROJ-1",
        skipComments: false,
        projectSettings: throwingSettings,
        workerState,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((line) => line.includes("disk I/O error"))).toBe(true);
    expect(workerState.getTaskActioned(actionedSourceKeyFromEnv(), "PROJ-1")).toBeNull();
  });
});
