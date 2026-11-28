/**
 * Settle deferred PR-driven runs whose retry will never come.
 *
 * A PR-driven run without a task key (CI fix, conflict resolution,
 * auto-merge, ...) that hit a usage limit is recorded `deferred`. It has no
 * retry of its own: the watcher that started it simply starts a fresh run when
 * the PR still needs the work. When the PR closes or merges first, or its CI
 * goes green before a CI fix retried, nothing else would ever settle the row,
 * and the dashboard keeps listing it as "waiting to retry". These helpers mark
 * such rows `abandoned` with the reason they were superseded.
 *
 * Runs with a task key are left alone: their retry goes through the task's own
 * retry path, which settles them.
 */

import type { Database } from "bun:sqlite";

import type { RunOrigin } from "./run-recorder";

/** Which PR's deferred runs to settle. */
export type DeferredPrRunTarget = { prUrl: string } | { repo: string; prNumber: number };

function hasTables(db: Database, ...names: string[]): boolean {
  const placeholders = names.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    )
    .get(...names) as { count: number } | null;
  return row?.count === names.length;
}

function settle(db: Database, ids: number[], reason: string): number[] {
  if (ids.length === 0) return [];
  const now = Date.now();
  const settled: number[] = [];
  for (const id of ids) {
    const { changes } = db.run(
      `UPDATE runs SET status = 'abandoned', outcome_reason = ?, finished_at = ?, step_active = 0
       WHERE id = ? AND status = 'deferred'`,
      [reason, now, id],
    );
    if (changes === 0) continue;
    db.run(`DELETE FROM run_stages WHERE run_id = ? AND stage = 'outcome'`, [id]);
    db.run(
      `INSERT INTO run_stages (run_id, stage, status, summary, detail, created_at)
       VALUES (?, 'outcome', 'abandoned', ?, NULL, ?)`,
      [id, reason, now],
    );
    settled.push(id);
  }
  return settled;
}

/**
 * Settle one PR's deferred, task-keyless runs as `abandoned`.
 *
 * @param db - Writable queue-database connection
 * @param target - The PR, by web URL or by repo and number
 * @param reason - Outcome reason recorded on each settled run
 * @param origins - Only settle runs of these origins (default: every origin)
 * @returns Ids of the runs settled
 */
export function abandonDeferredPrRuns(
  db: Database,
  target: DeferredPrRunTarget,
  reason: string,
  origins?: readonly RunOrigin[],
): number[] {
  if (!hasTables(db, "runs", "run_stages")) return [];
  return db
    .transaction((): number[] => {
      const clauses = ["status = 'deferred'", "task_key IS NULL"];
      const params: Array<string | number> = [];
      if ("prUrl" in target) {
        clauses.push("pr_url = ?");
        params.push(target.prUrl);
      } else {
        clauses.push("repo = ?", "pr_number = ?");
        params.push(target.repo, target.prNumber);
      }
      if (origins && origins.length > 0) {
        clauses.push(`origin IN (${origins.map(() => "?").join(", ")})`);
        params.push(...origins);
      }
      const ids = db
        .query(`SELECT id FROM runs WHERE ${clauses.join(" AND ")}`)
        .all(...params)
        .map((row) => (row as { id: number }).id);
      return settle(db, ids, reason);
    })
    .immediate();
}

/** Outcome reason for a deferred run whose PR closed before it retried. */
export function closedPrReason(closeReason: string | null | undefined): string {
  return closeReason === "merged"
    ? "superseded: the PR merged before this deferred run retried"
    : "superseded: the PR closed before this deferred run retried";
}

/**
 * Settle every deferred, task-keyless run whose PR the registry records as
 * closed. A startup sweep for rows deferred before their PR closed, which
 * no close event will settle any more.
 *
 * @param db - Writable queue-database connection
 * @returns Ids of the runs settled
 */
export function abandonDeferredRunsOnClosedPrs(db: Database): number[] {
  if (!hasTables(db, "runs", "run_stages", "agent_prs")) return [];
  return db
    .transaction((): number[] => {
      const rows = db
        .query(
          `SELECT r.id AS id, MAX(a.close_reason) AS close_reason
           FROM runs r JOIN agent_prs a ON a.web_url = r.pr_url
           WHERE r.status = 'deferred' AND r.task_key IS NULL AND a.state = 'closed'
           GROUP BY r.id`,
        )
        .all() as Array<{ id: number; close_reason: string | null }>;
      const settled: number[] = [];
      for (const row of rows) {
        settled.push(...settle(db, [row.id], closedPrReason(row.close_reason)));
      }
      return settled;
    })
    .immediate();
}
