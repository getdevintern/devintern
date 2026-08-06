/**
 * Electron main process entry.
 */

import { BrowserWindow, app } from "electron";
import { appOpenedProps, shutdownAnalytics, track } from "./analytics.ts";
import { registerIpcHandlers } from "./ipc.ts";
import { installAppMenu } from "./menu.ts";
import { augmentPath } from "./path-fix.ts";
import { createWindow } from "./window.ts";

augmentPath();

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
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

  void app.whenReady().then(() => {
    // Re-apply identity now that `app.getVersion()` is fully resolved.
    installAppMenu({ createWindow });
    registerIpcHandlers();
    createWindow();
    void track("app_opened", appOpenedProps(app.getVersion()));

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    void shutdownAnalytics();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
