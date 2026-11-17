import { describe, expect, test } from "bun:test";

import type { RunActivity } from "@/lib/api";
import {
  activeOrigins,
  activityGrid,
  formatHour,
  hourTotals,
  intensityStep,
  quietestWindow,
  sameClock,
} from "@/lib/run-activity";

const activity: RunActivity = {
  timezone: "UTC",
  cells: [
    { origin: "task", weekday: 0, hour: 9, starts: 3, busyMs: 1000 },
    { origin: "scheduled", weekday: 0, hour: 9, starts: 1, busyMs: 500 },
    { origin: "scheduled", weekday: 6, hour: 2, starts: 2, busyMs: 0 },
  ],
};

describe("run activity helpers", () => {
  test("activityGrid sums origins into a dense grid and filters by origin", () => {
    const all = activityGrid(activity, "starts");
    expect(all).toHaveLength(7);
    expect(all[0]?.[9]).toBe(4);
    expect(all[6]?.[2]).toBe(2);
    expect(activityGrid(activity, "busyMs", "scheduled")[0]?.[9]).toBe(500);
    expect(hourTotals(all)[9]).toBe(4);
  });

  test("intensityStep keeps any activity above the empty step", () => {
    expect(intensityStep(0, 10)).toBe(0);
    expect(intensityStep(0.1, 10)).toBe(1);
    expect(intensityStep(10, 10)).toBe(4);
    expect(intensityStep(5, 0)).toBe(0);
  });

  test("quietestWindow wraps midnight and formatHour wraps 24", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => (hour === 23 || hour < 3 ? 0 : 1));
    expect(quietestWindow(hours, 4)).toEqual({ startHour: 23, total: 0 });
    expect(formatHour(24)).toBe("00:00");
    expect(formatHour(9)).toBe("09:00");
  });

  test("activeOrigins orders by starts", () => {
    expect(activeOrigins(activity)).toEqual(["task", "scheduled"]);
  });

  test("sameClock treats zone aliases as equal and DST zones as different", () => {
    expect(sameClock("Asia/Saigon", "Asia/Ho_Chi_Minh")).toBe(true);
    expect(sameClock("Europe/Berlin", "Europe/Paris")).toBe(true);
    expect(sameClock("Europe/London", "UTC")).toBe(false);
    expect(sameClock("UTC", "Mars/Olympus")).toBe(false);
  });
});
