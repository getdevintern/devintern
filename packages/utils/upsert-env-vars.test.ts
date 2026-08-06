import { describe, expect, test } from "bun:test";
import { upsertEnvVars } from "./src/upsert-env-vars.ts";

describe("upsertEnvVars", () => {
  test("updates an existing assignment in place", () => {
    const result = upsertEnvVars("TASK_TRACKER=jira\nLINEAR_API_KEY=old\n", {
      TASK_TRACKER: "linear",
    });
    expect(result).toContain("TASK_TRACKER=linear");
    expect(result).toContain("LINEAR_API_KEY=old");
  });

  test("uncomments and replaces a commented key", () => {
    const result = upsertEnvVars("# LINEAR_DEFAULT_TEAM_KEY=ENG\n", {
      LINEAR_DEFAULT_TEAM_KEY: "PLAT",
    });
    expect(result).toContain("LINEAR_DEFAULT_TEAM_KEY=PLAT");
    expect(result).not.toContain("# LINEAR_DEFAULT_TEAM_KEY");
  });

  test("appends missing keys", () => {
    const result = upsertEnvVars("TASK_TRACKER=jira\n", {
      JIRA_DEFAULT_PROJECT_KEY: "ACME",
    });
    expect(result).toContain("TASK_TRACKER=jira");
    expect(result).toContain("JIRA_DEFAULT_PROJECT_KEY=ACME");
  });

  test("handles empty content", () => {
    expect(upsertEnvVars("", { TASK_TRACKER: "markdown" })).toContain("TASK_TRACKER=markdown");
  });
});
