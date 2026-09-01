import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { DashboardData, handleAutomations, handleRunAutomation } from "../src/lib/dashboard-api";
import type { AutomationRunDeps, DashboardAutomationView } from "../src/lib/dashboard-api";
import { startDashboardServer } from "../src/dashboard-server";
import { RunStore } from "../src/lib/run-recorder";
import type { AutomationScheduleStatus } from "../src/lib/automation-acquirer";

const ACTOR: NonNullable<AutomationRunDeps["resolveActor"]> = async () => ({
  email: "dev@example.com",
});

const CATALOG: AutomationScheduleStatus[] = [
  {
    id: "dependency-health",
    enabled: true,
    interval: "1d",
    prompt: "Inspect dependency health.",
    nextDueAt: 1_800_000_000_000,
  },
  {
    id: "weekly-grooming",
    enabled: false,
    cron: "0 9 * * 1",
    prompt: "Groom flaky tests.",
  },
];

interface AutomationBridgeHarness {
  data: DashboardData;
  triggers: string[];
  setOutcome(outcome: { ok: true } | { ok: false; reason: string }): void;
}

/** DashboardData with an automation bridge whose trigger records and can be reprogrammed. */
function harness(
  dbPath: string,
  workingDir: string,
  options: {
    retryMode?: "spawn" | "schedule";
    inflightAutomationTtlMs?: number;
  } = {},
): AutomationBridgeHarness {
  const triggers: string[] = [];
  let outcome: { ok: true } | { ok: false; reason: string } = { ok: true };
  const data = new DashboardData({
    dbPath,
    workingDir,
    retryMode: options.retryMode,
    inflightAutomationTtlMs: options.inflightAutomationTtlMs,
    automationActions: {
      list: () => CATALOG,
      trigger: async (automationId) => {
        triggers.push(automationId);
        return outcome;
      },
    },
  });
  return { data, triggers, setOutcome: (value) => (outcome = value) };
}

describe("dashboard automations (Run now)", () => {
  let dir: string;
  let workspaceDir: string;
  let dbPath: string;
  let savedWorkspaceDir: string | undefined;

  beforeEach(() => {
    dir = join(tmpdir(), `dash-auto-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspaceDir = join(
      tmpdir(),
      `dash-auto-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    savedWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    if (savedWorkspaceDir === undefined) {
      delete process.env.DEVINTERN_WORKSPACE_DIR;
    } else {
      process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceDir;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("handleAutomations lists configured automations with schedule state and last run", () => {
    const store = new RunStore(dbPath);
    const scheduled = store.createRun({
      origin: "scheduled",
      automationId: "dependency-health",
      tracker: "markdown",
    });
    store.finishRun(scheduled, "succeeded");
    const manual = store.createRun({ origin: "manual", automationId: "dependency-health" });
    store.close();

    const data = new DashboardData({
      dbPath,
      workingDir: dir,
      automationActions: { list: () => CATALOG, trigger: async () => ({ ok: true }) },
    });
    try {
      const response = handleAutomations(data);
      expect(response.status).toBe(200);
      const body = response.body as { automations: DashboardAutomationView[] };
      expect(body.automations).toHaveLength(2);

      const health = body.automations[0] as DashboardAutomationView;
      expect(health.id).toBe("dependency-health");
      expect(health.enabled).toBe(true);
      expect(health.schedule).toBe("1d");
      expect(health.prompt).toBe("Inspect dependency health.");
      expect(health.nextDueAt).toBe(1_800_000_000_000);
      // Most recent run wins (the manual run), with descriptions stripped.
      expect(health.lastRun?.id).toBe(manual);
      expect(health.lastRun?.origin).toBe("manual");
      expect(health.lastRun?.taskDescription).toBeUndefined();

      const grooming = body.automations[1] as DashboardAutomationView;
      expect(grooming.enabled).toBe(false);
      expect(grooming.schedule).toBe("0 9 * * 1");
      expect(grooming.lastRun).toBeUndefined();
    } finally {
      data.close();
    }
  });

  test("handleAutomations degrades to an empty list without configuration", () => {
    const data = new DashboardData({ dbPath, workingDir: dir });
    try {
      const response = handleAutomations(data);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ automations: [] });
    } finally {
      data.close();
    }
  });

  test("a worker-embedded dashboard without an in-process scheduler serves no catalog", () => {
    const data = new DashboardData({ dbPath, workingDir: dir, retryMode: "schedule" });
    try {
      const response = handleAutomations(data);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ automations: [] });
    } finally {
      data.close();
    }
  });

  test("handleRunAutomation validates the id and existence", async () => {
    const state = harness(dbPath, dir);
    try {
      expect((await handleRunAutomation(state.data, "", { resolveActor: ACTOR })).status).toBe(400);
      expect((await handleRunAutomation(state.data, "nope", { resolveActor: ACTOR })).status).toBe(
        404,
      );
    } finally {
      state.data.close();
    }
  });

  test("handleRunAutomation refuses disabled automations and in-progress runs", async () => {
    const state = harness(dbPath, dir);
    try {
      const disabled = await handleRunAutomation(state.data, "weekly-grooming", {
        resolveActor: ACTOR,
      });
      expect(disabled.status).toBe(409);
      expect((disabled.body as { error: string }).error).toContain("disabled");

      const store = new RunStore(dbPath);
      store.createRun({ origin: "scheduled", automationId: "dependency-health" });
      store.close();

      const busy = await handleRunAutomation(state.data, "dependency-health", {
        resolveActor: ACTOR,
      });
      expect(busy.status).toBe(409);
      expect((busy.body as { error: string }).error).toContain("run in progress");
    } finally {
      state.data.close();
    }
  });

  test("handleRunAutomation triggers through the bridge and debounces spawn-mode repeats", async () => {
    const state = harness(dbPath, dir, { inflightAutomationTtlMs: 20 });
    try {
      const response = await handleRunAutomation(state.data, "dependency-health", {
        resolveActor: ACTOR,
      });
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: "triggered", automationId: "dependency-health" });
      expect(state.triggers).toEqual(["dependency-health"]);

      // A rapid repeat is refused while the run is starting.
      const repeat = await handleRunAutomation(state.data, "dependency-health", {
        resolveActor: ACTOR,
      });
      expect(repeat.status).toBe(409);
      expect(state.triggers).toHaveLength(1);

      // Once the claim TTL lapses the automation can be triggered again.
      await new Promise((resolve) => setTimeout(resolve, 40));
      const again = await handleRunAutomation(state.data, "dependency-health", {
        resolveActor: ACTOR,
      });
      expect(again.status).toBe(202);
      expect(state.triggers).toHaveLength(2);
    } finally {
      state.data.close();
    }
  });

  test("schedule mode relies on the trigger outcome instead of the spawn-mode claim", async () => {
    const state = harness(dbPath, dir, { retryMode: "schedule" });
    try {
      const first = await handleRunAutomation(state.data, "dependency-health", {
        resolveActor: ACTOR,
      });
      expect(first.status).toBe(202);
      const second = await handleRunAutomation(state.data, "dependency-health", {
        resolveActor: ACTOR,
      });
      expect(second.status).toBe(202);
      expect(state.triggers).toHaveLength(2);
    } finally {
      state.data.close();
    }
  });

  test("handleRunAutomation surfaces trigger refusals and failures with detail", async () => {
    const state = harness(dbPath, dir);
    try {
      state.setOutcome({
        ok: false,
        reason: 'the repository for "dependency-health" is busy with another run',
      });
      const refused = await handleRunAutomation(state.data, "dependency-health", {
        resolveActor: ACTOR,
      });
      expect(refused.status).toBe(409);
      expect((refused.body as { error: string }).error).toContain("busy");

      // A refused trigger frees the slot, so an immediate retry is allowed.
      state.setOutcome({ ok: true });
      expect(
        (await handleRunAutomation(state.data, "dependency-health", { resolveActor: ACTOR }))
          .status,
      ).toBe(202);
    } finally {
      state.data.close();
    }

    const throwing = harness(dbPath, dir);
    try {
      const failed = await handleRunAutomation(throwing.data, "dependency-health", {
        resolveActor: ACTOR,
        trigger: async () => {
          throw new Error("clone failed");
        },
      });
      expect(failed.status).toBe(500);
      expect((failed.body as { error: string }).error).toContain("clone failed");
    } finally {
      throwing.data.close();
    }
  });
});

describe("dashboard server automation routes", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `dash-auto-srv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("serves GET /api/automations and POST /api/automations/:id/run end-to-end", async () => {
    const triggers: string[] = [];
    const server = startDashboardServer({
      port: 0,
      dbPath,
      workingDir: dir,
      automationActions: {
        list: () => CATALOG,
        trigger: async (automationId) => {
          triggers.push(automationId);
          return { ok: true };
        },
      },
      automationDeps: { resolveActor: ACTOR },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const list = (await (await fetch(`${base}/api/automations`)).json()) as {
        automations: { id: string }[];
      };
      expect(list.automations.map((item) => item.id)).toEqual([
        "dependency-health",
        "weekly-grooming",
      ]);

      const run = await fetch(`${base}/api/automations/dependency-health/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(run.status).toBe(202);
      const runBody = (await run.json()) as { status: string; automationId: string };
      expect(runBody.status).toBe("triggered");
      expect(runBody.automationId).toBe("dependency-health");
      expect(triggers).toEqual(["dependency-health"]);

      const missing = await fetch(`${base}/api/automations/nope/run`, { method: "POST" });
      expect(missing.status).toBe(404);

      const wrongMethod = await fetch(`${base}/api/automations/dependency-health/run`);
      expect(wrongMethod.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("allows a loopback trigger without a CLI sign-in session", async () => {
    const server = startDashboardServer({
      port: 0,
      dbPath,
      workingDir: dir,
      automationActions: { list: () => CATALOG, trigger: async () => ({ ok: true }) },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/api/automations/dependency-health/run`, {
        method: "POST",
      });
      expect(response.status).toBe(202);
    } finally {
      server.stop(true);
    }
  });
});
