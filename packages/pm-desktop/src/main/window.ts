/**
 * Main BrowserWindow factory — shared by app startup and menu-driven window creation.
 */

import { join } from "node:path";
import { BrowserWindow, app, nativeImage, shell } from "electron";

const isDev = !!process.env.ELECTRON_RENDERER_URL;

/**
 * Path to the DevIntern brand icon (`build/icon.png`).
 * Uses `app.getAppPath()` so the same relative path works in electron-vite
 * dev (package root) and packaged asar builds.
 */
export function resolveAppIconPath(): string {
  return join(app.getAppPath(), "build/icon.png");
}

export function createWindow(): BrowserWindow {
  const iconPath = resolveAppIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  // macOS packaged apps use the .icns from the bundle; still set icon for
  // Linux window chrome and unpackaged / Windows previews.
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "DevIntern PM",
    show: false,
    ...(icon.isEmpty() ? {} : { icon }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Unpackaged macOS still shows the Electron dock icon unless we override.
  if (process.platform === "darwin" && !app.isPackaged && !icon.isEmpty()) {
    app.dock?.setIcon(icon);
  }

  window.once("ready-to-show", () => window.show());

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

  return window;
}
