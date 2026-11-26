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
 * the row is marked handled, and the tick moves on. A send that fails its
 * retry budget stops that channel for the rest of the tick (later candidates,
 * resolves and the digest wait for the next tick); channels run concurrently
 * so one dead endpoint never delays the others. Only the worker that holds
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
/** Minimum gap between attempts to resend a digest whose delivery failed. */
const DIGEST_RETRY_MS = 15 * 60 * 1000;
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
  /** Last failed digest send per channel, to space out retries. */
  private readonly digestFailedAt = new Map<string, number>();

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
    try {
      await this.runTick(summary);
    } catch (error) {
      // Delivery state reads and writes (SQLITE_BUSY, a malformed or dropped
      // table) must never escape: the interval caller does not await.
      this.log.warn(`⚠️  [notifications] delivery tick failed: ${(error as Error).message}`);
    }
    return summary;
  }

  private async runTick(summary: TickSummary): Promise<void> {
    let config: ReturnType<DispatcherOptions["config"]>;
    try {
      config = this.options.config();
    } catch (error) {
      this.log.warn(
        `⚠️  [notifications] could not read delivery config: ${(error as Error).message}`,
      );
      return;
    }
    const tickAt = this.now();
    const previousTickAt = this.state.lastTickAt();
    const channels = config.notifications?.channels ?? [];
    // Mark every configured channel active in the same write as the tick,
    // before any send awaits. A worker stopped mid-tick (sends to one channel
    // can take many seconds) must not leave later channels looking like they
    // missed this tick, or activate() would reset them on restart.
    this.db.transaction(() => {
      this.state.recordTick(tickAt);
      for (const channel of channels) this.state.activate(channel.type, tickAt, previousTickAt);
    })();
    if (channels.length === 0 || !hasTable(this.db, "notifications")) return;
    const base = resolveDashboardBaseUrl(config, this.options.deps.env);
    const clock = new WallClock(config.notifications?.timezone);
    // Channels run concurrently, so a slow or hanging endpoint on one does not
    // delay the others. Their state is keyed by channel type, one per type.
    await Promise.all(
      channels.map(async (channel) => {
        try {
          await this.deliverChannel(channel, base, clock, summary);
        } catch (error) {
          this.log.warn(
            `⚠️  [notifications] ${channel.type} delivery pass failed: ${(error as Error).message}`,
          );
        }
      }),
    );
    // Keep a group's send time while its held repeats can still be released
    // (see pendingCandidates), even for windows longer than the prune age.
    const longestWindowMs = Math.max(
      0,
      ...channels.map((channel) => channel.rateLimitMinutes * 60_000),
    );
    this.maybePrune(Math.max(PRUNE_GROUPS_OLDER_THAN_MS, MAX_LOOKBACK_MS + longestWindowMs));
  }

  private maybePrune(groupsOlderThanMs: number): void {
    const now = this.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    try {
      this.state.prune(now, groupsOlderThanMs);
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
    // Circuit breaker: after one send fails its whole retry budget, stop using
    // this channel for the rest of the tick. Remaining candidates stay
    // unrecorded and go out on a later tick, instead of each spending the
    // retry budget (and being marked failed) against a dead endpoint.
    let broken = false;
    for (const candidate of this.pendingCandidates(channel, channelState.since, since, now)) {
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
      if (ok) {
        summary.sent++;
      } else {
        summary.failed++;
        broken = true;
        break;
      }
    }

    if (channel.notifyResolved && availability.available && !broken) {
      // A failed resolve stays unmarked and is retried on a later tick; the
      // `resolved_at >= since` bound stops retrying after the lookback.
      for (const notification of this.resolvedToAnnounce(name, since)) {
        const ok = await this.send(
          channel,
          buildNotificationMessage(notification, "resolved", base),
        );
        if (!ok) {
          summary.failed++;
          broken = true;
          break;
        }
        this.state.markResolvedSent(name, notification.id);
        summary.resolved++;
      }
    }

    if (channel.digestTime) {
      // A broken channel leaves the digest window open for a later tick.
      await this.maybeSendDigest(channel, base, clock, availability.available && !broken, summary);
    } else {
      this.state.clearDigest(name);
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
    if (digest) {
      // Leave the window open when the digest could not go out, so a later
      // tick (today, or tomorrow with the same `since`) still covers it.
      if (!available) return;
      const failedAt = this.digestFailedAt.get(name);
      if (failedAt !== undefined && now - failedAt < DIGEST_RETRY_MS) return;
      if (!(await this.send(channel, digest))) {
        this.digestFailedAt.set(name, now);
        return;
      }
      this.digestFailedAt.delete(name);
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

  /**
   * Open rows the channel has not handled at their current count. Groups still
   * inside their rate-limit window are left out here, not just skipped in the
   * loop: held rows are never recorded, so they would otherwise fill the
   * LIMIT and starve newer notifications until the window ends.
   */
  private pendingCandidates(
    channel: NotificationChannelConfig,
    channelSince: number,
    since: number,
    now: number,
  ): DeliveryCandidate[] {
    const { select, join } = this.runJoin();
    const windowMs = Math.max(0, channel.rateLimitMinutes) * 60_000;
    // Mirrors rateLimitAllows: held while now - last_sent_at < window.
    const heldAfter = windowMs > 0 ? now - windowMs : Number.MAX_SAFE_INTEGER;
    // A repeat held by the rate limit keeps its updated_at from while it was
    // held, which can be older than the lookback once a long window ends.
    // Groups whose window ended within the lookback stay eligible.
    const releasedAfter = now - MAX_LOOKBACK_MS - windowMs;
    return this.db
      .query(
        `SELECT n.*${select} FROM notifications n
         ${join}
         LEFT JOIN notification_deliveries d ON d.channel = ? AND d.notification_id = n.id
         WHERE n.resolved_at IS NULL AND n.muted = 0 AND n.updated_at >= ?
           AND (
             n.updated_at >= ?
             OR EXISTS (
               SELECT 1 FROM notification_delivery_groups g
               WHERE g.channel = ? AND g.group_key = n.group_key AND g.last_sent_at >= ?
             )
           )
           AND (d.notification_id IS NULL OR d.delivered_count < n.count)
           AND NOT EXISTS (
             SELECT 1 FROM notification_delivery_groups g
             WHERE g.channel = ? AND g.group_key = n.group_key AND g.last_sent_at > ?
           )
         ORDER BY n.updated_at ASC, n.id ASC
         LIMIT ?`,
      )
      .all(
        channel.type,
        channelSince,
        since,
        channel.type,
        releasedAfter,
        channel.type,
        heldAfter,
        CANDIDATE_LIMIT,
      )
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
  const timer = setInterval(() => {
    tick().catch((error: unknown) => {
      (options.log ?? consoleLogger).warn(
        `⚠️  [notifications] delivery tick failed: ${(error as Error).message}`,
      );
    });
  }, intervalMs);
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
