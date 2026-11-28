import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { collectQueuedWork } from "../src/lib/observability/queued-work";
import {
  readTaskDependents,
  resolveTaskLinks,
  withTaskLinkDatabases,
} from "../src/lib/observability/task-links";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { RunStore } from "../src/lib/state/run-recorder";
import type { RunStatus } from "../src/lib/state/run-recorder";
import { TrackerDependencyStore } from "../src/lib/state/tracker-dependencies";

describe("task dependency links", () => {
  let dir: string;
  let dbPath: string;
  let store: InjectedTaskStore;
  let runs: RunStore;
  let raw: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-links-"));
    dbPath = join(dir, "queue.db");
    store = new InjectedTaskStore(dbPath);
    runs = new RunStore(dbPath);
    store.hasPending(); // create the schema
    raw = new Database(dbPath);
  });

  afterEach(() => {
    raw.close();
    runs.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function add(taskKey: string, dependsOn: string[] = []): number {
    return store.enqueue({
      taskKey,
      repo: "backend",
      title: `Title of ${taskKey}`,
      body: "",
      taskFile: join(dir, `${taskKey}.md`),
      ...(dependsOn.length > 0
        ? {
            dependsOn,
            dependencyMode: "merged" as const,
            dependencyState: "blocked" as const,
            dependencyReason: `${dependsOn[0]} failed`,
          }
        : {}),
    }).task.id;
  }

  function settle(taskKey: string, status: "running" | "done" | "failed" | "cancelled"): void {
    raw.run("UPDATE injected_tasks SET status = ? WHERE task_key = ?", [status, taskKey]);
  }

  function run(
    taskKey: string,
    status: RunStatus,
    origin: "local" | "task" = "local",
    startedAt = Date.now(),
  ): number {
    const id = runs.createRun({ origin, taskKey, repo: "acme/backend" });
    raw.run("UPDATE runs SET started_at = ? WHERE id = ?", [startedAt, id]);
    if (status !== "in_progress") runs.finishRun(id, status);
    return id;
  }

  function resolve(keys: string[]) {
    return withTaskLinkDatabases(dbPath, dbPath, (dbs) => resolveTaskLinks(dbs, keys));
  }

  test("resolves status, newest run, and retry action per key", () => {
    add("local-failed");
    settle("local-failed", "failed");
    run("local-failed", "failed", "local", 1_000);
    const newest = run("local-failed", "abandoned", "local", 2_000);
    add("local-running");
    settle("local-running", "running");
    const running = run("local-running", "in_progress");
    const pendingId = add("local-pending");
    run("PROJ-7", "escalated", "task");

    const links = resolve(["local-failed", "local-running", "local-pending", "PROJ-7", "gone"]);
    expect(links.get("local-failed")).toEqual({
      key: "local-failed",
      status: "failed",
      latestRunId: newest,
      latestRunStatus: "abandoned",
      retryKind: "injected",
    });
    expect(links.get("local-running")).toEqual({
      key: "local-running",
      status: "running",
      latestRunId: running,
      latestRunStatus: "in_progress",
    });
    expect(links.get("local-pending")).toEqual({
      key: "local-pending",
      status: "pending",
      queuedItemId: `ad-hoc:${pendingId}`,
    });
    expect(links.get("PROJ-7")).toMatchObject({ status: "failed", retryKind: "task" });
    expect(links.get("gone")).toEqual({ key: "gone", status: "unknown" });
  });

  test("a cancelled ad-hoc row is not offered a re-queue", () => {
    add("local-cancelled");
    settle("local-cancelled", "cancelled");
    run("local-cancelled", "failed");
    const link = resolve(["local-cancelled"]).get("local-cancelled");
    expect(link?.status).toBe("cancelled");
    expect(link?.retryKind).toBeUndefined();
  });

  test("a tracker ticket still held back links to its queued item", () => {
    const tracker = new TrackerDependencyStore(dbPath);
    try {
      tracker.record({
        taskKey: "PROJ-9",
        team: "core",
        tracker: "jira",
        dependsOn: ["PROJ-1"],
        dependencyMode: "merged",
        state: "waiting",
        reason: "PROJ-1 open",
      });
    } finally {
      tracker.close();
    }
    expect(resolve(["PROJ-9"]).get("PROJ-9")).toEqual({
      key: "PROJ-9",
      status: "pending",
      queuedItemId: "tracker:core:PROJ-9",
    });
  });

  test("the queue serves each blocked item's links from one lookup", () => {
    add("local-base");
    settle("local-base", "failed");
    const baseRun = run("local-base", "failed");
    add("local-next", ["local-base", "local-pruned"]);
    raw.run("UPDATE injected_tasks SET stacked_on = ? WHERE task_key = ?", [
      "local-other",
      "local-next",
    ]);
    const lookups: string[][] = [];
    const body = collectQueuedWork({
      dbPath,
      queueDbPath: dbPath,
      listInjected: (limit) => store.listPending(limit),
      lookupRun: () => null,
      pendingTotal: 0,
      resolveLinks: (keys) => {
        lookups.push([...keys]);
        return resolve([...keys]);
      },
    });
    expect(lookups).toEqual([["local-base", "local-pruned", "local-other"]]);
    const next = body.items.find((item) => item.taskKey === "local-next");
    expect(next?.stackedOn).toBe("local-other");
    expect(next?.dependencyLinks).toEqual([
      {
        key: "local-base",
        status: "failed",
        latestRunId: baseRun,
        latestRunStatus: "failed",
        retryKind: "injected",
      },
      { key: "local-pruned", status: "unknown" },
      { key: "local-other", status: "unknown" },
    ]);
  });

  test("lists the queued tasks a task blocks", () => {
    add("local-base");
    settle("local-base", "failed");
    const dependentId = add("local-dependent", ["local-base"]);
    const earlier = run("local-dependent", "deferred");
    add("local-unrelated", ["local-base-two"]);
    add("local-done", ["local-base"]);
    settle("local-done", "done");

    expect(readTaskDependents(dbPath, dbPath, "local-base")).toEqual([
      {
        key: "local-dependent",
        title: "Title of local-dependent",
        queuedItemId: `ad-hoc:${dependentId}`,
        dependencyState: "blocked",
        dependencyReason: "local-base failed",
        latestRunId: earlier,
      },
    ]);
    expect(readTaskDependents(dbPath, dbPath, undefined)).toEqual([]);
    expect(readTaskDependents(join(dir, "missing.db"), join(dir, "missing.db"), "x")).toEqual([]);
  });
});
