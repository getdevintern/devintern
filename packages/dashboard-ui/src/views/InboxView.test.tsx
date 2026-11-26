/**
 * Inbox in a real DOM: tabs and the resolved toggle pick the right rows,
 * grouped rows show their count, row actions POST to the right endpoints,
 * mute asks first, and `work_spawned` rows expand into live spawned work.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";

import {
  NotificationHarness,
  PR_OPENED,
  RESOLVED,
  WORK_SPAWNED,
} from "@/components/notifications/notification-fixtures.test-helpers";
import { InboxView } from "@/views/InboxView";

let page: NotificationHarness;

beforeEach(() => {
  page = new NotificationHarness();
});

afterEach(async () => {
  await page.close();
});

async function renderInbox(): Promise<void> {
  await page.render(createElement(InboxView));
}

test("Needs you lists unresolved high-severity rows, newest first", async () => {
  await renderInbox();
  expect(page.inboxTitles()).toEqual([
    "Sentry issue escalated 88 times",
    "linear source product: authentication failed",
  ]);
  expect(page.calls.map((call) => call.url)).toContain(
    "/api/notifications?unresolved=true&severity=high&limit=50",
  );
});

test("Activity and All tabs switch the filter", async () => {
  await renderInbox();
  await page.click(page.button("Activity"));
  expect(page.inboxTitles()).toEqual([WORK_SPAWNED.title, PR_OPENED.title]);
  expect(page.button("Activity").getAttribute("aria-selected")).toBe("true");
  await page.click(page.button("All"));
  expect(page.inboxTitles()).toHaveLength(4);
  expect(page.inboxTitles()).not.toContain(RESOLVED.title);
});

test("Show resolved adds resolved rows and marks them", async () => {
  await renderInbox();
  await page.click(page.body.querySelector("#inbox-show-resolved"));
  expect(page.inboxTitles()).toContain(RESOLVED.title);
  const resolvedRow = page.body.querySelector(`li[data-notification-id="${RESOLVED.id}"]`);
  expect(resolvedRow?.textContent).toContain("Resolved");
  // A resolved row offers no Resolve action.
  expect(resolvedRow?.textContent).not.toContain("Mark read");
  expect(
    [...(resolvedRow?.querySelectorAll("button") ?? [])].some(
      (button) => button.textContent === "Resolve",
    ),
  ).toBe(false);
});

test("grouped rows show their count; unread rows say so in text", async () => {
  await renderInbox();
  const grouped = page.body.querySelector('li[data-notification-id="1"]');
  expect(grouped?.querySelector('[data-slot="notification-count"]')?.textContent).toContain("×88");
  expect(grouped?.getAttribute("data-unread")).toBe("true");
  expect(grouped?.textContent).toContain("New");
  expect(grouped?.textContent).toContain("acme/web");
  expect(grouped?.querySelector('a[href="#/runs/30"]')?.textContent).toBe("Run #30");
  const read = page.body.querySelector('li[data-notification-id="2"]');
  expect(read?.getAttribute("data-unread")).toBeNull();
  expect(read?.querySelector('[data-slot="notification-count"]')).toBeNull();
});

test("mark read, resolve, and mark all read call their endpoints", async () => {
  await renderInbox();
  await page.click(page.button("Mark read: Sentry issue escalated 88 times"));
  await page.click(page.button("Resolve: linear source product: authentication failed"));
  await page.click(page.button("Mark all read"));
  expect(page.writes().map((call) => `${call.method} ${call.url}`)).toEqual([
    "POST /api/notifications/1/read",
    "POST /api/notifications/2/resolve",
    "POST /api/notifications/read-all",
  ]);
  // Each write re-fetches the open list at once.
  const reads = page.calls.filter((call) => call.url.startsWith("/api/notifications?"));
  expect(reads.length).toBeGreaterThanOrEqual(4);
});

test("mute explains what gets hidden and only posts after confirming", async () => {
  await renderInbox();
  await page.click(page.button("Mute this group: Sentry issue escalated 88 times"));
  const dialog = page.body.querySelector('[data-slot="mute-dialog"]');
  expect(dialog?.textContent).toContain("Future notifications from the same cause");
  expect(page.writes()).toEqual([]);
  await page.click(page.button("Cancel", dialog ?? page.body));
  expect(page.writes()).toEqual([]);
  expect(page.body.querySelector('[data-slot="mute-dialog"]')).toBeNull();

  await page.click(page.button("Mute this group: Sentry issue escalated 88 times"));
  await page.click(page.body.querySelector("[data-confirm-mute]"));
  expect(page.writes()).toEqual([
    {
      url: "/api/notifications/mute",
      method: "POST",
      body: { groupKey: "escalated:sentry:checkout" },
    },
  ]);
  expect(page.body.querySelector('[data-slot="mute-dialog"]')).toBeNull();
});

test("work_spawned rows expand into the run's spawned work with live status", async () => {
  await renderInbox();
  await page.click(page.button("Activity"));
  const toggle = page.button("Show spawned work");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await page.click(toggle);
  expect(page.calls.some((call) => call.url === "/api/runs/41")).toBe(true);
  const row = page.body.querySelector(`li[data-notification-id="${WORK_SPAWNED.id}"]`);
  expect(row?.textContent).toContain("Spawned work");
  expect(row?.textContent).toContain("Document the CSV export flag");
  expect(row?.textContent).toContain("succeeded");
  expect(row?.textContent).toContain("Queued");
  expect(page.button("Hide spawned work").getAttribute("aria-expanded")).toBe("true");
});

test("empty tabs teach what lands there", async () => {
  await page.close();
  page = new NotificationHarness([]);
  await renderInbox();
  expect(page.body.textContent).toContain("Nothing needs you");
  await page.click(page.button("Activity"));
  expect(page.body.textContent).toContain("No recent activity");
  await page.click(page.button("All"));
  expect(page.body.textContent).toContain("Inbox is empty");
});
