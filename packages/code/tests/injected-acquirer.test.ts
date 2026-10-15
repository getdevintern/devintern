import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { InjectedTaskAcquirer } from "../src/lib/workspace/injected-acquirer";
import type { TaskExecutionResult } from "../src/lib/acquirers/task-polling";

describe("InjectedTaskAcquirer", () => {
  let dir: string;
  let store: InjectedTaskStore;

  beforeEach(() => {
    dir = join(tmpdir(), `injected-acq-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    store = new InjectedTaskStore(join(dir, "queue.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function enqueue(taskKey: string, repo = "backend") {
    store.enqueue({
      taskKey,
      repo,
      title: taskKey,
      body: "",
      taskFile: join(dir, `${taskKey}.md`),
    });
  }

  test("drains pending tasks through the executor and marks them done", async () => {
    enqueue("local-a");
    enqueue("local-b");

    const calls: string[] = [];
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async (task) => {
        calls.push(task.taskKey);
        return true;
      },
      intervalSeconds: 3600,
    });
    await acquirer.tick();

    expect(calls).toEqual(["local-a", "local-b"]);
    expect(store.hasPending()).toBe(false);
  });

  test("requeues deferred tasks for the next tick", async () => {
    enqueue("local-a");

    const calls: string[] = [];
    let busy = true;
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async (task) => {
        calls.push(task.taskKey);
        return busy ? "deferred" : true;
      },
      intervalSeconds: 3600,
    });

    await acquirer.tick();
    expect(calls).toEqual(["local-a"]);
    expect(store.hasPending()).toBe(true);

    busy = false;
    await acquirer.tick();
    expect(calls).toEqual(["local-a", "local-a"]);
    expect(store.hasPending()).toBe(false);
  });

  test("marks failed rows when the pipeline fails or throws", async () => {
    enqueue("local-a");
    const failed = new InjectedTaskAcquirer({
      store,
      execute: async () => false,
      intervalSeconds: 3600,
    });
    await failed.tick();
    expect(store.hasPending()).toBe(false);

    enqueue("local-b");
    const threw = new InjectedTaskAcquirer({
      store,
      execute: async () => {
        throw new Error("boom");
      },
      intervalSeconds: 3600,
    });
    await threw.tick();
    expect(store.hasPending()).toBe(false);
  });

  test("a tick while draining is a no-op (busy guard)", async () => {
    enqueue("local-a");

    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquirer = new InjectedTaskAcquirer({
      store,
      execute: async (task) => {
        calls.push(task.taskKey);
        await gate;
        return true as TaskExecutionResult;
      },
      intervalSeconds: 3600,
    });

    const first = acquirer.tick();
    await acquirer.tick();
    release();
    await first;

    expect(calls).toEqual(["local-a"]);
  });
});
