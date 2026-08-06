import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appOpenedProps,
  scrubProps,
  setAnalyticsCaptureForTests,
  setAnalyticsEnabled,
  track,
  type AnalyticsCapture,
} from "./analytics.ts";
import { setUserDataDirForTests, updateSettings } from "./settings.ts";

describe("scrubProps", () => {
  test("keeps allowlisted keys only", () => {
    expect(
      scrubProps({
        ok: true,
        source_type: "text",
        prompt: "secret",
        projectDir: "/tmp/leak",
        configured: false,
      }),
    ).toEqual({
      ok: true,
      source_type: "text",
      configured: false,
    });
  });

  test("drops undefined values", () => {
    expect(scrubProps({ ok: true, epic_linked: undefined })).toEqual({ ok: true });
  });
});

describe("appOpenedProps", () => {
  test("includes version and os", () => {
    const props = appOpenedProps("1.2.3");
    expect(props.app_version).toBe("1.2.3");
    expect(typeof props.os).toBe("string");
  });
});

describe("track", () => {
  let tempDir: string;
  let captures: Array<{ event: string; properties?: Record<string, unknown> }>;

  afterEach(async () => {
    setAnalyticsCaptureForTests(undefined);
    setUserDataDirForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setupCapture(): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-analytics-"));
    setUserDataDirForTests(tempDir);
    captures = [];
    const capture: AnalyticsCapture = {
      capture: (payload) => {
        captures.push({ event: payload.event, properties: payload.properties });
      },
      shutdown: async () => undefined,
    };
    setAnalyticsCaptureForTests(capture);
  }

  test("captures allowlisted props with install distinct id", async () => {
    await setupCapture();
    await track("story_generated", {
      source_type: "figma",
      ok: true,
      prompt: "should not appear",
    });

    expect(captures).toHaveLength(1);
    expect(captures[0]?.event).toBe("story_generated");
    expect(captures[0]?.properties).toEqual({ source_type: "figma", ok: true });
  });

  test("no-ops when user opted out", async () => {
    await setupCapture();
    await updateSettings({ analyticsEnabled: false });
    await track("app_opened", appOpenedProps("0.1.0"));
    expect(captures).toHaveLength(0);
  });

  test("setAnalyticsEnabled(false) emits analytics_opt_out then blocks later events", async () => {
    await setupCapture();
    await setAnalyticsEnabled(false);
    expect(captures.map((c) => c.event)).toEqual(["analytics_opt_out"]);

    await track("project_opened", { configured: true });
    expect(captures).toHaveLength(1);
  });

  test("never throws when capture fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-analytics-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => {
        throw new Error("network down");
      },
      shutdown: async () => undefined,
    });

    await expect(track("app_opened", { app_version: "1", os: "linux" })).resolves.toBeUndefined();
  });

  test("no-ops when capture client is null (missing API key)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-analytics-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests(null);

    await expect(track("app_opened", appOpenedProps("1.0.0"))).resolves.toBeUndefined();
  });
});
