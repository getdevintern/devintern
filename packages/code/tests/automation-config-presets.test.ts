import { describe, expect, test } from "bun:test";

import { parseAutomationConfig, parseAutomationEntries } from "../src/lib/automation-config";

function parseError(toml: string): string {
  try {
    parseAutomationConfig(toml);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("automation configuration: presets", () => {
  test("parses a preset entry with the default output mode and no prompt", () => {
    const entries = parseAutomationConfig(`
[[automations]]
id = "docs-drift"
enabled = true
preset = "docs-drift-guard"
cron = "0 5 * * *"
`);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.preset).toBe("docs-drift-guard");
    expect(entries[0]?.outputMode).toBe("ticket");
    expect(entries[0]?.prompt).toBeUndefined();
  });

  test("honors an explicit supported output mode", () => {
    const entries = parseAutomationConfig(`
[[automations]]
id = "docs-drift-pr"
enabled = true
preset = "docs-drift-guard"
output_mode = "pull_request"
interval = "1d"
`);
    expect(entries[0]?.outputMode).toBe("pull_request");
  });

  test("rejects unknown presets with the known list", () => {
    const message = parseError(`
[[automations]]
id = "drift"
enabled = true
preset = "tidy-docs"
cron = "0 5 * * *"
`);
    expect(message).toContain('preset "tidy-docs" is not a known automation preset');
    expect(message).toContain("docs-drift-guard");
  });

  test("rejects unsupported output modes for the preset", () => {
    const message = parseError(`
[[automations]]
id = "drift"
enabled = true
preset = "docs-drift-guard"
output_mode = "carrier-pigeon"
cron = "0 5 * * *"
`);
    expect(message).toContain(
      'output_mode "carrier-pigeon" is not supported by preset "docs-drift-guard"',
    );
  });

  test("rejects combining prompt and preset", () => {
    const message = parseError(`
[[automations]]
id = "drift"
enabled = true
preset = "docs-drift-guard"
prompt = "custom"
cron = "0 5 * * *"
`);
    expect(message).toContain("cannot combine prompt and preset");
  });

  test("preset entries do not need a prompt but still need a schedule", () => {
    const message = parseError(`
[[automations]]
id = "drift"
enabled = true
preset = "docs-drift-guard"
`);
    expect(message).not.toContain("prompt is required");
    expect(message).toContain("exactly one of cron or interval");
  });

  test("validates doc_paths overrides", () => {
    const message = parseError(`
[[automations]]
id = "drift"
enabled = true
preset = "docs-drift-guard"
cron = "0 5 * * *"
doc_paths = ["/etc", "../secrets", "a\\\\b", "", 42]
`);
    expect(message).toContain('must be repo-relative (no leading "/")');
    expect(message).toContain("traverse outside the repository");
    expect(message).toContain("must use forward slashes");
    expect(message).toContain("doc_paths entries must be non-empty strings");
  });

  test("accepts valid doc_paths and baseline_sha", () => {
    const entries = parseAutomationConfig(`
[[automations]]
id = "drift"
enabled = true
preset = "docs-drift-guard"
cron = "0 5 * * *"
doc_paths = ["guides/*.md", "handbook.md"]
baseline_sha = "ABCDEF1234567890"
`);
    expect(entries[0]?.docPaths).toEqual(["guides/*.md", "handbook.md"]);
    expect(entries[0]?.baselineSha).toBe("abcdef1234567890");
  });

  test("rejects malformed baseline_sha values", () => {
    const message = parseError(`
[[automations]]
id = "drift"
enabled = true
preset = "docs-drift-guard"
cron = "0 5 * * *"
baseline_sha = "not-a-sha!"
`);
    expect(message).toContain("baseline_sha must be a git commit SHA");
  });

  test("an invalid preset entry is dropped while other entries still parse", () => {
    const result = parseAutomationEntries(
      [
        {
          id: "broken",
          enabled: true,
          preset: "nope",
          cron: "0 5 * * *",
        },
        {
          id: "fine",
          enabled: true,
          prompt: "say hi",
          interval: "6h",
        },
      ],
      { sourceLabel: "test" },
    );
    expect(result.errors.join("\n")).toContain('preset "nope" is not a known automation preset');
    expect(result.automations.map((entry) => entry.id)).toEqual(["fine"]);
  });
});
