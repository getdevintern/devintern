/**
 * Worker-startup housekeeping for agent PRs the registry already records as
 * closed. Best-effort: each step logs its failure and never blocks startup.
 */

import type { WorkerState } from "../state/worker-state";

/**
 * Drop per-PR poll cursors of change requests already closed (databases from
 * before cursors were pruned on close), and settle deferred PR-driven runs on
 * closed PRs (rows deferred before their PR closed, which no close event will
 * settle any more, so they would keep showing as "waiting to retry").
 *
 * @param workerState - Worker state on the workspace database
 */
export function cleanUpClosedPrs(
  workerState: Pick<
    WorkerState,
    "pruneClosedChangeRequestCursors" | "settleDeferredRunsOnClosedPrs"
  >,
): void {
  try {
    const pruned = workerState.pruneClosedChangeRequestCursors();
    if (pruned > 0) {
      console.log(`🧹 [fleet] pruned ${pruned} poll cursor(s) of closed agent PR(s)`);
    }
  } catch (error) {
    console.warn(`⚠️  [fleet] could not prune closed PR cursors: ${(error as Error).message}`);
  }
  try {
    const settled = workerState.settleDeferredRunsOnClosedPrs();
    if (settled.length > 0) {
      console.log(`🧹 [fleet] settled ${settled.length} deferred run(s) on closed PRs`);
    }
  } catch (error) {
    console.warn(
      `⚠️  [fleet] could not settle deferred runs on closed PRs: ${(error as Error).message}`,
    );
  }
}
