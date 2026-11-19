import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DashboardData } from "../src/lib/observability/dashboard-api";
import { handleQueuedWork, supervisorJobToQueuedItem } from "../src/lib/observability/queued-work";
import type { QueuedWorkResponse } from "../src/lib/observability/queued-work";
import { createTaskSupervisor } from "../src/lib/worker/supervisor";

describe("PR jobs in the queued work list", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "queued-pr-jobs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("maps a PR job to a queued item and ignores task and automation jobs", () => {
    expect(
      supervisorJobToQueuedItem({
        id: "j1",
        source: "github:conflict",
        repo: "web",
        kind: "conflict",
        label: "acme/web#12",
        checkoutClass: "pr_worktree",
        exclusiveKey: "acme/web#12",
        enqueuedAt: 1_000,
        waitingOn: "repo",
      }),
    ).toEqual({
      id: "pr-job:j1",
      kind: "pr-job",
      title: "Conflict resolution on acme/web#12",
      repo: "web",
      actor: "github:conflict",
      createdAt: 1_000,
      prNumber: 12,
      message: "Waiting for a free slot on this repository (max_concurrency_per_repo)",
      jobKind: "conflict",
      waitingOn: "repo",
    });
    expect(
      supervisorJobToQueuedItem({
        id: "t",
        source: "poll",
        repo: "web",
        kind: "task",
        checkoutClass: "task_worktree",
        enqueuedAt: 1,
        waitingOn: "repo",
      }),
    ).toBeNull();
    expect(
      supervisorJobToQueuedItem({
        id: "a",
        source: "automation",
        repo: "web",
        kind: "automation",
        checkoutClass: "shared_base",
        enqueuedAt: 1,
        waitingOn: "repo",
      }),
    ).toBeNull();
  });

  test("the dashboard lists PR jobs waiting for a slot or for their PR", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 4, maxConcurrencyPerRepo: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = (id: string, kind: "conflict" | "auto_merge" | "review", pr: number) =>
      supervisor.schedule({
        id,
        source: `github:${kind}`,
        repo: "web",
        kind,
        label: `acme/web#${pr}`,
        checkoutClass: "pr_worktree",
        exclusiveKey: `acme/web#${pr}`,
        run: () => gate,
      });
    const running = job("running", "conflict", 1);
    const samePr = job("same-pr", "auto_merge", 1);
    const otherPr = job("other-pr", "review", 2);

    const dbPath = join(dir, "missing.db");
    const data = new DashboardData({
      dbPath,
      queueDbPath: dbPath,
      workingDir: dir,
      workspaceDir: dir,
      logDirs: [],
      configuredSources: () => [],
      supervisorQueuedJobs: () => supervisor.queuedJobs?.() ?? [],
    });
    const body = handleQueuedWork(data).body as QueuedWorkResponse;
    expect(body.total).toBe(2);
    expect(supervisor.queuedCount()).toBe(2);
    expect(
      body.items.map(({ id, title, waitingOn, prNumber }) => ({ id, title, waitingOn, prNumber })),
    ).toEqual([
      {
        id: "pr-job:same-pr",
        title: "Auto-merge check on acme/web#1",
        waitingOn: "exclusive",
        prNumber: 1,
      },
      {
        id: "pr-job:other-pr",
        title: "Review feedback on acme/web#2",
        waitingOn: "repo",
        prNumber: 2,
      },
    ]);

    release();
    await Promise.all([running, samePr, otherPr]);
    expect((handleQueuedWork(data).body as QueuedWorkResponse).items).toEqual([]);
  });
});
