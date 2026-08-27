/**
 * Per-repository, per-automation checkpoint SHAs for preset automations.
 *
 * Each docs-drift-guard automation stores the last successfully processed
 * commit on the repository default branch. Every run examines only
 * `checkpoint..head`; the checkpoint advances only after the run completed
 * cleanly (valid `no_drift` result or successful ticket/PR publication), so
 * a failed run is retried over the same range by the next scheduled tick.
 *
 * Stored beside the worker queue in `queue.db` (see CLAUDE.md — durable
 * state lives there), keyed by repository name and automation id so several
 * automations can guard the same repository independently.
 */

import { Database } from "bun:sqlite";

import { prepareQueueDbDirectory } from "../webhook-queue";

export interface CheckpointRecord {
  preset: string;
  lastProcessedSha: string;
  updatedAt: number;
}

export class AutomationCheckpointStore {
  private db: Database;

  /** Like {@link AutomationStateStore}: explicit path required by design. */
  constructor(dbPath: string) {
    prepareQueueDbDirectory(dbPath);
    this.db = new Database(dbPath);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS automation_checkpoints (
        repo TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        preset TEXT NOT NULL,
        last_processed_sha TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo, automation_id)
      )
    `);
  }

  /** Latest successful checkpoint, or `null` before the first clean run. */
  get(repo: string, automationId: string): CheckpointRecord | null {
    const row = this.db
      .query(
        `SELECT preset, last_processed_sha, updated_at FROM automation_checkpoints
         WHERE repo = ? AND automation_id = ?`,
      )
      .get(repo, automationId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      preset: row.preset as string,
      lastProcessedSha: row.last_processed_sha as string,
      updatedAt: row.updated_at as number,
    };
  }

  /** Persist a successful checkpoint (call only after clean completion). */
  set(repo: string, automationId: string, preset: string, sha: string): void {
    this.db.run(
      `INSERT INTO automation_checkpoints (repo, automation_id, preset, last_processed_sha, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo, automation_id) DO UPDATE SET
         preset = excluded.preset,
         last_processed_sha = excluded.last_processed_sha,
         updated_at = excluded.updated_at`,
      [repo, automationId, preset, sha, Date.now()],
    );
  }

  /** Forget the checkpoint (next run re-baselines at the current head). */
  clear(repo: string, automationId: string): void {
    this.db.run(`DELETE FROM automation_checkpoints WHERE repo = ? AND automation_id = ?`, [
      repo,
      automationId,
    ]);
  }

  close(): void {
    this.db.close();
  }
}
