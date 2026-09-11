import { describe, expect, test } from "bun:test";

import { createTaskSupervisor, JobNotStartedError } from "../src/lib/task-supervisor";
import type { HostCheckoutClass } from "../src/lib/task-supervisor";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function request<T>(options: {
  id: string;
  repo?: string;
  checkoutClass?: HostCheckoutClass;
  run: (signal: AbortSignal) => Promise<T>;
}) {
  return {
    id: options.id,
    source: "test",
    repo: options.repo,
    kind: "task" as const,
    checkoutClass: options.checkoutClass ?? ("task_worktree" as const),
    run: options.run,
  };
}

describe("TaskSupervisor", () => {
  test("admits four repositories concurrently when the global cap is four", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 1 });
    const gate = deferred<void>();
    const started: string[] = [];
    const jobs = ["a", "b", "c", "d"].map((repo) =>
      supervisor.schedule(
        request({
          id: repo,
          repo,
          run: async () => {
            started.push(repo);
            await gate.promise;
          },
        }),
      ),
    );

    await Promise.resolve();
    expect(started).toEqual(["a", "b", "c", "d"]);
    gate.resolve();
    await Promise.all(jobs);
  });

  test("a global cap of one preserves submission order", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 1, maxConcurrencyPerRepo: 1 });
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: string[] = [];
    const jobs = gates.map((gate, index) =>
      supervisor.schedule(
        request({
          id: `serial-${index}`,
          repo: `repo-${index}`,
          run: async () => {
            started.push(`serial-${index}`);
            await gate.promise;
          },
        }),
      ),
    );

    await Promise.resolve();
    expect(started).toEqual(["serial-0"]);
    gates[0]!.resolve();
    await jobs[0];
    expect(started).toEqual(["serial-0", "serial-1"]);
    gates[1]!.resolve();
    await jobs[1];
    expect(started).toEqual(["serial-0", "serial-1", "serial-2"]);
    gates[2]!.resolve();
    await jobs[2];
  });

  test("enforces global and per-repository task limits", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 2, maxConcurrencyPerRepo: 1 });
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];

    const a1 = supervisor.schedule(
      request({
        id: "a1",
        repo: "a",
        run: async () => {
          started.push("a1");
          await first.promise;
        },
      }),
    );
    const a2 = supervisor.schedule(
      request({
        id: "a2",
        repo: "a",
        run: async () => {
          started.push("a2");
        },
      }),
    );
    const b1 = supervisor.schedule(
      request({
        id: "b1",
        repo: "b",
        run: async () => {
          started.push("b1");
          await second.promise;
        },
      }),
    );

    await Promise.resolve();
    expect(started).toEqual(["a1", "b1"]);
    second.resolve();
    await b1;
    expect(started).toEqual(["a1", "b1"]);
    first.resolve();
    await Promise.all([a1, a2]);
    expect(started).toEqual(["a1", "b1", "a2"]);
  });

  test("serializes shared base jobs but lets a task worktree overlap", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 3, maxConcurrencyPerRepo: 2 });
    const baseGate = deferred<void>();
    const started: string[] = [];

    const base1 = supervisor.schedule(
      request({
        id: "base1",
        repo: "repo",
        checkoutClass: "shared_base",
        run: async () => {
          started.push("base1");
          await baseGate.promise;
        },
      }),
    );
    const base2 = supervisor.schedule(
      request({
        id: "base2",
        repo: "repo",
        checkoutClass: "shared_base",
        run: async () => started.push("base2"),
      }),
    );
    const task = supervisor.schedule(
      request({
        id: "task",
        repo: "repo",
        run: async () => started.push("task"),
      }),
    );

    await task;
    expect(started).toEqual(["base1", "task"]);
    baseGate.resolve();
    await Promise.all([base1, base2]);
    expect(started).toEqual(["base1", "task", "base2"]);
  });

  test("drain rejects queued jobs and aborts running work after the grace period", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 1, maxConcurrencyPerRepo: 1 });
    const running = supervisor.schedule(
      request({
        id: "running",
        repo: "repo",
        run: (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      }),
    );
    const queued = supervisor.schedule(
      request({ id: "queued", repo: "repo", run: async () => undefined }),
    );
    const queuedOutcome = queued.catch((error: unknown) => error);

    await supervisor.drain({ graceMs: 0 });

    expect(await queuedOutcome).toBeInstanceOf(JobNotStartedError);
    await expect(running).resolves.toBeUndefined();
    await expect(
      supervisor.schedule(request({ id: "late", repo: "repo", run: async () => undefined })),
    ).rejects.toBeInstanceOf(JobNotStartedError);
  });

  test("limit increases admit queued work and decreases do not cancel running work", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 1, maxConcurrencyPerRepo: 1 });
    const gates = [deferred<void>(), deferred<void>()];
    const started: string[] = [];
    const jobs = gates.map((gate, index) =>
      supervisor.schedule(
        request({
          id: `job-${index}`,
          repo: `repo-${index}`,
          run: async () => {
            started.push(`job-${index}`);
            await gate.promise;
          },
        }),
      ),
    );

    await Promise.resolve();
    expect(started).toEqual(["job-0"]);
    supervisor.updateLimits({ maxConcurrency: 2, maxConcurrencyPerRepo: 1 });
    await Promise.resolve();
    expect(started).toEqual(["job-0", "job-1"]);
    supervisor.updateLimits({ maxConcurrency: 1, maxConcurrencyPerRepo: 1 });
    gates.forEach((gate) => gate.resolve());
    await Promise.all(jobs);
  });
});
