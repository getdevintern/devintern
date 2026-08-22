import { describe, expect, test } from "bun:test";

import {
  RepoBusyError,
  SchedulerStoppedError,
  WorkspaceScheduler,
} from "../src/lib/workspace/scheduler";

/** Resolve after `ms`, so overlapping runs can be observed via timestamps. */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Run {
  repo: string;
  label: string;
  startedAt: number;
  finishedAt: number;
}

describe("WorkspaceScheduler", () => {
  test("serial mode (maxConcurrent 1) runs everything one at a time in order", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 1 });
    const runs: Run[] = [];
    const order: string[] = [];

    const submit = (repo: string, label: string, ms: number) =>
      scheduler.schedule(repo, { label }, async () => {
        order.push(label);
        const startedAt = Date.now();
        await delay(ms);
        runs.push({ repo, label, startedAt, finishedAt: Date.now() });
        return label;
      });

    const results = await Promise.all([
      submit("backend", "T-1", 15),
      submit("frontend", "T-2", 5),
      submit("backend", "T-3", 5),
    ]);

    expect(results).toEqual(["T-1", "T-2", "T-3"]);
    // Strictly serialized: every run starts after the previous one ended.
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].startedAt).toBeGreaterThanOrEqual(runs[i - 1].finishedAt - 1);
    }
    expect(order).toEqual(["T-1", "T-2", "T-3"]);
    expect(scheduler.status().active).toBe(0);
  });

  test("different repos run concurrently up to the global limit", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 2 });
    let inFlight = 0;
    let peakInFlight = 0;

    const run = (repo: string, ms: number) =>
      scheduler.schedule(repo, { label: repo }, async () => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await delay(ms);
        inFlight--;
        return true;
      });

    await Promise.all([run("a", 20), run("b", 20), run("c", 5)]);

    expect(peakInFlight).toBe(2);
    expect(scheduler.status().active).toBe(0);
  });

  test("excess work queues and never exceeds the limit as slots free up", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 2 });
    let inFlight = 0;
    let peak = 0;
    let completed = 0;

    const run = (repo: string) =>
      scheduler.schedule(repo, { label: repo }, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await delay(10);
        inFlight--;
        completed++;
      });

    const jobs = ["a", "b", "c", "d", "e"].map(run);
    const statusMidFlight = scheduler.status();
    expect(statusMidFlight.active).toBeLessThanOrEqual(2);
    expect(statusMidFlight.queued).toBeGreaterThan(0);

    await Promise.all(jobs);
    expect(completed).toBe(5);
    expect(peak).toBe(2);
  });

  test("same-repo work never overlaps even under a high global limit", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 8 });
    const perRepo = new Map<string, number>();
    let overlap: string | null = null;
    const runs: Run[] = [];

    const run = (repo: string, label: string) =>
      scheduler.schedule(repo, { label }, async () => {
        const current = perRepo.get(repo) ?? 0;
        if (current > 0 && !overlap) {
          overlap = repo;
        }
        perRepo.set(repo, current + 1);
        const startedAt = Date.now();
        await delay(10);
        runs.push({ repo, label, startedAt, finishedAt: Date.now() });
        perRepo.set(repo, perRepo.get(repo)! - 1);
      });

    await Promise.all([
      run("backend", "b-1"),
      run("frontend", "f-1"),
      run("backend", "b-2"),
      run("backend", "b-3"),
      run("frontend", "f-2"),
    ]);

    expect(overlap).toBeNull();

    // Same-repo FIFO: lane order preserved.
    const backendRuns = runs.filter((r) => r.repo === "backend").map((r) => r.label);
    expect(backendRuns).toEqual(["b-1", "b-2", "b-3"]);
  });

  test("concurrency above the repo count is naturally bounded without failure", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 10 });
    let peak = 0;
    let inFlight = 0;

    await Promise.all(
      ["only-a", "only-b"].map((repo) =>
        scheduler.schedule(repo, { label: repo }, async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await delay(10);
          inFlight--;
        }),
      ),
    );
    expect(peak).toBe(2); // bounded by repo count, not by the cap of 10
  });

  test("RepoBusyError parks work at its lane head and retries until it succeeds", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 2, retryDelayMs: 5 });
    const events: string[] = [];
    let busyThrows = 0;

    const first = scheduler.schedule("backend", { label: "contended" }, async () => {
      if (busyThrows < 2) {
        busyThrows++;
        throw new RepoBusyError("backend");
      }
      events.push("contended-ran");
      return true;
    });
    // Queued behind the contended item in the same lane.
    const second = scheduler.schedule("backend", { label: "follower" }, async () => {
      events.push("follower-ran");
      return true;
    });
    // Independent lane proceeds while backend is parked.
    const otherLane = scheduler.schedule("frontend", { label: "free" }, async () => {
      events.push("free-ran");
      return true;
    });

    await Promise.all([first, second, otherLane]);

    expect(events[0]).toBe("free-ran"); // not starved by the parked lane
    expect(busyThrows).toBe(2);
    expect(events.slice(1)).toEqual(["contended-ran", "follower-ran"]); // FIFO kept
    expect(scheduler.status().active).toBe(0);
  });

  test("a failing repo is isolated and does not cancel or block others", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 4 });
    const done: string[] = [];

    const failing = scheduler.schedule("bad", { label: "boom" }, async () => {
      throw new Error("repo exploded");
    });
    const healthyA = scheduler.schedule("good-a", { label: "a" }, async () => {
      await delay(5);
      done.push("a");
      return true;
    });
    const healthyB = scheduler.schedule("good-b", { label: "b" }, async () => {
      done.push("b");
      return true;
    });

    const outcomes = await Promise.allSettled([failing, healthyA, healthyB]);
    expect(outcomes[0].status).toBe("rejected");
    expect((outcomes[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(outcomes[1]).toEqual({ status: "fulfilled", value: true });
    expect(outcomes[2]).toEqual({ status: "fulfilled", value: true });
    expect(done.sort()).toEqual(["a", "b"]);
    // The failure leaves no residue: the lane is free again.
    expect(scheduler.status(["bad"]).repos[0].status).toBe("idle");
  });

  test("status reports idle/queued/running per configured repo", async () => {
    const configured = ["backend", "frontend"];
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 2 });
    let releaseRun: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    const running = scheduler.schedule("backend", { label: "B-1" }, () => gate.then(() => true));
    const queued = scheduler.schedule("backend", { label: "B-2" }, async () => true);
    await delay(5);

    let status = scheduler.status(configured);
    expect(status.repos.find((r) => r.repo === "backend")).toMatchObject({
      status: "running",
      label: "B-1",
      queued: 1,
    });
    expect(status.repos.find((r) => r.repo === "frontend")).toMatchObject({
      status: "idle",
      queued: 0,
    });
    expect(status.active).toBe(1);
    expect(status.max).toBe(2);
    expect(status.queued).toBe(1);

    releaseRun!();
    await Promise.all([running, queued]);
    status = scheduler.status(configured);
    expect(status.repos.find((r) => r.repo === "backend")?.status).toBe("idle");
  });

  test("drain cancels queued work with rollback and waits for in-flight runs", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 1 });
    const finished: string[] = [];
    const cancelledLabels: string[] = [];

    const inFlight = scheduler.schedule("backend", { label: "in-flight" }, async () => {
      await delay(30);
      finished.push("in-flight");
      return true;
    });
    const queued = scheduler.schedule(
      "frontend",
      { label: "queued", onCancel: () => cancelledLabels.push("queued") },
      async () => true,
    );
    // Capture outcomes without awaiting (attaching bun's `.rejects` to a
    // pending promise blocks the test body until it settles).
    const inFlightOutcome = inFlight.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    const queuedOutcome = queued.then(
      () => "resolved" as const,
      (error) => error,
    );

    await delay(5);
    const summary = await scheduler.drain();
    let lateRejected: unknown;
    try {
      await scheduler.schedule("x", {}, async () => true);
    } catch (error) {
      lateRejected = error;
    }

    expect(summary.drained).toBe(1);
    expect(summary.cancelled).toBe(1);
    expect(cancelledLabels).toEqual(["queued"]);
    expect(finished).toEqual(["in-flight"]);
    expect(await inFlightOutcome).toBe("resolved");
    expect(await queuedOutcome).toBeInstanceOf(SchedulerStoppedError);
    expect(lateRejected).toBeInstanceOf(SchedulerStoppedError);
  });

  test("drain also cancels a deferred (lock-contended) item", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 1, retryDelayMs: 50_000 });
    const rolledBack: string[] = [];

    const deferred = scheduler.schedule(
      "backend",
      { label: "parked", onCancel: () => rolledBack.push("parked") },
      async () => {
        throw new RepoBusyError("backend");
      },
    );
    const deferredOutcome = deferred.then(
      () => "resolved" as const,
      (error) => error,
    );
    await delay(5);
    const summary = await scheduler.drain();

    expect(summary.cancelled).toBe(1);
    expect(rolledBack).toEqual(["parked"]);
    expect(await deferredOutcome).toBeInstanceOf(SchedulerStoppedError);
  });

  test("drain resolves immediately when nothing is running", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 3 });
    const summary = await scheduler.drain();
    expect(summary).toEqual({ drained: 0, cancelled: 0 });
  });

  test("constructor rejects non-positive or fractional limits", () => {
    expect(() => new WorkspaceScheduler({ maxConcurrent: 0 })).toThrow(/positive integer/);
    expect(() => new WorkspaceScheduler({ maxConcurrent: -1 })).toThrow(/positive integer/);
    expect(() => new WorkspaceScheduler({ maxConcurrent: 1.5 })).toThrow(/positive integer/);
  });

  test("onChange fires on scheduling transitions", async () => {
    const scheduler = new WorkspaceScheduler({ maxConcurrent: 1 });
    let changes = 0;
    scheduler.onChange = () => changes++;

    await scheduler.schedule("repo", { label: "x" }, async () => true);
    expect(changes).toBeGreaterThanOrEqual(2); // enqueue + dispatch + completion

    const before = changes;
    await scheduler.drain();
    expect(changes).toBeGreaterThanOrEqual(before);
  });
});
