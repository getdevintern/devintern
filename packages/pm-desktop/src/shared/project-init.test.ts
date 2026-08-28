import { describe, expect, test } from "bun:test";
import {
  applyPmTrackerDefaults,
  missingRequiredPmFields,
  PM_TRACKER_SETUP,
} from "@getdevintern/pm/init-shared";

describe("setup field helpers (shared with wizard UI)", () => {
  test("markdown applies default tasks dir and has no missing required fields", () => {
    const values = applyPmTrackerDefaults("markdown", {});
    expect(values.MARKDOWN_TASKS_DIR).toBe(".devintern-pm/tasks");
    expect(missingRequiredPmFields("markdown", values)).toEqual([]);
  });

  test("jira reports missing required credentials", () => {
    expect(missingRequiredPmFields("jira", {})).toEqual([
      "JIRA_BASE_URL",
      "JIRA_EMAIL",
      "JIRA_API_TOKEN",
      "JIRA_DEFAULT_PROJECT_KEY",
    ]);
    expect(
      missingRequiredPmFields("jira", {
        JIRA_BASE_URL: "https://acme.atlassian.net",
        JIRA_EMAIL: "d@a.com",
        JIRA_API_TOKEN: "tok",
        JIRA_DEFAULT_PROJECT_KEY: "PROJ",
      }),
    ).toEqual([]);
  });

  test("every tracker in SETUP is reachable from the desktop menu order", () => {
    expect(Object.keys(PM_TRACKER_SETUP).length).toBeGreaterThanOrEqual(8);
    // GitLab must appear alongside the other remote trackers so the setup
    // wizard and tracker switcher pick it up without desktop-side changes.
    expect(Object.keys(PM_TRACKER_SETUP)).toContain("gitlab");
  });
});
