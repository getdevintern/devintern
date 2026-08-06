/**
 * Latches a single early show-about IPC event until a renderer subscriber attaches.
 */

export interface ShowAboutLatch {
  /** Record an IPC show-about arrival (no-op while a subscriber is active). */
  noteEvent(): void;
  /**
   * Register a subscriber. Flushes any latched event via `onFlush`.
   * Returns an unsubscribe that decrements the subscriber count.
   */
  subscribe(onFlush: () => void): () => void;
}

/** Create a latch for show-about events that arrive before the renderer subscribes. */
export function createShowAboutLatch(): ShowAboutLatch {
  let pending = false;
  let subscriberCount = 0;

  return {
    noteEvent() {
      if (subscriberCount === 0) {
        pending = true;
      }
    },
    subscribe(onFlush) {
      subscriberCount += 1;

      if (pending) {
        pending = false;
        onFlush();
      }

      return () => {
        subscriberCount -= 1;
      };
    },
  };
}
