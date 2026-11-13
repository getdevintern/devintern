import { expect, test } from "bun:test";

import { formatAge } from "@/lib/utils";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("ages under a minute show seconds", () => {
  expect(formatAge(NOW - 45_000, NOW)).toBe("45s");
});

test("ages up to an hour show minutes", () => {
  expect(formatAge(NOW - 5 * MINUTE, NOW)).toBe("5m");
});

test("ages up to a day show hours", () => {
  expect(formatAge(NOW - 3 * HOUR, NOW)).toBe("3h");
});

test("older ages show days", () => {
  expect(formatAge(NOW - 2 * DAY, NOW)).toBe("2d");
});

test("a future timestamp clamps to zero", () => {
  expect(formatAge(NOW + HOUR, NOW)).toBe("0s");
});

test("formatPastTime prints the same relative, yesterday and dated forms everywhere", async () => {
  const { formatPastTime, formatAgo } = await import("./utils");
  const now = new Date(2026, 10, 13, 12, 0, 0).getTime();
  expect(formatAgo(now - 20_000, now)).toBe("just now");
  expect(formatPastTime(now - 76 * 60_000, now)).toBe("1h ago");
  expect(
    formatPastTime(new Date(2026, 10, 12, 9, 25).getTime(), now).startsWith("Yesterday "),
  ).toBe(true);
});
