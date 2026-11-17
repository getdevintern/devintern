import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { DashboardData, handleWorkerStatus } from "../src/lib/observability/dashboard-api";
import {
  filterConfiguredSources,
  handleSources,
  parseSourceStatusRow,
} from "../src/lib/observability/dashboard-sources";
import type { DashboardSourceView } from "../src/lib/observability/dashboard-sources";
import { AutomationStateStore } from "../src/lib/automation/state";
import { WorkerState } from "../src/lib/state/worker-state";
import { startDashboardServer } from "../src/dashboard-server";
import { workspaceConfigPath } from "../src/lib/workspace/paths";

const WORKSPACE_TOML = `
[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[error_monitors]]
id = "api-production"
provider = "sentry"
repo = "api"
organization = "acme"
project = "api"

[[error_monitors]]
id = "api-staging"
provider = "sentry"
repo = "api"
organization = "acme"
project = "api-staging"
enabled = false
`;

describe("dashboard source health", () => {
  let dir: string;
  let workspaceDir: string;
  let dbPath: string;
  let savedWorkspaceDir: string | undefined;
  const opened: DashboardData[] = [];

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dir = join(tmpdir(), `dash-sources-${suffix}`);
    workspaceDir = join(tmpdir(), `dash-sources-ws-${suffix}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    savedWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    for (const data of opened.splice(0)) data.close();
    if (savedWorkspaceDir === undefined) {
      delete process.env.DEVINTERN_WORKSPACE_DIR;
    } else {
      process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceDir;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function makeData(options: ConstructorParameters<typeof DashboardData>[0] = {}): DashboardData {
    const data = new DashboardData({
      dbPath,
      workingDir: dir,
      workspaceDir,
      logDirs: [],
      ...options,
    });
    opened.push(data);
    return data;
  }

  function seed(): void {
    const store = new AutomationStateStore(dbPath);
    try {
      store.recordSourceStatus({
        provider: "sentry",
        sourceId: "api-production",
        status: "ok",
        checkedAt: 1_000,
      });
      store.recordSourceStatus({
        provider: "sentry",
        sourceId: "api-production",
        status: "rate-limited",
        checkedAt: 2_000,
        message: "HTTP 429",
        retryAfterMs: 60_000,
      });
      store.recordSourceStatus({
        provider: "sentry",
        sourceId: "removed-source",
        status: "auth-failed",
        checkedAt: 3_000,
        message: "HTTP 403",
      });
      store.recordSourceStatus({
        provider: "sentry",
        sourceId: "never-ok",
        status: "unreadable",
        checkedAt: 4_000,
      });
    } finally {
      store.close();
    }
  }

  test("GET /api/sources serves every field with null for unset values", () => {
    seed();
    const data = makeData({
      configuredSources: () => [
        { provider: "sentry", sourceId: "api-production" },
        { provider: "sentry", sourceId: "never-ok" },
      ],
    });

    const response = handleSources(data);
    expect(response.status).toBe(200);
    const { sources } = response.body as { sources: DashboardSourceView[] };
    expect(sources).toEqual([
      {
        provider: "sentry",
        sourceId: "api-production",
        status: "rate-limited",
        checkedAt: 2_000,
        lastSuccessAt: 1_000,
        consecutiveFailures: 1,
        message: "HTTP 429",
        retryAfterAt: 62_000,
      },
      {
        provider: "sentry",
        sourceId: "never-ok",
        status: "unreadable",
        checkedAt: 4_000,
        lastSuccessAt: null,
        consecutiveFailures: 1,
        message: null,
        retryAfterAt: null,
      },
    ]);
  });

  test("rows for sources removed from the config are not served", () => {
    seed();
    const data = makeData({
      configuredSources: () => [{ provider: "sentry", sourceId: "api-production" }],
    });

    const ids = data.getSources().sources.map((source) => source.sourceId);
    expect(ids).toEqual(["api-production"]);
  });

  test("no configured sources yields an empty list even with stored rows", () => {
    seed();
    const data = makeData({ configuredSources: () => [] });

    expect(handleSources(data).body).toEqual({ sources: [] });
    expect((handleWorkerStatus(data).body as { sources: unknown[] }).sources).toEqual([]);
  });

  test("defaults to the enabled [[error_monitors]] of workspace.toml", () => {
    seed();
    const store = new AutomationStateStore(dbPath);
    store.recordSourceStatus({
      provider: "sentry",
      sourceId: "api-staging",
      status: "auth-failed",
      checkedAt: 5_000,
    });
    store.close();
    writeFileSync(workspaceConfigPath(workspaceDir), WORKSPACE_TOML);

    const ids = makeData()
      .getSources()
      .sources.map((source) => source.sourceId);
    expect(ids).toEqual(["api-production"]);
  });

  test("a missing database or table yields no sources", () => {
    const data = makeData({
      configuredSources: () => [{ provider: "sentry", sourceId: "api-production" }],
    });
    expect(data.getSources()).toEqual({ sources: [] });

    // DB exists (worker state) but the source_status table does not yet.
    new WorkerState(dbPath).close();
    expect(data.getSources()).toEqual({ sources: [] });
  });

  test("GET /api/worker adds sources without changing existing fields", () => {
    seed();
    const data = makeData({
      configuredSources: () => [{ provider: "sentry", sourceId: "api-production" }],
    });

    const body = handleWorkerStatus(data).body as Record<string, unknown>;
    for (const key of [
      "worker",
      "queue",
      "agentPrs",
      "schedule",
      "cursors",
      "dbPath",
      "dbMissing",
      "queueDbPath",
      "queueDbMissing",
    ]) {
      expect(body).toHaveProperty(key);
    }
    expect(typeof body.dbPath).toBe("string");
    expect(typeof body.dbMissing).toBe("boolean");
    expect(Array.isArray(body.cursors)).toBe(true);
    expect(body).not.toHaveProperty("sourcesError");
    const sources = body.sources as DashboardSourceView[];
    expect(sources.map((source) => source.status)).toEqual(["rate-limited"]);
  });

  test("a failing sources read never blocks the worker payload", () => {
    seed();
    const data = makeData({
      configuredSources: () => {
        throw new Error("workspace.toml is invalid");
      },
    });

    const worker = handleWorkerStatus(data);
    expect(worker.status).toBe(200);
    const body = worker.body as Record<string, unknown>;
    expect(body.worker).toBeDefined();
    expect(body.queue).toBeDefined();
    expect(body.sources).toEqual([]);
    expect(body.sourcesError).toContain("workspace.toml is invalid");

    const sources = handleSources(data);
    expect(sources.status).toBe(500);
    expect((sources.body as { error: string }).error).toContain("workspace.toml is invalid");
  });

  test("serves /api/sources over HTTP", async () => {
    seed();
    const server = startDashboardServer({
      port: 0,
      dbPath,
      workingDir: dir,
      workspaceDir,
      logDirs: [],
      configuredSources: () => [{ provider: "sentry", sourceId: "api-production" }],
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const sources = (await (await fetch(`${base}/api/sources`)).json()) as {
        sources: DashboardSourceView[];
      };
      expect(sources.sources.map((source) => source.sourceId)).toEqual(["api-production"]);
      const worker = (await (await fetch(`${base}/api/worker`)).json()) as {
        sources: DashboardSourceView[];
        queue: unknown;
      };
      expect(worker.queue).toBeDefined();
      expect(worker.sources).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("source status parsing", () => {
  test("rejects unknown statuses and malformed rows", () => {
    expect(parseSourceStatusRow(null)).toBeNull();
    expect(
      parseSourceStatusRow({ provider: "sentry", source_id: "a", status: "weird", checked_at: 1 }),
    ).toBeNull();
    expect(parseSourceStatusRow({ provider: "sentry", source_id: "a", status: "ok" })).toBeNull();
  });

  test("filters to configured sources in config order", () => {
    const row = (sourceId: string): DashboardSourceView => ({
      provider: "sentry",
      sourceId,
      status: "ok",
      checkedAt: 1,
      lastSuccessAt: 1,
      consecutiveFailures: 0,
      message: null,
      retryAfterAt: null,
    });
    const result = filterConfiguredSources(
      [row("a"), row("b"), row("stale")],
      [
        { provider: "sentry", sourceId: "b" },
        { provider: "sentry", sourceId: "a" },
        { provider: "datadog", sourceId: "stale" },
      ],
    );
    expect(result.map((source) => source.sourceId)).toEqual(["b", "a"]);
  });
});
