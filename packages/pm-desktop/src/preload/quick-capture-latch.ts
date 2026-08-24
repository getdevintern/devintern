/**
 * Latches the latest Quick Capture IPC event until a renderer subscriber
 * attaches (hotkey pressed during app startup, before React mounts).
 */

import type { QuickCaptureEvent } from "../shared/ipc-contract.ts";

export interface QuickCaptureLatch {
  /** Record an IPC quick-capture arrival (replaces any latched payload). */
  noteEvent(event: QuickCaptureEvent): void;
  /**
   * Register a subscriber. Flushes any latched event once via `onFlush`.
   * Returns an unsubscribe that decrements the subscriber count.
   */
  subscribe(onFlush: (event: QuickCaptureEvent) => void): () => void;
}

export function createQuickCaptureLatch(): QuickCaptureLatch {
  let pending: QuickCaptureEvent | null = null;
  let subscriberCount = 0;

  return {
    noteEvent(event) {
      if (subscriberCount === 0) {
        pending = event;
      }
    },
    subscribe(onFlush) {
      subscriberCount += 1;

      if (pending) {
        const flushed = pending;
        pending = null;
        onFlush(flushed);
      }

      return () => {
        subscriberCount -= 1;
      };
    },
  };
}
