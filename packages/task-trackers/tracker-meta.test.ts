import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseTrackerConfigFromEnv } from "./src/config/load-tracker-config.ts";
import {
  TRACKER_IDS,
  TRACKER_META,
  getMissingRequiredEnv,
  getProjectKeyEnvVar,
  getTrackerDisplayName,
  isTrackerConfigured,
  isTrackerId,
  listConfiguredTrackers,
} from "./src/config/tracker-meta.ts";

describe("tracker-meta", () => {
  test("isTrackerId accepts known ids only", () => {
    expect(isTrackerId("jira")).toBe(true);
    expect(isTrackerId("azure-devops")).toBe(true);
    expect(isTrackerId("not-a-tracker")).toBe(false);
  });

  test("getTrackerDisplayName returns human-readable names", () => {
    expect(getTrackerDisplayName("jira")).toBe("Jira");
    expect(getTrackerDisplayName("github")).toBe("GitHub Issues");
    expect(getTrackerDisplayName("mystery")).toBe("mystery");
  });

  test("listConfiguredTrackers returns only fully configured trackers", () => {
    const env = {
      TASK_TRACKER: "jira",
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "a@b.com",
      JIRA_API_TOKEN: "tok",
      JIRA_DEFAULT_PROJECT_KEY: "ACME",
      LINEAR_API_KEY: "lin_api_x",
      // Incomplete GitHub — missing GITHUB_REPO
      GITHUB_TOKEN: "ghp_x",
    };

    const configured = listConfiguredTrackers(env);
    expect(configured.map((t) => t.id)).toEqual(["jira", "linear"]);
    expect(configured[0]?.displayName).toBe("Jira");
    expect(configured[1]?.projectKeyEnv).toBe("LINEAR_DEFAULT_TEAM_KEY");
  });

  test("trello is configured with token alone (bundled API key)", () => {
    expect(isTrackerConfigured("trello", { TRELLO_API_TOKEN: "tok" })).toBe(true);
    expect(isTrackerConfigured("trello", {})).toBe(false);
  });

  test("jira requires default project key", () => {
    expect(
      isTrackerConfigured("jira", {
        JIRA_BASE_URL: "https://acme.atlassian.net",
        JIRA_EMAIL: "a@b.com",
        JIRA_API_TOKEN: "tok",
      }),
    ).toBe(false);
    expect(
      isTrackerConfigured("jira", {
        JIRA_BASE_URL: "https://acme.atlassian.net",
        JIRA_EMAIL: "a@b.com",
        JIRA_API_TOKEN: "tok",
        JIRA_DEFAULT_PROJECT_KEY: "ACME",
      }),
    ).toBe(true);
  });

  test("getProjectKeyEnvVar returns per-tracker project env", () => {
    expect(getProjectKeyEnvVar("jira")).toBe("JIRA_DEFAULT_PROJECT_KEY");
    expect(getProjectKeyEnvVar("linear")).toBe("LINEAR_DEFAULT_TEAM_KEY");
    expect(getProjectKeyEnvVar("markdown")).toBeUndefined();
    expect(getProjectKeyEnvVar("nope")).toBeUndefined();
  });

  test("empty string values do not count as configured", () => {
    expect(isTrackerConfigured("linear", { LINEAR_API_KEY: "  " })).toBe(false);
  });

  test("getMissingRequiredEnv lists blank keys from TRACKER_META", () => {
    expect(
      getMissingRequiredEnv("jira", {
        JIRA_BASE_URL: "https://acme.atlassian.net",
        JIRA_EMAIL: "a@b.com",
        JIRA_API_TOKEN: "tok",
      }),
    ).toEqual(["JIRA_DEFAULT_PROJECT_KEY"]);
    expect(getMissingRequiredEnv("linear", { LINEAR_API_KEY: "x" })).toEqual([]);
    expect(getMissingRequiredEnv("unknown", {})).toEqual([]);
  });
});

describe("TRACKER_META ↔ parseTrackerConfigFromEnv", () => {
  const keys = ["TASK_TRACKER", ...TRACKER_IDS.flatMap((id) => [...TRACKER_META[id].requiredEnv])];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("parseTrackerConfigFromEnv rejects missing TRACKER_META.requiredEnv (non-markdown)", () => {
    for (const id of TRACKER_IDS) {
      if (id === "markdown") continue;
      process.env.TASK_TRACKER = id;
      for (const key of TRACKER_META[id].requiredEnv) {
        delete process.env[key];
      }
      expect(() => parseTrackerConfigFromEnv()).toThrow();
    }
  });
});
