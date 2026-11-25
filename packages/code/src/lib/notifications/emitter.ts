/**
 * Notification emitter: the one entry point rules use to record or resolve
 * notifications.
 *
 * Every emitter call is best-effort. Notification bookkeeping runs inside the
 * run-finish, PR, injected-task, and source-health writes, so a failure here
 * is caught and logged and never reaches the caller (a run must never fail or
 * slow down because a notification could not be written).
 *
 * Fan-out: listeners registered with {@link addNotificationListener} see every
 * created, grouped, updated, and resolved notification in this process. The
 * store is the source of truth: emits also happen in CLI child processes, so
 * an external delivery (Slack, desktop, webhooks) that needs every event
 * should read the table rather than rely on in-process listeners alone.
 */

import type { Database } from "bun:sqlite";

import { NotificationStore } from "./store";
import type { ResolveMatch } from "./store";
import type { EmitResult, Notification, NotificationInput, NotificationPatch } from "./types";

/** What a listener is told. */
export type NotificationEvent =
  | { type: "created" | "grouped" | "updated"; notification: Notification }
  | { type: "resolved"; match: ResolveMatch; count: number };

export type NotificationListener = (event: NotificationEvent) => void;

const listeners = new Set<NotificationListener>();

/**
 * Subscribe to notification events in this process.
 *
 * @returns Unsubscribe function
 */
export function addNotificationListener(listener: NotificationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(event: NotificationEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn(`⚠️  Notification listener failed: ${(error as Error).message}`);
    }
  }
}

/** Log a notification failure without propagating it. */
export function warnNotification(action: string, error: unknown): void {
  console.warn(`⚠️  Notification (${action}) failed: ${(error as Error).message}`);
}

/**
 * Run notification work, swallowing and logging any error.
 *
 * @param action - Label for the log line
 * @param work - Notification work
 */
export function safely(action: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    warnNotification(action, error);
  }
}

/** Emits and resolves through one store, publishing to listeners. */
export class NotificationEmitter {
  readonly store: NotificationStore;

  constructor(db: Database, now?: () => number) {
    this.store = new NotificationStore(db, now);
  }

  emit(input: NotificationInput): EmitResult {
    const result = this.store.emit(input);
    if (result.notification && result.action !== "muted") {
      publish({
        type:
          result.action === "created"
            ? "created"
            : result.action === "grouped"
              ? "grouped"
              : "updated",
        notification: result.notification,
      });
    }
    return result;
  }

  update(
    groupKey: string,
    patch: NotificationPatch,
    options: { resurface?: boolean } = {},
  ): Notification | null {
    const notification = this.store.updateOpenGroup(groupKey, patch, options);
    if (notification) publish({ type: "updated", notification });
    return notification;
  }

  resolve(match: ResolveMatch): number {
    const count = this.store.resolveMatching(match);
    if (count > 0) publish({ type: "resolved", match, count });
    return count;
  }
}
