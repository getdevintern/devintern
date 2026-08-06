import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  createRepoRunLock,
  createWorkspaceLock,
  openWorkspaceState,
} from "../src/lib/workspace/state";

describe("workspace state", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ws-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("openWorkspaceState creates the central DB and shares it across stores", () => {
    const state = openWorkspaceState(workspaceDir);
    try {
      expect(state.dbPath).toBe(join(workspaceDir, "state", "queue.db"));
      expect(existsSync(state.dbPath)).toBe(true);

      // Same DB serves worker cursors, dedupe queue, and routing skips.
      state.workerState.setCursor("jira", "2026-07-04T00:00:00Z");
      expect(state.workerState.getCursor("jira")?.cursorValue).toBe("2026-07-04T00:00:00Z");

      state.skips.record({
        taskKey: "BACK-12",
        reason: "ambiguous",
        candidates: ["backend", "frontend"],
        taskUpdated: "2026-07-04T10:00:00Z",
      });
      const skips = state.skips.list();
      expect(skips).toHaveLength(1);
      expect(skips[0].taskKey).toBe("BACK-12");
      expect(skips[0].reason).toBe("ambiguous");
      expect(skips[0].candidates).toEqual(["backend", "frontend"]);
      expect(skips[0].taskUpdated).toBe("2026-07-04T10:00:00Z");
    } finally {
      state.close();
    }
  });

  test("routing skips keep history and expose the latest per task", () => {
    const state = openWorkspaceState(workspaceDir);
    try {
      state.skips.record({ taskKey: "T-1", reason: "unrouted", candidates: [] });
      state.skips.record({
        taskKey: "T-1",
        reason: "ambiguous",
        candidates: ["a", "b"],
        taskUpdated: "2026-07-04T12:00:00Z",
      });
      state.skips.record({ taskKey: "T-2", reason: "unrouted", candidates: [] });

      expect(state.skips.list()).toHaveLength(3);
      const latest = state.skips.latestFor("T-1");
      expect(latest?.reason).toBe("ambiguous");
      expect(latest?.candidates).toEqual(["a", "b"]);
      expect(state.skips.latestFor("T-9")).toBeNull();
    } finally {
      state.close();
    }
  });

  test("workspace lock lives directly in the workspace dir and is exclusive", () => {
    const lock = createWorkspaceLock(workspaceDir);
    const acquired = lock.acquire();
    expect(acquired.success).toBe(true);
    expect(existsSync(join(workspaceDir, ".worker.lock"))).toBe(true);
    // No .devintern-code nesting inside the workspace home.
    expect(existsSync(join(workspaceDir, ".devintern-code"))).toBe(false);

    const second = createWorkspaceLock(workspaceDir).acquire();
    expect(second.success).toBe(false);

    lock.release();
    expect(existsSync(join(workspaceDir, ".worker.lock"))).toBe(false);
  });

  test("repo run locks are independent per repo", () => {
    const backend = createRepoRunLock("backend", workspaceDir);
    const frontend = createRepoRunLock("frontend", workspaceDir);

    expect(backend.acquire().success).toBe(true);
    // A second holder for the same repo is rejected...
    expect(createRepoRunLock("backend", workspaceDir).acquire().success).toBe(false);
    // ...while a different repo is unaffected.
    expect(frontend.acquire().success).toBe(true);

    expect(existsSync(join(workspaceDir, "locks", "backend.run.lock"))).toBe(true);

    backend.release();
    frontend.release();
    expect(createRepoRunLock("backend", workspaceDir).acquire().success).toBe(true);
  });
});
