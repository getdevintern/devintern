import { describe, expect, test } from "bun:test";
import { PM_TRACKER_SETUP } from "@getdevintern/pm/init-shared";
import {
  firstWizardStep,
  prefilledValues,
  reuseSourceLabel,
  reusedSecretKeys,
} from "./ProjectSetupWizard.helpers.ts";
import type { ProjectInitInspect } from "../../../shared/ipc-contract.ts";

function makeInspect(overrides: Partial<ProjectInitInspect> = {}): ProjectInitInspect {
  return {
    configExists: false,
    envPath: "/repo/.devintern-pm/.env",
    reusableFromCode: null,
    trackers: [],
    currentEnv: {},
    currentSecretKeys: [],
    ...overrides,
  };
}

describe("ProjectSetupWizard helpers", () => {
  describe("firstWizardStep", () => {
    test("init mode: starts at overwrite when config already exists", () => {
      const inspect = makeInspect({ configExists: true });
      expect(firstWizardStep(inspect, "init")).toBe("overwrite");
    });

    test("init mode: starts at reuse when code credentials are available", () => {
      const inspect = makeInspect({
        reusableFromCode: {
          trackerId: "jira",
          values: { JIRA_EMAIL: "dev@acme.com" },
          secretKeys: ["JIRA_API_TOKEN"],
        },
      });
      expect(firstWizardStep(inspect, "init")).toBe("reuse");
    });

    test("init mode: starts at tracker for a fresh project", () => {
      const inspect = makeInspect();
      expect(firstWizardStep(inspect, "init")).toBe("tracker");
    });

    test("update mode: always starts at the tracker picker (skips overwrite/reuse)", () => {
      const inspect = makeInspect({
        configExists: true,
        reusableFromCode: {
          trackerId: "jira",
          values: { JIRA_EMAIL: "dev@acme.com" },
          secretKeys: ["JIRA_API_TOKEN"],
        },
      });
      expect(firstWizardStep(inspect, "update")).toBe("tracker");
    });
  });

  describe("prefilledValues", () => {
    test("pulls existing credential values for the chosen tracker from the env", () => {
      const inspect = makeInspect({
        currentEnv: {
          TASK_TRACKER: "markdown",
          MARKDOWN_TASKS_DIR: ".devintern-pm/tasks",
          JIRA_BASE_URL: "https://acme.atlassian.net",
          JIRA_EMAIL: "dev@acme.com",
          JIRA_API_TOKEN: "existing-tok",
          JIRA_DEFAULT_PROJECT_KEY: "ACME",
        },
      });
      const values = prefilledValues(inspect, "jira");
      expect(values).toEqual({
        JIRA_BASE_URL: "https://acme.atlassian.net",
        JIRA_EMAIL: "dev@acme.com",
        JIRA_API_TOKEN: "existing-tok",
        JIRA_DEFAULT_PROJECT_KEY: "ACME",
      });
      // Markdown-only key is not pulled for the jira tracker.
      expect(values.MARKDOWN_TASKS_DIR).toBeUndefined();
    });

    test("omits blank/whitespace values so existing optional values are preserved", () => {
      const inspect = makeInspect({
        currentEnv: {
          LINEAR_API_KEY: "  ",
          LINEAR_DEFAULT_TEAM_KEY: "ENG",
        },
      });
      const values = prefilledValues(inspect, "linear");
      // Blank API key is dropped (user will re-enter); team key is kept.
      expect(values.LINEAR_API_KEY).toBeUndefined();
      expect(values.LINEAR_DEFAULT_TEAM_KEY).toBe("ENG");
    });

    test("returns empty for a tracker with no credentials in env yet", () => {
      const inspect = makeInspect({ currentEnv: { TASK_TRACKER: "markdown" } });
      expect(prefilledValues(inspect, "jira")).toEqual({});
    });

    test("covers every step defined for the tracker", () => {
      const jiraKeys = (PM_TRACKER_SETUP.jira ?? []).map((s) => s.key);
      const inspect = makeInspect({
        currentEnv: Object.fromEntries(jiraKeys.map((k) => [k, `val-${k}`])),
      });
      const values = prefilledValues(inspect, "jira");
      expect(Object.keys(values).sort()).toEqual([...jiraKeys].sort());
    });
  });

  describe("reusedSecretKeys", () => {
    const inspect = makeInspect({
      reusableFromCode: {
        trackerId: "jira",
        values: { JIRA_BASE_URL: "https://acme.atlassian.net" },
        secretKeys: ["JIRA_API_TOKEN"],
      },
      reusableSource: 'DevIntern workspace (repo "app")',
      currentEnv: { JIRA_BASE_URL: "https://acme.atlassian.net" },
      currentSecretKeys: ["JIRA_API_TOKEN", "LINEAR_API_KEY"],
    });
    const jira = { JIRA_BASE_URL: "https://acme.atlassian.net" };

    test("code source: only for the tracker DevIntern Code offered", () => {
      expect(reusedSecretKeys(inspect, "code", "jira", jira)).toEqual(["JIRA_API_TOKEN"]);
      expect(reusedSecretKeys(inspect, "code", "linear", {})).toEqual([]);
      expect(reuseSourceLabel(inspect, "code")).toBe('DevIntern workspace (repo "app")');
    });

    test("project source: the current secrets of the chosen tracker", () => {
      expect(reusedSecretKeys(inspect, "project", "linear", {})).toEqual(["LINEAR_API_KEY"]);
      expect(reusedSecretKeys(inspect, "project", "github", {})).toEqual([]);
    });

    test("an edited host turns reuse off, so the secret must be typed", () => {
      const edited = { JIRA_BASE_URL: "https://attacker.example" };
      expect(reusedSecretKeys(inspect, "code", "jira", edited)).toEqual([]);
      expect(reusedSecretKeys(inspect, "project", "jira", edited)).toEqual([]);
      expect(reusedSecretKeys(inspect, "project", "jira", jira)).toEqual(["JIRA_API_TOKEN"]);
    });

    test("no source reuses nothing", () => {
      expect(reusedSecretKeys(inspect, null, "jira", jira)).toEqual([]);
    });
  });
});
