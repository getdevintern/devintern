/**
 * Tasks whose agent CLI recently failed to start, for `worker status`,
 * `worker queue`, `worker service status`, and the dashboard status API.
 *
 * A start failure leaves the worker looking healthy: the process runs, the
 * queue is empty (a polled ticket has no queue row while it waits), and the
 * only trace is a deferred run. This reader finds tasks whose latest run is a
 * start failure (`agent_start: …` reason, see `agent/agent-start-failure.ts`)
 * so those surfaces can say so, with the error and a fix hint.
 *
 * Read-only like the rest of the dashboard GET path: a missing file or table
 * degrades to an empty list and nothing is created.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

import { agentStartFixHint, parseAgentStartReason } from "../agent/agent-start-failure";
import { AGENT_START_REASON_PREFIX } from "../state/run-outcome";
import { configureSqliteConnection } from "../state/sqlite";
import type { NextStep } from "./readiness-json";

/** One task whose agent CLI failed to start on its latest run. */
export interface AgentStartFailureView {
  taskKey: string;
  repo?: string;
  /** Harness the failing run used (`claude-code`), when recorded. */
  harness?: string;
  /** Latest start-failure run. */
  runId: number;
  /** When that run ended (epoch ms). */
  at: number;
  /** `retrying`: deferred, the worker tries again; `failed`: the retry budget is spent. */
  state: "retrying" | "failed";
  /** Start failures in a row on this task, including the latest. */
  attempts: number;
  /** Redacted one-line error (`Claude Code (claude) could not start: …`). */
  error: string;
  /** What to do about it. */
  hint: string;
}

/** How far back a start failure is still reported. */
export const AGENT_START_FAILURE_WINDOW_MS = 24 * 60 * 60_000;

/** Tasks listed at most. */
export const AGENT_START_FAILURE_LIMIT = 20;

interface RunRow {
  id: number;
  task_key: string;
  repo: string | null;
  harness: string | null;
  status: string;
  outcome_reason: string | null;
  started_at: number;
  finished_at: number | null;
}

/** Leading deferred start-failure runs of a newest-first history. */
function countDeferredStartFailures(
  history: ReadonlyArray<Pick<RunRow, "status" | "outcome_reason">>,
): number {
  let count = 0;
  for (const run of history) {
    if (run.status !== "deferred" || parseAgentStartReason(run.outcome_reason) === undefined) break;
    count++;
  }
  return count;
}

/**
 * Consecutive most recent runs of a task deferred because the agent CLI could
 * not start. Any other run (including a `failed` one that ended an earlier
 * streak, so a retry gets a fresh budget) stops the count. A missing or
 * unreadable database counts as none.
 *
 * @param dbPath - Run-history database
 * @param taskKey - Task whose runs to inspect
 * @param excludeRunId - The run being finished, left out of the count
 */
export function readAgentStartFailureStreak(
  dbPath: string,
  taskKey: string,
  excludeRunId?: number,
): number {
  if (!existsSync(dbPath)) return 0;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    configureSqliteConnection(db, { readonly: true });
    const rows = db
      .query(
        `SELECT status, outcome_reason FROM runs WHERE task_key = ? AND id != ?
         ORDER BY started_at DESC, id DESC LIMIT 100`,
      )
      .all(taskKey, excludeRunId ?? -1) as Array<Pick<RunRow, "status" | "outcome_reason">>;
    return countDeferredStartFailures(rows);
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

/** `{ agentStartFailures }` when any task's latest run failed to start the agent, else `{}`. */
export function withAgentStartFailures(dbPath: string): {
  agentStartFailures?: AgentStartFailureView[];
} {
  const failures = readAgentStartFailures(dbPath);
  return failures.length > 0 ? { agentStartFailures: failures } : {};
}

/**
 * Tasks whose latest run failed to start the agent, newest first.
 *
 * @param db - Open database holding the `runs` table
 * @param options.now - Clock (tests)
 * @param options.windowMs - Only runs started within this window
 * @param options.limit - Most tasks to return
 */
export function listAgentStartFailures(
  db: Database,
  options: { now?: number; windowMs?: number; limit?: number } = {},
): AgentStartFailureView[] {
  const since = (options.now ?? Date.now()) - (options.windowMs ?? AGENT_START_FAILURE_WINDOW_MS);
  const limit = options.limit ?? AGENT_START_FAILURE_LIMIT;
  const candidates = db
    .query(
      `SELECT id, task_key, repo, harness, status, outcome_reason, started_at, finished_at
       FROM runs
       WHERE task_key IS NOT NULL AND started_at >= ? AND status IN ('deferred', 'failed')
         AND substr(outcome_reason, 1, ?) = ?
       ORDER BY started_at DESC, id DESC LIMIT 500`,
    )
    .all(since, AGENT_START_REASON_PREFIX.length, AGENT_START_REASON_PREFIX) as RunRow[];
  const latestOfTask = db.query(
    `SELECT id, task_key, repo, harness, status, outcome_reason, started_at, finished_at
     FROM runs WHERE task_key = ? ORDER BY started_at DESC, id DESC LIMIT 100`,
  );
  const seen = new Set<string>();
  const views: AgentStartFailureView[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.task_key)) continue;
    seen.add(candidate.task_key);
    const history = latestOfTask.all(candidate.task_key) as RunRow[];
    const latest = history[0];
    // A newer run (one that started the agent, or is running now) supersedes it.
    if (!latest || latest.id !== candidate.id) continue;
    const error = parseAgentStartReason(latest.outcome_reason);
    if (error === undefined) continue;
    // The latest run may be the one that gave up; older ones must be deferrals.
    const attempts = 1 + countDeferredStartFailures(history.slice(1));
    const harness = latest.harness ?? undefined;
    views.push({
      taskKey: latest.task_key,
      ...(latest.repo ? { repo: latest.repo } : {}),
      ...(harness ? { harness } : {}),
      runId: latest.id,
      at: latest.finished_at ?? latest.started_at,
      state: latest.status === "failed" ? "failed" : "retrying",
      attempts,
      error,
      hint: agentStartFixHint(harness, error),
    });
    if (views.length >= limit) break;
  }
  return views;
}

/**
 * {@link listAgentStartFailures} over a database path, opened read-only.
 * Missing file, missing table, or a locked database read as no failures.
 *
 * @param dbPath - Run-history database
 * @param options - See {@link listAgentStartFailures}
 */
export function readAgentStartFailures(
  dbPath: string,
  options: { now?: number; windowMs?: number; limit?: number } = {},
): AgentStartFailureView[] {
  if (!existsSync(dbPath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    configureSqliteConnection(db, { readonly: true });
    return listAgentStartFailures(db, options);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Troubleshooting page for an agent CLI that fails to start. */
export const AGENT_START_DOCS_URL =
  "https://devintern.com/docs/code/worker-troubleshooting#the-agent-cli-fails-to-start";

/**
 * Headless next step (`{ id, message, command, url }`) for start failures, or
 * undefined when there are none. Names the newest failure's fix.
 *
 * @param failures - From {@link readAgentStartFailures}
 */
export function agentStartNextStep(failures: AgentStartFailureView[]): NextStep | undefined {
  const newest = failures[0];
  if (!newest) return undefined;
  const others = failures.length > 1 ? ` (${failures.length} tasks affected)` : "";
  return {
    id: "agent-start",
    message: `The agent CLI is failing to start${others}: ${newest.hint}; then retry the task`,
    command: "devintern worker status",
    url: AGENT_START_DOCS_URL,
  };
}

/**
 * Text lines describing start failures, shared by the CLI status commands.
 * Empty when there are none.
 *
 * @param failures - From {@link readAgentStartFailures}
 * @param formatTime - Timestamp formatter of the calling command
 */
export function renderAgentStartFailures(
  failures: AgentStartFailureView[],
  formatTime: (ms: number) => string = (ms) => new Date(ms).toISOString(),
): string[] {
  if (failures.length === 0) return [];
  const lines = ["Agent start: ❌ the agent CLI is failing to start"];
  for (const failure of failures) {
    const state =
      failure.state === "failed"
        ? `gave up after ${failure.attempts} attempt(s)`
        : `retrying with backoff (${failure.attempts} attempt(s) so far)`;
    lines.push(
      `  ${failure.taskKey}${failure.repo ? ` (${failure.repo})` : ""}: ${state}, last at ${formatTime(failure.at)}`,
      `    Error: ${failure.error}`,
      `    Fix:   ${failure.hint}`,
    );
  }
  if (failures.some((failure) => failure.state === "failed")) {
    lines.push(
      "  After fixing it, retry a task that gave up from the dashboard, by updating its ticket, " +
        "or (ad-hoc tasks) with `devintern worker add --resume <task>`.",
    );
  }
  return lines;
}
