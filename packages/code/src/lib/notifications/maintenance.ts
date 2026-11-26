/**
 * Notification retention maintenance for the worker daemon.
 *
 * Notifications are kept for a bounded window; without a sweep the
 * `notifications` table would grow for the workspace's lifetime and the
 * unread-count endpoint would keep scanning it. Besides resolved rows, the
 * never-resolved informational per-day groups (PRs opened or auto-merged,
 * delegated work) age out too, so they cannot accumulate forever.
 */

import { Database } from "bun:sqlite";

import { parseEnvInteger } from "../config/env-integer";
import { configureSqliteConnection } from "../state/sqlite";
import { workerNotificationDelivery } from "./delivery/dispatcher";
import type { DispatcherOptions } from "./delivery/dispatcher";
import { pruneNotifications } from "./store";

/** Interval between periodic notification prunes (1 hour). */
export const NOTIFICATION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long resolved notifications are retained:
 * `WORKER_NOTIFICATION_RETENTION_DAYS`, default 30 (matching settled injected
 * tasks).
 */
export function notificationRetentionMs(): number {
  return (
    parseEnvInteger("WORKER_NOTIFICATION_RETENTION_DAYS", 30, { min: 0 }) * 24 * 60 * 60 * 1000
  );
}

/**
 * Drop aged-out notifications (best-effort).
 *
 * Opens its own connection, so an unavailable database (gone workspace,
 * missing directory) logs a warning instead of failing worker startup.
 */
export function pruneResolvedNotifications(
  dbPath: string,
  retentionMs: number = notificationRetentionMs(),
): void {
  let db: Database | undefined;
  try {
    db = new Database(dbPath);
    configureSqliteConnection(db);
    const pruned = pruneNotifications(db, retentionMs);
    if (pruned > 0) {
      console.log(`🧹 [fleet] pruned ${pruned} notification row(s)`);
    }
  } catch (error) {
    console.warn(`⚠️  [fleet] could not prune notifications: ${(error as Error).message}`);
  } finally {
    db?.close();
  }
}

/**
 * Keep pruning resolved notifications while the worker runs. The startup sweep
 * alone misses rows resolved by a long-lived daemon, so the table would keep
 * growing until the next restart.
 */
export function startNotificationSweeper(
  dbPath: string,
  retentionMs: number | (() => number) = notificationRetentionMs,
  intervalMs: number = NOTIFICATION_SWEEP_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const activeRetention = typeof retentionMs === "function" ? retentionMs() : retentionMs;
    pruneResolvedNotifications(dbPath, activeRetention);
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/**
 * Worker startup: prune now, keep sweeping, and return the delivery loop for
 * the caller to start once it holds the worker lock.
 */
export function startNotificationMaintenance(
  dbPath: string,
  config: DispatcherOptions["config"],
): { start(): void; stop(): void } {
  pruneResolvedNotifications(dbPath);
  startNotificationSweeper(dbPath);
  return workerNotificationDelivery(dbPath, config);
}
