/**
 * Electron main process entry.
 */

import { join } from "node:path";
import { BrowserWindow, app, shell } from "electron";
import { registerIpcHandlers } from "./ipc.ts";
import { augmentPath } from "./path-fix.ts";

augmentPath();

const isDev = !!process.env.ELECTRON_RENDERER_URL;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "DevIntern PM",
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // External links open in the system browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(() => {
    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
