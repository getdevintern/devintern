import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { createMarkdownChangeDetector } from "../src/lib/change-detector";
import { TaskPollingAcquirer, type ReadyTask } from "../src/lib/task-polling-acquirer";
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
