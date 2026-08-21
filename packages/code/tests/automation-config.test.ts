import { describe, expect, test } from "bun:test";

import {
  parseAutomationConfig,
  parseAutomationInterval,
  validateAutomationProjects,
} from "../src/lib/automation-config";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

describe("automation configuration", () => {
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
    expect(() => validateAutomationProjects(entries, {})).toThrow(/no default project/);
    expect(() =>
      validateAutomationProjects(entries, { JIRA_DEFAULT_PROJECT_KEY: "ENG" }),
    ).not.toThrow();
  });
});
