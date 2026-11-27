import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applyMigratedConfig } from "./lib/init";

const template = readFileSync(join(import.meta.dir, ".env.example"), "utf8");

function activeLine(content: string, key: string): string | undefined {
  return content.split("\n").find((line) => line.startsWith(`${key}=`));
}

describe("applyMigratedConfig", () => {
  test("rewrites the settings, not the comments that mention them", () => {
    const result = applyMigratedConfig(template, {
      jiraBaseUrl: "https://acme.atlassian.net",
      jiraEmail: "me@acme.dev",
      jiraApiToken: "tok",
      agentHarness: "codex",
      agentCliPath: "/opt/bin/codex",
    });
    expect(activeLine(result, "JIRA_BASE_URL")).toBe("JIRA_BASE_URL=https://acme.atlassian.net");
    expect(activeLine(result, "JIRA_EMAIL")).toBe("JIRA_EMAIL=me@acme.dev");
    expect(activeLine(result, "JIRA_API_TOKEN")).toBe("JIRA_API_TOKEN=tok");
    expect(activeLine(result, "AGENT_HARNESS")).toBe("AGENT_HARNESS=codex");
    expect(activeLine(result, "AGENT_CLI_PATH")).toBe("AGENT_CLI_PATH=/opt/bin/codex");
    // Comments stay as shipped.
    expect(result).toContain("→ JIRA_BASE_URL=https://your-org.atlassian.net");
  });

  test("writes `$` sequences in values literally", () => {
    const result = applyMigratedConfig(template, {
      jiraBaseUrl: "",
      jiraEmail: "",
      jiraApiToken: "a$&b$'c",
      agentHarness: "",
      agentCliPath: "",
    });
    expect(activeLine(result, "JIRA_API_TOKEN")).toBe("JIRA_API_TOKEN=a$&b$'c");
  });

  test("leaves the template alone without migrated values", () => {
    const empty = {
      jiraBaseUrl: "",
      jiraEmail: "",
      jiraApiToken: "",
      agentHarness: "",
      agentCliPath: "",
    };
    expect(applyMigratedConfig(template, empty)).toBe(template);
  });
});
