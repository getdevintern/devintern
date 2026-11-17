import { expect, test } from "bun:test";

import {
  capacityRatio,
  formatAgo,
  formatIn,
  formatSpan,
  formatClock,
  formatUntil,
  formatWindow,
  harnessAlert,
  harnessSummary,
  overviewAlerts,
  pollFreshness,
  resumingHarness,
  sameWallClock,
  windowSpec,
  workerUptime,
} from "@/components/overview/overview-model";
import type { OverviewHarnesses, OverviewResponse } from "@/lib/api";

const NOW = new Date(2026, 10, 13, 12, 20, 0).getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function harnesses(overrides: Partial<OverviewHarnesses> = {}): OverviewHarnesses {
  return {
    source: "workspace_env",
    entries: [
      { name: "claude", priority: 0, known: true, active: true, state: "healthy" },
      { name: "codex", priority: 1, known: true, active: false, state: "healthy" },
    ],
    active: "claude",
    allExhausted: false,
    stateAvailable: true,
    ...overrides,
  };
}

function overview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    generatedAt: NOW,
    worker: { status: "running", pid: 42, startedAt: new Date(NOW - 3 * HOUR).toISOString() },
    config: { status: "ok", path: "/w/workspace.toml" },
    capacity: { running: 0, maxConcurrency: 4, perRepo: [], unattributed: 0, runs: [] },
    harnesses: harnesses(),
    trackers: {
      mode: "teams",
      pollIntervalSeconds: 60,
      sources: [
        { team: "web", tracker: "jira", cursorSource: "jira:web", lastPolledAt: NOW - 40 * SECOND },
      ],
    },
    ...overrides,
  };
}

test("spans keep two units at most and drop a zero second unit", () => {
  expect(formatSpan(45 * SECOND)).toBe("45s");
  expect(formatSpan(12 * MINUTE + 30 * SECOND)).toBe("12m");
  expect(formatSpan(2 * HOUR + 10 * MINUTE)).toBe("2h 10m");
  expect(formatSpan(3 * HOUR)).toBe("3h");
  expect(formatSpan(26 * HOUR)).toBe("1d 2h");
  expect(formatSpan(-5 * SECOND)).toBe("0s");
});

test("relative past times read as ago, with a just-now floor", () => {
  expect(formatAgo(NOW - 2 * SECOND, NOW)).toBe("just now");
  expect(formatAgo(NOW - 40 * SECOND, NOW)).toBe("just now");
  expect(formatAgo(NOW - 14 * MINUTE, NOW)).toBe("14m ago");
});

test("countdowns round up to the minute so a window never reads early", () => {
  expect(formatIn(NOW + 2 * HOUR + 9 * MINUTE + 40 * SECOND, NOW)).toBe("in 2h 10m");
  expect(formatIn(NOW + 10 * SECOND, NOW)).toBe("any moment");
  expect(formatIn(NOW - MINUTE, NOW)).toBe("any moment");
});

test("until combines the clock time with the countdown", () => {
  const at = NOW + 2 * HOUR + 10 * MINUTE;
  const clock = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  expect(formatUntil(at, NOW)).toBe(`until ${clock} (in 2h 10m)`);
});

test("uptime only exists for a running worker with a parseable start", () => {
  expect(
    workerUptime({ status: "running", startedAt: new Date(NOW - HOUR).toISOString() }, NOW),
  ).toBe(HOUR);
  expect(
    workerUptime({ status: "stopped", startedAt: new Date(NOW).toISOString() }, NOW),
  ).toBeNull();
  expect(workerUptime({ status: "running", startedAt: "not a date" }, NOW)).toBeNull();
});

test("a poll is stale only after three missed intervals", () => {
  expect(pollFreshness(NOW - 40 * SECOND, 60, NOW)).toBe("fresh");
  expect(pollFreshness(NOW - 180 * SECOND, 60, NOW)).toBe("fresh");
  expect(pollFreshness(NOW - 181 * SECOND, 60, NOW)).toBe("stale");
  // A slow interval tolerates a proportionally older poll.
  expect(pollFreshness(NOW - 10 * MINUTE, 300, NOW)).toBe("fresh");
  expect(pollFreshness(undefined, 60, NOW)).toBe("never");
  // Unknown interval falls back to the 60s default.
  expect(pollFreshness(NOW - 4 * MINUTE, undefined, NOW)).toBe("stale");
});

test("a healthy overview raises no alerts", () => {
  expect(overviewAlerts(overview(), NOW)).toEqual([]);
});

test("stale polls alert while the worker runs, not once it is stopped", () => {
  const trackers = {
    mode: "teams" as const,
    pollIntervalSeconds: 60,
    sources: [
      { team: "web", tracker: "jira", cursorSource: "jira:web", lastPolledAt: NOW - 14 * MINUTE },
    ],
  };
  const running = overviewAlerts(overview({ trackers }), NOW);
  expect(running.map((alert) => alert.kind)).toEqual(["stale-polls"]);

  const stopped = overviewAlerts(
    overview({ trackers, worker: { status: "stopped", pid: 7 } }),
    NOW,
  );
  // The stopped worker explains the stale cursor; only one alert is raised.
  expect(stopped.map((alert) => alert.kind)).toEqual(["worker-stopped"]);
});

test("an exhausted chain raises the pause banner with the first harness to resume", () => {
  const exhausted = harnesses({
    entries: [
      {
        name: "claude",
        priority: 0,
        known: true,
        active: true,
        state: "limited",
        limitedUntil: NOW + 2 * HOUR,
      },
      {
        name: "codex",
        priority: 1,
        known: true,
        active: false,
        state: "limited",
        limitedUntil: NOW + 40 * MINUTE,
      },
    ],
    allExhausted: true,
    resumesAt: NOW + 40 * MINUTE,
  });
  expect(resumingHarness(exhausted)).toBe("codex");
  expect(overviewAlerts(overview({ harnesses: exhausted }), NOW)).toEqual([
    { kind: "harnesses-exhausted", resumesAt: NOW + 40 * MINUTE, resumesWith: "codex" },
  ]);
});

test("config problems lead the alert stack", () => {
  const alerts = overviewAlerts(
    overview({
      config: { status: "invalid", path: "/w/workspace.toml", error: "bad tracker" },
      worker: { status: "stopped" },
    }),
    NOW,
  );
  expect(alerts.map((alert) => alert.kind)).toEqual(["config-invalid", "worker-stopped"]);
  expect(overviewAlerts(overview({ config: { status: "missing", path: "/w" } }), NOW)[0]).toEqual({
    kind: "config-missing",
    path: "/w",
  });
});

test("the harness alert distinguishes limited from exhausted and ignores unknown", () => {
  expect(harnessAlert(harnesses())).toBeNull();
  expect(
    harnessAlert(
      harnesses({
        entries: [
          {
            name: "claude",
            priority: 0,
            known: true,
            active: false,
            state: "limited",
            limitedUntil: NOW + HOUR,
          },
          { name: "codex", priority: 1, known: true, active: true, state: "healthy" },
        ],
      }),
    ),
  ).toEqual({ kind: "limited", names: ["claude"] });
  expect(harnessAlert(harnesses({ allExhausted: true, resumesAt: NOW + HOUR }))).toEqual({
    kind: "exhausted",
    resumesAt: NOW + HOUR,
  });
  expect(
    harnessAlert(
      harnesses({
        stateAvailable: false,
        entries: [{ name: "claude", priority: 0, known: true, active: false, state: "unknown" }],
      }),
    ),
  ).toBeNull();
});

test("capacity ratio clamps over-capacity rows and has no value without a limit", () => {
  expect(capacityRatio(2, 4)).toBe(0.5);
  expect(capacityRatio(6, 4)).toBe(1);
  expect(capacityRatio(1, null)).toBeNull();
  expect(capacityRatio(1, 0)).toBeNull();
});

test("clock times drop the leading zero and follow the locale's hour cycle", () => {
  const at = new Date(2026, 10, 13, 9, 5, 0).getTime();
  const expected = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const earlier = at - 60 * 60 * 1000;
  expect(formatClock(at, earlier)).toBe(expected);
  expect(formatClock(at, earlier).startsWith("0")).toBe(false);
  // Past instants print exactly like the Runs page.
  expect(formatClock(earlier, at)).toBe("1h ago");
});

test("the harness summary replaces the source in the section meta", () => {
  expect(harnessSummary(harnesses()).label).toBe("all healthy");
  expect(harnessSummary(harnesses({ stateAvailable: false })).label).toBe("health unknown");
  expect(harnessSummary(harnesses({ allExhausted: true }))).toEqual({
    label: "all limited",
    tone: "warning",
  });
});

test("a window is labelled with its zone only when the zone shows a different clock", () => {
  const local = formatWindow("09:00-19:00");
  expect(windowSpec({ active: ["09:00-19:00"], timezone: "UTC" }, "UTC")).toBe(local);
  // Aliases of one zone are not treated as different zones.
  expect(sameWallClock("Asia/Saigon", "Asia/Ho_Chi_Minh")).toBe(true);
  expect(windowSpec({ active: ["09:00-19:00"], timezone: "Asia/Tokyo" }, "Europe/London")).toBe(
    `${local} Asia/Tokyo`,
  );
  expect(sameWallClock("Not/AZone", "UTC")).toBe(false);
});

test("window specs use the same locale clock convention as every other time", () => {
  const nine = new Date(Date.UTC(2000, 0, 1, 9, 0)).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const plain = (text: string) => text.replace(/[\u202F\u00A0\u2060]/g, " ");
  expect(plain(formatWindow("09:00-19:00")).startsWith(plain(nine))).toBe(true);
  expect(formatWindow("09:00-19:00")).toContain("–");
  // Each time stays glued to its AM/PM: no plain space precedes a meridiem.
  expect(formatWindow("09:00-19:00")).not.toMatch(/ (AM|PM)/);
  expect(formatWindow("not a window")).toBe("not a window");
});

test("an elapsed limit with nothing run since is flagged as unconfirmed, not healthy", () => {
  const opencode: OverviewHarnesses["entries"][number] = {
    name: "opencode",
    priority: 0,
    known: true,
    active: true,
    state: "unconfirmed",
    lastLimitedAt: NOW - 2 * HOUR,
    limitEndedAt: NOW - HOUR,
  };
  const unconfirmed = harnesses({ entries: [opencode], active: "opencode" });
  expect(harnessSummary(unconfirmed)).toEqual({ label: "quota unconfirmed", tone: "warning" });
  expect(harnessAlert(unconfirmed)).toEqual({ kind: "unconfirmed", names: ["opencode"] });
  // A live limit outranks an unconfirmed one in the strip.
  expect(
    harnessAlert(
      harnesses({
        entries: [
          opencode,
          {
            name: "codex",
            priority: 1,
            known: true,
            active: false,
            state: "limited",
            limitedUntil: NOW + HOUR,
          },
        ],
      }),
    ),
  ).toEqual({ kind: "limited", names: ["codex"] });
});
