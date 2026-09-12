import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ANALYTICS_CONFIG_DIR_ENV,
  setAnalyticsCaptureForTests,
} from "../src/lib/observability/analytics";
import { ensureTrackerEnvConfigured, missingTrackerEnv } from "../src/lib/init/first-run";

// Snapshot the real wizard exports BEFORE any mock.module override so tests
// that stub ../src/lib/init/wizard can restore it afterwards (the namespace
// object is live — spreading it after a mock would capture the mock).
const realInitWizardExports = { ...(await import("../src/lib/init/wizard")) };

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

describe("ensureTrackerEnvConfigured analytics", () => {
  let telemetryDir: string;

  afterEach(() => {
    setAnalyticsCaptureForTests(undefined);
    delete process.env.POSTHOG_API_KEY;
    delete process.env[ANALYTICS_CONFIG_DIR_ENV];
    if (telemetryDir) rmSync(telemetryDir, { recursive: true, force: true });
    // bun test shares one module registry across test files, so a stubbed
    // init-wizard must be restored here or later files would bind the mock.
    mock.module("../src/lib/init/wizard", () => ({ ...realInitWizardExports }));
  });

  /** Pin analytics to a throwaway config dir and record captured events. */
  function stubAnalytics(): Array<{ event?: string; properties?: Record<string, unknown> }> {
    telemetryDir = mkdtempSync(join(tmpdir(), "first-run-telemetry-"));
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env[ANALYTICS_CONFIG_DIR_ENV] = telemetryDir;
    const recorded: Array<{ event?: string; properties?: Record<string, unknown> }> = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });
    return recorded;
  }

  test("declining the rescue offer emits setup_declined", async () => {
    const recorded = stubAnalytics();
    const outcome = await ensureTrackerEnvConfigured({
      env: { TASK_TRACKER: "jira" },
      stdinIsTTY: true,
      prompt: async () => "n",
    });
    expect(outcome).toBe("failed");
    expect(recorded.map((e) => e.event)).toEqual(["setup_declined"]);
    expect(recorded[0]?.properties).toMatchObject({ reason: "missing_tracker_credentials" });
  });

  test("a wizard that leaves credentials missing emits setup_failed", async () => {
    const recorded = stubAnalytics();
    const outcome = await ensureTrackerEnvConfigured({
      env: { TASK_TRACKER: "jira" },
      stdinIsTTY: true,
      prompt: async () => "y",
      runWizard: async () => {},
    });
    expect(outcome).toBe("failed");
    expect(recorded.map((e) => e.event)).toEqual(["setup_failed"]);
    expect(recorded[0]?.properties).toMatchObject({ reason: "missing_tracker_credentials" });
  });

  test("the default wizard path passes source: rescue to runInitWizard", async () => {
    const recorded = stubAnalytics();
    const wizardDeps: Array<Record<string, unknown> | undefined> = [];
    mock.module("../src/lib/init/wizard", () => ({
      runInitWizard: async (deps?: Record<string, unknown>) => {
        wizardDeps.push(deps);
      },
    }));
    const outcome = await ensureTrackerEnvConfigured({
      env: { TASK_TRACKER: "jira" },
      stdinIsTTY: true,
      prompt: async () => "y",
    });
    // The mocked wizard writes no credentials, so the run still fails.
    expect(outcome).toBe("failed");
    expect(wizardDeps).toEqual([{ source: "rescue" }]);
    expect(recorded.map((e) => e.event)).toEqual(["setup_failed"]);
  });

  test("a successful wizard emits no funnel events of its own", async () => {
    const recorded = stubAnalytics();
    const mutableEnv: Record<string, string | undefined> = { TASK_TRACKER: "jira" };
    const outcome = await ensureTrackerEnvConfigured({
      env: mutableEnv,
      stdinIsTTY: true,
      prompt: async () => "y",
      runWizard: async () => {
        mutableEnv.JIRA_BASE_URL = "https://acme.atlassian.net";
        mutableEnv.JIRA_EMAIL = "dev@acme.com";
        mutableEnv.JIRA_API_TOKEN = "secret";
      },
    });
    expect(outcome).toBe("ready");
    expect(recorded).toEqual([]);
  });
});
