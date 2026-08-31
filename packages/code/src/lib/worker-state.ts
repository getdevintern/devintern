/**
 * Worker State Store
 *
 * Durable state for the worker daemon, kept in the same SQLite database as
 * the webhook queue (`.devintern-code/queue.db`):
 *
 * - `cursors` — per-source high-water marks for polling ("changed since"
 *   values and HTTP ETags). On startup the worker resumes from these, never
 *   from "now", so a reboot cannot drop events.
 * - `agent_prs` — PRs created by the pipeline. Review polling watches these
 *   automatically (the agent's own PRs need no @mention to trigger).
 * - `addressed_comments` — PR feedback comments this worker has already
 *   addressed. The dedupe gate for review runs is local: GitHub reactions are
 *   visual feedback for humans only.
 */

import { Database } from "bun:sqlite";
import { prepareQueueDbDirectory, resolveQueueDbPath } from "./webhook-queue";

export interface Cursor {
  source: string;
  cursorValue: string;
  etag?: string;
  updatedAt: number;
}

export type AgentPrState = "open" | "closed";

export type AddressedCommentType = "review" | "conversation";

export interface AgentPr {
  repo: string; // owner/repo
  prNumber: number;
  branch?: string;
  taskKey?: string;
  state: AgentPrState;
  createdAt: number;
  updatedAt: number;
}

/**
 * Parse an `owner/repo` slug and PR number from a GitHub PR URL.
 *
 * @param url - e.g. `https://github.com/acme/widgets/pull/142`
 * @returns Parsed parts, or `null` for non-GitHub or malformed URLs
 */
export function parseGitHubPrUrl(url: string): { repo: string; prNumber: number } | null {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  return { repo: match[1], prNumber: parseInt(match[2], 10) };
}

/**
 * SQLite-backed store for worker cursors and the agent PR registry.
 */
export class WorkerState {
  private db: Database;

  /**
   * Open (or create) the worker state tables in the queue database.
   *
   * @param dbPath - Database path (defaults to the shared queue DB)
   * @param options - `readonly` opens the DB without creating dirs/tables
   *                  (dashboard reads alongside a live worker; throws when
   *                  the file does not exist)
   */
  constructor(dbPath: string = resolveQueueDbPath(), options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      this.db = new Database(dbPath, { readonly: true });
      this.db.run("PRAGMA busy_timeout = 5000");
      return;
    }

    prepareQueueDbDirectory(dbPath);

    this.db = new Database(dbPath);
    // The webhook queue may hold a connection to the same file.
    this.db.run("PRAGMA busy_timeout = 5000");
    this.initializeSchema();
  }

  /** Create tables if they do not exist. */
  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cursors (
        source TEXT PRIMARY KEY,
        cursor_value TEXT NOT NULL,
        etag TEXT,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_prs (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        branch TEXT,
        task_key TEXT,
        state TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo, pr_number)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_prs_state
      ON agent_prs(state)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS addressed_comments (
        repo TEXT NOT NULL,
        comment_type TEXT NOT NULL,
        comment_id INTEGER NOT NULL,
        addressed_at INTEGER NOT NULL,
        PRIMARY KEY (repo, comment_type, comment_id)
      )
    `);
  }

  /**
   * Read the persisted cursor for a polling source.
   *
   * @param source - Source key (e.g. `jira`, `github:reviews:owner/repo#42`)
   */
  getCursor(source: string): Cursor | null {
    const row = this.db
      .query(`SELECT source, cursor_value, etag, updated_at FROM cursors WHERE source = ?`)
      .get(source) as Record<string, unknown> | null;

    if (!row) {
      return null;
    }
    return {
      source: row.source as string,
      cursorValue: row.cursor_value as string,
      etag: (row.etag as string | null) ?? undefined,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Persist (upsert) the cursor for a polling source.
   *
   * @param source - Source key
   * @param cursorValue - High-water mark (timestamp, action id, sync token, ...)
   * @param etag - Optional HTTP ETag for conditional requests
   */
  setCursor(source: string, cursorValue: string, etag?: string): void {
    this.db.run(
      `INSERT INTO cursors (source, cursor_value, etag, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         cursor_value = excluded.cursor_value,
         etag = excluded.etag,
         updated_at = excluded.updated_at`,
      [source, cursorValue, etag ?? null, Date.now()],
    );
  }

  /** Remove a source's cursor (e.g. an expired Asana sync token). */
  clearCursor(source: string): void {
    this.db.run(`DELETE FROM cursors WHERE source = ?`, [source]);
  }

  /** List all persisted polling cursors (dashboard freshness view). */
  listCursors(): Cursor[] {
    const rows = this.db
      .query(`SELECT source, cursor_value, etag, updated_at FROM cursors ORDER BY source ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      source: row.source as string,
      cursorValue: row.cursor_value as string,
      etag: (row.etag as string | null) ?? undefined,
      updatedAt: row.updated_at as number,
    }));
  }

  /** Count agent PRs by state (dashboard header view). */
  countAgentPrs(): { open: number; closed: number } {
    const rows = this.db
      .query(`SELECT state, COUNT(*) AS count FROM agent_prs GROUP BY state`)
      .all() as { state: string; count: number }[];
    const result = { open: 0, closed: 0 };
    for (const row of rows) {
      if (row.state === "open") result.open = row.count;
      if (row.state === "closed") result.closed = row.count;
    }
    return result;
  }

  /**
   * Register a PR created by the pipeline (upsert; reopening resets state).
   *
   * @param pr - Repo slug, PR number, and optional branch/task metadata
   */
  recordAgentPr(pr: { repo: string; prNumber: number; branch?: string; taskKey?: string }): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO agent_prs (repo, pr_number, branch, task_key, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)
       ON CONFLICT(repo, pr_number) DO UPDATE SET
         branch = excluded.branch,
         task_key = excluded.task_key,
         state = 'open',
         updated_at = excluded.updated_at`,
      [pr.repo, pr.prNumber, pr.branch ?? null, pr.taskKey ?? null, now, now],
    );
  }

  /**
   * List agent-created PRs that are still open (the review-polling watch list).
   *
   * @param repo - Optional repo slug filter
   */
  listOpenAgentPrs(repo?: string): AgentPr[] {
    const rows = (
      repo
        ? this.db
            .query(
              `SELECT repo, pr_number, branch, task_key, state, created_at, updated_at
               FROM agent_prs WHERE state = 'open' AND repo = ? ORDER BY created_at ASC`,
            )
            .all(repo)
        : this.db
            .query(
              `SELECT repo, pr_number, branch, task_key, state, created_at, updated_at
               FROM agent_prs WHERE state = 'open' ORDER BY created_at ASC`,
            )
            .all()
    ) as Record<string, unknown>[];

    return rows.map((row) => ({
      repo: row.repo as string,
      prNumber: row.pr_number as number,
      branch: (row.branch as string | null) ?? undefined,
      taskKey: (row.task_key as string | null) ?? undefined,
      state: row.state as AgentPrState,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  /**
   * Close every open agent PR whose repo is not managed by this worker,
   * e.g. rows left over from a repo rename/transfer or from an older
   * checkout sharing the same queue database. Returns what was closed so
   * the caller can log it.
   *
   * @param allowedRepos - Repo slugs (`owner/repo`) this worker manages
   */
  closeForeignAgentPrs(allowedRepos: Iterable<string>): Array<{ repo: string; prNumber: number }> {
    const allowed = [...allowedRepos];
    if (allowed.length === 0) {
      return [];
    }
    const placeholders = allowed.map(() => "?").join(", ");
    const foreign = this.db
      .query(
        `SELECT repo, pr_number FROM agent_prs
         WHERE state = 'open' AND repo NOT IN (${placeholders})`,
      )
      .all(...allowed) as Array<{ repo: string; pr_number: number }>;
    if (foreign.length === 0) {
      return [];
    }
    this.db.run(
      `UPDATE agent_prs SET state = 'closed', updated_at = ?
       WHERE state = 'open' AND repo NOT IN (${placeholders})`,
      [Date.now(), ...allowed],
    );
    return foreign.map((row) => ({ repo: row.repo, prNumber: row.pr_number }));
  }

  /**
   * Mark an agent PR as closed/merged so review polling stops watching it.
   *
   * @param repo - Repo slug
   * @param prNumber - PR number
   */
  markAgentPrClosed(repo: string, prNumber: number): void {
    this.db.run(
      `UPDATE agent_prs SET state = 'closed', updated_at = ? WHERE repo = ? AND pr_number = ?`,
      [Date.now(), repo, prNumber],
    );
  }

  /**
   * Whether a PR feedback comment was already addressed by this worker.
   * This is the dedupe gate for review runs — GitHub reactions carry no
   * gating meaning.
   *
   * @param repo - Repo slug (`owner/repo`)
   * @param commentType - `review` (inline) or `conversation` (issue comment)
   * @param commentId - GitHub comment id
   */
  isCommentAddressed(repo: string, commentType: AddressedCommentType, commentId: number): boolean {
    return (
      this.db
        .query(
          `SELECT 1 FROM addressed_comments WHERE repo = ? AND comment_type = ? AND comment_id = ?`,
        )
        .get(repo, commentType, commentId) !== null
    );
  }

  /**
   * Record a single PR feedback comment as addressed (idempotent).
   *
   * @param repo - Repo slug (`owner/repo`)
   * @param commentType - `review` (inline) or `conversation` (issue comment)
   * @param commentId - GitHub comment id
   */
  markCommentAddressed(repo: string, commentType: AddressedCommentType, commentId: number): void {
    this.db.run(
      `INSERT OR IGNORE INTO addressed_comments (repo, comment_type, comment_id, addressed_at)
       VALUES (?, ?, ?, ?)`,
      [repo, commentType, commentId, Date.now()],
    );
  }

  /**
   * Record PR feedback comments as addressed (idempotent, single transaction).
   *
   * @param repo - Repo slug (`owner/repo`)
   * @param commentType - `review` (inline) or `conversation` (issue comment)
   * @param commentIds - GitHub comment ids
   */
  markCommentsAddressed(
    repo: string,
    commentType: AddressedCommentType,
    commentIds: number[],
  ): void {
    if (commentIds.length === 0) return;
    const now = Date.now();
    this.db.transaction(() => {
      for (const commentId of commentIds) {
        this.db.run(
          `INSERT OR IGNORE INTO addressed_comments (repo, comment_type, comment_id, addressed_at)
           VALUES (?, ?, ?, ?)`,
          [repo, commentType, commentId, now],
        );
      }
    })();
  }

  /** Close the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }
}

/**
 * Best-effort registration of a freshly created PR in the agent PR registry.
 * Never throws — a bookkeeping failure must not fail the run that just
 * successfully created a PR.
 *
 * @param prUrl - PR URL returned by the PR client
 * @param branch - Source branch of the PR
 * @param taskKey - Task tracker key the PR implements
 */
export function recordAgentPrFromUrl(prUrl: string, branch?: string, taskKey?: string): void {
  try {
    const parsed = parseGitHubPrUrl(prUrl);
    if (!parsed) {
      return; // non-GitHub host; review polling is GitHub-first
    }
    const state = new WorkerState();
    try {
      state.recordAgentPr({ ...parsed, branch, taskKey });
    } finally {
      state.close();
    }
  } catch (error) {
    console.warn(`⚠️  Could not record agent PR for polling: ${(error as Error).message}`);
  }
}
