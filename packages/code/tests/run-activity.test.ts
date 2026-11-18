import { describe, expect, test } from "bun:test";

import {
  computeRunActivity,
  hourProfile,
  isValidTimeZone,
  quietestWindow,
} from "../src/lib/state/run-activity";

const HOUR = 3_600_000;
// Monday 2026-11-16 09:00 UTC.
const MON_9_UTC = Date.UTC(2026, 10, 16, 9);

describe("computeRunActivity", () => {
  test("buckets starts and spreads busy time across local hours", () => {
    const activity = computeRunActivity(
      [
        // 09:30–11:15 UTC: 30m in 09, 60m in 10, 15m in 11.
        {
          origin: "task",
          status: "succeeded",
          started_at: MON_9_UTC + HOUR / 2,
          finished_at: MON_9_UTC + 2 * HOUR + HOUR / 4,
        },
        { origin: "scheduled", status: "failed", started_at: MON_9_UTC, finished_at: null },
      ],
      "UTC",
      0,
      MON_9_UTC + 10 * HOUR,
    );
    expect(activity.timezone).toBe("UTC");
    const task = activity.cells.filter((cell) => cell.origin === "task");
    expect(task.map((cell) => [cell.weekday, cell.hour, cell.starts, cell.busyMs])).toEqual([
      [0, 9, 1, HOUR / 2],
      [0, 10, 0, HOUR],
      [0, 11, 0, HOUR / 4],
    ]);
    // A finished run with no end time contributes a start but no busy time.
    const scheduled = activity.cells.filter((cell) => cell.origin === "scheduled");
    expect(scheduled).toEqual([{ origin: "scheduled", weekday: 0, hour: 9, starts: 1, busyMs: 0 }]);
  });

  test("expresses hours in the requested timezone, including 30-minute offsets", () => {
    const row = { origin: "task", status: "succeeded", started_at: MON_9_UTC, finished_at: null };
    // 09:00 UTC = 14:30 IST; 09:00 UTC Monday = 20:00 Monday in Sydney (AEDT, +11).
    expect(computeRunActivity([row], "Asia/Kolkata", 0, MON_9_UTC).cells[0]).toMatchObject({
      weekday: 0,
      hour: 14,
    });
    // 23:00 UTC Sunday → Monday 10:00 in Sydney.
    const sunday = { ...row, started_at: MON_9_UTC - 10 * HOUR };
    expect(computeRunActivity([sunday], "Australia/Sydney", 0, MON_9_UTC).cells[0]).toMatchObject({
      weekday: 0,
      hour: 10,
    });
    expect(computeRunActivity([sunday], "UTC", 0, MON_9_UTC).cells[0]).toMatchObject({
      weekday: 6,
      hour: 23,
    });
  });

  test("counts an in-progress run up to now and clips to the window start", () => {
    const activity = computeRunActivity(
      [{ origin: "task", status: "in_progress", started_at: MON_9_UTC, finished_at: null }],
      "UTC",
      MON_9_UTC + HOUR / 2,
      MON_9_UTC + HOUR + HOUR / 2,
    );
    expect(activity.cells.map((cell) => [cell.hour, cell.starts, cell.busyMs])).toEqual([
      [9, 1, HOUR / 2],
      [10, 0, HOUR / 2],
    ]);
  });
});

describe("hour helpers", () => {
  test("hourProfile sums across weekdays and quietestWindow wraps midnight", () => {
    const activity = computeRunActivity(
      [
        { origin: "task", status: "succeeded", started_at: MON_9_UTC, finished_at: null },
        {
          origin: "ci_fix",
          status: "succeeded",
          started_at: MON_9_UTC + 24 * HOUR,
          finished_at: null,
        },
      ],
      "UTC",
      0,
      MON_9_UTC + 48 * HOUR,
    );
    const starts = hourProfile(activity, "starts");
    expect(starts[9]).toBe(2);
    expect(starts.reduce((a, b) => a + b, 0)).toBe(2);

    const hours = Array.from({ length: 24 }, (_, hour) => (hour >= 2 && hour < 22 ? 5 : 0));
    expect(quietestWindow(hours, 4)).toEqual({ startHour: 22, total: 0 });
  });

  test("isValidTimeZone rejects unknown zones", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
