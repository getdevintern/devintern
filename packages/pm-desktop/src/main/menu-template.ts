/**
 * Pure application-menu template builder (no Electron runtime import).
 */

import type { MenuItemConstructorOptions } from "electron";
import { ABOUT_PRODUCT_NAME, APP_DISPLAY_NAME } from "../shared/about.ts";

export interface MenuBuildOptions {
  isMac: boolean;
  /** When true, View menu includes reload / force-reload / DevTools (dev builds only). */
  isDev: boolean;
  onAbout: () => void;
}

function buildViewSubmenu(isDev: boolean): MenuItemConstructorOptions[] {
  const submenu: MenuItemConstructorOptions[] = [];
  if (isDev) {
    submenu.push(
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
    );
  }
  submenu.push(
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  );
  return submenu;
}

/** Pure template builder — unit-tested without constructing a live Electron Menu. */
export function buildMenuTemplate({
  isMac,
  isDev,
  onAbout,
}: MenuBuildOptions): MenuItemConstructorOptions[] {
  // Intentionally no `role: "about"` — that opens Electron's native About
  // panel (shows "Electron" + runtime version in unpackaged dev) and ignores
  // `click`. Custom click opens the in-app About dialog instead.
  const aboutItem: MenuItemConstructorOptions = {
    id: "about",
    label: `About ${ABOUT_PRODUCT_NAME}`,
    click: onAbout,
  };

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: APP_DISPLAY_NAME,
      submenu: [
        aboutItem,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  } else {
    template.push({
      label: "File",
      submenu: [{ role: "quit" }],
    });
  }

  template.push(
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? ([{ role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }] as const)
          : ([{ role: "delete" }, { type: "separator" }, { role: "selectAll" }] as const)),
      ],
    },
    {
      label: "View",
      submenu: buildViewSubmenu(isDev),
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? ([{ type: "separator" }, { role: "front" }] as const)
          : ([{ role: "close" }] as const)),
      ],
    },
  );

  if (!isMac) {
    template.push({
      label: "Help",
      submenu: [aboutItem],
    });
  }

  return template;
}
