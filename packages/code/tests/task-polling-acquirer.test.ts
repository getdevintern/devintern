import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { createMarkdownChangeDetector } from "../src/lib/change-detector";
import { processedTaskId, TaskPollingAcquirer } from "../src/lib/task-polling-acquirer";
import type { ReadyTask } from "../src/lib/task-polling-acquirer";
import { WebhookQueue } from "../src/lib/webhook-queue";
import { WorkerState } from "../src/lib/worker-state";

function uniqueDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("createMarkdownChangeDetector", () => {
  let tasksDir: string;

  beforeEach(() => {
    tasksDir = uniqueDir("md-detector");
    mkdirSync(tasksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tasksDir, { recursive: true, force: true });
  });

  test("first run (null cursor) reports changed when files exist", async () => {
    writeFileSync(join(tasksDir, "task-1.md"), "# Task 1");
    const detector = createMarkdownChangeDetector(tasksDir);

    const result = await detector.changesSince(null);
    expect(result.changed).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  test("no change when nothing was modified since the cursor", async () => {
    writeFileSync(join(tasksDir, "task-1.md"), "# Task 1");
    const detector = createMarkdownChangeDetector(tasksDir);

    const first = await detector.changesSince(null);
    const second = await detector.changesSince(first.nextCursor);
    expect(second.changed).toBe(false);
    expect(second.nextCursor).toBe(first.nextCursor);
  });

  test("detects a modified file", async () => {
    const file = join(tasksDir, "task-1.md");
    writeFileSync(file, "# Task 1");
    const detector = createMarkdownChangeDetector(tasksDir);
    const first = await detector.changesSince(null);

    // Bump mtime well past the cursor.
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);

    const second = await detector.changesSince(first.nextCursor);
    expect(second.changed).toBe(true);
    expect(Number(second.nextCursor)).toBeGreaterThan(Number(first.nextCursor));
  });

  test("detects a new file", async () => {
    writeFileSync(join(tasksDir, "task-1.md"), "# Task 1");
    const detector = createMarkdownChangeDetector(tasksDir);
    const first = await detector.changesSince(null);

    const newFile = join(tasksDir, "task-2.md");
    writeFileSync(newFile, "# Task 2");
    const future = new Date(Date.now() + 5000);
    utimesSync(newFile, future, future);

    const second = await detector.changesSince(first.nextCursor);
    expect(second.changed).toBe(true);
  });

  test("ignores non-markdown files and missing directory", async () => {
    writeFileSync(join(tasksDir, "notes.txt"), "not a task");
    const detector = createMarkdownChangeDetector(tasksDir);
    expect((await detector.changesSince(null)).changed).toBe(false);

    const missing = createMarkdownChangeDetector(join(tasksDir, "nope"));
    const result = await missing.changesSince("123");
    expect(result.changed).toBe(false);
    expect(result.nextCursor).toBe("123");
  });
});

describe("TaskPollingAcquirer", () => {
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;

  beforeEach(() => {
    dbPath = join(tmpdir(), `acq-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function makeAcquirer(options: {
    detectorResults: Array<{ changed: boolean; nextCursor: string | null }>;
    tasks: ReadyTask[];
    executed: string[];
    executeResult?: boolean;
  }) {
    let call = 0;
    const seenCursors: (string | null)[] = [];
    const acquirer = new TaskPollingAcquirer({
      trackerType: "markdown",
      query: "status=todo",
      intervalSeconds: 60,
      detector: {
        source: "markdown",
        async changesSince(cursor) {
          seenCursors.push(cursor);
          const result =
            options.detectorResults[Math.min(call, options.detectorResults.length - 1)];
          call++;
          return result!;
        },
      },
      workerState,
      queue,
      searchTasks: async () => ({ tasks: options.tasks }),
      executeTask: async (key) => {
        options.executed.push(key);
        return options.executeResult ?? true;
      },
    });
    return { acquirer, seenCursors };
  }

  test("reads task_query dynamically and stays dormant while it is absent", async () => {
    let query: string | undefined;
    const seenQueries: string[] = [];
    const acquirer = new TaskPollingAcquirer({
      trackerType: "markdown",
      query: () => query,
      intervalSeconds: 60,
      detector: {
        source: "markdown",
        async changesSince() {
          return { changed: true, nextCursor: "1" };
        },
      },
      workerState,
      queue,
      searchTasks: async (activeQuery) => {
        seenQueries.push(activeQuery);
        return { tasks: [] };
      },
      executeTask: async () => true,
    });

    await acquirer.tick();
    expect(seenQueries).toEqual([]);
    query = "status=ready";
    await acquirer.tick();
    expect(seenQueries).toEqual(["status=ready"]);
  });

  test("executes query matches when a change is detected", async () => {
    const executed: string[] = [];
    const { acquirer } = makeAcquirer({
      detectorResults: [{ changed: true, nextCursor: "100" }],
      tasks: [
        { key: "TASK-1", updated: "a" },
        { key: "TASK-2", updated: "b" },
      ],
      executed,
    });

    await acquirer.tick();
    expect(executed).toEqual(["TASK-1", "TASK-2"]);
    expect(workerState.getCursor("markdown")?.cursorValue).toBe("100");
  });

  test("does not evaluate when nothing changed", async () => {
    const executed: string[] = [];
    const { acquirer } = makeAcquirer({
      detectorResults: [{ changed: false, nextCursor: "100" }],
      tasks: [{ key: "TASK-1", updated: "a" }],
      executed,
    });

    await acquirer.tick();
    expect(executed).toEqual([]);
  });

  test("dedupes tasks by (key, updated) across ticks", async () => {
    const executed: string[] = [];
    const { acquirer } = makeAcquirer({
      detectorResults: [
        { changed: true, nextCursor: "100" },
        { changed: true, nextCursor: "200" },
      ],
      tasks: [{ key: "TASK-1", updated: "a" }],
      executed,
    });

    await acquirer.tick();
    await acquirer.tick();
    expect(executed).toEqual(["TASK-1"]); // second tick deduped
  });

  test("re-executes a task when its updated stamp changes", async () => {
    const executed: string[] = [];
    const tasks: ReadyTask[] = [{ key: "TASK-1", updated: "a" }];
    const { acquirer } = makeAcquirer({
      detectorResults: [
        { changed: true, nextCursor: "100" },
        { changed: true, nextCursor: "200" },
      ],
      tasks,
      executed,
    });

    await acquirer.tick();
    tasks[0] = { key: "TASK-1", updated: "b" };
    await acquirer.tick();
    expect(executed).toEqual(["TASK-1", "TASK-1"]);
  });

  test("a failing task does not loop while its stamp is unchanged", async () => {
    const executed: string[] = [];
    const { acquirer } = makeAcquirer({
      detectorResults: [
        { changed: true, nextCursor: "100" },
        { changed: true, nextCursor: "200" },
      ],
      tasks: [{ key: "TASK-1", updated: "a" }],
      executed,
      executeResult: false,
    });

    await acquirer.tick();
    await acquirer.tick();
    expect(executed).toEqual(["TASK-1"]);
  });

  test("a deferred task retries while completed tasks stay deduped", async () => {
    const executed: string[] = [];
    const seenCursors: (string | null)[] = [];
    let deferredOnce = false;
    const acquirer = new TaskPollingAcquirer({
      trackerType: "markdown",
      query: "status=todo",
      intervalSeconds: 60,
      detector: {
        source: "markdown",
        async changesSince(cursor) {
          seenCursors.push(cursor);
          return { changed: true, nextCursor: "100" };
        },
      },
      workerState,
      queue,
      searchTasks: async () => ({
        tasks: [
          { key: "TASK-1", updated: "a" },
          { key: "TASK-2", updated: "b" },
        ],
      }),
      executeTask: async (key) => {
        executed.push(key);
        if (key === "TASK-2" && !deferredOnce) {
          deferredOnce = true;
          return "deferred";
        }
        return true;
      },
    });

    await acquirer.tick();
    expect(workerState.getCursor("markdown")).toBeNull();
    expect(queue.hasProcessed("markdown", "task:TASK-1:a")).toBe(true);
    expect(queue.hasProcessed("markdown", "task:TASK-2:b")).toBe(false);

    await acquirer.tick();
    expect(executed).toEqual(["TASK-1", "TASK-2", "TASK-2"]);
    expect(seenCursors).toEqual([null, null]);
    expect(workerState.getCursor("markdown")?.cursorValue).toBe("100");
    expect(queue.hasProcessed("markdown", "task:TASK-2:b")).toBe(true);
  });

  test("resumes from the persisted cursor", async () => {
    workerState.setCursor("markdown", "42");
    const executed: string[] = [];
    const { acquirer, seenCursors } = makeAcquirer({
      detectorResults: [{ changed: false, nextCursor: "42" }],
      tasks: [],
      executed,
    });

    await acquirer.tick();
    expect(seenCursors).toEqual(["42"]);
  });

  test("processedTaskId is empty-stamp when updated is missing", () => {
    expect(processedTaskId({ key: "DEV-87" })).toBe("task:DEV-87:");
    expect(processedTaskId({ key: "DEV-87", updated: "  " })).toBe("task:DEV-87:");
    expect(processedTaskId({ key: "DEV-87", updated: "2026-08-25T18:14:06.827+0700" })).toBe(
      "task:DEV-87:2026-08-25T18:14:06.827+0700",
    );
  });

  test("logs when every matching task is skipped as already processed", async () => {
    const executed: string[] = [];
    const { acquirer } = makeAcquirer({
      detectorResults: [
        { changed: true, nextCursor: "100" },
        { changed: true, nextCursor: "200" },
      ],
      tasks: [{ key: "DEV-87", updated: "a" }],
      executed,
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await acquirer.tick();
      logs.length = 0;
      await acquirer.tick();
    } finally {
      console.log = originalLog;
    }

    expect(executed).toEqual(["DEV-87"]);
    expect(
      logs.some((line) => line.includes("skipping DEV-87") && line.includes("already processed")),
    ).toBe(true);
  });

  test("a later stamp retriggers after an empty-stamp claim", async () => {
    const executed: string[] = [];
    const tasks: ReadyTask[] = [{ key: "DEV-87" }];
    const { acquirer } = makeAcquirer({
      detectorResults: [
        { changed: true, nextCursor: "100" },
        { changed: true, nextCursor: "200" },
      ],
      tasks,
      executed,
    });

    await acquirer.tick();
    tasks[0] = { key: "DEV-87", updated: "2026-08-25T18:14:06.827+0700" };
    await acquirer.tick();
    expect(executed).toEqual(["DEV-87", "DEV-87"]);
  });

  test("warns when a matching task has no update stamp", async () => {
    const executed: string[] = [];
    const { acquirer } = makeAcquirer({
      detectorResults: [{ changed: true, nextCursor: "100" }],
      tasks: [{ key: "DEV-87" }],
      executed,
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await acquirer.tick();
    } finally {
      console.warn = originalWarn;
    }

    expect(executed).toEqual(["DEV-87"]);
    expect(
      warnings.some(
        (line) =>
          line.includes("DEV-87") &&
          line.includes("no update stamp") &&
          line.includes("will not retrigger"),
      ),
    ).toBe(true);
  });

  test("a detector error is contained and does not advance the cursor", async () => {
    workerState.setCursor("markdown", "42");
    const acquirer = new TaskPollingAcquirer({
      trackerType: "markdown",
      query: "status=todo",
      intervalSeconds: 60,
      detector: {
        source: "markdown",
        changesSince: async () => {
          throw new Error("boom");
        },
      },
      workerState,
      queue,
      searchTasks: async () => ({ tasks: [] }),
      executeTask: async () => true,
    });

    await acquirer.tick(); // must not throw
    expect(workerState.getCursor("markdown")?.cursorValue).toBe("42");
  });
});
