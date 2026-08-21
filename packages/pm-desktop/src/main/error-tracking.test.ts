import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setUserDataDirForTests, updateSettings } from "./settings.ts";

const sentryCalls = {
  initOpts: undefined as { dsn?: string; isEnabled?: () => boolean; release?: string } | undefined,
  captured: [] as unknown[],
};

mock.module("@devintern/utils", () => ({
  initErrorTracking: (opts: typeof sentryCalls.initOpts) => {
    sentryCalls.initOpts = opts;
  },
  captureError: (error: unknown) => {
    // Mirror the real wrapper: the live opt-out gate blocks captures.
    if (!sentryCalls.initOpts?.isEnabled?.()) return;
    sentryCalls.captured.push(error);
  },
  flushErrorTracking: async () => undefined,
}));

const { captureError, initErrorTrackingFromSettings, setTelemetryEnabled, shutdownErrorTracking } =
  await import("./error-tracking.ts");

describe("error-tracking", () => {
  let tempDir: string;

  afterEach(async () => {
    setUserDataDirForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    sentryCalls.initOpts = undefined;
    sentryCalls.captured = [];
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

    expect(sentryCalls.initOpts?.isEnabled?.()).toBe(false);
    await captureError(new Error("blocked"));
    expect(sentryCalls.captured).toHaveLength(0);
  });

  test("captures when telemetry is enabled (default)", async () => {
    await setupSettings();
    await initErrorTrackingFromSettings("1.2.3");

    expect(sentryCalls.initOpts?.isEnabled?.()).toBe(true);
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
