const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isInt(field: string): boolean {
  return /^\d+$/.test(field);
}

function weekdayLabel(field: string): string | undefined {
  if (field === "1-5") return "Weekdays";
  if (field === "0,6" || field === "6,0") return "Weekends";
  const days = field.split(",");
  if (!days.every((day) => isInt(day) && Number(day) <= 7)) return undefined;
  const names = days.map((day) => DAY_NAMES[Number(day) % 7]);
  if (names.length === 1) return `${names[0]}s`;
  return days.map((day) => DAY_SHORT[Number(day) % 7]).join(", ");
}

function humanizeCron(fields: string[]): string | undefined {
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = fields;
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (hour === "*" && dom === "*" && month === "*" && dow === "*") {
    if (everyMinutes) return `Every ${everyMinutes[1]}m`;
    if (minute === "*") return "Every minute";
  }
  if (!isInt(minute) || Number(minute) > 59 || dom.includes("/") || month !== "*") {
    return undefined;
  }
  if (hour === "*" && dom === "*" && dow === "*") {
    return minute === "0" ? "Hourly" : `Hourly at :${pad(Number(minute))}`;
  }
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (everyHours && dom === "*" && dow === "*" && minute === "0") {
    return `Every ${everyHours[1]}h`;
  }
  return humanizeAtTime(`${hour}:${minute}`, dom, dow);
}

function humanizeAtTime(hourMinute: string, dom: string, dow: string): string | undefined {
  const [hour = "", minute = ""] = hourMinute.split(":");
  if (!isInt(hour) || Number(hour) > 23) return undefined;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (dom === "*" && dow === "*") return `Daily ${time}`;
  if (dom === "*") {
    const label = weekdayLabel(dow);
    return label ? `${label} ${time}` : undefined;
  }
  if (dow === "*" && isInt(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
    return `Monthly on day ${Number(dom)}, ${time}`;
  }
  return undefined;
}

/**
 * Humanize a common cron expression or interval ("6h", "30m") into short
 * operator-friendly text. Returns undefined when the pattern is not recognized
 * so callers can fall back to the raw value.
 */
export function humanizeSchedule(schedule: string): string | undefined {
  const value = schedule.trim();
  const interval = /^(\d+)\s*([smhd])$/i.exec(value);
  if (interval) {
    return `Every ${interval[1]}${(interval[2] ?? "").toLowerCase()}`;
  }
  const fields = value.split(/\s+/);
  return fields.length === 5 ? humanizeCron(fields) : undefined;
}

/** Relative description of a future instant: "in 6h", "Tomorrow 04:00", "Mon 08:00". */
export function formatNextRun(epochMs: number, now: number = Date.now()): string {
  const diff = epochMs - now;
  if (diff < 60_000) return "Due now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 360) {
    const rest = minutes % 60;
    return `in ${Math.floor(minutes / 60)}h${rest ? ` ${rest}m` : ""}`;
  }
  const target = new Date(epochMs);
  const today = new Date(now);
  const time = `${pad(target.getHours())}:${pad(target.getMinutes())}`;
  const dayDiff = Math.round(
    (new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  );
  if (dayDiff === 0) return `in ${Math.round(minutes / 60)}h`;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  if (dayDiff < 7) return `${DAY_SHORT[target.getDay()]} ${time}`;
  return `${target.toLocaleString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
