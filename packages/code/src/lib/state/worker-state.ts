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
 * - `actioned_tasks` — tickets that already produced a PR, keyed by tracker
 *   source. The acquirer uses this to keep an actioned ticket out of the sweep
 *   even when it still matches the query, until its signal changes again.
 */

import { Database } from "bun:sqlite";
import { parseChangeRequestUrl } from "../code-host/index";
import type { ChangeRequestIdentity, CodeHostProvider } from "../code-host/index";
import { configureSqliteConnection } from "./sqlite";
import { buildTicketUrl } from "../task/ticket-url";
import { prepareQueueDbDirectory, resolveQueueDbPath } from "./webhook-queue";
import {
  optionalEnum,
  optionalNumber,
  optionalString,
  parseRowObject,
  requireEnum,
  requireNumber,
  requireString,
} from "./row-parse";

export interface Cursor {
  source: string;
  cursorValue: string;
  etag?: string;
  updatedAt: number;
}

export type AgentPrState = "open" | "closed";

const AGENT_PR_STATES = ["open", "closed"] as const satisfies readonly AgentPrState[];
const CODE_HOST_PROVIDERS = [
  "github",
  "gitlab",
  "bitbucket",
] as const satisfies readonly CodeHostProvider[];

/** `worker_meta` key holding the epoch ms of the last executed task drain. */
export const TASK_POLL_LAST_DRAIN_KEY = "task-poll:last-drain-at";

export type AddressedCommentType = "review" | "conversation";

export interface AgentPr {
  provider: CodeHostProvider;
  instanceUrl: string;
  projectId?: string;
  projectPath: string;
  changeNumber: number;
  webUrl: string;
  /** @deprecated Use `projectPath`. Retained for GitHub polling compatibility. */
  repo: string; // owner/repo
  /** @deprecated Use `changeNumber`. Retained for GitHub polling compatibility. */
  prNumber: number;
  branch?: string;
  taskKey?: string;
  /**
   * Tracker ticket link, derived from the tracker configured when the PR was
   * created and frozen here. The dashboard replays it verbatim, so switching
   * `TASK_TRACKER` later (or running the dashboard without tracker env) never
   * breaks links for already-created PRs.
   */
  ticketUrl?: string;
  state: AgentPrState;
  createdAt: number;
  updatedAt: number;
}

/** Consecutive CI-fix bookkeeping for one agent-created PR. */
export interface CiFixState {
  consecutiveFailures: number;
  /** Head SHA where the worker exhausted its budget and escalated. */
  escalatedSha?: string;
}

/**
 * A ticket that already produced a PR.
 *
 * `signal` digests the human-editable fields (summary, description, status,
 * labels) observed immediately after the worker's own post-PR writes, so the
 * worker's own comment/transition does not look like a change and re-arm the
 * ticket. Any later change by a person yields a different signal.
 *
 * `verified` is false when the signal was recorded from a fallback snapshot
 * because the tracker read failed; the gate keeps such a record suppressed
 * until a successful read refreshes it.
 *
 * `updatedStamp` is the tracker's `updated` value observed at the last
 * successful read. The gate compares a sweep's `updated` against it to skip
 * the per-ticket tracker read; persisting it lets that cache survive restarts.
 */
export interface ActionedTask {
  taskKey: string;
  signal: string;
  verified: boolean;
  updatedStamp: string | null;
  pending: boolean;
  fallbackSnapshot: string | null;
  transitioned: boolean;
  transitionStatus: string | null;
  actionedAt: number;
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

/** Read the column names of a table from `PRAGMA table_info`. */
function readColumnNames(db: Database, table: string): string[] {
  const context = `PRAGMA table_info(${table})`;
  return db
    .query(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => requireString(parseRowObject(column, context), "name", context));
}

/** Parse one `cursors` row read from SQLite into a {@link Cursor}. */
function parseCursorRow(row: unknown): Cursor {
  const record = parseRowObject(row, "cursors row");
  return {
    source: requireString(record, "source", "cursors row"),
    cursorValue: requireString(record, "cursor_value", "cursors row"),
    etag: optionalString(record, "etag", "cursors row"),
    updatedAt: requireNumber(record, "updated_at", "cursors row"),
  };
}

/** Parse one `agent_prs` row, filling legacy columns the schema no longer writes. */
function parseAgentPrRow(row: unknown): AgentPr {
  const record = parseRowObject(row, "agent_prs row");
  const repo = requireString(record, "repo", "agent_prs row");
  const prNumber = requireNumber(record, "pr_number", "agent_prs row");
  const provider =
    optionalEnum(CODE_HOST_PROVIDERS, record.provider, "provider", "agent_prs row") ?? "github";
  const instanceUrl =
    optionalString(record, "instance_url", "agent_prs row") ??
    (provider === "bitbucket" ? "https://bitbucket.org" : "https://github.com");
  return {
    provider,
    instanceUrl,
    projectId: optionalString(record, "project_id", "agent_prs row"),
    projectPath: optionalString(record, "project_path", "agent_prs row") ?? repo,
    changeNumber: optionalNumber(record, "change_number", "agent_prs row") ?? prNumber,
    webUrl:
      optionalString(record, "web_url", "agent_prs row") ??
      `https://github.com/${repo}/pull/${prNumber}`,
    repo,
    prNumber,
    branch: optionalString(record, "branch", "agent_prs row"),
    taskKey: optionalString(record, "task_key", "agent_prs row"),
    ticketUrl: optionalString(record, "ticket_url", "agent_prs row"),
    state: requireEnum(AGENT_PR_STATES, record.state, "state", "agent_prs row"),
    createdAt: requireNumber(record, "created_at", "agent_prs row"),
    updatedAt: requireNumber(record, "updated_at", "agent_prs row"),
  };
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
      configureSqliteConnection(this.db, { readonly: true });
      return;
    }

    prepareQueueDbDirectory(dbPath);

    this.db = new Database(dbPath);
    configureSqliteConnection(this.db);
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

    this.initializeAgentPrSchema();

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_prs_state
      ON agent_prs(state)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS worker_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS ci_fix_state (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        escalated_sha TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo, pr_number)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS actioned_tasks (
        source TEXT NOT NULL,
        task_key TEXT NOT NULL,
        signal TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 1,
        updated_stamp TEXT,
        pending INTEGER NOT NULL DEFAULT 0,
        fallback_snapshot TEXT,
        transitioned INTEGER NOT NULL DEFAULT 0,
        transition_status TEXT,
        actioned_at INTEGER NOT NULL,
        PRIMARY KEY (source, task_key)
      )
    `);

    // Databases created before `verified` recorded every marker from a
    // successful read, so backfilling 1 preserves their behavior.
    const actionedColumns = readColumnNames(this.db, "actioned_tasks");
    if (!actionedColumns.includes("verified")) {
      this.db.run("ALTER TABLE actioned_tasks ADD COLUMN verified INTEGER NOT NULL DEFAULT 1");
    }
    // Older rows have no persisted stamp; the gate simply reads once and
    // backfills it, so no data migration is needed.
    if (!actionedColumns.includes("updated_stamp")) {
      this.db.run("ALTER TABLE actioned_tasks ADD COLUMN updated_stamp TEXT");
    }
    for (const [name, definition] of [
      ["pending", "INTEGER NOT NULL DEFAULT 0"],
      ["fallback_snapshot", "TEXT"],
      ["transitioned", "INTEGER NOT NULL DEFAULT 0"],
      ["transition_status", "TEXT"],
    ]) {
      if (!actionedColumns.includes(name)) {
        this.db.run(`ALTER TABLE actioned_tasks ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  /** Create or migrate the change-request registry without losing legacy rows. */
  private initializeAgentPrSchema(): void {
    const existing = this.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_prs'")
      .get();

    if (!existing) {
      this.createAgentPrTable();
      return;
    }

    const columns = readColumnNames(this.db, "agent_prs");
    if (columns.includes("provider")) return;

    const hasTicketUrl = columns.includes("ticket_url");
    this.db.transaction(() => {
      this.db.run("ALTER TABLE agent_prs RENAME TO agent_prs_legacy");
      this.createAgentPrTable();
      this.db.run(`
        INSERT INTO agent_prs (
          provider, instance_url, project_path, change_number, web_url,
          repo, pr_number, branch, task_key, ticket_url, state, created_at, updated_at
        )
        SELECT
          'github', 'https://github.com', repo, pr_number,
          'https://github.com/' || repo || '/pull/' || pr_number,
          repo, pr_number, branch, task_key, ${hasTicketUrl ? "ticket_url" : "NULL"},
          state, created_at, updated_at
        FROM agent_prs_legacy
      `);
      this.db.run("DROP TABLE agent_prs_legacy");
    })();
  }

  /** Create the provider-aware change-request registry. */
  private createAgentPrTable(): void {
    this.db.run(`
      CREATE TABLE agent_prs (
        provider TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        project_id TEXT,
        project_path TEXT NOT NULL,
        change_number INTEGER NOT NULL,
        web_url TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        branch TEXT,
        task_key TEXT,
        ticket_url TEXT,
        state TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, instance_url, project_path, change_number)
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
      .get(source);

    if (!row) {
      return null;
    }
    return parseCursorRow(row);
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
      .all();
    return rows.map((row) => parseCursorRow(row));
  }

  /** Count agent PRs by state (dashboard header view). */
  countAgentPrs(): { open: number; closed: number } {
    const rows = this.db
      .query(`SELECT state, COUNT(*) AS count FROM agent_prs GROUP BY state`)
      .all();
    const result = { open: 0, closed: 0 };
    for (const row of rows) {
      const record = parseRowObject(row, "agent_prs count row");
      const state = requireEnum(AGENT_PR_STATES, record.state, "state", "agent_prs count row");
      const count = requireNumber(record, "count", "agent_prs count row");
      result[state] = count;
    }
    return result;
  }

  /**
   * Register a PR created by the pipeline (upsert; reopening resets state).
   *
   * @param pr - Repo slug, PR number, and optional branch/task metadata
   *             including the ticket URL derived from the tracker active at
   *             creation time
   */
  recordAgentPr(pr: {
    repo: string;
    prNumber: number;
    branch?: string;
    taskKey?: string;
    ticketUrl?: string;
  }): void {
    this.recordAgentChangeRequest(
      {
        provider: "github",
        instanceUrl: "https://github.com",
        projectPath: pr.repo,
        number: pr.prNumber,
        webUrl: `https://github.com/${pr.repo}/pull/${pr.prNumber}`,
      },
      pr,
    );
  }

  /** Register a provider-neutral pull or merge request. */
  recordAgentChangeRequest(
    change: ChangeRequestIdentity,
    metadata: { branch?: string; taskKey?: string; ticketUrl?: string } = {},
  ): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO agent_prs (
         provider, instance_url, project_id, project_path, change_number, web_url,
         repo, pr_number, branch, task_key, ticket_url, state, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
       ON CONFLICT(provider, instance_url, project_path, change_number) DO UPDATE SET
         project_id = excluded.project_id,
         web_url = excluded.web_url,
         repo = excluded.repo,
         pr_number = excluded.pr_number,
         branch = excluded.branch,
         task_key = excluded.task_key,
         ticket_url = excluded.ticket_url,
         state = 'open',
         updated_at = excluded.updated_at`,
      [
        change.provider,
        change.instanceUrl,
        change.projectId ?? null,
        change.projectPath,
        change.number,
        change.webUrl,
        change.projectPath,
        change.number,
        metadata.branch ?? null,
        metadata.taskKey ?? null,
        metadata.ticketUrl ?? null,
        now,
        now,
      ],
    );
  }

  /**
   * List agent-created PRs that are still open (the review-polling watch list).
   *
   * @param repo - Optional repo slug filter
   */
  listOpenAgentPrs(repo?: string): AgentPr[] {
    // `SELECT *` (like the run store's reads) so a readonly dashboard can
    // still list PRs from a database that predates the ticket_url column.
    const hasProvider = readColumnNames(this.db, "agent_prs").includes("provider");
    const providerFilter = hasProvider ? " AND provider = 'github'" : "";
    const rows = repo
      ? this.db
          .query(
            `SELECT * FROM agent_prs
               WHERE state = 'open'${providerFilter} AND repo = ? ORDER BY created_at ASC`,
          )
          .all(repo)
      : this.db
          .query(
            `SELECT * FROM agent_prs
               WHERE state = 'open'${providerFilter} ORDER BY created_at ASC`,
          )
          .all();

    return rows.map((row) => this.mapAgentPrRow(row));
  }

  /** List every open provider change request for dashboard and diagnostics. */
  listOpenAgentChangeRequests(): AgentPr[] {
    const rows = this.db
      .query(`SELECT * FROM agent_prs WHERE state = 'open' ORDER BY created_at ASC`)
      .all();
    return rows.map((row) => this.mapAgentPrRow(row));
  }

  /** Map both legacy readonly schemas and the provider-aware schema. */
  private mapAgentPrRow(row: unknown): AgentPr {
    return parseAgentPrRow(row);
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
         WHERE state = 'open' AND provider = 'github' AND repo NOT IN (${placeholders})`,
      )
      .all(...allowed)
      .map((row) => {
        const record = parseRowObject(row, "agent_prs foreign row");
        return {
          repo: requireString(record, "repo", "agent_prs foreign row"),
          prNumber: requireNumber(record, "pr_number", "agent_prs foreign row"),
        };
      });
    if (foreign.length === 0) {
      return [];
    }
    this.db.run(
      `UPDATE agent_prs SET state = 'closed', updated_at = ?
       WHERE state = 'open' AND provider = 'github' AND repo NOT IN (${placeholders})`,
      [Date.now(), ...allowed],
    );
    return foreign;
  }

  /**
   * Mark an agent PR as closed/merged so review polling stops watching it.
   *
   * @param repo - Repo slug
   * @param prNumber - PR number
   */
  markAgentPrClosed(repo: string, prNumber: number): void {
    this.db.run(
      `UPDATE agent_prs SET state = 'closed', updated_at = ?
       WHERE provider = 'github' AND repo = ? AND pr_number = ?`,
      [Date.now(), repo, prNumber],
    );
  }

  /** Mark one provider-neutral registered change request closed. */
  markAgentChangeRequestClosed(identity: ChangeRequestIdentity): void {
    this.db.run(
      `UPDATE agent_prs SET state = 'closed', updated_at = ?
       WHERE provider = ? AND instance_url = ?
         AND COALESCE(project_id, '') = COALESCE(?, '')
         AND project_path = ? AND change_number = ?`,
      [
        Date.now(),
        identity.provider,
        identity.instanceUrl,
        identity.projectId ?? null,
        identity.projectPath,
        identity.number,
      ],
    );
  }

  /** Read CI autofix retry state, defaulting to a fresh budget. */
  getCiFixState(repo: string, prNumber: number): CiFixState {
    const row = this.db
      .query(
        `SELECT consecutive_failures, escalated_sha FROM ci_fix_state
         WHERE repo = ? AND pr_number = ?`,
      )
      .get(repo, prNumber);
    if (!row) {
      return { consecutiveFailures: 0 };
    }
    const record = parseRowObject(row, "ci_fix_state row");
    return {
      consecutiveFailures: requireNumber(record, "consecutive_failures", "ci_fix_state row"),
      escalatedSha: optionalString(record, "escalated_sha", "ci_fix_state row"),
    };
  }

  /** Persist CI autofix retry state. */
  setCiFixState(repo: string, prNumber: number, state: CiFixState): void {
    this.db.run(
      `INSERT INTO ci_fix_state (repo, pr_number, consecutive_failures, escalated_sha, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo, pr_number) DO UPDATE SET
         consecutive_failures = excluded.consecutive_failures,
         escalated_sha = excluded.escalated_sha,
         updated_at = excluded.updated_at`,
      [repo, prNumber, state.consecutiveFailures, state.escalatedSha ?? null, Date.now()],
    );
  }

  /**
   * Read the locally-recorded actioned state for a ticket.
   *
   * @param source - Tracker source key (matches the poll cursor source)
   * @param taskKey - Tracker task key
   * @returns The record, or `null` when the ticket was never actioned here
   */
  getTaskActioned(source: string, taskKey: string): ActionedTask | null {
    const row = this.db
      .query(
        `SELECT task_key, signal, verified, updated_stamp, pending, fallback_snapshot,
                transitioned, transition_status, actioned_at
         FROM actioned_tasks WHERE source = ? AND task_key = ?`,
      )
      .get(source, taskKey);
    if (!row) return null;
    const record = parseRowObject(row, "actioned_tasks row");
    return {
      taskKey: requireString(record, "task_key", "actioned_tasks row"),
      signal: requireString(record, "signal", "actioned_tasks row"),
      verified: optionalNumber(record, "verified", "actioned_tasks row") !== 0,
      updatedStamp: optionalString(record, "updated_stamp", "actioned_tasks row") ?? null,
      pending: optionalNumber(record, "pending", "actioned_tasks row") === 1,
      fallbackSnapshot: optionalString(record, "fallback_snapshot", "actioned_tasks row") ?? null,
      transitioned: optionalNumber(record, "transitioned", "actioned_tasks row") === 1,
      transitionStatus: optionalString(record, "transition_status", "actioned_tasks row") ?? null,
      actionedAt: requireNumber(record, "actioned_at", "actioned_tasks row"),
    };
  }

  /**
   * Record (or refresh) a ticket as actioned after its PR was created.
   *
   * @param source - Tracker source key
   * @param taskKey - Tracker task key
   * @param signal - Digest of the ticket's human-editable fields
   * @param verified - False when the signal came from a fallback snapshot
   *                   instead of a successful tracker read
   * @param updatedStamp - The ticket's tracker `updated` value at recording
   *                       time, persisted so the gate can skip re-reads
   */
  markTaskActioned(
    source: string,
    taskKey: string,
    signal: string,
    verified = true,
    updatedStamp?: string,
    options: {
      pending?: boolean;
      fallbackSnapshot?: string;
      transitioned?: boolean;
      transitionStatus?: string;
    } = {},
  ): void {
    this.db.run(
      `INSERT INTO actioned_tasks (source, task_key, signal, verified, updated_stamp,
                                  pending, fallback_snapshot, transitioned, transition_status, actioned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, task_key) DO UPDATE SET
         signal = excluded.signal,
         verified = excluded.verified,
         updated_stamp = excluded.updated_stamp,
         pending = excluded.pending,
         fallback_snapshot = excluded.fallback_snapshot,
         transitioned = excluded.transitioned,
         transition_status = excluded.transition_status,
         actioned_at = excluded.actioned_at`,
      [
        source,
        taskKey,
        signal,
        verified ? 1 : 0,
        updatedStamp?.trim() || null,
        options.pending ? 1 : 0,
        options.fallbackSnapshot ?? null,
        options.transitioned ? 1 : 0,
        options.transitionStatus ?? null,
        Date.now(),
      ],
    );
  }

  /**
   * Forget a ticket's actioned state so a genuine change can be re-implemented.
   *
   * @param source - Tracker source key
   * @param taskKey - Tracker task key
   */
  clearTaskActioned(source: string, taskKey: string): void {
    this.db.run(`DELETE FROM actioned_tasks WHERE source = ? AND task_key = ?`, [source, taskKey]);
  }

  /**
   * Read one metadata value (e.g. the last task-drain timestamp used by
   * working-window catch-up). Returns null when never written.
   */
  getMeta(key: string): string | null {
    const row = this.db.query(`SELECT value FROM worker_meta WHERE key = ?`).get(key);
    if (!row) {
      return null;
    }
    return requireString(parseRowObject(row, "worker_meta row"), "value", "worker_meta row");
  }

  /** Upsert one metadata value. */
  setMeta(key: string, value: string): void {
    this.db.run(
      `INSERT INTO worker_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, Date.now()],
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
 * The ticket URL is derived here, in the worker/CLI process that has the
 * project's tracker configuration loaded, and frozen in the registry so the
 * dashboard never has to re-derive it from its own (possibly unrelated)
 * environment.
 *
 * @param prUrl - PR URL returned by the PR client
 * @param branch - Source branch of the PR
 * @param taskKey - Task tracker key the PR implements
 * @param identity - Provider identity returned directly by the creation client
 */
export function recordAgentPrFromUrl(
  prUrl: string,
  branch?: string,
  taskKey?: string,
  identity?: ChangeRequestIdentity,
): void {
  try {
    const parsed =
      identity ??
      parseChangeRequestUrl(prUrl, {
        gitlabBaseUrl: process.env.GITLAB_CODE_HOST_URL,
      });
    if (!parsed) {
      return;
    }
    const ticketUrl = buildTicketUrl(process.env.TASK_TRACKER, taskKey);
    const state = new WorkerState();
    try {
      state.recordAgentChangeRequest(parsed, { branch, taskKey, ticketUrl });
    } finally {
      state.close();
    }
  } catch (error) {
    console.warn(`⚠️  Could not record agent PR for polling: ${(error as Error).message}`);
  }
}
