import { describe, expect, test } from "bun:test";

import { parseAutomationConfig, parseAutomationInterval } from "../src/lib/automation-config";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

describe("automation configuration", () => {
  test("parses cron and interval entries including multiline prompts", () => {
    const entries = parseAutomationConfig(`
[[automations]]
id = "daily-review"
enabled = true
cron = "0 9 * * 1-5"
prompt = """Review the repository.
Fix one issue."""

[[automations]]
id = "maintenance"
enabled = false
interval = "6h"
repo = "api"
prompt = "Apply one safe maintenance improvement"
`);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.prompt).toContain("\n");
    expect(entries[1]?.intervalMs).toBe(6 * 60 * 60 * 1000);
    expect(entries[1]?.enabled).toBe(false);
    expect(entries[1]?.repo).toBe("api");
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

  test("collects duplicate, prompt, and schedule errors", () => {
    let message = "";
    try {
      parseAutomationConfig(`
[[automations]]
id = "same"
enabled = "yes"
cron = "bad"
interval = "2w"
prompt = ""

[[automations]]
id = "same"
enabled = true
prompt = "ok"
`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Duplicate automation id "same"');
    expect(message).toContain("enabled must be a boolean");
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
interval = "1h"
prompt = "work"
repo = "web"
`),
    ).toThrow(/does not match any \[\[repos\]\] name/);
  });

  test("rejects the kind selector — scheduled estimation lives in [[estimations]]", () => {
    let message = "";
    try {
      parseAutomationConfig(`
[[automations]]
id = "groom"
enabled = true
interval = "1d"
kind = "estimate"
prompt = "estimate stories"
`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("kind is not supported");
    expect(message).toContain("[[estimations]]");
  });
});
