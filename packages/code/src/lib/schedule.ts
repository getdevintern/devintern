/**
 * Working windows (quiet hours) for new-task pickup.
 *
 * A schedule is a list of daily wall-clock windows in which the worker may
 * pick up ready tasks from the tracker (`active`), minus `blocked` windows
 * in which it must stay idle. Everything else — review replies, mentions,
 * automations, relay events — is unaffected: this gates only the
 * detect → evaluate → execute drain of the task-polling acquirer.
 *
 * Time is wall-clock in one zone: an optional IANA timezone, or the machine's
 * local time when none is set. Because windows are defined against the local
 * clock rather than absolute instants, DST transitions shift real window
 * duration by up to an hour (spring-forward shortens or skips times inside
 * the lost hour; fall-back repeats the same wall clock once). Transitions are
 * resolved on a best-effort minute grid and never crash polling.
 */

import { existsSync, unlinkSync } from "fs";

const WINDOW_SPEC_PATTERN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
const MINUTES_PER_DAY = 24 * 60;

/** One parsed daily window from a `"HH:MM-HH:MM"` spec. */
export interface ParsedTimeWindow {
  /** Original config string, used verbatim in logs. */
  spec: string;
  /** Minutes after midnight the window opens (inclusive). */
  startMinutes: number;
  /** Minutes after midnight the window closes (exclusive). */
  endMinutes: number;
}

/** Validated `[worker.schedule]` table. */
export interface WorkerScheduleConfig {
  /** Pickup allowed only during these windows; empty means any time. */
  active: ParsedTimeWindow[];
  /** Pickup suppressed during these windows even inside active ones. */
  blocked: ParsedTimeWindow[];
  /** IANA timezone name; undefined uses the machine's local time. */
  timezone?: string;
  /** Drain once at startup when the most recent window fully elapsed unused. */
  catchUpMissed: boolean;
}

export const DEFAULT_CATCH_UP_MISSED = true;

/**
 * Parse one `"HH:MM-HH:MM"` window spec.
 *
 * Overnight windows simply have start > end (`22:00-06:00`). Start equal to
 * end is rejected because it can only ever mean "no minutes" or "all day"
 * ambiguously.
 *
 * @throws With a user-facing message when the spec is malformed.
 */
export function parseTimeWindowSpec(rawSpec: string): ParsedTimeWindow {
  const spec = rawSpec.trim();
  const match = WINDOW_SPEC_PATTERN.exec(spec);
  if (!match) {
    throw new Error(
      `"${rawSpec}" is not a time window. Use "HH:MM-HH:MM", e.g. "22:00-06:00" (overnight is fine).`,
    );
  }
  const parts = [
    [match[1], match[2], "start"],
    [match[3], match[4], "end"],
  ] as const;
  const totals: number[] = [];
  for (const [hourText, minuteText, edge] of parts) {
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (hour > 23 || minute > 59) {
      throw new Error(`"${spec}" has an invalid ${edge} time ${hourText}:${minuteText} (HH:MM).`);
    }
    totals.push(hour * 60 + minute);
  }
  if (totals[0] === totals[1]) {
    throw new Error(`"${spec}" starts and ends at the same time; use two windows instead.`);
  }
  return { spec, startMinutes: totals[0] as number, endMinutes: totals[1] as number };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Canonical display form of a parsed window. */
export function formatTimeWindow(window: ParsedTimeWindow): string {
  const hhmm = (total: number) => `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
  return `${hhmm(window.startMinutes)}-${hhmm(window.endMinutes)}`;
}

/**
 * Parse the `[worker.schedule]` TOML table (already reduced to raw values).
 *
 * Collects every problem into `errors` so a broken config is fixable in one
 * pass; returns `config: null` when the section is absent or empty (schedule
 * disabled).
 */
export function parseWorkerScheduleSection(
  value: unknown,
  label = "[worker.schedule]",
): { config: WorkerScheduleConfig | null; errors: string[] } {
  const errors: string[] = [];
  if (value === undefined || value === null) {
    return { config: null, errors };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      config: null,
      errors: [`${label} must be a table with \`active\`, \`blocked\`, and \`timezone\` keys.`],
    };
  }
  const table = value as Record<string, unknown>;

  const readWindows = (key: "active" | "blocked"): ParsedTimeWindow[] => {
    const raw = table[key];
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw)) {
      errors.push(`${label}.${key} must be an array of time window strings ("22:00-06:00").`);
      return [];
    }
    const windows: ParsedTimeWindow[] = [];
    for (const item of raw) {
      if (typeof item !== "string") {
        errors.push(`${label}.${key} entries must be strings like "22:00-06:00".`);
        continue;
      }
      try {
        windows.push(parseTimeWindowSpec(item));
      } catch (error) {
        errors.push(`${label}.${key}: ${(error as Error).message}`);
      }
    }
    return windows;
  };

  const active = readWindows("active");
  const blocked = readWindows("blocked");

  let timezone: string | undefined;
  const rawTimezone = table.timezone;
  if (rawTimezone !== undefined && rawTimezone !== null) {
    if (typeof rawTimezone !== "string") {
      errors.push(`${label}.timezone must be a string (an IANA name like "America/New_York").`);
    } else if (!rawTimezone.trim()) {
      // Blank string stays machine-local by convention.
    } else if (!isValidTimeZone(rawTimezone.trim())) {
      errors.push(`${label}.timezone "${rawTimezone.trim()}" is not a valid IANA timezone name.`);
    } else {
      timezone = rawTimezone.trim();
    }
  }

  let catchUpMissed = DEFAULT_CATCH_UP_MISSED;
  const rawCatchUp = table.catch_up_missed;
  if (rawCatchUp !== undefined && rawCatchUp !== null) {
    if (typeof rawCatchUp !== "boolean") {
      errors.push(`${label}.catch_up_missed must be a boolean.`);
    } else {
      catchUpMissed = rawCatchUp;
    }
  }

  if (errors.length > 0) {
    return { config: null, errors };
  }

  // An empty section says nothing about scheduling; treat it as disabled so
  // existing configs that merely pre-create the table keep working.
  if (active.length === 0 && blocked.length === 0) {
    return { config: null, errors };
  }

  return { config: { active, blocked, timezone, catchUpMissed }, errors };
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Whether `minutes` past midnight falls inside a daily window (end-exclusive, wrap-aware). */
function containsMinute(window: ParsedTimeWindow, minutes: number): boolean {
  if (window.startMinutes < window.endMinutes) {
    return minutes >= window.startMinutes && minutes < window.endMinutes;
  }
  // Overnight window wraps around midnight.
  return minutes >= window.startMinutes || minutes < window.endMinutes;
}

/**
 * Whether new-task pickup is allowed at a given minute of day.
 *
 * Blocked windows always win over active ones: overlapping/conflicting
 * entries resolve to "stay quiet", which is the safe direction.
 */
export function pickupAllowedAt(schedule: WorkerScheduleConfig, minutesOfDay: number): boolean {
  if (schedule.blocked.some((w) => containsMinute(w, minutesOfDay))) {
    return false;
  }
  if (schedule.active.length === 0) {
    return true;
  }
  return schedule.active.some((w) => containsMinute(w, minutesOfDay));
}

interface WallYMDhM {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Wall-clock reader/converter for one timezone (undefined = system local).
 *
 * All reading goes through Intl formatting; all construction from wall time
 * iterates offset guesses to convergence, which handles fixed offsets and
 * both DST directions deterministically:
 *
 * - Fall-back repeated hour resolves to the later (standard-time) occurrence.
 * - Spring-forward gap snaps forward to the first instant whose clock has
 *   passed the requested time (a 02:30 window starts when the clock next
 *   shows ≥02:30 that day).
 */
export class WallClock {
  private readonly formatter: Intl.DateTimeFormat;

  constructor(readonly timezone?: string) {
    this.formatter = new Intl.DateTimeFormat("en-US", {
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  }

  wallAt(atMs: number): WallYMDhM {
    const parts = this.formatter.formatToParts(new Date(atMs));
    const get = (type: Intl.DateTimeFormatPartTypes): number => {
      const part = parts.find((p) => p.type === type);
      return part ? Number(part.value) : NaN;
    };
    let hour = get("hour");
    if (!(hour >= 0)) hour = 0;
    if (hour === 24) hour = 0;
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour,
      minute: get("minute"),
    };
  }

  /** Minutes after local midnight right now. */
  minutesOfDay(atMs: number = Date.now()): number {
    const wall = this.wallAt(atMs);
    return wall.hour * 60 + wall.minute;
  }

  /**
   * The instant at which this zone's wall clock reads `minutes` past
   * midnight on the local calendar day containing `sameLocalDayMs`.
   */
  instantAt(sameLocalDayMs: number, minutes: number): number {
    const wall = this.wallAt(sameLocalDayMs);
    const target = Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      Math.floor(minutes / 60),
      minutes % 60,
    );
    let candidate = target;
    for (let i = 0; i < 3; i++) {
      const skew = this.wallAsUtc(candidate) - candidate;
      candidate = target - skew;
    }
    // Spring-forward gap: no exact solution exists; snap forward onto the
    // first moment the wall clock reads at or past the requested time.
    for (let i = 0; i < 32 && this.wallAsUtc(candidate) - target < 0; i++) {
      candidate += 10 * 60_000;
    }
    return this.resolveAmbiguousToLaterOccurrence(candidate, target);
  }

  /**
   * Fall-back repeats a wall time twice; the documented policy resolves it
   * to the later (standard-time) occurrence by probing forward briefly for
   * a second exact rendering of the same wall clock on the same date.
   */
  private resolveAmbiguousToLaterOccurrence(candidate: number, target: number): number {
    // Cheap guard: a wall-time duplicate can only exist when a DST
    // transition sits within a few hours of this instant.
    const offsetAt = (atMs: number): number => this.wallAsUtc(atMs) - atMs;
    let minOffset = Number.POSITIVE_INFINITY;
    let maxOffset = Number.NEGATIVE_INFINITY;
    for (let delta = -3 * 3_600_000; delta <= 3 * 3_600_000; delta += 1_800_000) {
      const offset = offsetAt(candidate + delta);
      if (offset < minOffset) minOffset = offset;
      if (offset > maxOffset) maxOffset = offset;
    }
    if (maxOffset === minOffset) {
      return candidate;
    }
    let latest = candidate;
    const rendersWall = (atMs: number): boolean => this.wallAsUtc(atMs) === target;
    for (let probe = candidate + 300_000; probe <= candidate + 120 * 60_000; probe += 300_000) {
      if (rendersWall(probe)) {
        latest = probe;
      }
    }
    return rendersWall(latest) ? latest : candidate;
  }

  private wallAsUtc(atMs: number): number {
    const wall = this.wallAt(atMs);
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  }

  /** Local calendar dates around `fromMs`, each as its UTC-midnight anchor ms. */
  dayAnchors(fromMs: number, back: number, forward: number): number[] {
    const wall = this.wallAt(fromMs);
    const todayUtcMidnight = Date.UTC(wall.year, wall.month - 1, wall.day);
    const anchors: number[] = [];
    for (let offset = -back; offset <= forward; offset++) {
      anchors.push(todayUtcMidnight + offset * 86_400_000);
    }
    return anchors;
  }
}

export interface ScheduleTransition {
  at: number;
  kind: "open" | "close";
}

/** Human description of one scheduled window (raw specs are shown elsewhere). */
export function describeNextChangeLabel(kind: ScheduleTransition["kind"], at: number): string {
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return kind === "open" ? `pickup opens at ${time}` : `pickup closes at ${time}`;
}

/**
 * Next instant at which pickup availability flips.
 *
 * Candidate flip points are every start/end of every configured window; the
 * first candidate that actually changes availability wins, so overlapping
 * windows behave like their union (minus blocked) instead of producing
 * confusing no-op transitions.
 */
export function nextTransition(
  schedule: WorkerScheduleConfig,
  clock: WallClock,
  fromMs: number = Date.now(),
): ScheduleTransition | null {
  const candidates: number[] = [];
  for (const anchor of clock.dayAnchors(fromMs, 1, 9)) {
    for (const window of [...schedule.active, ...schedule.blocked]) {
      candidates.push(clock.instantAt(anchor, window.startMinutes));
      const endAnchor = window.endMinutes <= window.startMinutes ? anchor + 86_400_000 : anchor;
      candidates.push(clock.instantAt(endAnchor, window.endMinutes));
    }
  }
  candidates.sort((a, b) => a - b);

  let previousAllowed = pickupAllowedAt(schedule, clock.minutesOfDay(fromMs));
  for (const at of candidates) {
    if (at <= fromMs) continue;
    const allowed = pickupAllowedAt(schedule, clock.minutesOfDay(at));
    if (allowed !== previousAllowed) {
      return { at, kind: allowed ? "open" : "close" };
    }
    previousAllowed = allowed;
  }
  return null;
}

/** The latest daily-window occurrence that fully elapsed before `nowMs`. */
export function lastElapsedActiveWindow(
  schedule: WorkerScheduleConfig,
  clock: WallClock,
  nowMs: number,
  lookbackDays = 8,
): { startedAt: number; endedAt: number } | null {
  let latest: { startedAt: number; endedAt: number } | null = null;
  for (const anchor of clock.dayAnchors(nowMs, lookbackDays, 0)) {
    for (const window of schedule.active) {
      const startedAt = clock.instantAt(anchor, window.startMinutes);
      const endAnchor = window.endMinutes <= window.startMinutes ? anchor + 86_400_000 : anchor;
      const endedAt = clock.instantAt(endAnchor, window.endMinutes);
      if (endedAt > nowMs || endedAt <= startedAt) continue;
      if (!latest || endedAt > latest.endedAt) {
        latest = { startedAt, endedAt };
      }
    }
  }
  return latest;
}

/**
 * Catch-up eligibility: the last elapsed active window began after the final
 * drain, meaning the worker was down/asleep/idle through that entire window.
 * Calling this repeatedly outside a window stays eligible until the next
 * window actually drains; callers invoke it once per process start.
 */
export function missedMostRecentWindow(
  schedule: WorkerScheduleConfig,
  clock: WallClock,
  lastDrainAt: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (pickupAllowedAt(schedule, clock.minutesOfDay(nowMs))) {
    return false; // Window is open right now; normal draining applies.
  }
  if (schedule.active.length === 0) {
    return false; // Nothing bounded was missed.
  }
  const lastWindow = lastElapsedActiveWindow(schedule, clock, nowMs);
  if (!lastWindow) {
    return false;
  }
  return lastDrainAt === null || lastDrainAt < lastWindow.startedAt;
}

/** Serializable state shown in logs, the CLI banner, and `/api/worker`. */
export interface ScheduleSnapshot {
  enabled: boolean;
  pickupAllowed: boolean;
  /** Raw window specs (`"22:00-06:00"`), active then blocked. */
  active: string[];
  blocked: string[];
  /** Resolved timezone name, e.g. `"Europe/Berlin"` (system default included). */
  timezone: string;
  catchUpMissed: boolean;
  manualRequested: boolean;
  nextChange?: ScheduleTransition;
}

export interface PickupGateDeps {
  /**
   * Sentinel path signaling one immediate drain (manual "run now"); checked
   * and consumed on every tick evaluation.
   */
  runNowPath?: string;
  /** Injectable clock (tests); defaults to the system clock via the zone. */
  now?: () => number;
}

/**
 * Decides whether the task-polling acquirer may pick up new tracker work.
 *
 * Also owns side concerns keyed off scheduling: consuming the run-now
 * sentinel, detecting open/close flips for listeners, and answering the
 * startup catch-up question. Tracker/network access never happens here.
 */
export interface PickupGate {
  readonly enabled: boolean;
  /** True when a new detect→evaluate→execute tick may start right now. */
  pickupAllowed(): boolean;
  /** One-shot manual override; consumes a pending run-now request. */
  consumeManualPickup(): boolean;
  /** Startup catch-up: drain once although the gate is closed. */
  shouldCatchUpOnStart(lastDrainAt: number | null): boolean;
  /** Current status snapshot (cheap enough to call per dashboard poll). */
  snapshot(): ScheduleSnapshot;
  /** Registers a listener fired whenever availability flips. */
  onChange(listener: (snapshot: ScheduleSnapshot) => void): void;
}

class ScheduledPickupGate implements PickupGate {
  readonly enabled = true;
  private readonly clock: WallClock;
  private readonly config: WorkerScheduleConfig;
  private readonly deps: PickupGateDeps;
  private readonly listeners: Array<(snapshot: ScheduleSnapshot) => void> = [];
  private lastState: boolean | null = null;

  constructor(config: WorkerScheduleConfig, deps: PickupGateDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.clock = new WallClock(config.timezone);
  }

  private peekRunNowFile(): boolean {
    return Boolean(this.deps.runNowPath && existsSync(this.deps.runNowPath));
  }

  pickupAllowed(): boolean {
    const nowMs = this.nowMs();
    const manualPending = this.peekRunNowFile();
    const allowed = manualPending || pickupAllowedAt(this.config, this.clock.minutesOfDay(nowMs));
    this.publishIfFlipped(allowed, nowMs);
    return allowed;
  }

  consumeManualPickup(): boolean {
    if (!this.deps.runNowPath) return false;
    if (!existsSync(this.deps.runNowPath)) return false;
    try {
      unlinkSync(this.deps.runNowPath);
    } catch {
      // Another tick already consumed it; harmless.
    }
    return true;
  }

  shouldCatchUpOnStart(lastDrainAt: number | null): boolean {
    if (!this.config.catchUpMissed) return false;
    return missedMostRecentWindow(this.config, this.clock, lastDrainAt, this.nowMs());
  }

  snapshot(): ScheduleSnapshot {
    const nowMs = this.nowMs();
    const manualRequested = this.peekRunNowFile();
    return {
      enabled: true,
      pickupAllowed:
        manualRequested || pickupAllowedAt(this.config, this.clock.minutesOfDay(nowMs)),
      active: this.config.active.map((w) => w.spec),
      blocked: this.config.blocked.map((w) => w.spec),
      timezone: this.clock.timezone ?? currentSystemTimeZone(),
      catchUpMissed: this.config.catchUpMissed,
      manualRequested,
      nextChange: nextTransition(this.config, this.clock, nowMs) ?? undefined,
    };
  }

  onChange(listener: (snapshot: ScheduleSnapshot) => void): void {
    this.listeners.push(listener);
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private publishIfFlipped(allowed: boolean, nowMs: number): void {
    if (this.lastState === allowed) return;
    const hadPriorState = this.lastState !== null;
    this.lastState = allowed;
    if (!hadPriorState) return; // Startup state reaches listeners via the banner.
    const snapshot = this.buildSnapshot(allowed, nowMs);
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Listeners are observability sugar; never break polling.
      }
    }
  }

  private buildSnapshot(allowed: boolean, nowMs: number): ScheduleSnapshot {
    return {
      enabled: true,
      pickupAllowed: allowed,
      active: this.config.active.map((w) => w.spec),
      blocked: this.config.blocked.map((w) => w.spec),
      timezone: this.clock.timezone ?? currentSystemTimeZone(),
      catchUpMissed: this.config.catchUpMissed,
      manualRequested: this.peekRunNowFile(),
      nextChange: nextTransition(this.config, this.clock, nowMs) ?? undefined,
    };
  }
}

/** Gate for schedules that do not restrict anything (no `[worker.schedule]`). */
class OpenPickupGate implements PickupGate {
  readonly enabled = false;
  pickupAllowed(): boolean {
    return true;
  }
  consumeManualPickup(): boolean {
    return false;
  }
  shouldCatchUpOnStart(_lastDrainAt: number | null): boolean {
    return false;
  }
  snapshot(): ScheduleSnapshot {
    return {
      enabled: false,
      pickupAllowed: true,
      active: [],
      blocked: [],
      timezone: currentSystemTimeZone(),
      catchUpMissed: DEFAULT_CATCH_UP_MISSED,
      manualRequested: false,
    };
  }
  onChange(): void {}
}

/** Build the gate for a parsed schedule; `null` config yields an always-open gate. */
export function createPickupGate(
  config: WorkerScheduleConfig | null,
  deps: PickupGateDeps = {},
): PickupGate {
  return config ? new ScheduledPickupGate(config, deps) : new OpenPickupGate();
}

export function currentSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "system";
  } catch {
    return "system";
  }
}
