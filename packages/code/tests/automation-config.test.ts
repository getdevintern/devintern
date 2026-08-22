import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  parseAutomationConfig,
  parseAutomationInterval,
  resolvePmTrackerConfig,
  validateAutomationProjects,
} from "../src/lib/automation-config";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

describe("automation configuration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("parses cron and interval entries including multiline prompts", () => {
    const entries = parseAutomationConfig(`
[[automations]]
id = "daily-review"
enabled = true
action = "headless"
cron = "0 9 * * 1-5"
prompt = """Review the repository.
Fix one issue."""

[[automations]]
id = "planning"
enabled = false
action = "create_ticket"
interval = "6h"
tracker_project = "ENG"
prompt = "Draft the next maintenance ticket"
`);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.prompt).toContain("\n");
    expect(entries[1]?.intervalMs).toBe(6 * 60 * 60 * 1000);
    expect(entries[1]?.enabled).toBe(false);
  });

  test("accepts only documented positive duration units", () => {
    expect(parseAutomationInterval("15m")).toBe(900_000);
    expect(parseAutomationInterval("1d")).toBe(86_400_000);
    expect(parseAutomationInterval("30s")).toBeNull();
    expect(parseAutomationInterval("0h")).toBeNull();
  });

  test("rejects unsafe intervals and dates outside the runtime range", () => {
    expect(parseAutomationInterval("9007199254740991d", 0)).toBeNull();
    expect(parseAutomationInterval("100000000d", 0)).toBe(8_640_000_000_000_000);
    expect(parseAutomationInterval("100000001d", 0)).toBeNull();
    expect(parseAutomationInterval("1d", 8_640_000_000_000_000)).toBeNull();
  });

  test("collects duplicate, action, prompt, and schedule errors", () => {
    let message = "";
    try {
      parseAutomationConfig(`
[[automations]]
id = "same"
enabled = "yes"
action = "email"
cron = "bad"
interval = "2w"
prompt = ""

[[automations]]
id = "same"
enabled = true
action = "headless"
prompt = "ok"
`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Duplicate automation id "same"');
    expect(message).toContain("enabled must be a boolean");
    expect(message).toContain("action must be");
    expect(message).toContain("prompt is required");
    expect(message).toContain("exactly one of cron or interval");
  });

  test("workspace validation rejects unknown repositories", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "https://github.com/acme/api.git"

[[automations]]
id = "other"
enabled = true
action = "headless"
interval = "1h"
prompt = "work"
repo = "web"
`),
    ).toThrow(/does not match any \[\[repos\]\] name/);
  });

  test("create_ticket requires an explicit or configured default project", () => {
    const entries = parseAutomationConfig(`
[[automations]]
id = "ticket"
enabled = true
action = "create_ticket"
interval = "1d"
prompt = "plan"
`);
    expect(() => validateAutomationProjects(entries, { backend: { type: "markdown" } })).toThrow(
      /no default project/,
    );
    expect(() =>
      validateAutomationProjects(entries, {
        backend: { type: "linear" },
        linear: { apiKey: "test", defaultTeamKey: "PLAT" },
      }),
    ).not.toThrow();
  });

  test("validates against PM's tracker without changing the worker tracker", async () => {
    const dir = join(tmpdir(), `automation-pm-config-${Date.now()}-${Math.random()}`);
    tempDirs.push(dir);
    mkdirSync(join(dir, ".devintern-pm"), { recursive: true });
    writeFileSync(
      join(dir, ".devintern-pm", ".env"),
      ["TASK_TRACKER=linear", "LINEAR_API_KEY=test-key"].join("\n"),
    );
    const previousTracker = process.env.TASK_TRACKER;
    const previousProject = process.env.JIRA_DEFAULT_PROJECT_KEY;
    process.env.TASK_TRACKER = "jira";
    process.env.JIRA_DEFAULT_PROJECT_KEY = "WORKER";

    try {
      const config = await resolvePmTrackerConfig(dir);
      expect(config.backend.type).toBe("linear");
      expect(() =>
        validateAutomationProjects(
          parseAutomationConfig(`
[[automations]]
id = "ticket"
enabled = true
action = "create_ticket"
interval = "1d"
prompt = "plan"
`),
          config,
        ),
      ).toThrow(/no default project/);
      expect(process.env.TASK_TRACKER).toBe("jira");
      expect(process.env.JIRA_DEFAULT_PROJECT_KEY).toBe("WORKER");
    } finally {
      if (previousTracker === undefined) delete process.env.TASK_TRACKER;
      else process.env.TASK_TRACKER = previousTracker;
      if (previousProject === undefined) delete process.env.JIRA_DEFAULT_PROJECT_KEY;
      else process.env.JIRA_DEFAULT_PROJECT_KEY = previousProject;
    }
  });
});
