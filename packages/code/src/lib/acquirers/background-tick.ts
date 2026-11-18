/**
 * Kick off an acquirer's first tick without awaiting it.
 *
 * `startWorker` starts acquirers one after another, so a `start()` that
 * awaited a tick able to run agents (conflict resolution, CI fixes, merge
 * reviews, task executions) held every later acquirer, the relay included,
 * for as long as that tick took. Callers arm their interval first and rely on
 * their own busy guard so an interval fire during this tick is a no-op.
 *
 * A rejection is logged instead of surfacing as an unhandled rejection.
 */
export function startFirstTickInBackground(name: string, tick: () => Promise<unknown>): void {
  void tick().catch((error: unknown) => {
    console.warn(
      `⚠️  [${name}] first poll failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
