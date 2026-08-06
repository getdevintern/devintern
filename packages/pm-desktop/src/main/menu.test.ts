import { describe, expect, test } from "bun:test";
import { ABOUT_PRODUCT_NAME, APP_DISPLAY_NAME } from "../shared/about.ts";
import { buildMenuTemplate } from "./menu-template.ts";

function submenuLabels(submenu: unknown): string[] {
  if (!Array.isArray(submenu)) return [];
  return submenu
    .map((item) =>
      item && typeof item === "object" && "label" in item
        ? String((item as { label: string }).label)
        : null,
    )
    .filter((label): label is string => label !== null);
}

function submenuRoles(submenu: unknown): string[] {
  if (!Array.isArray(submenu)) return [];
  return submenu
    .map((item) =>
      item && typeof item === "object" && "role" in item
        ? String((item as { role: string }).role)
        : null,
    )
    .filter((role): role is string => role !== null);
}

function viewMenuRoles(isDev: boolean): string[] {
  const template = buildMenuTemplate({ isMac: false, isDev, onAbout: () => {} });
  const viewMenu = template.find((item) => item.label === "View");
  return submenuRoles(viewMenu?.submenu);
}

describe("buildMenuTemplate", () => {
  test("places About under the app menu on macOS", () => {
    const template = buildMenuTemplate({ isMac: true, isDev: false, onAbout: () => {} });
    const labels = template.map((item) => item.label);
    expect(labels[0]).toBe(APP_DISPLAY_NAME);
    expect(labels).not.toContain("Help");

    const appMenu = template[0];
    expect(submenuLabels(appMenu?.submenu)).toContain(`About ${ABOUT_PRODUCT_NAME}`);
  });

  test("About menu item uses click and never role:about", () => {
    const template = buildMenuTemplate({ isMac: true, isDev: false, onAbout: () => {} });
    const submenu = Array.isArray(template[0]?.submenu) ? template[0].submenu : [];
    const aboutItem = submenu.find(
      (item) =>
        item &&
        typeof item === "object" &&
        "label" in item &&
        item.label === `About ${ABOUT_PRODUCT_NAME}`,
    );
    expect(aboutItem).toBeTruthy();
    expect(aboutItem && typeof aboutItem === "object" && "role" in aboutItem).toBe(false);
    expect(aboutItem && typeof aboutItem === "object" && "click" in aboutItem).toBe(true);
    expect(aboutItem && typeof aboutItem === "object" && "id" in aboutItem && aboutItem.id).toBe(
      "about",
    );
  });

  test("places About under Help on Windows/Linux", () => {
    const template = buildMenuTemplate({ isMac: false, isDev: false, onAbout: () => {} });
    const labels = template.map((item) => item.label);
    expect(labels).not.toContain(APP_DISPLAY_NAME);
    expect(labels).toContain("File");
    expect(labels).toContain("Help");

    const helpMenu = template.find((item) => item.label === "Help");
    expect(submenuLabels(helpMenu?.submenu)).toEqual([`About ${ABOUT_PRODUCT_NAME}`]);
  });

  test("includes File → Exit on Windows/Linux", () => {
    const template = buildMenuTemplate({ isMac: false, isDev: false, onAbout: () => {} });
    const fileMenu = template.find((item) => item.label === "File");
    expect(submenuRoles(fileMenu?.submenu)).toEqual(["quit"]);
  });

  test("About click invokes the provided callback", () => {
    let aboutClicks = 0;
    const template = buildMenuTemplate({
      isMac: false,
      isDev: false,
      onAbout: () => {
        aboutClicks += 1;
      },
    });
    const helpMenu = template.find((item) => item.label === "Help");
    const submenu = Array.isArray(helpMenu?.submenu) ? helpMenu.submenu : [];
    const aboutItem = submenu.find(
      (item) =>
        item &&
        typeof item === "object" &&
        "label" in item &&
        item.label === `About ${ABOUT_PRODUCT_NAME}`,
    );
    expect(aboutItem && typeof aboutItem === "object" && "click" in aboutItem).toBe(true);
    if (aboutItem && typeof aboutItem === "object" && "click" in aboutItem) {
      const click = aboutItem.click as () => void;
      click();
    }
    expect(aboutClicks).toBe(1);
  });

  test("View menu omits reload and DevTools in packaged builds", () => {
    expect(viewMenuRoles(false)).toEqual(["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]);
  });

  test("View menu includes reload and DevTools in dev builds", () => {
    expect(viewMenuRoles(true)).toEqual([
      "reload",
      "forceReload",
      "toggleDevTools",
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "togglefullscreen",
    ]);
  });
});
