import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AutomationStateStore } from "../src/lib/automation/state";
import {
  WORKSPACE_MANUAL_RUN_UNAVAILABLE,
  loadWorkspaceAutomationActions,
} from "../src/lib/automation/workspace-dashboard";
import type { AutomationConfig } from "../src/lib/automation/config";
import { workspaceDbPath } from "../src/lib/workspace/paths";

const CONFIG = `
[defaults]
tracker = "markdown"

[[repos]]
name = "web"
remote = "https://github.com/acme/web.git"

[[repos]]
name = "api"
remote = "https://github.com/acme/api.git"

[[automations]]
id = "nightly-deps"
enabled = true
cron = "0 3 * * *"
repo = "web"
open_pr = true
prompt = "Bump dependencies."

[[automations]]
id = "paused-sweep"
enabled = false
interval = "12h"
repo = "api"
prompt = "Sweep stale branches."
`;

describe("loadWorkspaceAutomationActions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ws-dash-automations-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists the workspace [[automations]] with durable next-due times", () => {
    writeFileSync(join(dir, "workspace.toml"), CONFIG);
    const store = new AutomationStateStore(workspaceDbPath(dir));
    store.register(
      { id: "nightly-deps", cron: "0 3 * * *" } as AutomationConfig,
      1_800_000_000_000,
    );

    const list = loadWorkspaceAutomationActions(dir).list();

    expect(list.map((item) => item.id)).toEqual(["nightly-deps", "paused-sweep"]);
    expect(list[0]).toMatchObject({
      enabled: true,
      cron: "0 3 * * *",
      repo: "web",
      openPr: true,
      prompt: "Bump dependencies.",
      nextDueAt: 1_800_000_000_000,
    });
    expect(list[1]).toMatchObject({ enabled: false, interval: "12h", repo: "api", openPr: false });
    expect(list[1].nextDueAt).toBeUndefined();
  });

  test("lists automations without next-due times before the worker ever ran", () => {
    writeFileSync(join(dir, "workspace.toml"), CONFIG);
    const list = loadWorkspaceAutomationActions(dir).list();
    expect(list).toHaveLength(2);
    expect(list.every((item) => item.nextDueAt === undefined)).toBe(true);
  });

  test("a missing or invalid workspace.toml yields an empty catalog, not an error", () => {
    expect(loadWorkspaceAutomationActions(dir).list()).toEqual([]);
    writeFileSync(join(dir, "workspace.toml"), "[[automations]\nbroken");
    expect(loadWorkspaceAutomationActions(dir).list()).toEqual([]);
  });

  test("Run now is refused: workspace runs need the worker's fleet pipeline", async () => {
    writeFileSync(join(dir, "workspace.toml"), CONFIG);
    const outcome = await loadWorkspaceAutomationActions(dir).trigger("nightly-deps");
    expect(outcome).toEqual({ ok: false, reason: WORKSPACE_MANUAL_RUN_UNAVAILABLE });
  });
});
