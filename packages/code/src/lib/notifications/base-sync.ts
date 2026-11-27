/**
 * Notification row raised when a PR's automatic base sync keeps dying with
 * the worker.
 *
 * The row is cleared from every path that proves the PR no longer needs the
 * sync: a successful conflict-resolution run, GitHub reporting the PR clean
 * again (a human pushed or merged the base), a manual resolve-conflicts run,
 * or the PR leaving the open-PR watch list.
 */

import type { Database } from "bun:sqlite";

import { NotificationEmitter, safely } from "./emitter";

/** Group key of the notification raised when a base sync runs out of restarts. */
export function baseSyncExhaustedGroupKey(repo: string, prNumber: number): string {
  return `escalated:conflict_resolution:${repo.toLowerCase()}#${prNumber}`;
}

/**
 * Clear the exhaustion row for a PR whose conflict is gone.
 *
 * @param db - Writable queue database
 * @param repo - Repository slug (`owner/repo` or project path)
 * @param prNumber - PR or MR number
 * @param now - Clock override (tests)
 */
export function resolveBaseSyncExhausted(
  db: Database,
  repo: string,
  prNumber: number,
  now: () => number = Date.now,
): void {
  safely("base-sync-exhausted", () => {
    new NotificationEmitter(db, now).resolve({
      kinds: ["escalated"],
      groupKey: baseSyncExhaustedGroupKey(repo, prNumber),
    });
  });
}
