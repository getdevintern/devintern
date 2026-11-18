import type { RunActivity, RunOrigin } from "@/lib/api";

export type ActivityMetric = "starts" | "busyMs";

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Dense 7 × 24 grid (weekday 0 = Monday) of one metric, optionally limited to one origin. */
export function activityGrid(
  activity: RunActivity,
  metric: ActivityMetric,
  origin: RunOrigin | "all" = "all",
): number[][] {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const cell of activity.cells) {
    if (origin !== "all" && cell.origin !== origin) {
      continue;
    }
    const row = grid[cell.weekday];
    if (row && cell.hour >= 0 && cell.hour < 24) {
      row[cell.hour] = (row[cell.hour] ?? 0) + cell[metric];
    }
  }
  return grid;
}

/** Column totals of a 7 × 24 grid: the metric per hour of day. */
export function hourTotals(grid: number[][]): number[] {
  return Array.from({ length: 24 }, (_, hour) =>
    grid.reduce((sum, row) => sum + (row[hour] ?? 0), 0),
  );
}

/**
 * Intensity step 0–4 for a value against the grid maximum: 0 only for empty
 * cells, so any activity stays visible against the empty-cell color.
 */
export function intensityStep(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) {
    return 0;
  }
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 1 | 2 | 3 | 4;
}

/** The `length`-hour block (wrapping past midnight) with the least total; ties go earliest. */
export function quietestWindow(
  hours: number[],
  length: number,
): { startHour: number; total: number } {
  let best = { startHour: 0, total: Number.POSITIVE_INFINITY };
  for (let start = 0; start < 24; start += 1) {
    let total = 0;
    for (let offset = 0; offset < length; offset += 1) {
      total += hours[(start + offset) % 24] ?? 0;
    }
    if (total < best.total) {
      best = { startHour: start, total };
    }
  }
  return best;
}

/** `HH:00` for an hour of day (wraps past 24). */
export function formatHour(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, "0")}:00`;
}

/** Origins with any recorded activity, busiest first. */
export function activeOrigins(activity: RunActivity): RunOrigin[] {
  const totals = new Map<RunOrigin, number>();
  for (const cell of activity.cells) {
    totals.set(cell.origin, (totals.get(cell.origin) ?? 0) + cell.starts);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([origin]) => origin);
}

/** The viewer's IANA timezone, or null when the browser does not expose one. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function offsetAt(timeZone: string, epochMs: number): string | null {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(epochMs)
        .find((part) => part.type === "timeZoneName")?.value ?? null
    );
  } catch {
    return null;
  }
}

/**
 * True when two IANA names keep the same clock (e.g. `Asia/Saigon` and
 * `Asia/Ho_Chi_Minh`), judged by their UTC offsets across a year so DST
 * differences count.
 */
export function sameClock(a: string, b: string, now: number = Date.now()): boolean {
  if (a === b) {
    return true;
  }
  const MONTH_MS = 30 * 86_400_000;
  for (let month = 0; month < 12; month += 1) {
    const at = now + month * MONTH_MS;
    const offsetA = offsetAt(a, at);
    if (offsetA === null || offsetA !== offsetAt(b, at)) {
      return false;
    }
  }
  return true;
}
