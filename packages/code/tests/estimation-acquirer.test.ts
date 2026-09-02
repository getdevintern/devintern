import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  AUTOMATION_ID_ENV,
  AUTOMATION_ORIGIN_ENV,
  MAX_TIMER_DELAY_MS,
} from "../src/lib/automation-acquirer";
import { AutomationStateStore } from "../src/lib/automation-state";
import {
  estimationCliArgs,
  estimationRunEnv,
  EstimationAcquirer,
} from "../src/lib/estimation-acquirer";
import type { EstimationConfig } from "../src/lib/estimation-config";

function intervalEntry(id: string, overrides: Partial<EstimationConfig> = {}): EstimationConfig {
  return {
    id,
    enabled: true,
    query: "labels IN (NeedsEstimate)",
    interval: "15m",
    intervalMs: 900_000,
    ...overrides,
  };
}

describe("estimationCliArgs", () => {
  test("runs the one-shot estimate engine with git disabled", () => {
    expect(estimationCliArgs(intervalEntry("groom"))).toEqual([
      "--estimate",
      "--query",
      "labels IN (NeedsEstimate)",
      "--no-git",
    ]);
  });

  test("stamps the distinct estimate origin plus the owning schedule id", () => {
    const env = estimationRunEnv(intervalEntry("groom"), { TASK_TRACKER: "jira" });
    expect(env[AUTOMATION_ORIGIN_ENV]).toBe("estimate");
    expect(env[AUTOMATION_ID_ENV]).toBe("groom");
    expect(env.TASK_TRACKER).toBe("jira");
  });
});

describe("EstimationAcquirer", () => {
  const dbPaths: string[] = [];
  afterEach(() => {
    for (const path of dbPaths.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  function newDb(): string {
    const dbPath = join(tmpdir(), `estimator-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    return dbPath;
  }

  function noopTimers() {
    return {
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    };
  }

  test("is a distinct scheduled source beside the automations scheduler", () => {
    const acquirer = new EstimationAcquirer({
      estimations: [intervalEntry("groom")],
      dbPath: newDb(),
      resolveContext: async () => null,
    });
    expect(acquirer.name).toBe("scheduled-estimations");
  });

  test("namespaces durable schedule state away from automation ids", async () => {
    const dbPath = newDb();
    let now = 0;
    let runs = 0;
    const acquirer = new EstimationAcquirer({
      estimations: [intervalEntry("weekday-groom")],
      dbPath,
      now: () => now,
      ...noopTimers(),
      resolveContext: async () => ({ cwd: "/tmp", env: {}, release() {} }),
      spawnRun: () => {
        runs += 1;
        return { completion: Promise.resolve(true), terminate() {} };
      },
    });

    await acquirer.start();
    now = 900_000;
    await acquirer.tick();

    // State lives under "estimation:weekday-groom"; an unrelated automation
    // row sharing the plain id is untouched.
    const store = new AutomationStateStore(dbPath);
    expect(store.get("weekday-groom")).toBeNull();
    expect(store.get("estimation:weekday-groom")?.nextDueAt).toBe(1_800_000);
    store.close();

    expect(runs).toBe(1);
    await acquirer.stop();
  });

  test("hands the sweep runner the estimation entry and run context", async () => {
    const dbPath = newDb();
    let now = 0;
    const calls: Array<{ id: string; cwd: string; origin?: string }> = [];
    const finishers: Array<(ok: boolean) => void> = [];
    const acquirer = new EstimationAcquirer({
      estimations: [intervalEntry("sprint-gaps"), intervalEntry("off", { enabled: false })],
      dbPath,
      now: () => now,
      ...noopTimers(),
      resolveContext: async () => ({ cwd: "/workspace-home", env: {}, release() {} }),
      spawnRun: (estimation, context) => {
        calls.push({
          id: estimation.id,
          cwd: context.cwd,
          origin: context.env[AUTOMATION_ORIGIN_ENV],
        });
        let finish!: (ok: boolean) => void;
        const completion = new Promise<boolean>((resolve) => (finish = resolve));
        finishers.push(finish);
        return { completion, terminate() {} };
      },
    });

    await acquirer.start();
    now = 900_000;
    await acquirer.tick();

    expect(calls).toEqual([{ id: "sprint-gaps", cwd: "/workspace-home", origin: undefined }]);
    for (const finish of finishers) finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await acquirer.stop();
  });

  test("disabled entries are never scheduled", async () => {
    const dbPath = newDb();
    const acquirer = new EstimationAcquirer({
      estimations: [intervalEntry("off", { enabled: false })],
      dbPath,
      resolveContext: async () => null,
    });
    await acquirer.start();
    await acquirer.stop();
    const store = new AutomationStateStore(dbPath);
    expect(store.get("estimation:off")).toBeNull();
    store.close();
  });

  test("reconciles entries and updated queries after a live reload", async () => {
    const dbPath = newDb();
    let now = 0;
    const queries: string[] = [];
    const acquirer = new EstimationAcquirer({
      estimations: [],
      dbPath,
      now: () => now,
      ...noopTimers(),
      resolveContext: async () => ({ cwd: "/tmp", env: {}, release() {} }),
      spawnRun: (estimation) => {
        queries.push(estimation.query);
        return { completion: Promise.resolve(true), terminate() {} };
      },
    });

    await acquirer.start();
    acquirer.applyEstimations([
      intervalEntry("groom", { query: "labels = Fresh", interval: "1m", intervalMs: 60_000 }),
    ]);
    now = 60_000;
    await acquirer.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queries).toEqual(["labels = Fresh"]);

    acquirer.applyEstimations([]);
    const store = new AutomationStateStore(dbPath);
    expect(store.get("estimation:groom")).toBeNull();
    store.close();
    await acquirer.stop();
  });

  test("caps long timer delays at the runtime maximum", async () => {
    const dbPath = newDb();
    const delays: number[] = [];
    const acquirer = new EstimationAcquirer({
      estimations: [intervalEntry("long", { interval: "30d", intervalMs: 30 * 86_400_000 })],
      dbPath,
      now: () => 0,
      setTimer: (_callback, delay) => {
        delays.push(delay);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      resolveContext: async () => null,
    });
    await acquirer.start();
    expect(delays.at(-1)).toBe(MAX_TIMER_DELAY_MS);
    await acquirer.stop();
  });

  test("context decline releases the claim so later occurrences still run", async () => {
    const dbPath = newDb();
    let now = 0;
    let runs = 0;
    let declinedOnce = false;
    const acquirer = new EstimationAcquirer({
      estimations: [intervalEntry("busy")],
      dbPath,
      now: () => now,
      ...noopTimers(),
      resolveContext: async () => {
        if (!declinedOnce) {
          declinedOnce = true;
          return null;
        }
        return { cwd: "/tmp", env: {}, release() {} };
      },
      spawnRun: () => {
        runs += 1;
        return { completion: Promise.resolve(true), terminate() {} };
      },
    });

    await acquirer.start();
    now = 900_000;
    await acquirer.tick(); // occurrence skipped; cursor advances to 1_800_000
    now = 1_800_000;
    await acquirer.tick();
    expect(runs).toBe(1);
    await acquirer.stop();
  });
});
