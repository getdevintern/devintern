import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadStandaloneAutomationActions } from "../src/lib/automation/manual";
import { automationRunEnv } from "../src/lib/automation/acquirer";
import { workerTaskArgs } from "../src/lib/acquirers/task-polling";
import { SKIP_PROJECT_ENV_ENV, WORKER_SUBPROCESS_ENV } from "../src/lib/config/config-dir";

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
    // The child must skip the checkout's local `.env` so the composed
    // entry selection cannot be overridden on reload — via the narrow skip
    // marker, NOT the worker-subprocess marker, which would relocate the
    // child's runtime state/license session to the workspace state dir.
    expect(spawned[0].env[SKIP_PROJECT_ENV_ENV]).toBe("1");
  });

  test("the child cannot reload dropped CLI-path/model over a pinned harness", async () => {
    const dir = projectWith(`
[[automations]]
id = "dependency-health"
enabled = true
interval = "1d"
prompt = "Inspect dependency health."
harness = "codex"
`);
    writeFileSync(
      join(dir, ".devintern-code", ".env"),
      "AGENT_HARNESS=claude-code\nAGENT_CLI_PATH=/custom/claude\nAGENT_MODEL=workspace-model\n",
    );

    const previous = {
      AGENT_HARNESS: process.env.AGENT_HARNESS,
      AGENT_CLI_PATH: process.env.AGENT_CLI_PATH,
      AGENT_MODEL: process.env.AGENT_MODEL,
    };
    // The dashboard loads the project `.env` before triggering, so its own
    // process env carries the primary harness's CLI path and model.
    process.env.AGENT_HARNESS = "claude-code";
    process.env.AGENT_CLI_PATH = "/custom/claude";
    process.env.AGENT_MODEL = "workspace-model";

    let contextEnv: Record<string, string | undefined> = {};
    const actions = loadStandaloneAutomationActions(dir, {
      spawnRun: (_automation, context) => {
        contextEnv = context.env;
        return { completion: Promise.resolve(true), terminate() {} };
      },
    });
    try {
      expect(await actions.trigger("dependency-health")).toEqual({ ok: true });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const automation = {
      id: "dependency-health",
      enabled: true,
      prompt: "Inspect dependency health.",
      interval: "1d",
      intervalMs: 86_400_000,
      harness: "codex",
    };
    // The real spawn composes the child env via automationRunEnv: the pin
    // changes the harness, so the primary's AGENT_CLI_PATH/AGENT_MODEL drop.
    const childEnv = automationRunEnv(automation, contextEnv, "manual");
    expect(childEnv.AGENT_HARNESS).toBe("codex");
    expect(childEnv.AGENT_CLI_PATH).toBeUndefined();
    expect(childEnv.AGENT_MODEL).toBeUndefined();

    const bootstrapPath = join(__dirname, "..", "src", "lib", "cli", "bootstrap.ts");
    const script = `import { loadEnvironment } from ${JSON.stringify(bootstrapPath)}; loadEnvironment(); console.log(JSON.stringify({ cliPath: process.env.AGENT_CLI_PATH ?? null, model: process.env.AGENT_MODEL ?? null, harness: process.env.AGENT_HARNESS ?? null }));`;

    // With the skip marker, loadEnvironment() is skipped and the dropped keys
    // stay dropped.
    const pinned = spawnSync("bun", ["-e", script], {
      cwd: dir,
      env: { ...childEnv, SENTRY_DISABLED: "1" },
      encoding: "utf8",
    });
    expect(pinned.status).toBe(0);
    expect(JSON.parse(pinned.stdout.trim())).toEqual({
      cliPath: null,
      model: null,
      harness: "codex",
    });

    // Control: without either skip marker the checkout `.env` repopulates both
    // keys — the cross-harness leak this fix closes. (Both markers must be
    // removed because the test process itself may inherit the worker marker.)
    const leakyEnv = { ...childEnv };
    delete leakyEnv[SKIP_PROJECT_ENV_ENV];
    delete leakyEnv[WORKER_SUBPROCESS_ENV];
    const leaky = spawnSync("bun", ["-e", script], {
      cwd: dir,
      env: { ...leakyEnv, SENTRY_DISABLED: "1" },
      encoding: "utf8",
    });
    expect(leaky.status).toBe(0);
    expect(JSON.parse(leaky.stdout.trim())).toEqual({
      cliPath: "/custom/claude",
      model: "workspace-model",
      harness: "codex",
    });
  });

  test("the skip marker keeps runtime state and the auth session in the project config dir", () => {
    const dir = projectWith(`
[[automations]]
id = "dependency-health"
enabled = true
interval = "1d"
prompt = "Inspect dependency health."
`);
    const workspaceDir = join(dir, "workspace-home");
    const bootstrapPath = join(__dirname, "..", "src", "lib", "cli", "bootstrap.ts");
    const configDirPath = join(__dirname, "..", "src", "lib", "config", "config-dir.ts");
    const script = `import { resolveRuntimeStateDir } from ${JSON.stringify(configDirPath)}; import { loadSupabaseConfig } from ${JSON.stringify(bootstrapPath)}; console.log(JSON.stringify({ runtime: resolveRuntimeStateDir(), auth: loadSupabaseConfig().sessionFilePath }));`;

    const skipEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DEVINTERN_WORKSPACE_DIR: workspaceDir,
      [SKIP_PROJECT_ENV_ENV]: "1",
      SENTRY_DISABLED: "1",
    };
    delete skipEnv[WORKER_SUBPROCESS_ENV];

    // The manual spawn's narrow marker: state and auth stay in the project.
    const skip = spawnSync("bun", ["-e", script], { cwd: dir, env: skipEnv, encoding: "utf8" });
    expect(skip.status).toBe(0);
    expect(JSON.parse(skip.stdout.trim())).toEqual({
      runtime: join(dir, ".devintern-code"),
      auth: join(dir, ".devintern-code", ".auth-session.json"),
    });

    // Control: the broad worker marker relocates both to the workspace state
    // dir — the blast radius this fix avoids by not overloading it.
    const workerEnv: NodeJS.ProcessEnv = { ...skipEnv };
    delete workerEnv[SKIP_PROJECT_ENV_ENV];
    workerEnv[WORKER_SUBPROCESS_ENV] = "1";
    const worker = spawnSync("bun", ["-e", script], {
      cwd: dir,
      env: workerEnv,
      encoding: "utf8",
    });
    expect(worker.status).toBe(0);
    expect(JSON.parse(worker.stdout.trim())).toEqual({
      runtime: join(workspaceDir, "state", "code"),
      auth: join(workspaceDir, "state", "code", ".auth-session.json"),
    });
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

  test("workerTaskArgs still defaults to --create-pr for manual pipeline parity", () => {
    expect(workerTaskArgs()).toEqual(["--create-pr"]);
  });
});
