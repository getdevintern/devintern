import { afterEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANALYTICS_CONFIG_DIR_ENV,
  flushAnalytics,
  isAnalyticsEnabled,
  isAnonymousIdNewlyCreated,
  isTelemetryDisabledByEnv,
  readinessCheckProps,
  readAnalyticsEnabledFromSettings,
  resolveWorkerMode,
  RUN_ORIGIN_ENV,
  scrubProps,
  setAnalyticsCaptureForTests,
  track,
  trackDoctorRun,
  trackInteractiveTaskRun,
  trackLoginResult,
  trackSetupCompleted,
  trackSetupDeclined,
  trackSetupFailed,
  trackSetupStarted,
  trackWorkerConnect,
  trackWorkerInitCompleted,
  trackWorkerInitFailed,
  trackWorkerInitStarted,
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

/** Config dir with `analytics.enabled: false` and an existing telemetry id. */
function optedOutConfigDir(anonymousId: string): string {
  const dir = makeConfigDir({ analytics: { enabled: false } });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "telemetry.json"),
    `${JSON.stringify({ anonymousId }, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

/** Events collected by the injected capture seam. */
interface RecordedEvent {
  distinctId?: string;
  event?: string;
  properties?: Record<string, unknown>;
}

afterEach(() => {
  setAnalyticsCaptureForTests(undefined);
  delete process.env.POSTHOG_API_KEY;
  delete process.env.POSTHOG_HOST;
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
        email: "dev@example.com",
        token: "secret",
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

    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    await track("cli_run", { tracker: "linear", task_key: "ENG-42" }, { configDir: dir });
    await track("doctor_run", { sandbox: "docker" }, { configDir: dir });

    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      event: "cli_run",
      properties: { tracker: "linear" },
    });
    expect(recorded[0]!.distinctId).toMatch(/[0-9a-f-]{36}/);
    expect(recorded[1]!.properties).toEqual({ sandbox: "docker" });
    expect(recorded[1]!.distinctId).toBe(recorded[0]!.distinctId);
  });

  test("no capture when opted out via env", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env.DEVINTERN_TELEMETRY_DISABLED = "1";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });
    await track("cli_run", {}, { configDir: makeConfigDir() });
    expect(recorded).toHaveLength(0);
  });

  test("no capture when disabled in settings", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });
    const dir = makeConfigDir({ analytics: { enabled: false } });
    await track("cli_run", {}, { configDir: dir });
    expect(recorded).toHaveLength(0);
  });

  test("never throws when the capture fails", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    setAnalyticsCaptureForTests({
      capture: () => {
        throw new Error("queue broken");
      },
    });
    await expect(track("cli_run", {}, { configDir: makeConfigDir() })).resolves.toBeUndefined();
  });
});

describe("settings opt-out reporting", () => {
  test("emits one analytics_opt_out event, then never again", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const dir = makeConfigDir({ analytics: { enabled: false } });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "telemetry.json"),
      `${JSON.stringify({ anonymousId: "11111111-2222-3333-4444-555555555555" }, null, 2)}\n`,
      "utf8",
    );
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    await track("cli_run", { tracker: "jira" }, { configDir: dir });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      distinctId: "11111111-2222-3333-4444-555555555555",
      event: "analytics_opt_out",
      properties: {},
    });
    expect(JSON.parse(readFileSync(join(dir, "telemetry.json"), "utf8"))).toMatchObject({
      anonymousId: "11111111-2222-3333-4444-555555555555",
      optOutReported: true,
    });

    await track("cli_run", {}, { configDir: dir });
    expect(recorded).toHaveLength(1);
  });

  test("env kill-switch suppresses the opt-out acknowledgement", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env.DEVINTERN_TELEMETRY_DISABLED = "1";
    const dir = makeConfigDir({ analytics: { enabled: false } });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "telemetry.json"),
      `${JSON.stringify({ anonymousId: "11111111-2222-3333-4444-555555555555" }, null, 2)}\n`,
      "utf8",
    );
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    await track("cli_run", {}, { configDir: dir });
    expect(recorded).toHaveLength(0);
    // The opt-out marker is untouched so a later run without the env var can
    // still acknowledge the settings opt-out.
    expect(JSON.parse(readFileSync(join(dir, "telemetry.json"), "utf8"))).toEqual({
      anonymousId: "11111111-2222-3333-4444-555555555555",
    });
  });

  test("does not report when the settings opt-out is absent", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const dir = makeConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "telemetry.json"), `${JSON.stringify({ anonymousId: "x" })}\n`);
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });
    await track("cli_run", {}, { configDir: dir });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.event).toBe("cli_run");
  });

  test("does not report when telemetry.json does not exist yet", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });
    await track("cli_run", {}, { configDir: makeConfigDir({ analytics: { enabled: false } }) });
    expect(recorded).toHaveLength(0);
  });

  test("restoring the test capture seam resets the one-time opt-out gate", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";

    const first: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => first.push(payload) });
    const dirOne = optedOutConfigDir("11111111-2222-3333-4444-555555555555");
    await track("cli_run", {}, { configDir: dirOne });
    expect(first.map((r) => r.event)).toEqual(["analytics_opt_out"]);

    // Simulate a fresh test run: the undefined restore clears the process
    // flag, so a later test still sees its own opt-out acknowledgement.
    setAnalyticsCaptureForTests(undefined);
    const second: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => second.push(payload) });
    const dirTwo = optedOutConfigDir("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await track("cli_run", {}, { configDir: dirTwo });
    expect(second.map((r) => r.event)).toEqual(["analytics_opt_out"]);
  });
});

describe("readinessCheckProps", () => {
  test("maps readiness ids to allowlisted check properties", () => {
    expect(
      readinessCheckProps([
        { id: "runtime", status: "ok" },
        { id: "git", status: "ok" },
        { id: "agent", status: "warn" },
        { id: "tracker", status: "ok" },
        { id: "auth", status: "warn" },
        { id: "license", status: "fail" },
      ]),
    ).toEqual({
      check_bun: "ok",
      check_git: "ok",
      check_agent: "warn",
      check_tracker: "ok",
      check_auth: "warn",
      check_license: "fail",
    });
  });

  test("drops unknown check ids", () => {
    expect(readinessCheckProps([{ id: "email", status: "ok" }])).toEqual({});
  });
});

describe("activation funnel events", () => {
  test("setup events carry only allowlisted outcome props", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    trackSetupStarted("rescue");
    await trackSetupDeclined("missing_tracker_credentials");
    await trackSetupFailed("scaffold_refused");
    trackSetupCompleted({
      tracker: "markdown",
      signedIn: "skipped",
      checks: [
        { id: "runtime", status: "ok" },
        { id: "agent", status: "fail" },
      ],
    });
    await Promise.resolve();

    expect(recorded.map((r) => r.event)).toEqual([
      "setup_started",
      "setup_declined",
      "setup_failed",
      "setup_completed",
    ]);
    expect(recorded[0]!.properties).toEqual({
      cli_version: expect.any(String),
      os: process.platform,
      source: "rescue",
    });
    expect(recorded[2]!.properties).toEqual({
      cli_version: expect.any(String),
      os: process.platform,
      reason: "scaffold_refused",
    });
    expect(recorded[3]!.properties).toEqual({
      cli_version: expect.any(String),
      os: process.platform,
      tracker: "markdown",
      signed_in: "skipped",
      check_bun: "ok",
      check_agent: "fail",
    });
    for (const event of recorded) {
      expect(event.properties).not.toHaveProperty("task_key");
      expect(event.properties).not.toHaveProperty("email");
    }
  });

  test("doctor_run reports aggregate outcome and per-check statuses", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    const checks = [
      { id: "runtime", label: "Bun runtime", status: "ok" as const },
      { id: "git", label: "Git", status: "ok" as const },
      { id: "agent", label: "AI agent CLI", status: "fail" as const },
      { id: "tracker", label: "Task tracker", status: "ok" as const },
    ];
    await trackDoctorRun({ checks, hasFailures: true, hasWarnings: false });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.event).toBe("doctor_run");
    expect(recorded[0]!.properties).toMatchObject({
      outcome: "failures",
      check_bun: "ok",
      check_git: "ok",
      check_agent: "fail",
      check_tracker: "ok",
    });
  });

  test("doctor_run without failures or warnings reports ready", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });
    await trackDoctorRun({ checks: [], hasFailures: false, hasWarnings: false });
    expect(recorded[0]!.properties).toMatchObject({ outcome: "ready" });
  });

  test("login_result records outcome and provider method", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    await trackLoginResult({ outcome: "succeeded", method: "github" });
    await trackLoginResult({ outcome: "failed" });

    expect(recorded[0]!.properties).toMatchObject({ outcome: "succeeded", method: "github" });
    expect(recorded[1]!.properties).toMatchObject({ outcome: "failed" });
    expect(recorded[1]!.properties).not.toHaveProperty("method");
  });

  test("interactive task runs carry aggregate outcome without task identity", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    await trackInteractiveTaskRun({
      tracker: "linear",
      outcome: "succeeded",
      taskCount: 2,
      runMode: "tasks",
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.properties).toEqual({
      cli_version: expect.any(String),
      os: process.platform,
      tracker: "linear",
      outcome: "succeeded",
      task_count: 2,
      run_mode: "tasks",
    });
  });

  test("scrubs PII-shaped keys out of task_run payloads", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    await track(
      "task_run",
      {
        tracker: "github",
        outcome: "failed",
        task_key: "ACME-9",
        repo: "acme/webapp",
        git_email: "dev@example.com",
      },
      { configDir: makeConfigDir() },
    );

    expect(recorded[0]!.properties).toEqual({ tracker: "github", outcome: "failed" });
  });
});

describe("worker init and connect events", () => {
  test("worker init lifecycle reports step outcomes", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    trackWorkerInitStarted();
    trackWorkerInitFailed("tracker_not_pollable");
    trackWorkerInitCompleted({
      tracker: "jira",
      relayConnect: "succeeded",
      serviceInstall: "installed",
      githubApp: "skipped",
    });
    await Promise.resolve();

    expect(recorded.map((r) => r.event)).toEqual([
      "worker_init_started",
      "worker_init_failed",
      "worker_init_completed",
    ]);
    expect(recorded[2]!.properties).toEqual({
      cli_version: expect.any(String),
      os: process.platform,
      tracker: "jira",
      relay_connect: "succeeded",
      service_install: "installed",
      github_app: "skipped",
    });
  });

  test("worker connect reports target and outcome", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    await trackWorkerConnect({ target: "github", outcome: "succeeded" });
    await trackWorkerConnect({ target: "sentry", outcome: "failed" });

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.properties).toMatchObject({ target: "github", outcome: "succeeded" });
    expect(recorded[1]!.properties).toMatchObject({ target: "sentry", outcome: "failed" });
  });
});

describe("trackWorkerTaskRun", () => {
  test("emits one terminal event for worker task subprocesses", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env[RUN_ORIGIN_ENV] = "worker";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    expect(trackWorkerTaskRun("succeeded", { cliVersion: "2.5.0", tracker: "linear" })).toBe(true);
    await Promise.resolve();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
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
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    expect(trackWorkerTaskRun("deferred", { cliVersion: "2.5.0", tracker: "markdown" })).toBe(true);
    await Promise.resolve();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      event: "worker_task_run",
      properties: {
        outcome: "deferred",
        worker_trigger: "scheduled",
      },
    });
    expect(recorded[0]!.properties).not.toHaveProperty("task_key");
  });

  test("counts error-monitor subprocesses as worker task runs", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env[RUN_ORIGIN_ENV] = "error_monitor";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    expect(trackWorkerTaskRun("failed", { cliVersion: "2.8.0", tracker: "sentry" })).toBe(true);
    await Promise.resolve();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.properties).toMatchObject({
      outcome: "failed",
      tracker: "sentry",
      worker_trigger: "task",
    });
  });

  test("attributes manual automation runs from the dashboard Run now action", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env[RUN_ORIGIN_ENV] = "manual";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    expect(trackWorkerTaskRun("failed", { cliVersion: "2.6.0", tracker: "markdown" })).toBe(true);
    await Promise.resolve();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.properties).toMatchObject({
      outcome: "failed",
      worker_trigger: "manual",
    });
  });

  test("does not emit for manual CLI task runs", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    expect(trackWorkerTaskRun("failed", { cliVersion: "2.5.0", tracker: "jira" })).toBe(false);
    await Promise.resolve();
    expect(recorded).toHaveLength(0);
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
    const recorded: RecordedEvent[] = [];
    setAnalyticsCaptureForTests({ capture: (payload) => recorded.push(payload) });

    trackWorkerStarted({
      cliVersion: "2.5.0",
      tracker: "jira",
      acquirerNames: ["poll:jira", "poll:reviews", "relay"],
    });
    await Promise.resolve();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
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
    setAnalyticsCaptureForTests({ capture: () => {} });
    const dir = makeConfigDir();
    expect(isAnonymousIdNewlyCreated(dir)).toBe(true);
    await track("cli_run", {}, { configDir: dir });
    expect(isAnonymousIdNewlyCreated(dir)).toBe(false);
  });

  test("worker subprocesses use the workspace telemetry directory", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const dir = makeConfigDir();
    process.env[ANALYTICS_CONFIG_DIR_ENV] = dir;
    setAnalyticsCaptureForTests({ capture: () => {} });

    expect(isAnonymousIdNewlyCreated()).toBe(true);
    await track("worker_task_run", { outcome: "succeeded" });
    expect(isAnonymousIdNewlyCreated()).toBe(false);
  });
});

describe("posthog-node sender", () => {
  test("flush delivers queued captures to the PostHog batch endpoint", async () => {
    const received: Array<{ api_key?: string; batch?: Array<Record<string, unknown>> }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = new Uint8Array(await request.arrayBuffer());
        let text: string;
        if (request.headers.get("content-encoding") === "gzip") {
          text = new TextDecoder().decode(gunzipSync(body));
        } else {
          text = new TextDecoder().decode(body);
        }
        received.push(JSON.parse(text));
        return new Response("{}", { status: 200 });
      },
    });
    try {
      process.env.POSTHOG_API_KEY = "phc_test_sdk";
      process.env.POSTHOG_HOST = `http://127.0.0.1:${server.port}`;
      const dir = makeConfigDir();

      await track("cli_run", { tracker: "linear", ci: true }, { configDir: dir });
      await flushAnalytics(5000);

      expect(received).toHaveLength(1);
      expect(received[0]!.api_key).toBe("phc_test_sdk");
      const batch = received[0]!.batch ?? [];
      expect(batch).toHaveLength(1);
      expect(batch[0]).toMatchObject({
        event: "cli_run",
        distinct_id: expect.stringMatching(/[0-9a-f-]{36}/),
        properties: { tracker: "linear", ci: true },
      });
    } finally {
      server.stop(true);
    }
  });

  test("flushAnalytics resolves even when the client never flushes", async () => {
    setAnalyticsCaptureForTests({
      capture: () => {},
      flush: () => new Promise(() => {}),
    });
    await expect(flushAnalytics(20)).resolves.toBeUndefined();
  });
});
