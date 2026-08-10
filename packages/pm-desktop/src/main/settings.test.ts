import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAnalyticsEnabled,
  readSettings,
  setUserDataDirForTests,
  updateSettings,
} from "./settings.ts";

describe("settings", () => {
  let tempDir: string;

  afterEach(async () => {
    setUserDataDirForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("round-trips codeDiscoveryDismissed", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-settings-"));
    setUserDataDirForTests(tempDir);

    expect(await readSettings()).toEqual({});

    await updateSettings({ codeDiscoveryDismissed: true });
    expect(await readSettings()).toEqual({ codeDiscoveryDismissed: true });
  });

  test("updateSettings merges without dropping other keys", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-settings-"));
    setUserDataDirForTests(tempDir);

    await updateSettings({ lastProjectDir: "/tmp/project" });
    await updateSettings({ codeDiscoveryDismissed: true });

    expect(await readSettings()).toEqual({
      lastProjectDir: "/tmp/project",
      codeDiscoveryDismissed: true,
    });
  });

  test("round-trips recentProjectDirs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-settings-"));
    setUserDataDirForTests(tempDir);

    await updateSettings({ recentProjectDirs: ["/tmp/a", "/tmp/b"] });
    expect(await readSettings()).toEqual({ recentProjectDirs: ["/tmp/a", "/tmp/b"] });
  });

  test("concurrent updateSettings patches both survive", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-settings-"));
    setUserDataDirForTests(tempDir);

    await Promise.all([
      updateSettings({ lastProjectDir: "/tmp/project" }),
      updateSettings({ codeDiscoveryDismissed: true }),
    ]);

    expect(await readSettings()).toEqual({
      lastProjectDir: "/tmp/project",
      codeDiscoveryDismissed: true,
    });
  });

  test("updateSettings updater sees prior writes in the serialize chain", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-settings-"));
    setUserDataDirForTests(tempDir);

    await updateSettings({ recentProjectDirs: ["/tmp/a"] });
    await updateSettings((current) => ({
      ...current,
      recentProjectDirs: ["/tmp/b", ...(current.recentProjectDirs ?? [])],
      lastProjectDir: "/tmp/b",
    }));

    expect(await readSettings()).toEqual({
      recentProjectDirs: ["/tmp/b", "/tmp/a"],
      lastProjectDir: "/tmp/b",
    });
  });

  test("isAnalyticsEnabled defaults to true and respects opt-out", async () => {
    expect(isAnalyticsEnabled({})).toBe(true);
    expect(isAnalyticsEnabled({ analyticsEnabled: true })).toBe(true);
    expect(isAnalyticsEnabled({ analyticsEnabled: false })).toBe(false);
  });
});
