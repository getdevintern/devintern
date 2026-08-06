/**
 * Main BrowserWindow factory — shared by app startup and menu-driven window creation.
 */

import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

const isDev = !!process.env.ELECTRON_RENDERER_URL;

export function createWindow(): BrowserWindow {
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
