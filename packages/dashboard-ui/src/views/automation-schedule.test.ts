import { expect, test } from "bun:test";

import { formatNextRun, humanizeSchedule } from "@/views/automation-schedule";

test("humanizes common cron patterns", () => {
  expect(humanizeSchedule("0 4 * * *")).toBe("Daily 04:00");
  expect(humanizeSchedule("0 8 * * 1")).toBe("Mondays 08:00");
  expect(humanizeSchedule("30 9 * * 1-5")).toBe("Weekdays 09:30");
  expect(humanizeSchedule("0 */12 * * *")).toBe("Every 12h");
  expect(humanizeSchedule("*/15 * * * *")).toBe("Every 15m");
  expect(humanizeSchedule("0 * * * *")).toBe("Hourly");
  expect(humanizeSchedule("0 6 1 * *")).toBe("Monthly on day 1, 06:00");
  expect(humanizeSchedule("0 9 * * 1,3,5")).toBe("Mon, Wed, Fri 09:00");
});

test("humanizes interval shorthand", () => {
  expect(humanizeSchedule("6h")).toBe("Every 6h");
  expect(humanizeSchedule("30m")).toBe("Every 30m");
});

test("returns undefined for unrecognized patterns", () => {
  expect(humanizeSchedule("*/5 1-6 29-31 11-12 0-6")).toBeUndefined();
  expect(humanizeSchedule("0 4 * *")).toBeUndefined();
  expect(humanizeSchedule("nonsense")).toBeUndefined();
});

test("formats next run relative to now", () => {
  const now = new Date(2026, 10, 12, 10, 0, 0).getTime();
  expect(formatNextRun(now + 10_000, now)).toBe("Due now");
  expect(formatNextRun(now + 25 * 60_000, now)).toBe("in 25m");
  expect(formatNextRun(now + 90 * 60_000, now)).toBe("in 1h 30m");
  expect(formatNextRun(new Date(2026, 10, 13, 4, 0).getTime(), now)).toBe("Tomorrow 04:00");
  expect(formatNextRun(new Date(2026, 10, 16, 8, 0).getTime(), now)).toBe("Mon 08:00");
});
