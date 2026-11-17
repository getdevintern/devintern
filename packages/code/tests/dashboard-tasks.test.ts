import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { startDashboardServer } from "../src/dashboard-server";
import { DashboardData } from "../src/lib/observability/dashboard-api";
import {
  DASHBOARD_TASK_ACTOR,
  handleCreateTask,
  parseDashboardTaskRequest,
} from "../src/lib/observability/dashboard-tasks";
import type { DashboardTaskResponse } from "../src/lib/observability/dashboard-tasks";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { MAX_INJECTED_BODY_CHARS } from "../src/lib/workspace/injected-enqueue";
import { injectedTasksDir, workspaceConfigPath } from "../src/lib/workspace/paths";

const WORKSPACE_TOML = `[workspace]
dashboard = false

[defaults]
tracker = "markdown"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`;

describe("POST /api/tasks", () => {
  let workspaceDir: string;
  let dbPath: string;
  let data: DashboardData;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "dashboard-tasks-test-"));
    dbPath = join(workspaceDir, "queue.db");
    data = new DashboardData({ dbPath, workingDir: workspaceDir, workspaceDir, logDirs: [] });
  });

  afterEach(() => {
    data.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeWorkspace(toml: string = WORKSPACE_TOML): void {
    writeFileSync(workspaceConfigPath(workspaceDir), toml);
  }

  function readRows() {
    const store = new InjectedTaskStore(dbPath);
    try {
      return store.list();
    } finally {
      store.close();
    }
  }

  test("enqueues a pending task with its markdown prompt", () => {
    writeWorkspace();
    const response = handleCreateTask(data, {
      repo: "web",
      title: "Fix the flaky login test",
      body: "It fails on **CI** only.",
    });

    expect(response.status).toBe(201);
    const body = response.body as DashboardTaskResponse;
    expect(body).toEqual({
      id: body.id,
      taskKey: "local-fix-the-flaky-login-test",
      repo: "web",
      status: "pending",
      deduplicated: false,
    });

    const [row] = readRows();
    expect(row?.repo).toBe("web");
    expect(row?.title).toBe("Fix the flaky login test");
    expect(row?.actor).toBe(DASHBOARD_TASK_ACTOR);
    expect(row?.taskFile.startsWith(injectedTasksDir(workspaceDir))).toBe(true);
    const markdown = readFileSync(row!.taskFile, "utf8");
    expect(markdown).toContain("key: local-fix-the-flaky-login-test");
    expect(markdown).toContain("# Fix the flaky login test");
    expect(markdown).toContain("It fails on **CI** only.");
  });

  test("an active idempotency key returns the existing task without a second row", () => {
    writeWorkspace();
    const input = { repo: "backend", title: "Bump deps", body: "", idempotencyKey: "form-1" };
    const first = handleCreateTask(data, input);
    const second = handleCreateTask(data, input);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const firstBody = first.body as DashboardTaskResponse;
    const secondBody = second.body as DashboardTaskResponse;
    expect(secondBody).toEqual({ ...firstBody, deduplicated: true });
    expect(readRows()).toHaveLength(1);

    // A different key is a separate submission.
    const third = handleCreateTask(data, { ...input, idempotencyKey: "form-2" });
    expect(third.status).toBe(201);
    expect((third.body as DashboardTaskResponse).taskKey).toBe("local-bump-deps-2");
  });

  test("rejects an unknown repo with the valid names", () => {
    writeWorkspace();
    const response = handleCreateTask(data, { repo: "mobile", title: "x" });
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toContain("backend, web");
    expect(readRows()).toHaveLength(0);
  });

  test("rejects an oversized body", () => {
    writeWorkspace();
    const response = handleCreateTask(data, {
      repo: "web",
      title: "Too long",
      body: "x".repeat(MAX_INJECTED_BODY_CHARS + 1),
    });
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toContain("too large");
    expect(readRows()).toHaveLength(0);
  });

  test("accepts a body at exactly the cap", () => {
    writeWorkspace();
    const response = handleCreateTask(data, {
      repo: "web",
      title: "At the cap",
      body: "x".repeat(MAX_INJECTED_BODY_CHARS),
    });
    expect(response.status).toBe(201);
  });

  test("returns 409 when the dashboard has no workspace", () => {
    const response = handleCreateTask(data, { repo: "web", title: "x" });
    expect(response.status).toBe(409);
    expect((response.body as { error: string }).error).toContain("workspace");
    expect(existsSync(dbPath)).toBe(false);
  });

  test("returns 409 for an invalid workspace config", () => {
    writeWorkspace("[[repos]]\nname = 1\n");
    const response = handleCreateTask(data, { repo: "web", title: "x" });
    expect(response.status).toBe(409);
  });

  test("returns 500 with the cause when the prompt cannot be written", () => {
    if (process.getuid?.() === 0) return; // root ignores directory modes
    writeWorkspace();
    // A read-only workspace home: the injected/ prompt dir cannot be created.
    data.getInjectedTaskStore(); // open the DB first so only the prompt write fails
    chmodSync(workspaceDir, 0o500);
    try {
      const response = handleCreateTask(data, { repo: "web", title: "x" });
      expect(response.status).toBe(500);
      expect((response.body as { error: string }).error).toContain("could not enqueue the task");
    } finally {
      chmodSync(workspaceDir, 0o700);
    }
  });

  /** Start a real server on an ephemeral port against this workspace. */
  function startServer() {
    data.close();
    return startDashboardServer({
      port: 0,
      dbPath,
      workingDir: workspaceDir,
      workspaceDir,
      logDirs: [],
    });
  }

  test("the server routes POST /api/tasks and rejects malformed JSON", async () => {
    writeWorkspace();
    const server = startServer();
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const url = `${base}/api/tasks`;
      // Same-origin JSON, as the dashboard page sends it.
      const headers = { "Content-Type": "application/json", Origin: base };
      const created = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ repo: "web", title: "From the server", idempotencyKey: "k" }),
      });
      expect(created.status).toBe(201);
      expect(((await created.json()) as DashboardTaskResponse).taskKey).toBe(
        "local-from-the-server",
      );

      const malformed = await fetch(url, { method: "POST", headers, body: "{not json" });
      expect(malformed.status).toBe(400);

      const wrongMethod = await fetch(url);
      expect(wrongMethod.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("a cross-origin POST is refused and enqueues nothing", async () => {
    writeWorkspace();
    const server = startServer();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ repo: "web", title: "Smuggled" }),
      });
      expect(response.status).toBe(403);
    } finally {
      server.stop(true);
    }
    expect(existsSync(injectedTasksDir(workspaceDir))).toBe(false);
    expect(readRows()).toHaveLength(0);
  });
});

describe("parseDashboardTaskRequest", () => {
  test("requires an object with a repo and a non-blank title", () => {
    expect(parseDashboardTaskRequest(null).ok).toBe(false);
    expect(parseDashboardTaskRequest([]).ok).toBe(false);
    expect(parseDashboardTaskRequest({ title: "x" }).ok).toBe(false);
    expect(parseDashboardTaskRequest({ repo: "web", title: "   " }).ok).toBe(false);
    expect(parseDashboardTaskRequest({ repo: "web", title: "x", body: 3 }).ok).toBe(false);
  });

  test("rejects blank idempotency keys and defaults the body", () => {
    expect(parseDashboardTaskRequest({ repo: "web", title: "x", idempotencyKey: " " }).ok).toBe(
      false,
    );
    expect(parseDashboardTaskRequest({ repo: "web", title: "x" })).toEqual({
      ok: true,
      request: { repo: "web", title: "x", body: "" },
    });
  });
});
