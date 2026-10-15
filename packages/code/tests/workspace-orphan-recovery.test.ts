import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  recoverOrphanedWorkspaceRuns,
  scheduleOrphanPickups,
  writeWorkspaceResumeNote,
} from "../src/lib/workspace/workspace-worker";
import { RunStore } from "../src/lib/state/run-recorder";
import type { RunRecord } from "../src/lib/state/run-recorder";
import { buildResumeNote, readResumeNote, writeResumeNote } from "../src/lib/state/resume-note";
import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { workspaceResumeNotePath } from "../src/lib/workspace/paths";
import { BASE_WORKTREE_NAME } from "../src/lib/workspace/repo-manager";
import type { WorkspaceConfig } from "../src/lib/workspace/config";

describe("recoverOrphanedWorkspaceRuns", () => {
  let workspaceDir: string;
  let dbPath: string;
  let store: RunStore;
  const savedEnv = { ...process.env };

  function workspaceConfig(): WorkspaceConfig {
    return {
      workspace: {},
      defaults: { tracker: "jira", pollIntervalSeconds: 60 },
      repos: [{ name: "web-app", remote: "https://github.com/acme/web-app.git", env: {} }],
      routing: [],
      automations: [],
    } as unknown as WorkspaceConfig;
  }

  beforeEach(() => {
    workspaceDir = join(
      tmpdir(),
      `orphan-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const baseWorktree = join(workspaceDir, "worktrees", "web-app", BASE_WORKTREE_NAME);
    mkdirSync(join(baseWorktree, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(baseWorktree, ".devintern-code", "settings.json"),
      JSON.stringify({
        jira: { projects: { PROJ: { inProgressStatus: "In Progress", todoStatus: "To Do" } } },
      }),
    );
    dbPath = join(workspaceDir, "state", "queue.db");
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    store.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("reaps orphans and degrades to reap-only when tracker credentials are missing", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;

    store.createRun({ origin: "task", taskKey: "PROJ-1", tracker: "jira" });

    // Recovery runs before acquirers in the real startup path; missing
    // tracker credentials must never fail the worker start.
    await recoverOrphanedWorkspaceRuns({
      config: workspaceConfig(),
      workspaceDir,
      dbPath,
    });

    const runs = store.listRuns({ taskKey: "PROJ-1" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.outcomeReason).toContain("orphaned");
  });

  test("writeWorkspaceResumeNote captures in-flight runs without mutating run rows", () => {
    const runId = store.createRun({
      origin: "task",
      taskKey: "PROJ-31",
      branch: "feature/proj-31",
    });
    const notePath = workspaceResumeNotePath(workspaceDir);

    const written = writeWorkspaceResumeNote({ dbPath, path: notePath, signal: "SIGTERM" });

    expect(written).toBe(true);
    const note = readResumeNote(notePath);
    expect(note?.signal).toBe("SIGTERM");
    expect(note?.runs.map((entry) => entry.runId)).toContain(runId);
    // No irreversible state on the signal path: the run row is untouched.
    expect(store.getRun(runId)?.status).toBe("in_progress");
    expect(store.getRun(runId)?.finishedAt).toBeUndefined();
  });

  test("writeWorkspaceResumeNote does nothing when no run is in flight", () => {
    const notePath = workspaceResumeNotePath(workspaceDir);

    expect(writeWorkspaceResumeNote({ dbPath, path: notePath, signal: "SIGTERM" })).toBe(false);
    expect(existsSync(notePath)).toBe(false);
  });

  test("consumes a clean-stop resume note and labels its runs as a clean stop", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;

    const runId = store.createRun({ origin: "task", taskKey: "PROJ-30" });
    const run = store.getRun(runId);
    const notePath = workspaceResumeNotePath(workspaceDir);
    writeResumeNote(notePath, buildResumeNote([run!], { signal: "SIGTERM" }));

    await recoverOrphanedWorkspaceRuns({ config: workspaceConfig(), workspaceDir, dbPath });

    // The note is consumed exactly once.
    expect(existsSync(notePath)).toBe(false);
    const reaped = store.getRun(runId);
    expect(reaped?.status).toBe("failed");
    expect(reaped?.outcomeReason).toContain("cleanly");
    expect(reaped?.outcomeReason).not.toContain("exited unexpectedly");
  });

  test("leaves terminal history untouched", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;

    const done = store.createRun({ origin: "task", taskKey: "PROJ-2" });
    store.finishRun(done, "succeeded");

    await recoverOrphanedWorkspaceRuns({
      config: workspaceConfig(),
      workspaceDir,
      dbPath,
    });

    expect(store.getRun(done)?.status).toBe("succeeded");
    expect(store.getRun(done)?.outcomeReason).toBeUndefined();
  });

  test("reaps interrupted error-monitor runs without treating them as Jira tickets", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    const runId = store.createRun({
      origin: "error_monitor",
      taskKey: "devintern-public-devintern-a",
      tracker: "sentry",
    });

    try {
      await recoverOrphanedWorkspaceRuns({ config: workspaceConfig(), workspaceDir, dbPath });
    } finally {
      console.warn = originalWarn;
    }

    expect(store.getRun(runId)?.status).toBe("failed");
    expect(warnings.some((warning) => warning.includes("JIRA"))).toBe(false);
    expect(warnings.some((warning) => warning.includes("recover"))).toBe(false);
  });

  test("settles scheduled retries left running by the previous worker", async () => {
    process.env.TASK_TRACKER = "jira";
    delete process.env.JIRA_BASE_URL;

    const retryStore = new ScheduledRetryStore(dbPath);
    retryStore.schedule({ taskKey: "PROJ-1", actor: "sup@example.com" });
    retryStore.schedule({ taskKey: "PROJ-2", actor: "sup@example.com" });
    retryStore.claimNext(); // PROJ-1 → running
    retryStore.claimNext(); // PROJ-2 → running

    await recoverOrphanedWorkspaceRuns({
      config: workspaceConfig(),
      workspaceDir,
      dbPath,
    });

    // Both rows were settled, so the dashboard's per-task guard unblocks and
    // the operator can schedule again.
    expect(retryStore.hasActive("PROJ-1")).toBe(false);
    expect(retryStore.hasActive("PROJ-2")).toBe(false);
    expect(retryStore.hasPending()).toBe(false);

    // Sanity: a fresh schedule is accepted after recovery.
    expect(retryStore.schedule({ taskKey: "PROJ-1", actor: "sup@example.com" }).scheduled).toBe(
      true,
    );
    retryStore.close();
  });
});

describe("scheduleOrphanPickups", () => {
  let workspaceDir: string;
  let dbPath: string;

  function run(overrides: Partial<RunRecord>): RunRecord {
    return {
      id: 1,
      origin: "task",
      taskKey: "PROJ-1",
      status: "failed",
      startedAt: Date.now(),
      ...overrides,
    } as RunRecord;
  }

  beforeEach(() => {
    workspaceDir = join(
      tmpdir(),
      `orphan-pickup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    dbPath = join(workspaceDir, "state", "queue.db");
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("queues a retry for each resumable run, preserving routing context", () => {
    const store = new ScheduledRetryStore(dbPath);
    const queued = scheduleOrphanPickups(store, [
      run({ id: 7, taskKey: "PROJ-1", branch: "feature/proj-1", repo: "api", team: "platform" }),
      run({ id: 8, taskKey: "PROJ-2", branch: "feature/proj-2", repo: "web" }),
      run({ id: 9, taskKey: undefined }),
    ]);

    expect(queued).toBe(2);
    const first = store.claimNext();
    const second = store.claimNext();
    expect(first?.taskKey).toBe("PROJ-1");
    expect(first?.runId).toBe(7);
    expect(first?.team).toBe("platform");
    expect(first?.repo).toBe("api");
    expect(second?.taskKey).toBe("PROJ-2");
    expect(second?.repo).toBe("web");
    store.close();
  });

  test("does not double-queue a task that already has an active retry", () => {
    const store = new ScheduledRetryStore(dbPath);
    store.schedule({ taskKey: "PROJ-1", actor: "sup@example.com" });

    const queued = scheduleOrphanPickups(store, [
      run({ id: 7, taskKey: "PROJ-1", branch: "feature/proj-1" }),
    ]);

    expect(queued).toBe(0);
    store.close();
  });
});
