/**
 * Pure state logic behind the Overview screen and the status-strip harness
 * pill: relative times, tracker poll freshness, harness chain health, and the
 * degraded-state alerts. Kept free of React so every rule is unit-testable.
 */

import {
  formatAgo as formatAgoShared,
  formatClockTime,
  formatPastTime,
  formatSpan,
} from "@/lib/utils";
import type {
  OverviewHarnesses,
  OverviewResponse,
  OverviewTrackerSource,
  WorkerStatus,
} from "@/lib/api";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export { formatSpan };

/** A poll older than this many intervals is flagged as stale. */
export const STALE_POLL_FACTOR = 3;

/** `poll_interval_seconds` default when the config does not say. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/** "just now", "12m ago", "3h ago": the dashboard-wide relative age. */
export function formatAgo(at: number, now: number): string {
  return formatAgoShared(at, now);
}

/** "in 2h 10m", or "any moment" once the instant has passed. */
export function formatIn(at: number, now: number): string {
  const diff = at - now;
  if (diff < 30 * SECOND) return "any moment";
  // Round up so a window ending in 2h 9m 40s reads "in 2h 10m", not "2h 9m".
  return `in ${formatSpan(Math.ceil(diff / MINUTE) * MINUTE)}`;
}

/**
 * Wall-clock time in the viewer's locale, without a leading zero and with the
 * locale's 12/24-hour convention: "2:30 PM" (or "14:30") today, "Tue 9:00 AM"
 * within the week, "Nov 21, 9:00 AM" beyond. Past instants print exactly like
 * the Runs page ({@link formatPastTime}).
 */
export function formatClock(at: number, now: number): string {
  if (at <= now) return formatPastTime(at, now);
  const date = new Date(at);
  const time = formatClockTime(at);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return time;
  if (Math.abs(at - now) < 6 * DAY) {
    return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** "until 2:30 PM (in 2h 10m)". */
export function formatUntil(at: number, now: number): string {
  return `until ${formatClock(at, now)} (${formatIn(at, now)})`;
}

/** Uptime of a worker from its lock `startedAt` (ISO), or null when unknown. */
export function workerUptime(worker: WorkerStatus, now: number): number | null {
  if (worker.status !== "running" || !worker.startedAt) return null;
  const started = Date.parse(worker.startedAt);
  return Number.isNaN(started) ? null : Math.max(0, now - started);
}

export type PollFreshness = "fresh" | "stale" | "never";

/**
 * Whether a tracker source is polling on schedule. A poll older than
 * {@link STALE_POLL_FACTOR} × the interval is stale; a source the worker has
 * never advanced is `never`.
 */
export function pollFreshness(
  lastPolledAt: number | undefined,
  pollIntervalSeconds: number | undefined,
  now: number,
): PollFreshness {
  if (lastPolledAt === undefined) return "never";
  const interval = (pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * SECOND;
  return now - lastPolledAt > STALE_POLL_FACTOR * interval ? "stale" : "fresh";
}

/** Sources whose poll is stale. */
export function stalePollSources(
  overview: Pick<OverviewResponse, "trackers">,
  now: number,
): OverviewTrackerSource[] {
  const { sources, pollIntervalSeconds } = overview.trackers;
  return sources.filter(
    (source) => pollFreshness(source.lastPolledAt, pollIntervalSeconds, now) === "stale",
  );
}

/** "every 60s", "every 5m", "every 1h 30m". */
export function formatInterval(seconds: number): string {
  return `every ${formatSpan(seconds * SECOND)}`;
}

/** Display names for tracker kinds as configured in `workspace.toml`. */
const TRACKER_LABELS: Record<string, string> = {
  jira: "Jira",
  linear: "Linear",
  github: "GitHub Issues",
  gitlab: "GitLab",
  trello: "Trello",
  asana: "Asana",
  "azure-devops": "Azure DevOps",
  markdown: "Markdown",
};

export function formatTracker(tracker: string): string {
  return TRACKER_LABELS[tracker] ?? tracker;
}

/** Harness chain health, condensed for the status strip pill. */
export type HarnessAlert =
  | { kind: "exhausted"; resumesAt?: number }
  | { kind: "limited"; names: string[] }
  | { kind: "unconfirmed"; names: string[] };

/** Section summary of the chain: "all healthy", "1 of 3 limited", "all limited", "health unknown". */
export function harnessSummary(harnesses: OverviewHarnesses): {
  label: string;
  tone: "neutral" | "warning";
} {
  if (!harnesses.stateAvailable) return { label: "health unknown", tone: "neutral" };
  if (harnesses.allExhausted) return { label: "all limited", tone: "warning" };
  const limited = harnesses.entries.filter((entry) => entry.state === "limited").length;
  if (limited > 0) {
    return { label: `${limited} of ${harnesses.entries.length} limited`, tone: "warning" };
  }
  const unconfirmed = harnesses.entries.filter((entry) => entry.state === "unconfirmed").length;
  if (unconfirmed > 0) {
    return {
      label:
        harnesses.entries.length === 1
          ? "quota unconfirmed"
          : `${unconfirmed} of ${harnesses.entries.length} quota unconfirmed`,
      tone: "warning",
    };
  }
  return {
    label: harnesses.entries.length === 1 ? "healthy" : "all healthy",
    tone: "neutral",
  };
}

/** Null while every harness is healthy (or its state is unknown). */
export function harnessAlert(harnesses: OverviewHarnesses): HarnessAlert | null {
  if (harnesses.allExhausted) return { kind: "exhausted", resumesAt: harnesses.resumesAt };
  const limited = harnesses.entries.filter((entry) => entry.state === "limited");
  if (limited.length > 0) return { kind: "limited", names: limited.map((entry) => entry.name) };
  const unconfirmed = harnesses.entries.filter((entry) => entry.state === "unconfirmed");
  return unconfirmed.length > 0
    ? { kind: "unconfirmed", names: unconfirmed.map((entry) => entry.name) }
    : null;
}

/** First harness whose usage window ends, i.e. the one the worker resumes with. */
export function resumingHarness(harnesses: OverviewHarnesses): string | undefined {
  let best: { name: string; until: number } | undefined;
  for (const entry of harnesses.entries) {
    if (entry.limitedUntil === undefined) continue;
    if (!best || entry.limitedUntil < best.until) {
      best = { name: entry.name, until: entry.limitedUntil };
    }
  }
  return best?.name;
}

/** Degraded states the overview raises above the fold, most severe first. */
export type OverviewAlert =
  | { kind: "config-missing"; path: string }
  | { kind: "config-invalid"; path: string; error?: string }
  | { kind: "worker-stopped"; pid?: number }
  | { kind: "harnesses-exhausted"; resumesAt?: number; resumesWith?: string }
  | { kind: "stale-polls"; sources: OverviewTrackerSource[] };

/**
 * Derive the alert stack. Stale polls are only raised while the worker runs:
 * a stopped worker explains every stale cursor on its own.
 */
export function overviewAlerts(overview: OverviewResponse, now: number): OverviewAlert[] {
  const alerts: OverviewAlert[] = [];
  if (overview.config.status === "missing") {
    alerts.push({ kind: "config-missing", path: overview.config.path });
  } else if (overview.config.status === "invalid") {
    alerts.push({
      kind: "config-invalid",
      path: overview.config.path,
      error: overview.config.error,
    });
  }
  if (overview.worker.status === "stopped") {
    alerts.push({ kind: "worker-stopped", pid: overview.worker.pid });
  }
  if (overview.harnesses.allExhausted) {
    alerts.push({
      kind: "harnesses-exhausted",
      resumesAt: overview.harnesses.resumesAt,
      resumesWith: resumingHarness(overview.harnesses),
    });
  }
  if (overview.worker.status === "running") {
    const stale = stalePollSources(overview, now);
    if (stale.length > 0) alerts.push({ kind: "stale-polls", sources: stale });
  }
  return alerts;
}

/** The viewer's IANA time zone (e.g. "Europe/Berlin"). */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "HH:MM" as a locale clock time ("9:00 AM" or "9:00"), or null when malformed. */
function formatHhMm(text: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const at = Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2]));
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/**
 * A raw `"HH:MM-HH:MM"` window in the same locale convention as every other
 * clock time ("9:00 AM–7:00 PM"); unparseable specs pass through unchanged.
 */
export function formatWindow(spec: string): string {
  const [start, end, ...rest] = spec.split("-");
  if (start === undefined || end === undefined || rest.length > 0) return spec;
  const from = formatHhMm(start);
  const to = formatHhMm(end);
  return from && to ? `${from}\u2013\u2060${to}`.replace(/[ \u00A0](AM|PM)/g, "\u202F$1") : spec;
}

/**
 * Working-window spec with its zone when the worker's zone differs from the
 * viewer's, so "09:00-19:00" is never read against the wrong clock.
 */
export function windowSpec(
  schedule: { active: string[]; timezone: string },
  viewerZone: string = viewerTimeZone(),
): string {
  const windows =
    schedule.active.length > 0 ? schedule.active.map(formatWindow).join(", ") : "unrestricted";
  return schedule.timezone && !sameWallClock(schedule.timezone, viewerZone)
    ? `${windows} ${schedule.timezone}`
    : windows;
}

/**
 * Whether two IANA zones currently show the same wall-clock time. Compares
 * renderings rather than names, so aliases ("Asia/Saigon" vs
 * "Asia/Ho_Chi_Minh") are not labelled as a different zone.
 */
export function sameWallClock(a: string, b: string, at: number = Date.now()): boolean {
  if (a === b) return true;
  try {
    const render = (timeZone: string) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(at);
    return render(a) === render(b);
  } catch {
    return false;
  }
}

/** Fraction of a capacity limit in use, clamped to 0..1 (null without a limit). */
export function capacityRatio(running: number, max: number | null): number | null {
  if (max === null || max <= 0) return null;
  return Math.min(1, Math.max(0, running / max));
}
