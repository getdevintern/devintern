/**
 * Electron main process entry.
 */

import { BrowserWindow, app } from "electron";
import { appOpenedProps, shutdownAnalytics, track } from "./analytics.ts";
import {
  captureError,
  initErrorTrackingFromSettings,
  shutdownErrorTracking,
} from "./error-tracking.ts";
import {
  initAutoUpdate,
  resolveElectronAutoUpdater,
  startAutoUpdateChecks,
  stopAutoUpdateChecks,
} from "./auto-update.ts";
import { registerIpcHandlers } from "./ipc.ts";
import { installAppMenu } from "./menu.ts";
import { augmentPath } from "./path-fix.ts";
import { disposeQuickCapture, syncQuickCaptureRegistration } from "./quick-capture.ts";
import { createWindow } from "./window.ts";

augmentPath();

// Report main-process crashes and unhandled rejections to Sentry (no-op
// without a baked DSN). We keep the app alive — Electron decides on quit.
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught exception:", error);
  void captureError(error);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
  void captureError(reason);
});

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  void initErrorTrackingFromSettings(app.getVersion());

  // Claim the application menu before Electron's default `will-finish-launching`
  // handler installs `role: "appMenu"` (native About → "Electron" in dev).
  installAppMenu({ createWindow });

  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(async () => {
    // Re-apply identity now that `app.getVersion()` is fully resolved.
    installAppMenu({ createWindow });
    registerIpcHandlers({ createWindow });
    // Register the Quick Capture global shortcut per persisted settings.
    // Registration failures surface through Settings; never block startup.
    void syncQuickCaptureRegistration();

    if (app.isPackaged) {
      // Dynamic import: unpackaged/dev never loads electron-updater.
      // Do NOT destructure `{ autoUpdater }` from the import — CJS/ESM interop
      // often leaves the named export undefined (electron-builder#7976).
      const electronUpdater = await import("electron-updater");
      const autoUpdater = resolveElectronAutoUpdater(electronUpdater);
      initAutoUpdate({
        isPackaged: true,
        currentVersion: app.getVersion(),
        createUpdater: () => autoUpdater,
      });
      startAutoUpdateChecks();
    } else {
      initAutoUpdate({
        isPackaged: false,
        currentVersion: app.getVersion(),
      });
    }

    createWindow();
    void track("app_opened", appOpenedProps(app.getVersion()));

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    stopAutoUpdateChecks();
    disposeQuickCapture();
    void shutdownAnalytics();
    void shutdownErrorTracking();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
