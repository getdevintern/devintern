import { expect, test } from "bun:test";

import { groupCountLabel, inboxQuery, isUnread, notificationsUrl } from "@/lib/api-notifications";
import type { NotificationRecord } from "@/lib/api-notifications";

test("builds list URLs with a stable parameter order", () => {
  expect(notificationsUrl()).toBe("/api/notifications");
  expect(notificationsUrl({ limit: 5, severity: "high", unresolved: true })).toBe(
    "/api/notifications?unresolved=true&severity=high&limit=5",
  );
});

test("maps inbox tabs to severity filters and hides resolved rows unless asked", () => {
  expect(inboxQuery("needs_you", false, 50)).toEqual({
    unresolved: true,
    severity: "high",
    limit: 50,
  });
  expect(inboxQuery("activity", false, 50)).toEqual({
    unresolved: true,
    severity: "normal",
    limit: 50,
  });
  expect(inboxQuery("all", false, 50)).toEqual({ unresolved: true, limit: 50 });
  expect(inboxQuery("all", true, 100)).toEqual({ limit: 100 });
  expect(inboxQuery("needs_you", true, 50)).toEqual({ severity: "high", limit: 50 });
});

test("labels grouped counts and unread state", () => {
  expect(groupCountLabel(1)).toBeNull();
  expect(groupCountLabel(88)).toBe("×88");
  const row = { readAt: undefined, resolvedAt: undefined } as NotificationRecord;
  expect(isUnread(row)).toBe(true);
  expect(isUnread({ ...row, readAt: 1 })).toBe(false);
  expect(isUnread({ ...row, resolvedAt: 1 })).toBe(false);
});
