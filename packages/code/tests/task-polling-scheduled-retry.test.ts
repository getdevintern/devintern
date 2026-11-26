/**
 * The poller must never start a ticket a scheduled dashboard retry owns.
 *
 * Reproduces the duplicate-run interleaving the schedule-mode retry e2e
 * caught under load: the retry drain runs a failed ticket, the retry's own
 * transition bumps the ticket's `updated` stamp, the poller picks the new
 * stamp up and reads the actioned gate before the retry has recorded its
 * actioned marker, the retry then settles (marker written, retry state
 * cleared, ticket lock released), and the poller's run starts as a third,
 * unforced-but-ungated attempt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { TaskPollingAcquirer } from "../src/lib/acquirers/task-polling";
import type { ReadyTask } from "../src/lib/acquirers/task-polling";
import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";
import {
  actionedSourceKey,
  createTaskActionedGate,
  recordTaskActioned,
} from "../src/lib/task/actioned-state";
import type { TaskTrackerClient } from "../src/lib/trackers/client";
import type { Task } from "../src/types/task-tracker";

describe("TaskPollingAcquirer with scheduled dashboard retries", () => {
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;
  let retries: ScheduledRetryStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `acq-retry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
    retries = new ScheduledRetryStore(dbPath);
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    retries.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function jiraTask(updated: string): Task {
    return {
      key: "DEV-1",
      summary: "Expand the greeting",
      issueType: "Task",
      status: "In Progress",
      reporter: "alice",
      labels: [],
      components: [],
      fixVersions: [],
      created: "",
      updated,
      raw: { description: "Change the greeting" },
    };
  }

  function makeAcquirer(options: {
    tasks: () => ReadyTask[];
    executed: string[];
    isTaskActionedUnchanged?: (task: ReadyTask) => Promise<boolean>;
  }): TaskPollingAcquirer {
    let cursor = 0;
    return new TaskPollingAcquirer({
      trackerType: "jira",
      query: "project = DEV",
      intervalSeconds: 60,
      detector: {
        source: "jira",
        // Only the first tick sees a tracker change; later ticks run only
        // because a pending re-admission became ready.
        changesSince: async () => ({ changed: cursor++ === 0, nextCursor: String(cursor) }),
      },
      workerState,
      queue,
      searchTasks: async () => ({ tasks: options.tasks() }),
      executeTask: async (key) => {
        options.executed.push(key);
        return true;
      },
      isTaskActionedUnchanged: options.isTaskActionedUnchanged,
      heldTaskKeys: () => retries.activeTaskKeys(),
    });
  }

  test("a retry that settles while the actioned gate is read does not get a duplicate poll run", async () => {
    let ticket = jiraTask("2026-11-21T20:00:00Z");
    const tracker = {
      getTask: async () => ticket,
      extractDescriptionText: (task: Task) =>
        (task.raw as { description?: string }).description ?? "",
    } as unknown as TaskTrackerClient;
    const source = actionedSourceKey("jira");
    const gate = createTaskActionedGate({ getTracker: () => tracker, workerState, source });

    // The dashboard scheduled a retry and the drain claimed it; the retry's
    // In Progress transition bumped the stamp the poller is about to see.
    expect(retries.schedule({ taskKey: "DEV-1", runId: 1, actor: "local-dashboard" })).toEqual({
      scheduled: true,
    });
    const claimed = retries.claimNext();
    expect(claimed?.taskKey).toBe("DEV-1");
    ticket = jiraTask("2026-11-21T20:00:05Z");

    let gateReads = 0;
    const executed: string[] = [];
    const acquirer = makeAcquirer({
      tasks: () => [{ key: "DEV-1", updated: ticket.updated }],
      executed,
      isTaskActionedUnchanged: async (task) => {
        gateReads++;
        // No marker yet: the retry is still running.
        const actioned = await gate(task.key, task.updated);
        if (gateReads === 1) {
          // The retry finishes before the poller reaches its claim loop: it
          // records the actioned marker, exits, and the drain settles the row.
          await recordTaskActioned({ workerState, source, tracker, taskKey: "DEV-1" });
          retries.finish(claimed!.id, "done");
        }
        return actioned;
      },
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await acquirer.tick();
      // The gate said "not actioned" from a pre-retry read, but the ticket was
      // held when that read began: the poller must not start it.
      expect(executed).toEqual([]);
      expect(logs.some((line) => line.includes("DEV-1") && line.includes("scheduled retry"))).toBe(
        true,
      );

      // The hold cleared: the remembered stamp is re-evaluated once, and the
      // actioned marker the retry recorded keeps it out.
      await acquirer.tick();
      expect(gateReads).toBe(2);
      expect(executed).toEqual([]);
      expect(logs.some((line) => line.includes("DEV-1") && line.includes("already actioned"))).toBe(
        true,
      );

      // Nothing left pending: later ticks do not even search.
      await acquirer.tick();
      expect(gateReads).toBe(2);
      expect(executed).toEqual([]);
    } finally {
      console.log = originalLog;
    }
  });

  test("a retry claimed while the actioned gate is read still holds the ticket", async () => {
    retries.schedule({ taskKey: "DEV-1", runId: 1, actor: "local-dashboard" });
    const executed: string[] = [];
    const acquirer = makeAcquirer({
      tasks: () => [{ key: "DEV-1", updated: "b" }],
      executed,
      isTaskActionedUnchanged: async () => {
        // Pending (also a hold) when the gate began; running by the claim loop.
        retries.claimNext();
        return false;
      },
    });

    await acquirer.tick();
    expect(executed).toEqual([]);
    await acquirer.tick(); // still running: not re-admitted
    expect(executed).toEqual([]);
  });

  test("a ticket whose retry failed is re-evaluated once the hold clears", async () => {
    retries.schedule({ taskKey: "DEV-1", runId: 1, actor: "local-dashboard" });
    const claimed = retries.claimNext()!;
    const executed: string[] = [];
    const acquirer = makeAcquirer({ tasks: () => [{ key: "DEV-1", updated: "b" }], executed });

    await acquirer.tick();
    expect(executed).toEqual([]);

    // A failed retry leaves no actioned marker; the poller hands the stamp to
    // the pipeline, whose incomplete-attempt gate decides (exactly once).
    retries.finish(claimed.id, "failed", "agent failed");
    await acquirer.tick();
    expect(executed).toEqual(["DEV-1"]);
    await acquirer.tick();
    expect(executed).toEqual(["DEV-1"]);
  });

  test("activeTaskKeys scopes holds by team and ignores settled rows", () => {
    retries.schedule({ taskKey: "DEV-1", actor: "a" });
    retries.schedule({ taskKey: "DEV-2", team: "platform", actor: "a" });
    retries.schedule({ taskKey: "DEV-3", actor: "a" });
    const first = retries.claimNext()!;
    retries.finish(first.id, "done");

    expect([...retries.activeTaskKeys()]).toEqual(["DEV-3"]);
    expect([...retries.activeTaskKeys("platform")]).toEqual(["DEV-2"]);
  });
});
