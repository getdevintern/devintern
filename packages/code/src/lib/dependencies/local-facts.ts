/**
 * Build {@link DependencyFacts} for task dependencies from the local
 * workspace DB: the `injected_tasks` row (work state), the latest `runs` row
 * (outcome, PR, branch), and the `agent_prs` registry (PR open/merged/closed).
 * A stack base comes from `injected_tasks.stacked_on` (ad-hoc tasks) or
 * `tracker_dependencies.stacked_on` (tracker tickets).
 *
 * Only local reads: the acquirer calls this on every tick. Tables that do not
 * exist yet (a fresh workspace) read as "no facts" instead of failing.
 */

import type { Database } from "bun:sqlite";

import type { RunStatus } from "../state/run-recorder";
import { TRACKER_DEPENDENCIES_TABLE } from "../state/tracker-dependencies";
import type { DependencyFacts, DependencyPr, DependencyWorkState } from "./gate";

const RUN_STATUSES: readonly RunStatus[] = [
  "in_progress",
  "succeeded",
  "failed",
  "deferred",
  "escalated",
  "abandoned",
];

function hasTable(db: Database, name: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function workState(status: unknown): DependencyWorkState {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "missing";
  }
}

function prState(row: Record<string, unknown>): DependencyPr["state"] {
  if (row.state === "open") return "open";
  if (row.close_reason === "merged") return "merged";
  if (row.close_reason === "closed") return "closed";
  return "closed-unknown";
}

/**
 * Limit facts to one workspace team, for tracker keys that are only unique
 * within that team's source (a GitHub issue number such as `12`: two teams
 * polling different repositories can both have an issue `12`). Runs and
 * tracker gate rows must carry this team; PR registry rows must be the PR
 * that team's run reported; ad-hoc (`injected_tasks`) rows are ignored.
 */
export interface LocalFactsScope {
  team: string;
}

/**
 * Read the facts for each dependency key, in the order given.
 *
 * @param db - Open workspace DB connection (`state/queue.db`)
 * @param keys - Dependency task keys
 * @param scope - Only read facts recorded for this team (see {@link LocalFactsScope})
 */
export function readLocalDependencyFacts(
  db: Database,
  keys: readonly string[],
  scope?: LocalFactsScope,
): DependencyFacts[] {
  return readFacts(db, keys, new Set(), scope);
}

/**
 * Bound on how far a chain of stack bases is followed. Each hop is a task
 * whose PR merged into another task's branch; real chains are short.
 */
const MAX_STACK_BASE_DEPTH = 16;

/**
 * Scoped reads keep only the registry row for the PR this team's run
 * reported: the same task key in another team's repository has its own PRs.
 */
function scopedPrRows(
  rows: Array<Record<string, unknown>>,
  latestRun: DependencyFacts["latestRun"],
  scope: LocalFactsScope | undefined,
): Array<Record<string, unknown>> {
  if (!scope) return rows;
  const prNumber = latestRun?.prNumber;
  if (prNumber === undefined) return [];
  return rows.filter((row) => {
    const url = text(row.web_url);
    return (
      row.pr_number === prNumber &&
      (latestRun?.prUrl === undefined || url === undefined || url === latestRun.prUrl)
    );
  });
}

function teamClause(scope: LocalFactsScope | undefined): {
  teamFilter: string;
  teamArgs: string[];
} {
  return scope
    ? { teamFilter: " AND team = ?", teamArgs: [scope.team] }
    : { teamFilter: "", teamArgs: [] };
}

function readFacts(
  db: Database,
  keys: readonly string[],
  visiting: ReadonlySet<string>,
  scope: LocalFactsScope | undefined,
): DependencyFacts[] {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => "?").join(", ");
  const { teamFilter, teamArgs } = teamClause(scope);

  const work = new Map<string, DependencyWorkState>();
  const stackedOn = new Map<string, string>();
  const stackBlocked = new Map<string, string>();
  if (!scope && hasTable(db, "injected_tasks")) {
    const stackedOnColumn = hasColumn(db, "injected_tasks", "stacked_on") ? ", stacked_on" : "";
    const noticeColumn = hasColumn(db, "injected_tasks", "stack_notice") ? ", stack_notice" : "";
    const rows = db
      .query(
        `SELECT task_key, status${stackedOnColumn}${noticeColumn} FROM injected_tasks WHERE task_key IN (${placeholders})`,
      )
      .all(...unique) as Array<{
      task_key: string;
      status: string;
      stacked_on?: unknown;
      stack_notice?: unknown;
    }>;
    for (const row of rows) {
      work.set(row.task_key, workState(row.status));
      const base = text(row.stacked_on);
      if (base) stackedOn.set(row.task_key, base);
      const notice = text(row.stack_notice);
      if (notice) stackBlocked.set(row.task_key, notice);
    }
  }
  if (hasTable(db, TRACKER_DEPENDENCIES_TABLE)) {
    const rows = db
      .query(
        `SELECT task_key, stacked_on FROM ${TRACKER_DEPENDENCIES_TABLE}
         WHERE task_key IN (${placeholders})${teamFilter}
         ORDER BY updated_at ASC`,
      )
      .all(...unique, ...teamArgs) as Array<{
      task_key: string;
      stacked_on?: unknown;
    }>;
    for (const row of rows) {
      // An ad-hoc row's own base wins; tracker rows fill in tracker tickets.
      if (work.has(row.task_key)) continue;
      const base = text(row.stacked_on);
      if (base) stackedOn.set(row.task_key, base);
      else stackedOn.delete(row.task_key);
    }
  }

  const runs = new Map<string, NonNullable<DependencyFacts["latestRun"]>>();
  // A scoped read of a DB whose runs predate the team column reads no runs.
  if (hasTable(db, "runs") && (!scope || hasColumn(db, "runs", "team"))) {
    const prFailureColumn = hasColumn(db, "runs", "pr_failure") ? ", pr_failure" : "";
    const repoColumn = hasColumn(db, "runs", "repo") ? ", repo" : "";
    const rows = db
      .query(
        `SELECT task_key, status, pr_number, pr_url, branch${prFailureColumn}${repoColumn} FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY task_key ORDER BY started_at DESC, id DESC
           ) AS rn
           FROM runs WHERE task_key IN (${placeholders})${teamFilter}
         ) WHERE rn = 1`,
      )
      .all(...unique, ...teamArgs) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const key = text(row.task_key);
      const status = RUN_STATUSES.find((candidate) => candidate === row.status);
      if (!key || !status) continue;
      runs.set(key, {
        status,
        prNumber: integer(row.pr_number),
        prUrl: text(row.pr_url),
        branch: text(row.branch),
        prFailure: text(row.pr_failure),
        repo: text(row.repo),
      });
    }
  }

  const prs = new Map<string, Array<Record<string, unknown>>>();
  if (hasTable(db, "agent_prs")) {
    const closeColumns = hasColumn(db, "agent_prs", "close_reason") ? ", close_reason" : "";
    const urlColumn = hasColumn(db, "agent_prs", "web_url") ? ", web_url" : "";
    const mergeColumns = hasColumn(db, "agent_prs", "host_merged_at")
      ? ", host_merged_at, merged_into"
      : "";
    const defaultColumn = hasColumn(db, "agent_prs", "merged_into_default")
      ? ", merged_into_default"
      : "";
    const rows = db
      .query(
        `SELECT task_key, pr_number, branch, state${closeColumns}${urlColumn}${mergeColumns}${defaultColumn} FROM agent_prs
         WHERE task_key IN (${placeholders}) ORDER BY created_at DESC`,
      )
      .all(...unique) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const key = text(row.task_key);
      if (!key) continue;
      const list = prs.get(key) ?? [];
      list.push(row);
      prs.set(key, list);
    }
  }

  return unique.map((key) => {
    const latestRun = runs.get(key);
    // Prefer the registry row for the PR the latest run reported; else the
    // newest PR recorded for the task.
    const candidates = scopedPrRows(prs.get(key) ?? [], latestRun, scope);
    const row =
      (latestRun?.prNumber !== undefined
        ? candidates.find((candidate) => candidate.pr_number === latestRun.prNumber)
        : undefined) ?? (latestRun?.prNumber === undefined ? candidates[0] : undefined);
    const prNumber = row ? integer(row.pr_number) : undefined;
    const pr: DependencyPr | undefined =
      row && prNumber !== undefined
        ? {
            number: prNumber,
            url: text(row.web_url) ?? latestRun?.prUrl,
            branch: text(row.branch) ?? latestRun?.branch,
            state: prState(row),
            mergedAt: integer(row.host_merged_at),
            mergedInto: text(row.merged_into),
            mergedIntoDefault:
              row.merged_into_default === 1
                ? true
                : row.merged_into_default === 0
                  ? false
                  : undefined,
          }
        : undefined;
    const facts: DependencyFacts = { key, work: work.get(key) ?? "missing", latestRun, pr };
    const blocked = stackBlocked.get(key);
    if (blocked) facts.stackBlocked = blocked;
    // Only a merged PR consults its stack base, but read it whenever one is
    // recorded: the caller may learn the merge from the code host after this
    // read (a PR with no registry row, or a registry row that is stale).
    const base = stackedOn.get(key);
    if (base) {
      const chain = new Set(visiting).add(key);
      if (chain.has(base) || chain.size > MAX_STACK_BASE_DEPTH) {
        // A looping or runaway chain cannot be resolved; an unknown base
        // classifies as blocked rather than silently satisfied.
        facts.stackBase = { key: base, work: "missing" };
      } else {
        facts.stackBase = readFacts(db, [base], chain, scope)[0];
      }
    }
    return facts;
  });
}
