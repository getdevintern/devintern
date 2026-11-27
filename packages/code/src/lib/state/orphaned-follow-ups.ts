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
import { NotificationEmitter } from "../notifications/emitter";
import { hasTable } from "../notifications/store";
import { DEFAULT_MAX_RETRIES } from "./webhook-queue";

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
}

/** Group key of the notification raised when a base sync runs out of restarts. */
export function baseSyncExhaustedGroupKey(repo: string, prNumber: number): string {
  return `escalated:conflict_resolution:${repo.toLowerCase()}#${prNumber}`;
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
 * @param options - Retry ceiling and clock override
 */
export function settleOrphanedFollowUps(
  db: Database,
  runs: readonly OrphanedFollowUpRun[],
  options: SettleOrphanedFollowUpsOptions = {},
): void {
  const now = options.now ?? Date.now();
  const maxRetries = options.maxRetries ?? configuredMaxRetries();
  for (const run of runs) {
    try {
      if (run.origin === "conflict_resolution") {
        settleBaseSyncRun(db, run, now, maxRetries);
      } else if (run.origin === "ci_fix") {
        consumeCiFixAttempt(db, run, now);
      }
    } catch (error) {
      console.warn(
        `⚠️  Could not settle orphaned ${run.origin} run #${run.id}: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * Mark the PR's pending base-sync event failed so its backoff starts at the
 * restart, and exhaust it once the same attempt cap as a resolver failure is
 * spent. The attempt itself was consumed before the resolver ran.
 */
function settleBaseSyncRun(
  db: Database,
  run: OrphanedFollowUpRun,
  now: number,
  maxRetries: number,
): void {
  if (!run.repo || run.prNumber === undefined || !hasTable(db, "base_sync_events")) return;
  const row = db
    .query(
      `SELECT external_id, attempts, updated_at FROM base_sync_events
       WHERE repo = ? AND pr_number = ? AND status = 'pending'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(run.repo, run.prNumber);
  if (typeof row !== "object" || row === null) return;
  const event = row as { external_id?: unknown; attempts?: unknown; updated_at?: unknown };
  const externalId = optionalString(event.external_id);
  if (!externalId) return;
  // A pending event that opened after this run started belongs to newer work
  // (a later head), not to the attempt the dead worker left behind.
  if (
    run.startedAt !== undefined &&
    isFiniteNumber(event.updated_at) &&
    event.updated_at > run.startedAt
  ) {
    return;
  }

  const attempts = isFiniteNumber(event.attempts) ? event.attempts : 0;
  const exhausted = attempts >= maxRetries;
  const outcome = exhausted
    ? `${ORPHANED_BASE_SYNC_EXHAUSTED_REASON} (${attempts} attempts)`
    : ORPHANED_FOLLOW_UP_REASON;
  db.transaction(() => {
    db.run(
      `UPDATE base_sync_events SET status = ?, last_error = ?, updated_at = ?
       WHERE external_id = ?`,
      [exhausted ? "failed" : "pending", outcome, now, externalId],
    );
    if (!exhausted) return;
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
  })();
  if (exhausted) notifyBaseSyncExhausted(db, run, attempts, now);
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
