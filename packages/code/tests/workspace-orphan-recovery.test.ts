import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { recoverOrphanedWorkspaceRuns } from "../src/lib/workspace/workspace-worker";
import { RunStore } from "../src/lib/run-recorder";
import { ScheduledRetryStore } from "../src/lib/run-retry";
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
