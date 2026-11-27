/**
 * Finish the retry bookkeeping for automatic per-PR work interrupted by a
 * worker exit.
 *
 * A base-sync attempt is consumed before its resolver starts
 * (`beginBaseSyncAttempt`), so a worker that dies mid-run leaves the event
 * `pending` with the attempt already counted but no `failBaseSyncEvent`: the
 * restart retries immediately and the exhaustion cap never applies. Reaping
 * the run closes that gap here — the orphaned attempt counts as a failure, the
 * retry backoff restarts from the worker's restart, and the same cap applies.
 * Repeated orphaning exhausts the event, records a clear outcome on the run,
 * and raises one dashboard notification instead of retrying forever.
 *
 * CI autofix keeps its budget in `ci_fix_state`; an orphaned fix run consumes
 * one attempt there too, so a restart loop reaches the watcher's escalation
 * instead of retrying at every restart.
 */

import type { Database } from "bun:sqlite";

import { parseEnvInteger } from "../config/env-integer";
import { baseSyncExhaustedGroupKey } from "../notifications/base-sync";
import { NotificationEmitter } from "../notifications/emitter";
import { hasTable } from "../notifications/store";
import { DEFAULT_MAX_RETRIES } from "./webhook-queue";
import type { RunStore } from "./run-recorder";

/** Must match the source the review poller marks processed for base sync. */
const BASE_SYNC_SOURCE = "github:base-sync";

/** Reason recorded on a run whose resolver attempt was cut off by the worker. */
export const ORPHANED_FOLLOW_UP_REASON = "orphaned: worker exited before the run finished";

/** Clear outcome recorded when repeated worker exits exhaust a base sync. */
export const ORPHANED_BASE_SYNC_EXHAUSTED_REASON =
  "conflict resolution keeps getting cut off by worker restarts";

/** One reaped run's identity, enough to settle its follow-up work. */
export interface OrphanedFollowUpRun {
  id: number;
  origin: string;
  repo?: string;
  prNumber?: number;
  prUrl?: string;
  /** Run start, used to reject an event that opened after the orphaned run. */
  startedAt?: number;
}

export interface SettleOrphanedFollowUpsOptions {
  /** Retry ceiling; defaults to the workspace's `WEBHOOK_MAX_RETRIES` (3). */
  maxRetries?: number;
  /** Clock override (tests). */
  now?: number;
  /**
   * Emit exhaustion notifications (default true). A caller that settles inside
   * its own transaction passes false and calls
   * {@link notifyOrphanedBaseSyncExhausted} after the commit.
   */
  notify?: boolean;
}

/** A base-sync event that reached the restart cap during settlement. */
export interface OrphanedBaseSyncExhaustion {
  run: OrphanedFollowUpRun;
  attempts: number;
}

/** Configured retry ceiling, matching `WebhookQueue`'s `WEBHOOK_MAX_RETRIES`. */
function configuredMaxRetries(): number {
  return parseEnvInteger("WEBHOOK_MAX_RETRIES", DEFAULT_MAX_RETRIES, { min: 0 });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Settle follow-up state for runs a worker exit orphaned. Best-effort: one
 * run's bookkeeping cannot stop the rest of the sweep.
 *
 * @param db - Writable queue database the run store owns
 * @param runs - Runs reaped by this sweep
 * @param options - Retry ceiling, clock override, and notification switch
 * @returns Base-sync events that reached the cap (notified unless deferred)
 */
export function settleOrphanedFollowUps(
  db: Database,
  runs: readonly OrphanedFollowUpRun[],
  options: SettleOrphanedFollowUpsOptions = {},
): OrphanedBaseSyncExhaustion[] {
  const now = options.now ?? Date.now();
  const maxRetries = options.maxRetries ?? configuredMaxRetries();
  const exhausted = db
    .transaction(() => {
      const settled: OrphanedBaseSyncExhaustion[] = [];
      for (const run of runs) {
        try {
          if (run.origin === "conflict_resolution") {
            const attempts = settleBaseSyncRun(db, run, now, maxRetries);
            if (attempts !== undefined) settled.push({ run, attempts });
          } else if (run.origin === "ci_fix") {
            consumeCiFixAttempt(db, run, now);
          }
        } catch (error) {
          console.warn(
            `⚠️  Could not settle orphaned ${run.origin} run #${run.id}: ${(error as Error).message}`,
          );
        }
      }
      return settled;
    })
    .immediate();
  if (options.notify ?? true) notifyOrphanedBaseSyncExhausted(db, exhausted, now);
  return exhausted;
}

/**
 * Emit the exhaustion rows collected by deferred settlement. Separated from
 * the DB writes so a caller's transaction commits before listeners see it.
 *
 * @param db - Writable queue database
 * @param exhausted - Events that reached the cap
 * @param now - Clock used for the notification timestamp
 */
export function notifyOrphanedBaseSyncExhausted(
  db: Database,
  exhausted: readonly OrphanedBaseSyncExhaustion[],
  now: number,
): void {
  for (const { run, attempts } of exhausted) {
    try {
      notifyBaseSyncExhausted(db, run, attempts, now);
    } catch (error) {
      console.warn(
        `⚠️  Could not notify orphaned ${run.origin} run #${run.id}: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * Mark the PR's pending base-sync event failed so its backoff starts at the
 * restart, and exhaust it once the same attempt cap as a resolver failure is
 * spent. The attempt itself was consumed before the resolver ran.
 *
 * @returns The attempt count when the event reached the cap, else undefined
 */
function settleBaseSyncRun(
  db: Database,
  run: OrphanedFollowUpRun,
  now: number,
  maxRetries: number,
): number | undefined {
  if (!run.repo || run.prNumber === undefined || !hasTable(db, "base_sync_events"))
    return undefined;
  const row = db
    .query(
      `SELECT external_id, attempts, updated_at FROM base_sync_events
       WHERE repo = ? AND pr_number = ? AND status = 'pending'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(run.repo, run.prNumber);
  if (typeof row !== "object" || row === null) return undefined;
  const event = row as { external_id?: unknown; attempts?: unknown; updated_at?: unknown };
  const externalId = optionalString(event.external_id);
  if (!externalId) return undefined;
  // A pending event that opened after this run started belongs to newer work
  // (a later head), not to the attempt the dead worker left behind.
  if (
    run.startedAt !== undefined &&
    isFiniteNumber(event.updated_at) &&
    event.updated_at > run.startedAt
  ) {
    return undefined;
  }

  const attempts = isFiniteNumber(event.attempts) ? event.attempts : 0;
  const exhausted = attempts >= maxRetries;
  const outcome = exhausted
    ? `${ORPHANED_BASE_SYNC_EXHAUSTED_REASON} (${attempts} attempts)`
    : ORPHANED_FOLLOW_UP_REASON;
  db.run(
    `UPDATE base_sync_events SET status = ?, last_error = ?, updated_at = ?
     WHERE external_id = ?`,
    [exhausted ? "failed" : "pending", outcome, now, externalId],
  );
  if (!exhausted) return undefined;
  db.run(
    `INSERT INTO processed_events (source, external_id, processed_at)
     VALUES (?, ?, ?) ON CONFLICT(source, external_id) DO NOTHING`,
    [BASE_SYNC_SOURCE, externalId, now],
  );
  db.run(`UPDATE runs SET outcome_reason = ? WHERE id = ?`, [outcome, run.id]);
  db.run(`UPDATE run_stages SET summary = ? WHERE run_id = ? AND stage = 'outcome'`, [
    outcome,
    run.id,
  ]);
  return attempts;
}

/** One dashboard row per PR whose base sync kept dying with the worker. */
function notifyBaseSyncExhausted(
  db: Database,
  run: OrphanedFollowUpRun,
  attempts: number,
  now: number,
): void {
  if (!run.repo || run.prNumber === undefined) return;
  const repo = run.repo;
  const prNumber = run.prNumber;
  const label = `${repo}#${prNumber}`;
  const prUrl = run.prUrl ?? `https://github.com/${repo}/pull/${prNumber}`;
  new NotificationEmitter(db, () => now).emit({
    kind: "escalated",
    severity: "high",
    groupKey: baseSyncExhaustedGroupKey(repo, prNumber),
    runId: run.id,
    repo,
    subject: `pr:${prUrl}`,
    title: `Conflict resolution for ${label} keeps getting cut off by worker restarts`,
    body:
      `${attempts} automatic attempt${attempts === 1 ? "" : "s"} ended when the worker exited ` +
      "before the run finished. Automatic retries are paused until the base branch moves. " +
      `Run \`devintern resolve-conflicts ${prUrl}\` to try again now.`,
    links: [
      { label: `Run #${run.id}`, runId: run.id },
      { label, url: prUrl },
    ],
    appendLinks: true,
  });
}

/** Count an orphaned CI autofix as one failed attempt for its PR's budget. */
function consumeCiFixAttempt(db: Database, run: OrphanedFollowUpRun, now: number): void {
  if (!run.repo || run.prNumber === undefined || !hasTable(db, "ci_fix_state")) return;
  db.run(
    `INSERT INTO ci_fix_state (repo, pr_number, consecutive_failures, escalated_sha, updated_at)
     VALUES (?, ?, 1, NULL, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       consecutive_failures = ci_fix_state.consecutive_failures + 1,
       updated_at = excluded.updated_at`,
    [run.repo, run.prNumber, now],
  );
}

/**
 * Fail a CI-fix run the parent watcher already counted as a failed attempt but
 * whose child never closed. A child killed by timeout/abort cannot call
 * `endRun`, so the run stays `in_progress`; settling it here keeps the restart
 * reaper (`consumeCiFixAttempt`) from counting the same failure again.
 *
 * Only runs still `in_progress` are listed, so a late child finish is left
 * alone and repeated calls are no-ops.
 *
 * @param store - Run store holding the child's run
 * @param repo - Repository slug stored on the run
 * @param prNumber - Pull request number stored on the run
 * @param reason - Outcome reason recorded on the settled runs
 * @returns Ids of the runs settled by this call
 */
export function settleInProgressCiFixRun(
  store: Pick<RunStore, "listRuns" | "finishRun">,
  repo: string,
  prNumber: number,
  reason: string,
): number[] {
  const runs = store
    .listRuns({ origin: "ci_fix", status: "in_progress", limit: 1_000 })
    .filter((run) => run.repo === repo && run.prNumber === prNumber);
  for (const run of runs) store.finishRun(run.id, "failed", reason);
  return runs.map((run) => run.id);
}
