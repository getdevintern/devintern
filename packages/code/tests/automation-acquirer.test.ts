import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { AutomationAcquirer, nextAutomationDue } from "../src/lib/automation-acquirer";
import { AutomationStateStore } from "../src/lib/automation-state";
import type { AutomationConfig } from "../src/lib/automation-config";

describe("AutomationAcquirer", () => {
  const dbPaths: string[] = [];
  afterEach(() => {
    for (const path of dbPaths.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  test("calculates future cron and interval due times", () => {
    const after = new Date("2026-08-21T12:34:00Z").getTime();
    const interval: AutomationConfig = {
      id: "i",
      enabled: true,
      prompt: "p",
      action: "headless",
      interval: "15m",
      intervalMs: 900_000,
    };
    const cron: AutomationConfig = {
      id: "c",
      enabled: true,
      prompt: "p",
      action: "headless",
      cron: "*/5 * * * *",
    };
    expect(nextAutomationDue(interval, after)).toBe(after + 900_000);
    expect(nextAutomationDue(cron, after)).toBeGreaterThan(after);
  });

  test("disabled entries never receive schedule state", async () => {
    const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    const automation: AutomationConfig = {
      id: "off",
      enabled: false,
      prompt: "p",
      action: "headless",
      interval: "1h",
      intervalMs: 3_600_000,
    };
    const acquirer = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      resolveContext: async () => null,
      now: () => 100,
    });
    await acquirer.start();
    await acquirer.stop();
    const store = new AutomationStateStore(dbPath);
    expect(store.get("off")).toBeNull();
    store.close();
  });

  test("coalesces a missed occurrence to one run", async () => {
    const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    let now = 0;
    let runs = 0;
    let resolveRun!: (ok: boolean) => void;
    const automation: AutomationConfig = {
      id: "due",
      enabled: true,
      prompt: "p",
      action: "headless",
      interval: "15m",
      intervalMs: 900_000,
    };
    const acquirer = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      now: () => now,
      resolveContext: async () => ({ cwd: "/tmp", env: {}, release() {} }),
      spawnRun: () => {
        runs += 1;
        return { completion: new Promise((resolve) => (resolveRun = resolve)), terminate() {} };
      },
    });
    await acquirer.start();
    now = 10_000_000;
    await acquirer.tick();
    expect(runs).toBe(1);
    await acquirer.tick();
    expect(runs).toBe(1);
    resolveRun(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await acquirer.stop();
  });
});
