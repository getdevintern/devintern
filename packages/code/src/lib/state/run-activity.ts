/**
 * One non-empty weekday × hour bucket of run activity for a single origin,
 * in local time of {@link RunActivity.timezone}.
 */
export interface RunActivityCell<O extends string = string> {
  origin: O;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** 0–23, local hour. */
  hour: number;
  /** Runs that started in this hour. */
  starts: number;
  /** Agent time spent running in this hour; overlapping runs add up. */
  busyMs: number;
}

/** When runs happen: sparse weekday × hour buckets split by origin. */
export interface RunActivity<O extends string = string> {
  /** IANA timezone the buckets are expressed in. */
  timezone: string;
  cells: RunActivityCell<O>[];
}

/** Inputs for {@link computeRunActivity}: one row per run. */
export interface RunActivityRow<O extends string = string> {
  origin: O;
  /** Run status; only `in_progress` runs without `finished_at` count busy time. */
  status: string;
  started_at: number;
  finished_at: number | null;
}

/**
 * Local offsets are whole multiples of 15 minutes in every IANA zone in use,
 * so a local hour never changes inside a UTC-aligned 15-minute slice.
 */
const SLICE_MS = 15 * 60_000;
/** Bound the busy-time walk for a run left open far longer than any real run. */
const MAX_BUSY_SPAN_MS = 7 * 86_400_000;

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** The worker host's IANA timezone (cron automations fire in this zone). */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** True when `timeZone` is an IANA zone the runtime can format in. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Bucket runs into local weekday × hour cells.
 *
 * Starts count each run once in the hour it was picked up. Busy time spreads
 * each run's `[started_at, finished_at]` across the hours it spans (an
 * in-progress run counts up to `now`), clipped to `[since, now]`.
 *
 * @param rows - Runs that started at or after `since`
 * @param timeZone - IANA zone to express hours in (must be valid)
 * @param since - Window start (epoch ms)
 * @param now - Current time (epoch ms)
 */
export function computeRunActivity<O extends string>(
  rows: RunActivityRow<O>[],
  timeZone: string,
  since: number,
  now: number,
): RunActivity<O> {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  const slotCache = new Map<number, number>();
  /** Local slot index (weekday * 24 + hour) for the 15-minute slice holding `epochMs`. */
  const slotOf = (epochMs: number): number => {
    const slice = Math.floor(epochMs / SLICE_MS);
    const cached = slotCache.get(slice);
    if (cached !== undefined) {
      return cached;
    }
    let weekday = 0;
    let hour = 0;
    for (const part of format.formatToParts(slice * SLICE_MS)) {
      if (part.type === "weekday") {
        weekday = WEEKDAYS[part.value] ?? 0;
      } else if (part.type === "hour") {
        hour = Number(part.value) % 24;
      }
    }
    const slot = weekday * 24 + hour;
    slotCache.set(slice, slot);
    return slot;
  };

  const cells = new Map<string, RunActivityCell<O>>();
  const cellFor = (origin: O, slot: number): RunActivityCell<O> => {
    const key = `${origin}:${slot}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { origin, weekday: Math.floor(slot / 24), hour: slot % 24, starts: 0, busyMs: 0 };
      cells.set(key, cell);
    }
    return cell;
  };

  for (const row of rows) {
    cellFor(row.origin, slotOf(row.started_at)).starts += 1;

    const rawEnd = row.finished_at ?? (row.status === "in_progress" ? now : null);
    if (rawEnd === null) {
      continue;
    }
    const start = Math.max(row.started_at, since);
    const end = Math.min(rawEnd, now, start + MAX_BUSY_SPAN_MS);
    for (let t = start; t < end;) {
      const next = Math.min((Math.floor(t / SLICE_MS) + 1) * SLICE_MS, end);
      cellFor(row.origin, slotOf(t)).busyMs += next - t;
      t = next;
    }
  }

  return {
    timezone: timeZone,
    cells: [...cells.values()].sort(
      (a, b) => a.weekday - b.weekday || a.hour - b.hour || a.origin.localeCompare(b.origin),
    ),
  };
}

/** Sum a metric per local hour of day (0–23) across weekdays and origins. */
export function hourProfile(activity: RunActivity, metric: "starts" | "busyMs"): number[] {
  const hours = Array.from({ length: 24 }, () => 0);
  for (const cell of activity.cells) {
    hours[cell.hour] += cell[metric];
  }
  return hours;
}

/**
 * The `length`-hour block (wrapping past midnight) with the least total of
 * `hours`; ties go to the earliest start hour.
 */
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
