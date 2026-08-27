import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutomationAcquirer, makeDefaultPresetSpawnRun } from "../src/lib/automation-acquirer";
import { AutomationStateStore } from "../src/lib/automation-state";
import type { AutomationConfig } from "../src/lib/automation-config";
import { getPreset, registerPreset } from "../src/lib/automations/presets";
import { createTempRepo } from "./git-fixture";

/** Pre-seed the schedule so the automation is due on the first tick. */
function seedDueSchedule(dbPath: string, automation: AutomationConfig): void {
  new AutomationStateStore(dbPath).register(automation, Date.now() - 1_000);
}

function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "devintern-acq-preset-"));
  return join(dir, "queue.db");
}

describe("AutomationAcquirer preset dispatch", () => {
  test("preset automations run through the registry instead of the task pipeline", async () => {
    const repo = createTempRepo("acqpreset");
    const dbPath = makeDb();
    const runs: Array<{ automationId: string; cwd: string; mode: string; options: unknown }> = [];

    registerPreset({
      name: "test-preset",
      version: 3,
      summary: "registry dispatch test",
      outputModes: ["ticket"],
      defaultOutputMode: "ticket",
      checkPrerequisites: (context) => {
        if (!context.cwd) context.error("cwd is required");
      },
      run: async (input) => {
        runs.push({
          automationId: input.automationId,
          cwd: input.cwd,
          mode: input.resolved.outputMode,
          options: input.resolved.options,
        });
        return true;
      },
    });

    const automation: AutomationConfig = {
      id: "preset-run",
      enabled: true,
      preset: "test-preset",
      outputMode: "ticket",
      interval: "1d",
      intervalMs: 86_400_000,
    };

    seedDueSchedule(dbPath, automation);
    const acquirer = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      resolveContext: async () => ({
        cwd: repo.dir,
        env: {},
        repo: "repo",
        release: () => {},
      }),
      presetRunner: makeDefaultPresetSpawnRun(dbPath),
    });

    await acquirer.start();
    // Wait for the in-process run to settle.
    await Bun.sleep(50);
    await acquirer.stop();

    expect(runs).toEqual([
      {
        automationId: "preset-run",
        cwd: repo.dir,
        mode: "ticket",
        options: {},
      },
    ]);
    repo.cleanup();
  });

  test("prerequisite failures skip the run without throwing", async () => {
    const repo = createTempRepo("acqpreset2");
    const dbPath = makeDb();
    let ran = false;

    registerPreset({
      name: "test-preset-failing",
      version: 1,
      summary: "prereq failure test",
      outputModes: ["ticket"],
      defaultOutputMode: "ticket",
      checkPrerequisites: (context) => context.error("tracker cannot create issues"),
      run: async () => {
        ran = true;
        return true;
      },
    });

    const automation: AutomationConfig = {
      id: "preset-fail",
      enabled: true,
      preset: "test-preset-failing",
      interval: "1d",
      intervalMs: 86_400_000,
    };

    seedDueSchedule(dbPath, automation);
    const acquirer = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      resolveContext: async () => ({ cwd: repo.dir, env: {}, release: () => {} }),
      presetRunner: makeDefaultPresetSpawnRun(dbPath),
    });

    await acquirer.start();
    await Bun.sleep(50);
    await acquirer.stop();

    expect(ran).toBe(false);
    repo.cleanup();
  });

  test("unknown presets are reported and fail the occurrence", async () => {
    const repo = createTempRepo("acqpreset3");
    const dbPath = makeDb();
    const automation: AutomationConfig = {
      id: "preset-unknown",
      enabled: true,
      preset: "never-registered",
      interval: "1d",
      intervalMs: 86_400_000,
    };
    seedDueSchedule(dbPath, automation);
    const acquirer = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      resolveContext: async () => ({ cwd: repo.dir, env: {}, release: () => {} }),
      presetRunner: makeDefaultPresetSpawnRun(dbPath),
    });
    await acquirer.start();
    await Bun.sleep(50);
    await acquirer.stop();
    expect(getPreset("never-registered")).toBeUndefined();
    repo.cleanup();
  });
});
