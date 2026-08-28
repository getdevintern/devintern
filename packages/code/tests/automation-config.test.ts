import { describe, expect, test } from "bun:test";

import {
  nextScheduleOccurrence,
  parseAutomationConfig,
  parseAutomationInterval,
  parseCronOrIntervalSchedule,
} from "../src/lib/automation-config";
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
});

describe("parseCronOrIntervalSchedule", () => {
  test("normalizes a valid cron schedule", () => {
    const errors: string[] = [];
    const schedule = parseCronOrIntervalSchedule({ cron: " 0 3 * * * " }, { label: "[x]" }, errors);
    expect(errors).toEqual([]);
    expect(schedule).toEqual({ cron: "0 3 * * *", interval: undefined, intervalMs: undefined });
  });

  test("honors renamed keys in error messages", () => {
    const errors: string[] = [];
    parseCronOrIntervalSchedule(
      {},
      {
        label: "[workspace]",
        cronKey: "conflict_resolution_cron",
        intervalKey: "conflict_resolution_interval",
      },
      errors,
    );
    expect(errors).toEqual([
      "[workspace] must set exactly one of conflict_resolution_cron or conflict_resolution_interval.",
    ]);
  });

  test("collects every schedule problem", () => {
    const errors: string[] = [];
    const schedule = parseCronOrIntervalSchedule(
      { cron: "bad", interval: "2w" },
      { label: "[[automations]][0]" },
      errors,
    );
    expect(schedule).toBeUndefined();
    expect(errors).toEqual([
      "[[automations]][0] must set exactly one of cron or interval.",
      "[[automations]][0].cron must be a five-field cron expression.",
      "[[automations]][0].interval must use a positive duration such as 15m, 6h, or 1d.",
    ]);
  });
});

describe("nextScheduleOccurrence", () => {
  test("interval schedules are relative to the given time", () => {
    const start = 1_750_000_000_000;
    expect(nextScheduleOccurrence({ interval: "6h", intervalMs: 6 * 3_600_000 }, start)).toBe(
      start + 6 * 3_600_000,
    );
  });

  test("cron occurrences are strictly after the given time", () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = nextScheduleOccurrence({ cron: "0 3 * * *" }, start);
    expect(next).toBeGreaterThan(start);
    expect(next - start).toBeLessThanOrEqual(29 * 3_600_000);
  });

  test("throws without any schedule", () => {
    expect(() => nextScheduleOccurrence({}, 0)).toThrow(/no cron expression/);
  });
});
