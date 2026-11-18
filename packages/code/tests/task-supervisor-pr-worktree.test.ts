import { describe, expect, test } from "bun:test";

import { createTaskSupervisor, JobNotStartedError } from "../src/lib/worker/supervisor";
import type { HostCheckoutClass, JobKind, ScheduleRequest } from "../src/lib/worker/supervisor";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A job that records its start and runs until `release()` is called. */
function heldJob(
  id: string,
  options: {
    repo?: string;
    kind?: JobKind;
    checkoutClass?: HostCheckoutClass;
    exclusiveKey?: string;
    started: string[];
  },
): { request: ScheduleRequest<void>; release: () => void } {
  const gate = deferred();
  return {
    release: gate.resolve,
    request: {
      id,
      source: "test",
      repo: options.repo ?? "web",
      kind: options.kind ?? "conflict",
      label: options.exclusiveKey,
      checkoutClass: options.checkoutClass ?? "pr_worktree",
      ...(options.exclusiveKey ? { exclusiveKey: options.exclusiveKey } : {}),
      run: async () => {
        options.started.push(id);
        await gate.promise;
      },
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TaskSupervisor pr_worktree class", () => {
  test("PR jobs for different PRs on one repo run in parallel up to the per-repo limit", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 2 });
    const started: string[] = [];
    const a = heldJob("a", { exclusiveKey: "o/web#1", started });
    const b = heldJob("b", { exclusiveKey: "o/web#2", started });
    const c = heldJob("c", { exclusiveKey: "o/web#3", started });
    const runs = [a, b, c].map((job) => supervisor.schedule(job.request));
    await tick();
    expect(started).toEqual(["a", "b"]);
    expect(supervisor.inFlightCount()).toBe(2);
    expect(supervisor.queuedJobs?.()).toMatchObject([
      { id: "c", label: "o/web#3", waitingOn: "repo" },
    ]);
    a.release();
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    b.release();
    c.release();
    await Promise.all(runs);
    expect(supervisor.inFlightCount()).toBe(0);
  });

  test("a second job on the same PR waits without taking a slot", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 2 });
    const started: string[] = [];
    const conflict = heldJob("conflict", { exclusiveKey: "o/web#7", started });
    const merge = heldJob("merge", { kind: "auto_merge", exclusiveKey: "o/web#7", started });
    const other = heldJob("other", { kind: "review", exclusiveKey: "o/web#8", started });
    const runs = [conflict, merge, other].map((job) => supervisor.schedule(job.request));
    await tick();
    // The auto-merge outranks the conflict by priority but its PR is busy;
    // the free per-repo slot goes to the other PR instead.
    expect(started).toEqual(["conflict", "other"]);
    expect(supervisor.inFlightCount()).toBe(2);
    expect(supervisor.queuedCount()).toBe(1);
    expect(supervisor.queuedJobs?.()).toMatchObject([
      { id: "merge", exclusiveKey: "o/web#7", waitingOn: "exclusive" },
    ]);
    other.release();
    await tick();
    expect(started).toEqual(["conflict", "other"]);
    conflict.release();
    await tick();
    expect(started).toEqual(["conflict", "other", "merge"]);
    merge.release();
    await Promise.all(runs);
  });

  test("task and PR worktree jobs share the per-repo budget", async () => {
    const n = 3;
    const supervisor = createTaskSupervisor({ maxConcurrency: 10, maxConcurrencyPerRepo: n });
    const started: string[] = [];
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const runs: Array<Promise<void>> = [];
    for (let index = 0; index < n + 2; index++) {
      const gate = deferred();
      gates.push(gate.resolve);
      const isTask = index % 2 === 0;
      runs.push(
        supervisor.schedule({
          id: `job-${index}`,
          source: "test",
          repo: "web",
          kind: isTask ? "task" : "review",
          checkoutClass: isTask ? "task_worktree" : "pr_worktree",
          ...(isTask ? {} : { exclusiveKey: `o/web#${index}` }),
          run: async () => {
            started.push(`job-${index}`);
            running++;
            peak = Math.max(peak, running);
            await gate.promise;
            running--;
          },
        }),
      );
    }
    await tick();
    expect(running).toBe(n);
    expect(supervisor.queuedCount()).toBe(2);
    expect(supervisor.queuedJobs?.().every((job) => job.waitingOn === "repo")).toBe(true);
    for (const release of gates) {
      release();
      await tick();
    }
    await Promise.all(runs);
    expect(peak).toBe(n);
    expect(started).toHaveLength(n + 2);
  });

  test("one PR job still starts while tasks fill the per-repo budget", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 1 });
    const started: string[] = [];
    const task = heldJob("task", { kind: "task", checkoutClass: "task_worktree", started });
    const review = heldJob("review", { kind: "review", exclusiveKey: "o/web#1", started });
    const ciFix = heldJob("ci-fix", { kind: "ci_fix", exclusiveKey: "o/web#2", started });
    const queuedTask = heldJob("task-2", { kind: "task", checkoutClass: "task_worktree", started });
    const runs = [task, review, ciFix, queuedTask].map((job) => supervisor.schedule(job.request));
    await tick();
    // The review does not wait for the long task (the pre-parallel behavior);
    // a second PR job and a second task do wait for the per-repo budget.
    expect(started).toEqual(["task", "review"]);
    expect(supervisor.queuedJobs?.()).toMatchObject([
      { id: "ci-fix", waitingOn: "repo" },
      { id: "task-2", waitingOn: "repo" },
    ]);
    review.release();
    await tick();
    expect(started).toEqual(["task", "review", "ci-fix"]);
    for (const job of [task, ciFix, queuedTask]) job.release();
    await Promise.all(runs);
  });

  test("the global limit caps PR jobs across repositories", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 3, maxConcurrencyPerRepo: 3 });
    const started: string[] = [];
    const jobs = [
      heldJob("w1", { repo: "web", exclusiveKey: "o/web#1", started }),
      heldJob("w2", { repo: "web", exclusiveKey: "o/web#2", started }),
      heldJob("a1", { repo: "api", exclusiveKey: "o/api#1", started }),
      heldJob("a2", { repo: "api", exclusiveKey: "o/api#2", started }),
    ];
    const runs = jobs.map((job) => supervisor.schedule(job.request));
    await tick();
    expect(supervisor.inFlightCount()).toBe(3);
    expect(supervisor.queuedJobs?.()).toMatchObject([{ id: "a2", waitingOn: "global" }]);
    jobs[0]!.release();
    await tick();
    expect(started).toContain("a2");
    for (const job of jobs) job.release();
    await Promise.all(runs);
  });

  test("a PR job starts while an automation holds the shared base", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 1 });
    const started: string[] = [];
    const automation = heldJob("automation", {
      kind: "automation",
      checkoutClass: "shared_base",
      started,
    });
    const pr = heldJob("pr", { exclusiveKey: "o/web#1", started });
    const runs = [supervisor.schedule(automation.request), supervisor.schedule(pr.request)];
    await tick();
    expect(started).toEqual(["automation", "pr"]);
    automation.release();
    pr.release();
    await Promise.all(runs);
  });

  test("an automation starts while PR jobs fill the per-repo budget", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 2 });
    const started: string[] = [];
    const prs = [
      heldJob("pr1", { exclusiveKey: "o/web#1", started }),
      heldJob("pr2", { exclusiveKey: "o/web#2", started }),
    ];
    const automation = heldJob("automation", {
      kind: "automation",
      checkoutClass: "shared_base",
      started,
    });
    const second = heldJob("automation-2", {
      kind: "automation",
      checkoutClass: "shared_base",
      started,
    });
    const runs = [...prs, automation, second].map((job) => supervisor.schedule(job.request));
    await tick();
    // The shared base stays exclusive: only one automation runs.
    expect(started).toEqual(["pr1", "pr2", "automation"]);
    expect(supervisor.queuedJobs?.()).toMatchObject([{ id: "automation-2", waitingOn: "repo" }]);
    automation.release();
    await tick();
    expect(started).toContain("automation-2");
    for (const job of [...prs, second]) job.release();
    await Promise.all(runs);
  });

  test("a throwing PR job frees its per-repo count and exclusive key", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 1 });
    await expect(
      supervisor.schedule({
        id: "boom",
        source: "test",
        repo: "web",
        kind: "conflict",
        checkoutClass: "pr_worktree",
        exclusiveKey: "o/web#1",
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    await expect(
      supervisor.schedule({
        id: "next",
        source: "test",
        repo: "web",
        kind: "auto_merge",
        checkoutClass: "pr_worktree",
        exclusiveKey: "o/web#1",
        run: async () => "ran",
      }),
    ).resolves.toBe("ran");
  });

  test("an aborted PR job frees its slot, and a waiting job on its PR is deferred", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 2 });
    const running = supervisor.schedule({
      id: "running",
      source: "test",
      repo: "web",
      kind: "conflict",
      checkoutClass: "pr_worktree",
      exclusiveKey: "o/web#1",
      run: (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    const waiting = supervisor.schedule({
      id: "waiting",
      source: "test",
      repo: "web",
      kind: "auto_merge",
      checkoutClass: "pr_worktree",
      exclusiveKey: "o/web#1",
      run: async () => "ran",
    });
    await tick();
    expect(supervisor.queuedJobs?.()).toMatchObject([{ id: "waiting", waitingOn: "exclusive" }]);
    await supervisor.drain({ graceMs: 0 });
    await expect(running).resolves.toBeUndefined();
    await expect(waiting).rejects.toBeInstanceOf(JobNotStartedError);
    expect(supervisor.inFlightCount()).toBe(0);
    expect(supervisor.queuedCount()).toBe(0);
  });

  test("with a per-repo limit of 1, PR jobs on one repo run one at a time", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 1 });
    const started: string[] = [];
    const a = heldJob("a", { exclusiveKey: "o/web#1", started });
    const b = heldJob("b", { exclusiveKey: "o/web#2", started });
    const runs = [a, b].map((job) => supervisor.schedule(job.request));
    await tick();
    expect(started).toEqual(["a"]);
    a.release();
    await tick();
    expect(started).toEqual(["a", "b"]);
    b.release();
    await Promise.all(runs);
  });

  test("rejects a blank exclusive key", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 1, maxConcurrencyPerRepo: 1 });
    await expect(
      supervisor.schedule({
        id: "blank",
        source: "test",
        repo: "web",
        kind: "review",
        checkoutClass: "pr_worktree",
        exclusiveKey: " ",
        run: async () => undefined,
      }),
    ).rejects.toThrow("exclusiveKey");
  });
});
