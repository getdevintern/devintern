import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setUserDataDirForTests, updateSettings } from "./settings.ts";

const sentryCalls = {
  initOpts: undefined as
    | { release?: string; environment?: string; beforeSend?: (event: unknown) => unknown }
    | undefined,
  captured: [] as unknown[],
  capturedExtras: [] as Array<Record<string, unknown> | undefined>,
};

// Mock Sentry directly so @devintern/utils keeps its real exports for other test files.
mock.module("@sentry/node", () => ({
  init: (opts: typeof sentryCalls.initOpts) => {
    sentryCalls.initOpts = opts;
  },
  captureException: (error: unknown, hint?: { extra?: Record<string, unknown> }) => {
    sentryCalls.captured.push(error);
    sentryCalls.capturedExtras.push(hint?.extra);
  },
  flush: async () => true,
}));

const {
  captureError,
  captureErrorOnce,
  initErrorTrackingFromSettings,
  resetErrorDeduplicationForTests,
  setTelemetryEnabled,
  shutdownErrorTracking,
} = await import("./error-tracking.ts");

describe("error-tracking", () => {
  let tempDir: string;

  afterAll(() => {
    mock.restore();
  });

  afterEach(async () => {
    setUserDataDirForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    sentryCalls.initOpts = undefined;
    sentryCalls.captured = [];
    sentryCalls.capturedExtras = [];
    resetErrorDeduplicationForTests();
    delete process.env.SENTRY_DISABLED;
  });

  async function setupSettings(analyticsEnabled?: boolean): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-error-tracking-"));
    setUserDataDirForTests(tempDir);
    if (analyticsEnabled !== undefined) {
      await updateSettings({ analyticsEnabled });
    }
  }

  test("respects the analytics opt-out at init", async () => {
    await setupSettings(false);
    await initErrorTrackingFromSettings("1.2.3");

    expect(sentryCalls.initOpts?.beforeSend?.({ event_id: "x" })).toBeNull();
    await captureError(new Error("blocked"));
    expect(sentryCalls.captured).toHaveLength(0);
  });

  test("captures when telemetry is enabled (default)", async () => {
    await setupSettings();
    await initErrorTrackingFromSettings("1.2.3");

    expect(sentryCalls.initOpts?.beforeSend?.({ event_id: "x" })).not.toBeNull();
    expect(sentryCalls.initOpts?.release).toBe("pm-desktop@1.2.3");
    const error = new Error("boom");
    await captureError(error);
    expect(sentryCalls.captured).toEqual([error]);
  });

  test("setTelemetryEnabled flips the live guard", async () => {
    await setupSettings(true);
    await initErrorTrackingFromSettings("1.2.3");

    setTelemetryEnabled(false);
    await captureError(new Error("blocked"));
    expect(sentryCalls.captured).toHaveLength(0);

    setTelemetryEnabled(true);
    await captureError(new Error("sent"));
    expect(sentryCalls.captured).toHaveLength(1);
  });

  test("shutdown resolves even when unused", async () => {
    await shutdownErrorTracking();
  });

  test("captureError forwards context to Sentry", async () => {
    await setupSettings();
    await initErrorTrackingFromSettings("1.2.3");

    await captureError(new Error("with context"), { operation: "ipc:pm:create-task" });
    expect(sentryCalls.capturedExtras[0]).toEqual({ operation: "ipc:pm:create-task" });
  });

  test("captureErrorOnce dedupes repeats per operation within the window", async () => {
    await setupSettings();
    await initErrorTrackingFromSettings("1.2.3");

    const error = new Error("repeated failure");
    await captureErrorOnce(error, { operation: "ipc:pm:create-task" });
    await captureErrorOnce(error, { operation: "ipc:pm:create-task" });
    await captureErrorOnce(error, { operation: "ipc:pm:create-task" });
    expect(sentryCalls.captured).toHaveLength(1);

    // A different operation reports independently.
    await captureErrorOnce(error, { operation: "renderer" });
    expect(sentryCalls.captured).toHaveLength(2);
    expect(sentryCalls.capturedExtras[1]).toEqual({ operation: "renderer" });
  });

  test("captureErrorOnce stays silent when telemetry is opted out", async () => {
    await setupSettings(false);
    await initErrorTrackingFromSettings("1.2.3");

    // Forwarded renderer errors must be suppressed by the same opt-out.
    await captureErrorOnce(new Error("forwarded from renderer"), { operation: "renderer" });
    await captureError(new Error("direct"), { operation: "renderer" });
    expect(sentryCalls.captured).toHaveLength(0);
  });
});
