/**
 * Header bell: the unread bubble and its accessible name, and the popover
 * (opens from the keyboard-focusable trigger, lists the latest open rows,
 * links to the inbox, closes on Escape).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  flush,
  NotificationHarness,
} from "@/components/notifications/notification-fixtures.test-helpers";
import {
  BellIndicator,
  bellCountText,
  bellLabel,
  NotificationBell,
} from "@/components/notifications/NotificationBell";

function bubble(counts: { unread: number; unreadHigh: number } | null): string {
  return renderToStaticMarkup(createElement(BellIndicator, { counts }));
}

test("no bubble when nothing is unread", () => {
  expect(bubble(null)).not.toContain('data-slot="bell-count"');
  expect(bubble({ unread: 0, unreadHigh: 0 })).not.toContain('data-slot="bell-count"');
  expect(bellLabel({ unread: 0, unreadHigh: 0 })).toBe("Notifications: none unread");
});

test("shows the unread count, capped at 99+", () => {
  const html = bubble({ unread: 7, unreadHigh: 0 });
  expect(html).toContain(">7</span>");
  expect(html).not.toContain("data-high");
  expect(bellCountText(150)).toBe("99+");
  expect(bellLabel({ unread: 7, unreadHigh: 0 })).toBe("Notifications: 7 unread");
});

test("emphasizes high-severity unread with a marker, not only color", () => {
  const html = bubble({ unread: 7, unreadHigh: 2 });
  expect(html).toContain('data-high="true"');
  expect(html).toContain("notification-bell-count-high");
  expect(html).toContain(">2!</span>");
  expect(bellLabel({ unread: 7, unreadHigh: 2 })).toBe("Notifications: 7 unread, 2 need you");
});

let page: NotificationHarness;

beforeEach(() => {
  page = new NotificationHarness();
});

afterEach(async () => {
  await page.close();
});

function trigger(): HTMLElement {
  const button = page.body.querySelector('button[aria-label^="Notifications"]');
  if (!button) throw new Error("bell trigger not found");
  return button as HTMLElement;
}

test("polls the unread count and names the bell with it", async () => {
  await page.render(createElement(NotificationBell));
  expect(page.calls.map((call) => call.url)).toContain("/api/notifications/unread-count");
  expect(trigger().getAttribute("aria-label")).toBe("Notifications: 2 unread, 1 need you");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(trigger().querySelector('[data-slot="bell-count"]')?.textContent).toBe("1!");
});

test("opens a popover with the latest open rows and a link to the inbox", async () => {
  await page.render(createElement(NotificationBell));
  await page.click(trigger());
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(page.calls.map((call) => call.url)).toContain(
    "/api/notifications?unresolved=true&limit=6",
  );
  const list = page.body.querySelector('[aria-label="Latest notifications"]');
  expect(list?.querySelectorAll("li")).toHaveLength(4);
  expect(list?.textContent).toContain("Sentry issue escalated 88 times");
  expect(list?.textContent).toContain("×88");
  expect(list?.querySelector('a[href="#/runs/30"]')).toBeTruthy();
  const inbox = [...page.body.querySelectorAll("a")].find((a) => a.textContent === "Open inbox");
  expect(inbox?.getAttribute("href")).toBe("#/inbox");

  await act(async () => {
    (page.window.document.activeElement as unknown as Element | null)?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }) as unknown as Event,
    );
    await flush();
  });
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(page.body.querySelector('[aria-label="Latest notifications"]')).toBeNull();
});

test("an empty popover says so", async () => {
  await page.close();
  page = new NotificationHarness([]);
  await page.render(createElement(NotificationBell));
  expect(trigger().getAttribute("aria-label")).toBe("Notifications: none unread");
  await page.click(trigger());
  expect(page.body.textContent).toContain("Nothing open. All caught up.");
});
