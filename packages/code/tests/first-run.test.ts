import { describe, expect, test } from "bun:test";
import { ensureTrackerEnvConfigured, missingTrackerEnv } from "../src/lib/first-run";

const jiraEnv = () => ({
  TASK_TRACKER: "jira",
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_EMAIL: "dev@acme.com",
  JIRA_API_TOKEN: "secret",
});

describe("missingTrackerEnv", () => {
  test("lists missing required vars for the active tracker", () => {
    const result = missingTrackerEnv({ TASK_TRACKER: "linear" });
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe("Linear");
    expect(result[0].missing).toEqual(["LINEAR_API_KEY"]);
  });

  test("empty when everything required is set", () => {
    expect(missingTrackerEnv(jiraEnv())).toEqual([]);
  });

  test("flags an unknown tracker id", () => {
    const result = missingTrackerEnv({ TASK_TRACKER: "bogus" });
    expect(result[0].missing).toEqual(["TASK_TRACKER"]);
  });
});

describe("ensureTrackerEnvConfigured", () => {
  test("ready without prompting when credentials are present", async () => {
    let prompted = false;
    const outcome = await ensureTrackerEnvConfigured({
      env: jiraEnv(),
      stdinIsTTY: true,
      prompt: async () => {
        prompted = true;
        return "";
      },
    });
    expect(outcome).toBe("ready");
    expect(prompted).toBe(false);
  });

  test("failed without prompting in a non-interactive session", async () => {
    const outcome = await ensureTrackerEnvConfigured({
      env: { TASK_TRACKER: "jira" },
      stdinIsTTY: false,
      automated: false,
    });
    expect(outcome).toBe("failed");
  });

  test("failed without prompting in an automated environment", async () => {
    const outcome = await ensureTrackerEnvConfigured({
      env: { TASK_TRACKER: "jira" },
      stdinIsTTY: true,
      automated: true,
    });
    expect(outcome).toBe("failed");
  });

  test("declining the offer fails the run", async () => {
    const outcome = await ensureTrackerEnvConfigured({
      env: { TASK_TRACKER: "jira" },
      stdinIsTTY: true,
      prompt: async () => "n",
    });
    expect(outcome).toBe("failed");
  });

  test("completing the wizard reloads env and reports ready", async () => {
    const mutableEnv: Record<string, string | undefined> = { TASK_TRACKER: "jira" };
    let wizardRan = false;
    let reloaded = false;
    const outcome = await ensureTrackerEnvConfigured({
      env: mutableEnv,
      stdinIsTTY: true,
      prompt: async () => "y",
      runWizard: async () => {
        wizardRan = true;
        mutableEnv.JIRA_BASE_URL = "https://acme.atlassian.net";
        mutableEnv.JIRA_EMAIL = "dev@acme.com";
        mutableEnv.JIRA_API_TOKEN = "secret";
      },
      reloadEnv: () => {
        reloaded = true;
      },
    });
    expect(wizardRan).toBe(true);
    expect(reloaded).toBe(true);
    expect(outcome).toBe("ready");
  });

  test("wizard that leaves credentials missing still fails", async () => {
    const outcome = await ensureTrackerEnvConfigured({
      env: { TASK_TRACKER: "jira" },
      stdinIsTTY: true,
      prompt: async () => "",
      runWizard: async () => {},
    });
    expect(outcome).toBe("failed");
  });
});
