import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DashboardData } from "../src/lib/observability/dashboard-api";
import {
  buildHarnesses,
  buildOverview,
  lastSuccessByHarness,
  remoteSlug,
  UNCONFIRMED_LIMIT_LOOKBACK_MS,
} from "../src/lib/observability/dashboard-overview";
import { startDashboardServer } from "../src/dashboard-server";
import { RunStore } from "../src/lib/state/run-recorder";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";

const WORKSPACE_TOML = `
[workspace.execution]
isolation = "best_effort_host"
max_concurrency = 4
max_concurrency_per_repo = 2

[defaults]
tracker = "jira"
task_query = "project = DEV"

[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT"
repo = "api"

[[teams]]
name = "web"
tracker = "github"
task_query = "is:open label:intern"
repo = "web"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "https://github.com/acme/web"
`;

describe("GET /api/overview", () => {
  let workspaceDir: string;
  let dbPath: string;
  let data: DashboardData;
  let savedHarness: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "dash-overview-"));
    dbPath = join(workspaceDir, "queue.db");
    savedHarness = process.env.AGENT_HARNESS;
    delete process.env.AGENT_HARNESS;
    data = new DashboardData({
      dbPath,
      queueDbPath: dbPath,
      workingDir: workspaceDir,
      workspaceDir,
      logDirs: [],
    });
  });

  afterEach(() => {
    data.close();
    if (savedHarness === undefined) delete process.env.AGENT_HARNESS;
    else process.env.AGENT_HARNESS = savedHarness;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("capacity counts running runs against the configured limits, per repo", () => {
    writeFileSync(join(workspaceDir, "workspace.toml"), WORKSPACE_TOML);
    const store = new RunStore(dbPath);
    try {
      store.createRun({ origin: "task", taskKey: "PLAT-1", repo: "api" });
      // Owner/repo slugs (PR-driven runs) are attributed by remote.
      store.createRun({ origin: "pr_mention", repo: "acme/web" });
      store.createRun({ origin: "task", taskKey: "X-1", repo: "elsewhere" });
      store.createRun({ origin: "scheduled" });
      const done = store.createRun({ origin: "task", taskKey: "PLAT-2", repo: "api" });
      store.finishRun(done, "succeeded");
    } finally {
      store.close();
    }

    const { capacity, config } = buildOverview(data);
    expect(config.status).toBe("ok");
    expect(capacity.running).toBe(4);
    expect(capacity.maxConcurrency).toBe(4);
    expect(capacity.unattributed).toBe(1);
    expect(capacity.perRepo).toEqual([
      { repo: "api", running: 1, maxConcurrency: 2, configured: true },
      { repo: "web", running: 1, maxConcurrency: 2, configured: true },
      { repo: "elsewhere", running: 1, maxConcurrency: 2, configured: false },
    ]);
    expect(capacity.runs.find((run) => run.repo === "acme/web")?.workspaceRepo).toBe("web");
  });

  test("harness entries report healthy, limited, and unconfirmed (expired) windows from persisted state", () => {
    writeFileSync(join(workspaceDir, ".env"), "AGENT_HARNESS=claude-code,codex,grok\n");
    const now = Date.now();
    const queue = new WebhookQueue({ dbPath });
    queue.setRateLimit("claude-code", now + 60_000);
    // Expired with no succeeded run since → unconfirmed, not healthy.
    queue.setRateLimit("codex", now - 60_000, now - 120_000);
    queue.setActiveHarness("codex");
    queue.close();

    const { harnesses } = buildOverview(data, now);
    expect(harnesses.source).toBe("workspace_env");
    expect(harnesses.stateAvailable).toBe(true);
    expect(harnesses.allExhausted).toBe(false);
    expect(harnesses.active).toBe("codex");
    expect(harnesses.persistedActive).toBe("codex");
    expect(harnesses.entries).toEqual([
      {
        name: "claude-code",
        priority: 0,
        known: true,
        active: false,
        state: "limited",
        limitedUntil: now + 60_000,
      },
      {
        name: "codex",
        priority: 1,
        known: true,
        active: true,
        state: "unconfirmed",
        lastLimitedAt: now - 120_000,
        limitEndedAt: now - 60_000,
      },
      { name: "grok", priority: 2, known: true, active: false, state: "healthy" },
    ]);
  });

  test("every entry limited is exhausted and parks on the primary", () => {
    const now = 1_000_000;
    const harnesses = buildHarnesses(
      ["claude-code", "codex"],
      {
        rateLimits: { "claude-code": now + 5_000, codex: now + 2_000 },
        activeHarness: null,
        lastLimits: {},
      },
      now,
      "process_env",
    );
    expect(harnesses.allExhausted).toBe(true);
    expect(harnesses.active).toBe("claude-code");
    expect(harnesses.resumesAt).toBe(now + 2_000);
    expect(harnesses.entries.every((entry) => entry.state === "limited")).toBe(true);
  });

  test("an elapsed limit with no success since is unconfirmed, not healthy", () => {
    const now = 10_000_000;
    const hitAt = now - 3_600_000;
    const untilMs = now - 60_000;
    const state = {
      rateLimits: {},
      activeHarness: "opencode",
      lastLimits: { opencode: { hitAt, untilMs } },
    };

    const unchecked = buildHarnesses(["opencode"], state, now, "workspace_env");
    expect(unchecked.entries[0]).toMatchObject({
      state: "unconfirmed",
      lastLimitedAt: hitAt,
      limitEndedAt: untilMs,
    });
    expect(unchecked.allExhausted).toBe(false);

    // A run that failed or started before the hit proves nothing...
    const stale = buildHarnesses(["opencode"], state, now, "workspace_env", {
      opencode: hitAt - 1,
    });
    expect(stale.entries[0].state).toBe("unconfirmed");

    // ...a run that succeeded after the hit confirms the quota is back.
    const confirmed = buildHarnesses(["opencode"], state, now, "workspace_env", {
      opencode: untilMs + 1,
    });
    expect(confirmed.entries[0]).toMatchObject({ state: "healthy" });
    expect(confirmed.entries[0].lastLimitedAt).toBeUndefined();

    // Limits older than the lookback no longer cast doubt.
    const old = buildHarnesses(
      ["opencode"],
      { ...state, lastLimits: { opencode: { hitAt: 0, untilMs: 1 } } },
      now + UNCONFIRMED_LIMIT_LOOKBACK_MS,
      "workspace_env",
    );
    expect(old.entries[0].state).toBe("healthy");
  });

  test("lastSuccessByHarness keeps each harness's newest succeeded run", () => {
    expect(
      lastSuccessByHarness([
        { harness: "codex", status: "succeeded", startedAt: 5 },
        { harness: "codex", status: "succeeded", startedAt: 9 },
        { harness: "codex", status: "failed", startedAt: 20 },
        { harness: "grok", status: "in_progress", startedAt: 30 },
        { status: "succeeded", startedAt: 40 },
      ]),
    ).toEqual({ codex: 9 });
  });

  test("the last limit survives the window being cleared", () => {
    const dbPath = join(workspaceDir, "limits.db");
    const queue = new WebhookQueue({ dbPath });
    queue.setRateLimit("opencode", 2_000, 1_000);
    queue.clearRateLimit("opencode");
    expect(queue.getAllRateLimits()).toEqual({});
    expect(queue.getAllLastLimits()).toEqual({ opencode: { hitAt: 1_000, untilMs: 2_000 } });
    queue.close();
  });

  test("unreadable failover state reports unknown entries instead of healthy", () => {
    // No database file exists yet.
    const { harnesses, capacity, config, trackers } = buildOverview(data);
    expect(harnesses.stateAvailable).toBe(false);
    expect(harnesses.active).toBeNull();
    expect(harnesses.entries.map((entry) => entry.state)).toEqual(["unknown"]);
    expect(harnesses.source).toBe("default");
    // Missing config degrades every config-backed section instead of failing.
    expect(config.status).toBe("missing");
    expect(capacity).toMatchObject({ running: 0, maxConcurrency: null, perRepo: [] });
    expect(trackers).toEqual({ mode: "none", sources: [] });
  });

  test("team trackers carry their cursor's last poll time", () => {
    writeFileSync(join(workspaceDir, "workspace.toml"), WORKSPACE_TOML);
    const state = new WorkerState(dbPath);
    state.setCursor("jira:platform", "1700000000000");
    state.close();

    const { trackers } = buildOverview(data);
    expect(trackers.mode).toBe("teams");
    expect(trackers.pollIntervalSeconds).toBe(60);
    expect(trackers.sources[0]).toMatchObject({
      team: "platform",
      tracker: "jira",
      cursorSource: "jira:platform",
      cursorValue: "1700000000000",
    });
    expect(typeof trackers.sources[0]?.lastPolledAt).toBe("number");
    expect(trackers.sources[1]).toMatchObject({
      team: "web",
      repo: "web",
      cursorSource: "github:web",
    });
    expect(trackers.sources[1]?.lastPolledAt).toBeUndefined();
  });

  test("remote slugs normalize scp, https, and credentialed remotes", () => {
    expect(remoteSlug("git@github.com:Acme/API.git")).toBe("acme/api");
    expect(remoteSlug("https://token@github.com/acme/web/")).toBe("acme/web");
    expect(remoteSlug("ssh://git@gitlab.example.com/group/sub/proj.git")).toBe("sub/proj");
    expect(remoteSlug("not a url")).toBeNull();
  });

  test("the server routes /api/overview", async () => {
    const server = startDashboardServer({
      port: 0,
      dbPath,
      queueDbPath: dbPath,
      workingDir: workspaceDir,
      workspaceDir,
      logDirs: [],
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/overview`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { harnesses: { entries: unknown[] } };
      expect(body.harnesses.entries).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});
