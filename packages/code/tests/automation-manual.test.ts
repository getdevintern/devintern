import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadStandaloneAutomationActions } from "../src/lib/automation/manual";
import { workerTaskArgs } from "../src/lib/acquirers/task-polling";
import { WORKSPACE_PIPELINE_AUTOMATION_ENV } from "../src/lib/workspace/env";

describe("standalone dashboard automation actions", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function projectWith(automationsToml?: string): string {
    const dir = join(tmpdir(), `auto-manual-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, ".devintern-code"), { recursive: true });
    if (automationsToml !== undefined) {
      writeFileSync(join(dir, ".devintern-code", "automations.toml"), automationsToml, "utf8");
    }
    dirs.push(dir);
    return dir;
  }

  test("lists automations from the project's automations.toml", () => {
    const dir = projectWith(`
[[automations]]
id = "dependency-health"
enabled = true
interval = "1d"
prompt = "Inspect dependency health."

[[automations]]
id = "weekly-grooming"
enabled = false
cron = "0 9 * * 1"
prompt = "Groom flaky tests."
`);
    const actions = loadStandaloneAutomationActions(dir);
    const list = actions.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: "dependency-health", enabled: true, interval: "1d" });
    expect(list[1]).toMatchObject({ id: "weekly-grooming", enabled: false, cron: "0 9 * * 1" });
  });

  test("returns an empty list without a config file", () => {
    const actions = loadStandaloneAutomationActions(projectWith());
    expect(actions.list()).toEqual([]);
  });

  test("trigger spawns the CLI pipeline with the manual origin in the project dir", async () => {
    const dir = projectWith(`
[[automations]]
id = "dependency-health"
enabled = true
interval = "1d"
prompt = "Inspect dependency health."
`);
    const spawned: { id: string; cwd: string; env: Record<string, string | undefined> }[] = [];
    const actions = loadStandaloneAutomationActions(dir, {
      spawnRun: (automation, context) => {
        spawned.push({ id: automation.id, cwd: context.cwd, env: context.env });
        return { completion: Promise.resolve(true), terminate() {} };
      },
    });

    expect(await actions.trigger("dependency-health")).toEqual({ ok: true });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].id).toBe("dependency-health");
    expect(spawned[0].cwd).toBe(dir);
    expect(spawned[0].env.DEVINTERN_RUN_ORIGIN).toBe("manual");
    expect(spawned[0].env.DEVINTERN_AUTOMATION_ID).toBe("dependency-health");
  });

  test("trigger re-validates the config and refuses unknown or disabled automations", async () => {
    const dir = projectWith(`
[[automations]]
id = "dependency-health"
enabled = true
interval = "1d"
prompt = "Inspect dependency health."

[[automations]]
id = "weekly-grooming"
enabled = false
cron = "0 9 * * 1"
prompt = "Groom flaky tests."
`);
    const actions = loadStandaloneAutomationActions(dir, {
      spawnRun: () => ({ completion: Promise.resolve(true), terminate() {} }),
    });

    expect(await actions.trigger("nope")).toEqual({
      ok: false,
      reason: 'automation "nope" is not configured',
    });
    expect(await actions.trigger("weekly-grooming")).toMatchObject({
      ok: false,
    });
  });

  test("trigger pins pipeline_file against the project dir", async () => {
    const dir = projectWith(`
[[automations]]
id = "pipeline-run"
enabled = true
interval = "1d"
prompt = "Use a custom pipeline."
pipeline_file = "pipelines/custom.json"
`);
    const spawned: Record<string, string | undefined>[] = [];
    const actions = loadStandaloneAutomationActions(dir, {
      spawnRun: (_automation, context) => {
        spawned.push(context.env);
        return { completion: Promise.resolve(true), terminate() {} };
      },
    });

    expect(await actions.trigger("pipeline-run")).toEqual({ ok: true });
    expect(spawned[0][WORKSPACE_PIPELINE_AUTOMATION_ENV]).toBe(
      join(dir, "pipelines", "custom.json"),
    );
  });

  test("trigger clears a stale pipeline env when the automation has none", async () => {
    const dir = projectWith(`
[[automations]]
id = "plain-run"
enabled = true
interval = "1d"
prompt = "No pipeline override."
`);
    const previous = process.env[WORKSPACE_PIPELINE_AUTOMATION_ENV];
    process.env[WORKSPACE_PIPELINE_AUTOMATION_ENV] = "/tmp/stale-automation-pipeline.json";
    try {
      const spawned: Record<string, string | undefined>[] = [];
      const actions = loadStandaloneAutomationActions(dir, {
        spawnRun: (_automation, context) => {
          spawned.push(context.env);
          return { completion: Promise.resolve(true), terminate() {} };
        },
      });

      expect(await actions.trigger("plain-run")).toEqual({ ok: true });
      expect(spawned[0][WORKSPACE_PIPELINE_AUTOMATION_ENV]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[WORKSPACE_PIPELINE_AUTOMATION_ENV];
      else process.env[WORKSPACE_PIPELINE_AUTOMATION_ENV] = previous;
    }
  });

  test("workerTaskArgs still defaults to --create-pr for manual pipeline parity", () => {
    expect(workerTaskArgs()).toEqual(["--create-pr"]);
  });
});
