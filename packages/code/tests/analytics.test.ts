import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANALYTICS_CONFIG_DIR_ENV,
  flushAnalytics,
  isAnonymousIdNewlyCreated,
  isAnalyticsEnabled,
  isTelemetryDisabledByEnv,
  readAnalyticsEnabledFromSettings,
  resolveWorkerMode,
  RUN_ORIGIN_ENV,
  scrubProps,
  setAnalyticsSenderForTests,
  track,
  trackWorkerStarted,
  trackWorkerTaskRun,
} from "../src/lib/analytics";

const tmpDirs: string[] = [];

function makeConfigDir(withSettings?: object): string {
  const dir = mkdtempSync(join("/tmp", "devintern-analytics-"));
  tmpDirs.push(dir);
  if (withSettings) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(withSettings), "utf8");
  }
  return dir;
}

afterEach(() => {
  setAnalyticsSenderForTests(undefined);
  delete process.env.POSTHOG_API_KEY;
  delete process.env.DEVINTERN_TELEMETRY_DISABLED;
  delete process.env[RUN_ORIGIN_ENV];
  delete process.env[ANALYTICS_CONFIG_DIR_ENV];
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isTelemetryDisabledByEnv", () => {
  test("unset means enabled", () => {
    expect(isTelemetryDisabledByEnv({})).toBe(false);
  });

  test("truthy values disable", () => {
    expect(isTelemetryDisabledByEnv({ DEVINTERN_TELEMETRY_DISABLED: "1" })).toBe(true);
    expect(isTelemetryDisabledByEnv({ DEVINTERN_TELEMETRY_DISABLED: "true" })).toBe(true);
    expect(isTelemetryDisabledByEnv({ DEVINTERN_TELEMETRY_DISABLED: "YES" })).toBe(true);
  });

  test("empty and zero keep analytics enabled", () => {
    expect(isTelemetryDisabledByEnv({ DEVINTERN_TELEMETRY_DISABLED: "" })).toBe(false);
    expect(isTelemetryDisabledByEnv({ DEVINTERN_TELEMETRY_DISABLED: "0" })).toBe(false);
  });
});

describe("readAnalyticsEnabledFromSettings", () => {
  test("undefined when no settings file exists", () => {
    expect(readAnalyticsEnabledFromSettings(makeConfigDir())).toBeUndefined();
  });

  test("reads analytics.enabled=false", () => {
    const dir = makeConfigDir({ analytics: { enabled: false } });
    expect(readAnalyticsEnabledFromSettings(dir)).toBe(false);
  });

  test("undefined when analytics section missing", () => {
    const dir = makeConfigDir({ jira: {} });
    expect(readAnalyticsEnabledFromSettings(dir)).toBeUndefined();
  });

  test("undefined on malformed settings instead of throwing", () => {
    const dir = makeConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{not json", "utf8");
    expect(readAnalyticsEnabledFromSettings(dir)).toBeUndefined();
  });
});

describe("isAnalyticsEnabled", () => {
  test("disabled when the API key is absent (source/dev builds)", () => {
    delete process.env.POSTHOG_API_KEY;
    expect(isAnalyticsEnabled(makeConfigDir())).toBe(false);
  });
});

describe("scrubProps", () => {
  test("drops non-allowlisted keys and undefined values", () => {
    expect(
      scrubProps({
        tracker: "jira",
        task_count: 3,
        task_key: "PROJ-123",
        repo_url: "https://github.com/acme/webapp",
        create_pr: undefined,
      }),
    ).toEqual({ tracker: "jira", task_count: 3 });
  });

  test("returns empty object for undefined input", () => {
    expect(scrubProps(undefined)).toEqual({});
  });
});

describe("track", () => {
  test("sends allowlisted payload with a stable anonymous id", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const dir = makeConfigDir();

    let received: unknown;
    setAnalyticsSenderForTests({
      send: async (payload) => {
        received = payload;
      },
    });

    await track("cli_run", { tracker: "linear", task_key: "ENG-42" }, { configDir: dir });

    expect(received).toBeDefined();
    const payload = received as {
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    };
    expect(payload.event).toBe("cli_run");
    expect(payload.properties).toEqual({ tracker: "linear" });
    expect(payload.distinct_id).toMatch(/[0-9a-f-]{36}/);

    await track("cli_run", {}, { configDir: dir });
    const second = received as { distinct_id: string };
    expect(second.distinct_id).toBe(payload.distinct_id);
  });

  test("no network when opted out via env", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env.DEVINTERN_TELEMETRY_DISABLED = "1";
    let called = false;
    setAnalyticsSenderForTests({
      send: async () => {
        called = true;
      },
    });
    await track("cli_run", {}, { configDir: makeConfigDir() });
    expect(called).toBe(false);
  });

  test("no network when disabled in settings", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    let called = false;
    setAnalyticsSenderForTests({
      send: async () => {
        called = true;
      },
    });
    const dir = makeConfigDir({ analytics: { enabled: false } });
    await track("cli_run", {}, { configDir: dir });
    expect(called).toBe(false);
  });

  test("never throws when the sender fails", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    setAnalyticsSenderForTests({
      send: async () => {
        throw new Error("network down");
      },
    });
    await expect(track("cli_run", {}, { configDir: makeConfigDir() })).resolves.toBeUndefined();
  });
});

describe("trackWorkerTaskRun", () => {
  test("emits one terminal event for worker task subprocesses", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env[RUN_ORIGIN_ENV] = "worker";
    const received: unknown[] = [];
    setAnalyticsSenderForTests({
      send: async (payload) => {
        received.push(payload);
      },
    });

    expect(trackWorkerTaskRun("succeeded", { cliVersion: "2.5.0", tracker: "linear" })).toBe(true);
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event: "worker_task_run",
      properties: {
        cli_version: "2.5.0",
        tracker: "linear",
        outcome: "succeeded",
        worker_trigger: "task",
      },
    });
  });

  test("attributes scheduled worker tasks without identifiers", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env[RUN_ORIGIN_ENV] = "scheduled";
    let received: unknown;
    setAnalyticsSenderForTests({
      send: async (payload) => {
        received = payload;
      },
    });

    expect(trackWorkerTaskRun("deferred", { cliVersion: "2.5.0", tracker: "markdown" })).toBe(true);
    await Promise.resolve();

    expect(received).toMatchObject({
      event: "worker_task_run",
      properties: {
        outcome: "deferred",
        worker_trigger: "scheduled",
      },
    });
    expect((received as { properties: Record<string, unknown> }).properties).not.toHaveProperty(
      "task_key",
    );
  });

  test("attributes manual automation runs from the dashboard Run now action", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env[RUN_ORIGIN_ENV] = "manual";
    let received: unknown;
    setAnalyticsSenderForTests({
      send: async (payload) => {
        received = payload;
      },
    });

    expect(trackWorkerTaskRun("failed", { cliVersion: "2.6.0", tracker: "markdown" })).toBe(true);
    await Promise.resolve();

    expect(received).toMatchObject({
      event: "worker_task_run",
      properties: {
        outcome: "failed",
        worker_trigger: "manual",
      },
    });
  });

  test("does not emit for manual CLI task runs", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    let called = false;
    setAnalyticsSenderForTests({
      send: async () => {
        called = true;
      },
    });

    expect(trackWorkerTaskRun("failed", { cliVersion: "2.5.0", tracker: "jira" })).toBe(false);
    await Promise.resolve();
    expect(called).toBe(false);
  });
});

describe("worker startup analytics", () => {
  test.each([
    { names: ["poll:jira", "poll:reviews"], expected: "polling" },
    { names: ["relay"], expected: "relay" },
    { names: ["poll:linear", "relay"], expected: "hybrid" },
    { names: ["scheduled-automations"], expected: "scheduled" },
  ])("classifies $expected mode", ({ names, expected }) => {
    expect(resolveWorkerMode(names)).toBe(expected);
  });

  test("emits one startup event with the aggregate mode", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    let received: unknown;
    setAnalyticsSenderForTests({
      send: async (payload) => {
        received = payload;
      },
    });

    trackWorkerStarted({
      cliVersion: "2.5.0",
      tracker: "jira",
      acquirerNames: ["poll:jira", "poll:reviews", "relay"],
    });
    await Promise.resolve();

    expect(received).toMatchObject({
      event: "worker_started",
      properties: {
        cli_version: "2.5.0",
        tracker: "jira",
        worker_mode: "hybrid",
      },
    });
  });
});

describe("anonymous id persistence", () => {
  test("first run reports new, subsequent runs do not", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    setAnalyticsSenderForTests({ send: async () => {} });
    const dir = makeConfigDir();
    expect(isAnonymousIdNewlyCreated(dir)).toBe(true);
    await track("cli_run", {}, { configDir: dir });
    expect(isAnonymousIdNewlyCreated(dir)).toBe(false);
  });

  test("flushAnalytics resolves without pending sends", async () => {
    await expect(flushAnalytics(10)).resolves.toBeUndefined();
  });

  test("worker subprocesses use the workspace telemetry directory", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const dir = makeConfigDir();
    process.env[ANALYTICS_CONFIG_DIR_ENV] = dir;
    setAnalyticsSenderForTests({ send: async () => {} });

    expect(isAnonymousIdNewlyCreated()).toBe(true);
    await track("worker_task_run", { outcome: "succeeded" });
    expect(isAnonymousIdNewlyCreated()).toBe(false);
  });
});
