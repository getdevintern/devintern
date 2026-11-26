/**
 * Notification delivery loop run by the workspace worker.
 *
 * Notifications are emitted by the worker and by CLI child processes, so the
 * dispatcher reads the `notifications` table on an interval instead of
 * relying on in-process emitter listeners (see `emitter.ts`). Each tick, per
 * enabled channel:
 *
 * 1. Open rows whose count grew past what the channel last handled are
 *    candidates (new rows and resurfaced groups). Filters decide send / skip /
 *    digest; the per-group rate limit holds a send until its window ends.
 * 2. With `notify_resolved`, rows the channel delivered that have since
 *    resolved get one resolve message.
 * 3. With `digest_time`, the routine items since the last digest are sent
 *    once a day after that local time.
 *
 * Delivery is fully isolated from runs and storage: every failure is logged,
 * the row is marked handled, and the tick moves on. Only the worker that holds
 * the workspace lock runs a dispatcher, so two daemons never double-send.
 */

import { Database } from "bun:sqlite";

import { configureSqliteConnection } from "../../state/sqlite";
import type { WorkspaceConfig } from "../../workspace/config-types";
import { WallClock } from "../../worker/schedule";
import { hasTable, rowToNotification } from "../store";
import { channelAvailability, defaultChannelDeps, sendToChannel } from "./channels";
import type { ChannelDeps } from "./channels";
import type { NotificationChannelConfig } from "./config";
import { buildDigest, buildNotificationMessage, resolveDashboardBaseUrl } from "./message";
import type { DeliveryMessage } from "./message";
import { decideImmediate, digestIncludes, rateLimitAllows } from "./policy";
import type { DeliveryCandidate } from "./policy";
import { DeliveryStateStore } from "./state";

/** Interval between delivery ticks. */
export const DELIVERY_INTERVAL_MS = 30_000;
/** Never deliver rows last updated longer ago than this (restart catch-up bound). */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Longest window a digest covers after a long outage. */
const MAX_DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CANDIDATE_LIMIT = 100;
const RESOLVED_LIMIT = 50;
const DIGEST_ROW_LIMIT = 1_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_GROUPS_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeliveryLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface DispatcherOptions {
  /** Current workspace config (live-reloaded). */
  config: () => Pick<WorkspaceConfig, "workspace" | "dashboard" | "notifications">;
  deps: ChannelDeps;
  now?: () => number;
  log?: DeliveryLogger;
}

/** What one tick did, for tests and logs. */
export interface TickSummary {
  sent: number;
  failed: number;
  skipped: number;
  held: number;
  digests: number;
  resolved: number;
}

function emptySummary(): TickSummary {
  return { sent: 0, failed: 0, skipped: 0, held: 0, digests: 0, resolved: 0 };
}

const consoleLogger: DeliveryLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

function localDayKey(clock: WallClock, at: number): string {
  const wall = clock.wallAt(at);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** Delivers notifications from one database connection. */
export class NotificationDispatcher {
  private readonly state: DeliveryStateStore;
  private readonly now: () => number;
  private readonly log: DeliveryLogger;
  private readonly warnedUnavailable = new Set<string>();
  private lastPruneAt = 0;

  constructor(
    private readonly db: Database,
    private readonly options: DispatcherOptions,
  ) {
    this.state = new DeliveryStateStore(db);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? consoleLogger;
  }

  /** Run one delivery pass over every enabled channel. Never throws. */
  async tick(): Promise<TickSummary> {
    const summary = emptySummary();
    let config: ReturnType<DispatcherOptions["config"]>;
    try {
      config = this.options.config();
    } catch (error) {
      this.log.warn(
        `⚠️  [notifications] could not read delivery config: ${(error as Error).message}`,
      );
      return summary;
    }
    const channels = config.notifications?.channels ?? [];
    if (channels.length === 0 || !hasTable(this.db, "notifications")) return summary;
    const base = resolveDashboardBaseUrl(config, this.options.deps.env);
    const clock = new WallClock(config.notifications?.timezone);
    for (const channel of channels) {
      try {
        await this.deliverChannel(channel, base, clock, summary);
      } catch (error) {
        this.log.warn(
          `⚠️  [notifications] ${channel.type} delivery pass failed: ${(error as Error).message}`,
        );
      }
    }
    this.maybePrune();
    return summary;
  }

  private maybePrune(): void {
    const now = this.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    try {
      this.state.prune(now, PRUNE_GROUPS_OLDER_THAN_MS);
    } catch (error) {
      this.log.warn(
        `⚠️  [notifications] could not prune delivery state: ${(error as Error).message}`,
      );
    }
  }

  private async deliverChannel(
    channel: NotificationChannelConfig,
    base: string,
    clock: WallClock,
    summary: TickSummary,
  ): Promise<void> {
    const name = channel.type;
    const now = this.now();
    const channelState = this.state.channel(name, now);
    const availability = channelAvailability(channel, this.options.deps);
    if (!availability.available) {
      if (!this.warnedUnavailable.has(name)) {
        this.warnedUnavailable.add(name);
        this.log.warn(
          `⚠️  [notifications] ${name} channel unavailable: ${availability.detail}. ` +
            "Run `devintern worker doctor` for details.",
        );
      }
    } else {
      this.warnedUnavailable.delete(name);
    }

    const since = Math.max(channelState.since, now - MAX_LOOKBACK_MS);
    for (const candidate of this.pendingCandidates(name, since)) {
      const { notification } = candidate;
      const decision = decideImmediate(channel, candidate);
      if (decision !== "send" || !availability.available) {
        this.state.record(name, notification.id, {
          count: notification.count,
          status: decision === "digest" ? "digest" : "skipped",
          now,
          ...(decision === "send" ? { error: availability.detail } : {}),
        });
        summary.skipped++;
        continue;
      }
      if (!rateLimitAllows(channel, this.state.lastSentAt(name, notification.groupKey), now)) {
        summary.held++;
        continue;
      }
      const previous = this.state.get(name, notification.id);
      const event = previous || notification.count > 1 ? "resurfaced" : "created";
      const ok = await this.send(channel, buildNotificationMessage(notification, event, base));
      this.state.record(name, notification.id, {
        count: notification.count,
        status: ok ? "sent" : "failed",
        now: this.now(),
        ...(ok ? {} : { error: "delivery failed" }),
      });
      // A failed send also starts the window, so a broken endpoint is not
      // hammered by every repeat of the same cause.
      this.state.recordSent(name, notification.groupKey, this.now());
      if (ok) summary.sent++;
      else summary.failed++;
    }

    if (channel.notifyResolved && availability.available) {
      for (const notification of this.resolvedToAnnounce(name, since)) {
        await this.send(channel, buildNotificationMessage(notification, "resolved", base));
        this.state.markResolvedSent(name, notification.id);
        summary.resolved++;
      }
    }

    if (channel.digestTime) {
      await this.maybeSendDigest(channel, base, clock, availability.available, summary);
    }
  }

  private async maybeSendDigest(
    channel: NotificationChannelConfig,
    base: string,
    clock: WallClock,
    available: boolean,
    summary: TickSummary,
  ): Promise<void> {
    const digestTime = channel.digestTime;
    if (!digestTime) return;
    const name = channel.type;
    const now = this.now();
    const today = localDayKey(clock, now);
    const pastDigestTime = clock.minutesOfDay(now) >= digestTime.minutes;
    const channelState = this.state.channel(name, now);
    if (channelState.lastDigestAt === undefined) {
      // First digest-enabled tick: start the window now. If today's digest
      // time already passed, the first digest goes out tomorrow.
      this.state.recordDigest(name, pastDigestTime ? today : "", now);
      return;
    }
    if (!pastDigestTime || channelState.lastDigestDay === today) return;
    const since = Math.max(channelState.lastDigestAt, now - MAX_DIGEST_WINDOW_MS);
    const items = this.digestCandidates(since, now).filter((item) => digestIncludes(channel, item));
    const digest = buildDigest(items, { since, until: now }, base);
    if (digest && available) {
      await this.send(channel, digest);
      summary.digests++;
    }
    this.state.recordDigest(name, today, now);
  }

  /** Send with retry; log and report false on failure. */
  private async send(
    channel: NotificationChannelConfig,
    message: DeliveryMessage,
  ): Promise<boolean> {
    try {
      await sendToChannel(channel, message, this.options.deps);
      return true;
    } catch (error) {
      const what =
        message.type === "digest" ? "daily digest" : `notification #${message.notification.id}`;
      this.log.warn(
        `⚠️  [notifications] ${channel.type} delivery of ${what} failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private runJoin(): { select: string; join: string } {
    return hasTable(this.db, "runs")
      ? {
          select: ", r.outcome_class AS run_outcome_class",
          join: "LEFT JOIN runs r ON r.id = n.run_id",
        }
      : { select: "", join: "" };
  }

  private toCandidate(raw: unknown): DeliveryCandidate {
    const row = raw as Record<string, unknown>;
    const outcome = row.run_outcome_class;
    return {
      notification: rowToNotification(raw),
      ...(typeof outcome === "string" ? { runOutcomeClass: outcome } : {}),
    };
  }

  private pendingCandidates(channel: string, since: number): DeliveryCandidate[] {
    const { select, join } = this.runJoin();
    return this.db
      .query(
        `SELECT n.*${select} FROM notifications n
         ${join}
         LEFT JOIN notification_deliveries d ON d.channel = ? AND d.notification_id = n.id
         WHERE n.resolved_at IS NULL AND n.muted = 0 AND n.updated_at >= ?
           AND (d.notification_id IS NULL OR d.delivered_count < n.count)
         ORDER BY n.updated_at ASC, n.id ASC
         LIMIT ?`,
      )
      .all(channel, since, CANDIDATE_LIMIT)
      .map((raw) => this.toCandidate(raw));
  }

  private resolvedToAnnounce(channel: string, since: number) {
    return this.db
      .query(
        `SELECT n.* FROM notifications n
         JOIN notification_deliveries d ON d.channel = ? AND d.notification_id = n.id
         WHERE n.resolved_at IS NOT NULL AND n.resolved_at >= ? AND n.muted = 0
           AND d.status = 'sent' AND d.resolved_sent = 0
         ORDER BY n.resolved_at ASC
         LIMIT ?`,
      )
      .all(channel, since, RESOLVED_LIMIT)
      .map((raw) => rowToNotification(raw));
  }

  private digestCandidates(since: number, until: number): DeliveryCandidate[] {
    const { select, join } = this.runJoin();
    return this.db
      .query(
        `SELECT n.*${select} FROM notifications n
         ${join}
         WHERE n.muted = 0 AND n.updated_at > ? AND n.updated_at <= ?
         ORDER BY n.updated_at DESC
         LIMIT ?`,
      )
      .all(since, until, DIGEST_ROW_LIMIT)
      .map((raw) => this.toCandidate(raw));
  }
}

/** Handle for a running delivery loop. */
export interface NotificationDeliveryHandle {
  /** Run one pass now (tests, startup). */
  tick(): Promise<TickSummary>;
  stop(): void;
}

/**
 * Start delivering notifications on an interval (best-effort).
 *
 * Opens its own connection; an unavailable database logs a warning and
 * returns a handle that does nothing.
 */
export function startNotificationDelivery(
  dbPath: string,
  options: DispatcherOptions,
  intervalMs: number = DELIVERY_INTERVAL_MS,
): NotificationDeliveryHandle {
  let db: Database;
  let dispatcher: NotificationDispatcher;
  try {
    db = new Database(dbPath);
    configureSqliteConnection(db);
    dispatcher = new NotificationDispatcher(db, options);
  } catch (error) {
    (options.log ?? consoleLogger).warn(
      `⚠️  [notifications] delivery disabled: ${(error as Error).message}`,
    );
    return { tick: async () => emptySummary(), stop: () => {} };
  }
  let running: Promise<TickSummary> | null = null;
  let stopped = false;
  const tick = (): Promise<TickSummary> => {
    if (stopped) return Promise.resolve(emptySummary());
    if (running) return running;
    running = dispatcher.tick().finally(() => {
      running = null;
      if (stopped) db.close();
    });
    return running;
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (!running) db.close();
    },
  };
}

/**
 * The workspace worker's delivery loop, started once the worker holds its
 * lock. `config` returns the live (reloaded) config, so `[notifications]`
 * edits apply without a restart; env vars are read at send time.
 */
export function workerNotificationDelivery(
  dbPath: string,
  config: DispatcherOptions["config"],
): { start(): void; stop(): void } {
  let handle: NotificationDeliveryHandle | null = null;
  return {
    start: () => {
      if (handle) return;
      handle = startNotificationDelivery(dbPath, { config, deps: defaultChannelDeps(process.env) });
      const channels = config().notifications?.channels ?? [];
      if (channels.length > 0) {
        console.log(`🔔 Notification delivery: ${channels.map((entry) => entry.type).join(", ")}`);
      }
    },
    stop: () => {
      handle?.stop();
      handle = null;
    },
  };
}
