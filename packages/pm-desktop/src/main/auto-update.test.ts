import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_SNOOZE_MS,
  formatUpdateAvailableMessage,
  shouldPromptForUpdate,
} from "../shared/auto-update.ts";
import {
  checkForUpdates,
  dismissUpdateError,
  downloadUpdate,
  getUpdateStatus,
  initAutoUpdate,
  installUpdate,
  resetAutoUpdateForTests,
  resolveElectronAutoUpdater,
  snoozeUpdate,
} from "./auto-update.ts";
import type { UpdaterLike } from "./auto-update.ts";
import { setAnalyticsCaptureForTests } from "./analytics.ts";
import { setUserDataDirForTests } from "./settings.ts";

function createMockUpdater(overrides?: Partial<UpdaterLike>): {
  updater: UpdaterLike;
  emit: (event: string, ...args: unknown[]) => void;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const updater: UpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: console,
    checkForUpdates: mock(async () => null),
    downloadUpdate: mock(async () => undefined),
    quitAndInstall: mock(() => undefined),
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
      return updater;
    },
    ...overrides,
  };
  return {
    updater,
    emit(event, ...args) {
      for (const listener of handlers.get(event) ?? []) {
        listener(...args);
      }
    },
  };
}

describe("shouldPromptForUpdate / formatUpdateAvailableMessage", () => {
  test("formats the available message", () => {
    expect(formatUpdateAvailableMessage("1.2.0", "1.1.0")).toBe(
      "Version 1.2.0 is available (you have 1.1.0).",
    );
  });

  test("respects snooze for the same version", () => {
    expect(
      shouldPromptForUpdate({
        availableVersion: "1.2.0",
        snoozedVersion: "1.2.0",
        snoozedUntil: 2_000,
        now: 1_000,
      }),
    ).toBe(false);
  });

  test("prompts again after snooze expires or for a newer version", () => {
    expect(
      shouldPromptForUpdate({
        availableVersion: "1.2.0",
        snoozedVersion: "1.2.0",
        snoozedUntil: 500,
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldPromptForUpdate({
        availableVersion: "1.3.0",
        snoozedVersion: "1.2.0",
        snoozedUntil: 2_000,
        now: 1_000,
      }),
    ).toBe(true);
  });

  test("force ignores snooze", () => {
    expect(
      shouldPromptForUpdate({
        availableVersion: "1.2.0",
        snoozedVersion: "1.2.0",
        snoozedUntil: 2_000,
        now: 1_000,
        force: true,
      }),
    ).toBe(true);
  });
});

describe("resolveElectronAutoUpdater", () => {
  test("reads named autoUpdater export", () => {
    const { updater } = createMockUpdater();
    expect(resolveElectronAutoUpdater({ autoUpdater: updater })).toBe(updater);
  });

  test("falls back to default.autoUpdater (CJS/ESM interop)", () => {
    const { updater } = createMockUpdater();
    expect(resolveElectronAutoUpdater({ default: { autoUpdater: updater } })).toBe(updater);
  });

  test("throws when autoUpdater is missing (the production bug shape)", () => {
    // What `const { autoUpdater } = await import("electron-updater")` can yield:
    // a module namespace with no usable instance.
    expect(() => resolveElectronAutoUpdater({ autoUpdater: undefined })).toThrow(
      /autoUpdater is unavailable/,
    );
    expect(() => resolveElectronAutoUpdater({})).toThrow(/autoUpdater is unavailable/);
  });
});

describe("auto-update service", () => {
  let tempDir: string;

  afterEach(async () => {
    resetAutoUpdateForTests();
    setAnalyticsCaptureForTests(undefined);
    setUserDataDirForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("createUpdater returning undefined becomes a clear error status", () => {
    const status = initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.9.0",
      createUpdater: () => undefined as unknown as UpdaterLike,
    });
    expect(status.phase).toBe("error");
    expect(status.errorMessage).toMatch(/no instance/i);
  });

  test("unpackaged builds stay disabled and never call the updater", async () => {
    const createUpdater = mock(() => {
      throw new Error("should not create updater");
    });
    const status = initAutoUpdate({
      isPackaged: false,
      currentVersion: "0.2.0",
      createUpdater,
    });
    expect(status.phase).toBe("disabled");
    expect(status.disabledReason).toBe("not-packaged");
    expect(createUpdater).not.toHaveBeenCalled();

    await checkForUpdates({ silent: false });
    expect(getUpdateStatus().phase).toBe("disabled");
  });

  test("check → available → download progress → downloaded → install", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0", releaseNotes: "Fixes" });
        return { updateInfo: { version: "0.3.0", releaseNotes: "Fixes" } };
      }),
      downloadUpdate: mock(async () => {
        emit("download-progress", { percent: 40, transferred: 40, total: 100 });
        emit("update-downloaded", { version: "0.3.0" });
      }),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
      now: () => 1_000,
    });

    expect(updater.autoDownload).toBe(true);

    const available = await checkForUpdates({ silent: false });
    expect(available.phase).toBe("available");
    expect(available.availableVersion).toBe("0.3.0");
    expect(available.snoozed).toBe(false);

    const downloading = await downloadUpdate();
    expect(downloading.phase).toBe("downloaded");
    expect(downloading.download?.percent).toBe(100);

    installUpdate();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  test("download failure is recoverable", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0" });
        return { updateInfo: { version: "0.3.0" } };
      }),
      downloadUpdate: mock(async () => {
        throw new Error("network down");
      }),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
    });

    await checkForUpdates({ silent: false });
    const failed = await downloadUpdate();
    expect(failed.phase).toBe("error");
    expect(failed.errorMessage).toContain("network down");
    expect(failed.availableVersion).toBe("0.3.0");

    const dismissed = dismissUpdateError();
    expect(dismissed.phase).toBe("available");
    expect(dismissed.errorMessage).toBeUndefined();
  });

  test("silent check failures do not flip to error", async () => {
    const { updater } = createMockUpdater({
      checkForUpdates: mock(async () => {
        throw new Error("offline");
      }),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
    });

    const status = await checkForUpdates({ silent: true });
    expect(status.phase).toBe("idle");
    expect(status.errorMessage).toBeUndefined();
  });

  test("snooze hides prompts for the same version until the window elapses", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    let now = 1_000;
    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0" });
        return { updateInfo: { version: "0.3.0" } };
      }),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
      now: () => now,
    });

    await checkForUpdates({ silent: false });
    const snoozed = await snoozeUpdate();
    expect(snoozed.snoozed).toBe(true);
    expect(UPDATE_SNOOZE_MS).toBeGreaterThan(0);

    // Background check while snoozed marks snoozed again.
    const background = await checkForUpdates({ silent: true });
    expect(background.phase).toBe("available");
    expect(background.snoozed).toBe(true);

    // Manual check clears snooze for display.
    const manual = await checkForUpdates({ silent: false });
    expect(manual.snoozed).toBe(false);

    // After window elapses, silent check prompts again.
    await snoozeUpdate();
    now = 1_000 + UPDATE_SNOOZE_MS + 1;
    const after = await checkForUpdates({ silent: true });
    expect(after.snoozed).toBe(false);
  });

  test("concurrent checks share one in-flight request", async () => {
    let resolveCheck: (value: null) => void = () => undefined;
    const checkForUpdatesFn = mock(
      () =>
        new Promise<null>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const { updater } = createMockUpdater({ checkForUpdates: checkForUpdatesFn });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
    });

    const a = checkForUpdates({ silent: true });
    const b = checkForUpdates({ silent: true });
    resolveCheck(null);
    await Promise.all([a, b]);
    expect(checkForUpdatesFn).toHaveBeenCalledTimes(1);
  });

  test("manual check keeps snoozed false after a late update-available IIFE", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    const now = 1_000;
    const { updateSettings } = await import("./settings.ts");
    await updateSettings({
      updateSnoozedVersion: "0.3.0",
      updateSnoozedUntil: now + UPDATE_SNOOZE_MS,
    });

    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        // Fire the event first so its async snooze read races with checkForUpdates.
        emit("update-available", { version: "0.3.0" });
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return { updateInfo: { version: "0.3.0" } };
      }),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
      now: () => now,
    });

    const manual = await checkForUpdates({ silent: false });
    expect(manual.snoozed).toBe(false);

    // Tick past any lingering update-available IIFE (old bug re-applied snooze here).
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(getUpdateStatus().snoozed).toBe(false);
    expect(getUpdateStatus().phase).toBe("available");
  });

  test("concurrent downloads share one in-flight request", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    let resolveDownload: () => void = () => undefined;
    const downloadUpdateFn = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0" });
        return { updateInfo: { version: "0.3.0" } };
      }),
      downloadUpdate: downloadUpdateFn,
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
    });

    await checkForUpdates({ silent: false });
    const a = downloadUpdate();
    const b = downloadUpdate();
    expect(getUpdateStatus().phase).toBe("downloading");
    resolveDownload();
    await Promise.all([a, b]);
    expect(downloadUpdateFn).toHaveBeenCalledTimes(1);
  });

  test("a later update-available event does not regress a downloaded update", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0" });
        return { updateInfo: { version: "0.3.0" } };
      }),
      downloadUpdate: mock(async () => {
        emit("download-progress", { percent: 100, transferred: 100, total: 100 });
        emit("update-downloaded", { version: "0.3.0" });
      }),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
    });

    await checkForUpdates({ silent: false });
    await downloadUpdate();
    expect(getUpdateStatus().phase).toBe("downloaded");

    // A periodic re-check fires `update-available` again for the same version.
    // The downloaded payload is already staged — we must not regress to
    // "available" (which would re-prompt the user to download what they have),
    // and must not trigger a duplicate underlying download.
    await checkForUpdates({ silent: true });
    expect(getUpdateStatus().phase).toBe("downloaded");
    expect(getUpdateStatus().availableVersion).toBe("0.3.0");
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  test("a periodic re-check does not regress an in-flight download", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    let resolveDownload: () => void = () => undefined;
    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0" });
        return { updateInfo: { version: "0.3.0" } };
      }),
      downloadUpdate: mock(
        () =>
          new Promise<void>((resolve) => {
            resolveDownload = () => {
              emit("update-downloaded", { version: "0.3.0" });
              resolve();
            };
          }),
      ),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
    });

    await checkForUpdates({ silent: false });
    const downloadPromise = downloadUpdate();
    // Yield so the download-progress / phase flips to "downloading" settle.
    await Promise.resolve();
    expect(getUpdateStatus().phase).toBe("downloading");

    // A periodic re-check fires while the download is in flight. The
    // update-available event during the check must not regress us to
    // "available" and lose the visible download progress, and must not
    // trigger a duplicate underlying download (autoDownload is suppressed
    // for the check while a download is in flight).
    await checkForUpdates({ silent: true });
    expect(getUpdateStatus().phase).toBe("downloading");
    expect(getUpdateStatus().availableVersion).toBe("0.3.0");
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);

    resolveDownload();
    await downloadPromise;
    expect(getUpdateStatus().phase).toBe("downloaded");
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  test("snoozing gates autoInstallOnAppQuit so 'Later' is not cosmetic", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0" });
        return { updateInfo: { version: "0.3.0" } };
      }),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
      now: () => 1_000,
    });

    expect(updater.autoInstallOnAppQuit).toBe(true);

    await checkForUpdates({ silent: false });
    expect(updater.autoInstallOnAppQuit).toBe(true);

    await snoozeUpdate();
    // Snoozing the available version must disable install-on-quit so the
    // update is not silently applied when the user later quits the app.
    expect(updater.autoInstallOnAppQuit).toBe(false);

    // A manual check (force) clears snooze and re-enables install-on-quit.
    await checkForUpdates({ silent: false });
    expect(updater.autoInstallOnAppQuit).toBe(true);

    // Snooze again, then let the window elapse: a background check must
    // re-enable install-on-quit once snooze has expired.
    await snoozeUpdate();
    expect(updater.autoInstallOnAppQuit).toBe(false);
    const { updateSettings } = await import("./settings.ts");
    await updateSettings({
      updateSnoozedVersion: "0.3.0",
      updateSnoozedUntil: 0,
    });
    await checkForUpdates({ silent: true });
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  test("expired snooze clears while downloaded on silent and force checks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    let now = 1_000;
    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0" });
        return { updateInfo: { version: "0.3.0" } };
      }),
      downloadUpdate: mock(async () => {
        emit("update-downloaded", { version: "0.3.0" });
      }),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
      now: () => now,
    });

    await checkForUpdates({ silent: false });
    await downloadUpdate();
    expect(getUpdateStatus().phase).toBe("downloaded");
    expect(updater.autoInstallOnAppQuit).toBe(true);

    await snoozeUpdate();
    expect(getUpdateStatus().snoozed).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);

    // Expire snooze; silent re-check must re-assert downloaded + clear snooze
    // (the early-return path must not preserve stale status.snoozed).
    now = 1_000 + UPDATE_SNOOZE_MS + 1;
    const silent = await checkForUpdates({ silent: true });
    expect(silent.phase).toBe("downloaded");
    expect(silent.snoozed).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);

    await snoozeUpdate();
    expect(updater.autoInstallOnAppQuit).toBe(false);
    // About force-check clears snooze while package stays staged.
    const forced = await checkForUpdates({ silent: false });
    expect(forced.phase).toBe("downloaded");
    expect(forced.snoozed).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  test("expired snooze clears while downloading on silent check", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    let now = 1_000;
    let resolveDownload: () => void = () => undefined;
    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0" });
        return { updateInfo: { version: "0.3.0" } };
      }),
      downloadUpdate: mock(
        () =>
          new Promise<void>((resolve) => {
            resolveDownload = () => {
              emit("update-downloaded", { version: "0.3.0" });
              resolve();
            };
          }),
      ),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
      now: () => now,
    });

    await checkForUpdates({ silent: false });
    const downloadPromise = downloadUpdate();
    await Promise.resolve();
    expect(getUpdateStatus().phase).toBe("downloading");

    await snoozeUpdate();
    expect(getUpdateStatus().snoozed).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);

    now = 1_000 + UPDATE_SNOOZE_MS + 1;
    const silent = await checkForUpdates({ silent: true });
    expect(silent.phase).toBe("downloading");
    expect(silent.snoozed).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);

    resolveDownload();
    await downloadPromise;
    // Ready banner clears any lingering snooze and keeps install-on-quit on.
    expect(getUpdateStatus().phase).toBe("downloaded");
    expect(getUpdateStatus().snoozed).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  test("silent check failure while downloading preserves in-flight progress", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    let resolveDownload: () => void = () => undefined;
    let checkCalls = 0;
    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        checkCalls += 1;
        if (checkCalls === 1) {
          emit("update-available", { version: "0.3.0" });
          return { updateInfo: { version: "0.3.0" } };
        }
        // Simulate checking-for-update clearing progress, then a network error.
        emit("checking-for-update");
        throw new Error("offline during re-check");
      }),
      downloadUpdate: mock(
        () =>
          new Promise<void>((resolve) => {
            resolveDownload = () => {
              emit("update-downloaded", { version: "0.3.0" });
              resolve();
            };
          }),
      ),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
    });

    await checkForUpdates({ silent: false });
    const downloadPromise = downloadUpdate();
    await Promise.resolve();
    emit("download-progress", { percent: 42, transferred: 42, total: 100 });
    expect(getUpdateStatus().phase).toBe("downloading");
    expect(getUpdateStatus().download?.percent).toBe(42);

    const failed = await checkForUpdates({ silent: true });
    expect(failed.phase).toBe("downloading");
    expect(failed.download?.percent).toBe(42);
    expect(failed.errorMessage).toBeUndefined();

    resolveDownload();
    await downloadPromise;
    expect(getUpdateStatus().phase).toBe("downloaded");
  });

  test("update-downloaded re-enables autoInstallOnAppQuit after a prior snooze", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-update-"));
    setUserDataDirForTests(tempDir);
    setAnalyticsCaptureForTests({
      capture: () => undefined,
      shutdown: async () => undefined,
    });

    const { updater, emit } = createMockUpdater({
      checkForUpdates: mock(async () => {
        emit("update-available", { version: "0.3.0" });
        return { updateInfo: { version: "0.3.0" } };
      }),
      downloadUpdate: mock(async () => {
        emit("update-downloaded", { version: "0.3.0" });
      }),
    });

    initAutoUpdate({
      isPackaged: true,
      currentVersion: "0.2.0",
      createUpdater: () => updater,
      now: () => 1_000,
    });

    await checkForUpdates({ silent: false });
    await snoozeUpdate();
    expect(updater.autoInstallOnAppQuit).toBe(false);

    await downloadUpdate();
    expect(getUpdateStatus().phase).toBe("downloaded");
    expect(getUpdateStatus().snoozed).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });
});
