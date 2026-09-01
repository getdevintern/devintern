import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  DEFAULT_CATCH_UP_MISSED,
  WallClock,
  createPickupGate,
  formatTimeWindow,
  lastElapsedActiveWindow,
  missedMostRecentWindow,
  nextTransition,
  parseTimeWindowSpec,
  parseWorkerScheduleSection,
  pickupAllowedAt,
} from "../src/lib/schedule";
import type {
  ParsedTimeWindow,
  ScheduleTransition,
  WorkerScheduleConfig,
} from "../src/lib/schedule";

function windowSpec(spec: string): ParsedTimeWindow {
  return parseTimeWindowSpec(spec);
}

function configOf(
  active: string[],
  blocked: string[] = [],
  timezone?: string,
): WorkerScheduleConfig {
  const parsed = parseWorkerScheduleSection({
    active,
    blocked,
    ...(timezone ? { timezone } : {}),
  });
  expect(parsed.errors).toEqual([]);
  expect(parsed.config).not.toBeNull();
  return parsed.config as WorkerScheduleConfig;
}

/** UTC midnight anchors keep every expectation below independent of the host clock. */

describe("parseTimeWindowSpec", () => {
  test("parses plain and overnight windows", () => {
    const day = windowSpec("09:00-17:00");
    expect(day.startMinutes).toBe(540);
    expect(day.endMinutes).toBe(1020);
    expect(day.spec).toBe("09:00-17:00");

    const night = windowSpec("22:00-06:00");
    expect(night.startMinutes).toBe(22 * 60);
    expect(night.endMinutes).toBe(6 * 60);

    const padded = windowSpec(" 7:05 - 8:10 ");
    expect(padded.spec).toBe("7:05 - 8:10".trim());
    expect(padded.startMinutes).toBe(425);
  });

  test("rejects malformed specs with actionable errors", () => {
    for (const bad of ["9-17", "24:00-02:00", "10:60-12:00", "ab:cd-ef:gh", "0900-1700"]) {
      expect(() => windowSpec(bad)).toThrow(/time window|invalid/);
    }
  });

  test("rejects zero-length windows", () => {
    expect(() => windowSpec("10:00-10:00")).toThrow(/same time/);
  });

  test("formatTimeWindow canonicalizes to HH:MM-HH:MM", () => {
    expect(formatTimeWindow(windowSpec("7:05-8:10"))).toBe("07:05-08:10");
    expect(formatTimeWindow(windowSpec("22:00-06:00"))).toBe("22:00-06:00");
  });
});

describe("parseWorkerScheduleSection", () => {
  test("absent or empty section disables the schedule", () => {
    expect(parseWorkerScheduleSection(undefined).config).toBeNull();
    expect(parseWorkerScheduleSection(null).errors).toEqual([]);
    expect(parseWorkerScheduleSection({}).config).toBeNull();
    // Only the catch-up flag present says nothing about windows.
    expect(parseWorkerScheduleSection({ catch_up_missed: true }).config).toBeNull();
  });

  test("parses active/blocked windows and options", () => {
    const { config, errors } = parseWorkerScheduleSection({
      active: ["22:00-06:00", "12:00-13:00"],
      blocked: ["01:00-02:00"],
      timezone: "Europe/Berlin",
      catch_up_missed: false,
    });
    expect(errors).toEqual([]);
    expect(config?.active.map((w) => w.spec)).toEqual(["22:00-06:00", "12:00-13:00"]);
    expect(config?.blocked.map((w) => w.spec)).toEqual(["01:00-02:00"]);
    expect(config?.timezone).toBe("Europe/Berlin");
    expect(config?.catchUpMissed).toBe(false);
  });

  test("defaults catch_up_missed to true and leaves blank timezone machine-local", () => {
    const { config } = parseWorkerScheduleSection({ active: ["09:00-17:00"], timezone: "" });
    expect(config?.catchUpMissed).toBe(DEFAULT_CATCH_UP_MISSED);
    expect(config?.timezone).toBeUndefined();
  });

  test("collects all problems in one pass", () => {
    const { config, errors } = parseWorkerScheduleSection({
      active: ["nope", "25:00-26:00"],
      blocked: ["ok-but-equal:0-0"],
      timezone: "Mars/Olympus_Mons",
      catch_up_missed: "yes",
    });
    expect(config).toBeNull();
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.some((e) => e.includes("[worker.schedule].active"))).toBe(true);
    expect(errors.some((e) => e.includes("timezone"))).toBe(true);
    expect(errors.some((e) => e.includes("catch_up_missed"))).toBe(true);
  });

  test("non-array window lists are rejected", () => {
    const { errors } = parseWorkerScheduleSection({ active: "22:00-06:00" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must be an array");
  });

  test("a non-table section is an error", () => {
    const { errors } = parseWorkerScheduleSection(["22:00-06:00"]);
    expect(errors).toHaveLength(1);
  });
});

describe("pickupAllowedAt (pure minute logic)", () => {
  test("overnight wrap covers both sides of midnight", () => {
    const schedule = configOf(["22:00-06:00"]);
    expect(pickupAllowedAt(schedule, 23 * 60)).toBe(true); // 23:00
    expect(pickupAllowedAt(schedule, 3 * 60)).toBe(true); // 03:00
    expect(pickupAllowedAt(schedule, 6 * 60)).toBe(false); // 06:00 = end (exclusive)
    expect(pickupAllowedAt(schedule, 21 * 60 + 59)).toBe(false);
    expect(pickupAllowedAt(schedule, 22 * 60)).toBe(true);
    expect(pickupAllowedAt(schedule, 0)).toBe(true); // exactly midnight
  });

  test("multiple active windows union; blocked always wins on overlap", () => {
    const schedule = configOf(["08:00-14:00", "18:00-20:00"], ["11:00-13:00"]);
    expect(pickupAllowedAt(schedule, 8 * 60)).toBe(true);
    expect(pickupAllowedAt(schedule, 17 * 60)).toBe(false);
    expect(pickupAllowedAt(schedule, 19 * 60)).toBe(true);
    expect(pickupAllowedAt(schedule, 10 * 60)).toBe(true);
    expect(pickupAllowedAt(schedule, 12 * 60)).toBe(false); // blocked
    expect(pickupAllowedAt(schedule, 13 * 60)).toBe(true); // after blocked ends
  });

  test("blocked without active restricts only those minutes", () => {
    const schedule = configOf([], ["12:00-13:00"]);
    expect(pickupAllowedAt(schedule, 11 * 60)).toBe(true);
    expect(pickupAllowedAt(schedule, 12 * 60 + 30)).toBe(false);
    expect(pickupAllowedAt(schedule, 13 * 60)).toBe(true);
  });
});

describe("WallClock", () => {
  test("minutesOfDay reads the configured zone", () => {
    const utc = new WallClock("UTC");
    expect(utc.minutesOfDay(Date.UTC(2026, 5, 15, 8, 30))).toBe(510);

    const ny = new WallClock("America/New_York"); // EDT, UTC-4 in June
    expect(ny.minutesOfDay(Date.UTC(2026, 5, 15, 8, 30))).toBe(270); // 04:30

    const system = new WallClock();
    const now = new Date();
    expect(system.minutesOfDay(now.getTime())).toBe(now.getHours() * 60 + now.getMinutes());
  });

  test("instantAt round-trips through wallAt on ordinary days", () => {
    const ny = new WallClock("America/New_York");
    // Any instant during NY's local June 15 works as the day anchor.
    const localDayInstant = Date.UTC(2026, 5, 15, 17); // 13:00 EDT
    const instant = ny.instantAt(localDayInstant, 22 * 60);
    const wall = ny.wallAt(instant);
    expect([wall.year, wall.month, wall.day]).toEqual([2026, 6, 15]);
    expect(wall.hour * 60 + wall.minute).toBe(22 * 60);
    // New York is UTC-4 in June.
    expect(instant).toBe(Date.UTC(2026, 5, 16, 2, 0));
  });

  test("instantAt across a DST fall-back resolves inside standard time", () => {
    // Nov 1 2026: US clocks repeat the 01:00 hour (EDT -> EST at 06:00Z).
    const ny = new WallClock("America/New_York");
    const localDayInstant = Date.UTC(2026, 10, 1, 12); // 08:00 EDT Nov 1
    const instant = ny.instantAt(localDayInstant, 90);
    const wall = ny.wallAt(instant);
    expect([wall.month, wall.day]).toEqual([11, 1]);
    expect(wall.hour * 60 + wall.minute).toBe(90);
    expect(instant).toBe(Date.UTC(2026, 10, 1, 6, 30)); // second pass, EST (UTC-5)
  });

  test("instantAt snaps forward across a spring-forward gap", () => {
    // Mar 8 2026: US clocks jump 02:00 -> 03:00 local (07:00Z).
    const ny = new WallClock("America/New_York");
    const localDayInstant = Date.UTC(2026, 2, 8, 12); // 08:00 EDT Mar 8
    const instant = ny.instantAt(localDayInstant, 150); // 02:30 does not exist
    const wall = ny.wallAt(instant);
    expect(wall.hour * 60 + wall.minute).toBeGreaterThanOrEqual(150); // never before schedule
    expect(instant).toBeLessThanOrEqual(Date.UTC(2026, 2, 8, 8, 0)); // within ~an hour
  });
});

function collectFlips(
  schedule: WorkerScheduleConfig,
  zone: string,
  dayStartMs: number,
  spanMs = 86_400_000,
): ScheduleTransition[] {
  const clock = new WallClock(zone);
  const flips: ScheduleTransition[] = [];
  let cursor = dayStartMs;
  for (let i = 0; i < 12; i++) {
    const transition = nextTransition(schedule, clock, cursor);
    if (!transition || transition.at >= dayStartMs + spanMs) break;
    flips.push(transition);
    cursor = transition.at;
  }
  return flips;
}

describe("nextTransition", () => {
  const zone = "UTC";

  test("finds open and close for a daytime window", () => {
    const schedule = configOf(["09:00-17:00"], [], zone);
    const fromBefore = Date.UTC(2026, 5, 15, 8, 0);
    expect(nextTransition(schedule, new WallClock(zone), fromBefore)).toEqual({
      at: Date.UTC(2026, 5, 15, 9, 0),
      kind: "open",
    });

    const fromInside = Date.UTC(2026, 5, 15, 12, 0);
    expect(nextTransition(schedule, new WallClock(zone), fromInside)).toEqual({
      at: Date.UTC(2026, 5, 15, 17, 0),
      kind: "close",
    });

    const fromEvening = Date.UTC(2026, 5, 15, 18, 0);
    expect(nextTransition(schedule, new WallClock(zone), fromEvening)).toEqual({
      at: Date.UTC(2026, 5, 16, 9, 0),
      kind: "open",
    });
  });

  test("handles a window crossing midnight", () => {
    const schedule = configOf(["22:00-06:00"], [], zone);
    const clock = new WallClock(zone);

    // Just before midnight: still inside tonight's window.
    const lateNight = Date.UTC(2026, 5, 16, 23, 30);
    expect(nextTransition(schedule, clock, lateNight)).toEqual({
      at: Date.UTC(2026, 5, 17, 6, 0),
      kind: "close",
    });

    // Early morning: close is imminent today.
    const earlyMorning = Date.UTC(2026, 5, 16, 5, 0);
    expect(nextTransition(schedule, clock, earlyMorning)).toEqual({
      at: Date.UTC(2026, 5, 16, 6, 0),
      kind: "close",
    });

    // Afternoon: opens again this evening.
    const afternoon = Date.UTC(2026, 5, 16, 12, 0);
    expect(nextTransition(schedule, clock, afternoon)).toEqual({
      at: Date.UTC(2026, 5, 16, 22, 0),
      kind: "open",
    });
  });

  test("blocked overlap suppresses availability between its edges", () => {
    const schedule = configOf(["08:00-14:00"], ["11:00-13:00"], zone);
    const flips = collectFlips(schedule, zone, Date.UTC(2026, 5, 15));
    expect(flips.map((f) => [f.kind, f.at])).toEqual([
      ["open", Date.UTC(2026, 5, 15, 8, 0)],
      ["close", Date.UTC(2026, 5, 15, 11, 0)],
      ["open", Date.UTC(2026, 5, 15, 13, 0)],
      ["close", Date.UTC(2026, 5, 15, 14, 0)],
    ]);
  });

  test("a US spring-forward day produces clean open/close flips", () => {
    const zone = "America/New_York"; // Mar 8 2026: 02:00 -> 03:00 local
    const schedule = configOf(["01:00-04:00"], [], zone);
    const flips = collectFlips(schedule, zone, Date.UTC(2026, 2, 8, 5));
    expect(flips.map((f) => f.kind)).toEqual(["open", "close"]);

    // The 02:30–03:30 stretch is shortened by the lost hour: window closes
    // one wall-clock hour earlier than the naive count suggests.
    const closeAtEdt = new WallClock(zone).wallAt(flips[1]!.at);
    expect(closeAtEdt.hour).toBe(4);
  });

  test("a US fall-back day resolves the repeated hour to its second pass", () => {
    const zone = "America/New_York"; // Nov 1 2026: 02:00 -> 01:00 local
    const schedule = configOf(["01:20-01:40"], [], zone);
    const flips = collectFlips(schedule, zone, Date.UTC(2026, 10, 1, 4));
    // Runtime pickup decisions read wall minutes per tick, so the repeated
    // hour works; the enumerated transition display pins to the
    // standard-time (second) occurrence documented in `instantAt`.
    expect(flips.map((f) => f.kind)).toEqual(["open", "close"]);
    const clock = new WallClock(zone);
    const openWall = clock.wallAt(flips[0]!.at);
    const closeWall = clock.wallAt(flips[1]!.at);
    expect(openWall.hour * 60 + openWall.minute).toBe(80);
    expect(closeWall.hour * 60 + closeWall.minute).toBe(100);
  });
});

describe("missedMostRecentWindow / lastElapsedActiveWindow", () => {
  const zone = "UTC";
  const schedule = configOf(["22:00-06:00"], [], zone);
  const clock = new WallClock(zone);

  test("draining during the last elapsed window means nothing was missed", () => {
    const now = Date.UTC(2026, 5, 15, 9, 0); // morning after the window ended 06:00Z
    const drainedDuringWindow = Date.UTC(2026, 5, 14, 23, 0); // inside Jun 14 22:00 -> Jun 15 06:00Z
    expect(missedMostRecentWindow(schedule, clock, drainedDuringWindow, now)).toBe(false);
  });

  test("the most recent window counts even though earlier ones also elapsed", () => {
    const now = Date.UTC(2026, 5, 15, 9, 0);
    const startOfLatestWindow = Date.UTC(2026, 5, 14, 22, 0);
    // A drain from two nights ago predates the latest window's start.
    const staleDrain = Date.UTC(2026, 5, 13, 23, 0);
    expect(missedMostRecentWindow(schedule, clock, staleDrain, now)).toBe(true);

    const lastWindow = lastElapsedActiveWindow(schedule, clock, now);
    expect(lastWindow?.startedAt).toBe(startOfLatestWindow);
    expect(lastWindow?.endedAt).toBe(Date.UTC(2026, 5, 15, 6, 0));
  });

  test("never-drained state counts as missed", () => {
    const now = Date.UTC(2026, 5, 15, 9, 0);
    expect(missedMostRecentWindow(schedule, clock, null, now)).toBe(true);
  });

  test("inside an open window nothing is 'missed'", () => {
    const now = Date.UTC(2026, 5, 15, 23, 0); // window is open right now
    expect(missedMostRecentWindow(schedule, clock, null, now)).toBe(false);
  });

  test("blocked-only schedules never report catch-up", () => {
    const blockedOnly = configOf([], ["12:00-13:00"], zone);
    const now = Date.UTC(2026, 5, 15, 9, 0);
    expect(missedMostRecentWindow(blockedOnly, clock, null, now)).toBe(false);
  });

  test("fully blocked active windows never report catch-up", () => {
    const fullyBlocked = configOf(["22:00-06:00"], ["22:00-06:00"], zone);
    const now = Date.UTC(2026, 5, 15, 9, 0);
    expect(lastElapsedActiveWindow(fullyBlocked, clock, now)).toBeNull();
    expect(missedMostRecentWindow(fullyBlocked, clock, null, now)).toBe(false);
  });

  test("blocked intervals split the effective catch-up windows", () => {
    const split = configOf(["08:00-14:00"], ["11:00-13:00"], zone);
    const now = Date.UTC(2026, 5, 15, 15, 0);
    expect(lastElapsedActiveWindow(split, clock, now)).toEqual({
      startedAt: Date.UTC(2026, 5, 15, 13, 0),
      endedAt: Date.UTC(2026, 5, 15, 14, 0),
    });
    expect(missedMostRecentWindow(split, clock, Date.UTC(2026, 5, 15, 10, 0), now)).toBe(true);
  });

  test("catch_up_missed=false disables startup catch-up in the gate", () => {
    const parsed = parseWorkerScheduleSection({
      active: ["22:00-06:00"],
      timezone: "UTC",
      catch_up_missed: false,
    });
    expect(parsed.errors).toEqual([]);
    const gate = createPickupGate(parsed.config, { now: () => Date.UTC(2026, 5, 15, 9, 0) });
    expect(gate.shouldCatchUpOnStart(null)).toBe(false);
  });
});

describe("PickupGate", () => {
  function uniqueFile(prefix: string): string {
    return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  let runNowPath: string;

  beforeEach(() => {
    runNowPath = uniqueFile("run-now-test");
  });

  afterEach(() => {
    rmSync(runNowPath, { force: true, recursive: true });
  });

  test("allows and blocks by minute of day, reporting flips once per change", () => {
    const utcNow = (isoUtc: string) => Date.parse(isoUtc);
    let now = utcNow("2026-06-15T11:00:00Z");
    const gate = createPickupGate(configOf(["10:00-12:00"], [], "UTC"), { now: () => now });

    expect(gate.enabled).toBe(true);
    expect(gate.pickupAllowed()).toBe(true);

    const events: boolean[] = [];
    gate.onChange((snapshot) => events.push(snapshot.pickupAllowed));

    now = utcNow("2026-06-15T12:30:00Z");
    expect(gate.pickupAllowed()).toBe(false);
    now = utcNow("2026-06-15T12:45:00Z");
    expect(gate.pickupAllowed()).toBe(false); // same closed state: no extra event
    now = utcNow("2026-06-15T13:00:00Z");
    expect(gate.pickupAllowed()).toBe(false); // outside any window
    now = utcNow("2026-06-16T10:30:00Z");
    expect(gate.pickupAllowed()).toBe(true);
    expect(events).toEqual([false, true]);
  });

  test("consumeManualPickup consumes the sentinel file exactly once", () => {
    const gate = createPickupGate(configOf(["10:00-12:00"], [], "UTC"), {
      now: () => Date.parse("2026-06-15T23:00:00Z"), // outside the window
      runNowPath,
    });
    expect(gate.pickupAllowed()).toBe(false);
    writeFileSync(runNowPath, "");
    expect(gate.snapshot().manualRequested).toBe(true);
    expect(gate.pickupAllowed()).toBe(false); // only successful consumption grants the bypass
    expect(gate.consumeManualPickup()).toBe(true);
    expect(gate.consumeManualPickup()).toBe(false);
    expect(gate.pickupAllowed()).toBe(false);
  });

  test("without a sentinel path there is no manual override", () => {
    const gate = createPickupGate(configOf(["10:00-12:00"], [], "UTC"), { runNowPath: undefined });
    expect(gate.consumeManualPickup()).toBe(false);
  });

  test("an undeletable sentinel never holds a closed schedule open", () => {
    const gate = createPickupGate(configOf(["10:00-12:00"], [], "UTC"), {
      now: () => Date.parse("2026-06-15T23:00:00Z"),
      runNowPath,
    });
    mkdirSync(runNowPath);
    expect(() => gate.consumeManualPickup()).toThrow();
    expect(gate.pickupAllowed()).toBe(false);
  });

  test("snapshot carries windows, resolved zone, and the next change", () => {
    const gate = createPickupGate(configOf(["10:00-12:00"], ["11:00-11:30"], "UTC"), {
      now: () => Date.parse("2026-06-15T10:15:00Z"),
      runNowPath,
    });
    const snapshot = gate.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.pickupAllowed).toBe(true);
    expect(snapshot.active).toEqual(["10:00-12:00"]);
    expect(snapshot.blocked).toEqual(["11:00-11:30"]);
    expect(snapshot.timezone).toBe("UTC");
    expect(snapshot.manualRequested).toBe(false);
    expect(snapshot.nextChange?.kind).toBe("close");
    expect(snapshot.nextChange?.at).toBe(Date.parse("2026-06-15T11:00:00Z"));
  });

  test("shouldCatchUpOnStart delegates to missed-window logic", () => {
    const gate = createPickupGate(configOf(["22:00-06:00"], [], "UTC"), {
      now: () => Date.UTC(2026, 5, 15, 9, 0),
    });
    expect(gate.shouldCatchUpOnStart(null)).toBe(true);
    expect(gate.shouldCatchUpOnStart(Date.UTC(2026, 5, 14, 23, 0))).toBe(false);
    expect(gate.shouldCatchUpOnStart(Date.UTC(2026, 5, 13, 23, 0))).toBe(true);
  });

  test("createPickupGate(null) yields an always-open gate that clears run-now markers", () => {
    writeFileSync(runNowPath, "");
    const gate = createPickupGate(null, { runNowPath });
    expect(gate.enabled).toBe(false);
    expect(gate.pickupAllowed()).toBe(true);
    expect(gate.snapshot().manualRequested).toBe(true);
    expect(gate.consumeManualPickup()).toBe(true);
    expect(gate.consumeManualPickup()).toBe(false);
    expect(gate.shouldCatchUpOnStart(null)).toBe(false);
    expect(gate.snapshot().enabled).toBe(false);
  });
});
