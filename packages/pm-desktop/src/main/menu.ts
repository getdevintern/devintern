/**
 * Application menu: platform-standard placement for About DevIntern.
 *
 * macOS → under the app menu; Windows/Linux → under Help.
 * Selecting About notifies the focused (or first) window so the renderer
 * can open the in-app dialog without interrupting workspace state.
 *
 * Install as early as possible (before `will-finish-launching`) so Electron's
 * default menu — which uses `role: "about"` / native "Electron" About — never
 * wins in unpackaged dev.
 */

import { BrowserWindow, Menu, app } from "electron";
import { APP_DISPLAY_NAME } from "../shared/about.ts";
import { buildMenuTemplate } from "./menu-template.ts";
import { notifyShowAbout as deliverShowAbout } from "./show-about.ts";

export { buildMenuTemplate } from "./menu-template.ts";
export type { MenuBuildOptions } from "./menu-template.ts";

export interface InstallAppMenuOptions {
  createWindow: () => BrowserWindow;
}

let createWindowFn: (() => BrowserWindow) | undefined;

/** Send show-about to the focused window, or the first window if none is focused. */
export function notifyShowAbout(): void {
  deliverShowAbout({
    getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
    getAllWindows: () => BrowserWindow.getAllWindows(),
    createWindow: createWindowFn,
  });
}

/** Apply product identity used by menus / native chrome. Safe before ready. */
export function applyAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  // If anything still hits the native About path, don't show Electron.app plist.
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
  });
}

/** Install the application menu. Safe to call before `ready` on macOS. */
export function installAppMenu(options: InstallAppMenuOptions): void {
  createWindowFn = options.createWindow;
  applyAppIdentity();

  const template = buildMenuTemplate({
    isMac: process.platform === "darwin",
    isDev: !!process.env.ELECTRON_RENDERER_URL,
    onAbout: notifyShowAbout,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
