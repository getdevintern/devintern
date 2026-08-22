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
};

// Mock Sentry directly so @devintern/utils keeps its real exports for other test files.
mock.module("@sentry/node", () => ({
  init: (opts: typeof sentryCalls.initOpts) => {
    sentryCalls.initOpts = opts;
  },
  captureException: (error: unknown) => {
    sentryCalls.captured.push(error);
  },
  flush: async () => true,
}));

const { captureError, initErrorTrackingFromSettings, setTelemetryEnabled, shutdownErrorTracking } =
  await import("./error-tracking.ts");

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
});
