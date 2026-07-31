/**
 * Change detectors: the "detect" half of the worker's detect-then-evaluate
 * polling loop.
 *
 * A detector answers one cheap, cursor-based question per tick: did anything
 * change at the source since the cursor? It never decides whether a task is
 * ready — the acquirer re-runs the user's configured `--query` filter
 * (evaluate) and dedupes by `(task key, updated)`, so detectors stay small
 * and per-tracker query semantics are reused verbatim.
 *
 * Detectors register per tracker; `TRACKER_CAPABILITIES[tracker].poll` is
 * the rollout switch.
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";

import { AsanaClient, TrelloClient } from "@devintern/task-trackers";

export interface DetectionResult {
  /** Whether anything changed since the cursor (always true on first run). */
  changed: boolean;
  /** New high-water mark to persist; null when the source is empty. */
  nextCursor: string | null;
}

export interface ChangeDetector {
  /** Source key used for cursor persistence (usually the tracker name). */
  source: string;
  /**
   * Cheap delta check against the tracker.
   *
   * @param cursor - Last persisted high-water mark, or null on first run
   */
  changesSince(cursor: string | null): Promise<DetectionResult>;
}

/**
 * Markdown tracker detector: scans `MARKDOWN_TASKS_DIR` file mtimes.
 * Zero-config demo path — a folder of markdown tasks needs no accounts.
 *
 * @param tasksDir - Directory containing `.md` task files
 */
export function createMarkdownChangeDetector(tasksDir: string): ChangeDetector {
  return {
    source: "markdown",
    async changesSince(cursor: string | null): Promise<DetectionResult> {
      let maxMtime = 0;
      let changed = false;
      const since = cursor === null ? null : Number(cursor);

      let names: string[];
      try {
        names = readdirSync(tasksDir).filter((name) => name.toLowerCase().endsWith(".md"));
      } catch {
        return { changed: false, nextCursor: cursor };
      }

      for (const name of names) {
        let mtime: number;
        try {
          mtime = statSync(join(tasksDir, name)).mtimeMs;
        } catch {
          continue; // deleted between readdir and stat
        }
        if (mtime > maxMtime) {
          maxMtime = mtime;
        }
        if (since === null || mtime > since) {
          changed = true;
        }
      }

      return {
        changed,
        nextCursor: maxMtime > 0 ? String(maxMtime) : cursor,
      };
    },
  };
}

/** Tracker search function injected into query-based detectors. */
export type SearchTasksFn = (query: string) => Promise<{ tasks: Array<{ key: string }> }>;

/**
 * Build a detector that runs one cheap tracker query per tick asking "did
 * anything change since the cursor?". The cursor is the detection start time
 * (epoch ms); the query window always overlaps the previous one, and the
 * acquirer's `(key, updated)` dedupe absorbs re-detections, so clock skew or
 * a crash mid-tick can delay work but never drop it.
 *
 * @param source - Cursor source key (tracker name)
 * @param searchTasks - The tracker's `searchTasks`
 * @param buildDeltaQuery - Tracker-specific "changed since" query builder
 */
function createQueryChangeDetector(
  source: string,
  searchTasks: SearchTasksFn,
  buildDeltaQuery: (sinceEpochMs: number) => string,
): ChangeDetector {
  return {
    source,
    async changesSince(cursor: string | null): Promise<DetectionResult> {
      const now = Date.now();
      if (cursor === null) {
        // First run: drain the backlog (evaluate everything the query matches).
        return { changed: true, nextCursor: String(now) };
      }

      const since = Number(cursor);
      if (!Number.isFinite(since)) {
        return { changed: true, nextCursor: String(now) };
      }

      const { tasks } = await searchTasks(buildDeltaQuery(since));
      return { changed: tasks.length > 0, nextCursor: String(now) };
    },
  };
}

/** Jira: relative JQL window (`updated >= "-Nm"`) avoids timezone pitfalls. */
export function createJiraChangeDetector(searchTasks: SearchTasksFn): ChangeDetector {
  return createQueryChangeDetector("jira", searchTasks, (since) => {
    const minutes = Math.max(1, Math.ceil((Date.now() - since) / 60_000) + 1);
    return `updated >= "-${minutes}m"`;
  });
}

/** Linear: `IssueFilter` on `updatedAt` (UTC ISO). */
export function createLinearChangeDetector(searchTasks: SearchTasksFn): ChangeDetector {
  return createQueryChangeDetector("linear", searchTasks, (since) =>
    JSON.stringify({ updatedAt: { gt: new Date(since).toISOString() } }),
  );
}

/** GitHub Issues: `updated:>=` search qualifier (auto-scoped to the repo). */
export function createGitHubChangeDetector(searchTasks: SearchTasksFn): ChangeDetector {
  return createQueryChangeDetector("github", searchTasks, (since) => {
    const iso = new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z");
    return `updated:>=${iso}`;
  });
}

/**
 * Azure DevOps: WIQL on `[System.ChangedDate]`. WIQL date literals are
 * day-precision by default, so the window is the cursor's calendar day (UTC);
 * within an active day this over-reports changes, which only costs an extra
 * evaluate query — dedupe keeps execution exactly-once.
 */
export function createAzureDevOpsChangeDetector(searchTasks: SearchTasksFn): ChangeDetector {
  return createQueryChangeDetector("azure-devops", searchTasks, (since) => {
    const day = new Date(since).toISOString().slice(0, 10);
    return `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= '${day}'`;
  });
}

/**
 * Trello: board actions feed. `since=<last action id>` returns only newer
 * actions (newest first) — a different API than card search, which is why
 * the acquirer re-evaluates the user's filter instead of composing queries.
 *
 * @param getBoardActions - `TrelloClient.getBoardActions` bound to the board
 */
export function createTrelloChangeDetector(
  getBoardActions: (since?: string) => Promise<Array<{ id: string }>>,
): ChangeDetector {
  return {
    source: "trello",
    async changesSince(cursor: string | null): Promise<DetectionResult> {
      const actions = await getBoardActions(cursor ?? undefined);
      const newestActionId = actions[0]?.id ?? null;

      if (cursor === null) {
        // First run: establish the cursor and drain the backlog.
        return { changed: true, nextCursor: newestActionId };
      }
      return { changed: actions.length > 0, nextCursor: newestActionId ?? cursor };
    },
  };
}

/**
 * Asana: Events API with opaque sync tokens. A 412 (first call or expired
 * token) yields a fresh token with an unknown gap — treated as changed so
 * the evaluate step drains anything missed.
 *
 * @param getEvents - `AsanaClient.getEvents` bound to the watched project
 */
export function createAsanaChangeDetector(
  getEvents: (
    syncToken?: string,
  ) => Promise<{ events: unknown[]; sync: string; fullSync: boolean }>,
): ChangeDetector {
  return {
    source: "asana",
    async changesSince(cursor: string | null): Promise<DetectionResult> {
      const page = await getEvents(cursor ?? undefined);
      const nextCursor = page.sync || cursor;

      if (cursor === null || page.fullSync) {
        return { changed: true, nextCursor };
      }
      return { changed: page.events.length > 0, nextCursor };
    },
  };
}

/**
 * Resolve the change detector for a tracker, or null when polling is not
 * implemented for it yet (or its environment is incomplete).
 *
 * @param trackerType - `TASK_TRACKER` value (e.g. `markdown`, `jira`)
 * @param searchTasks - The tracker's `searchTasks` (required by query-based detectors)
 */
export function createChangeDetector(
  trackerType: string,
  searchTasks?: SearchTasksFn,
): ChangeDetector | null {
  switch (trackerType) {
    case "markdown": {
      const tasksDir = process.env.MARKDOWN_TASKS_DIR;
      return tasksDir ? createMarkdownChangeDetector(tasksDir) : null;
    }
    case "jira":
      return searchTasks ? createJiraChangeDetector(searchTasks) : null;
    case "linear":
      return searchTasks ? createLinearChangeDetector(searchTasks) : null;
    case "github":
      return searchTasks ? createGitHubChangeDetector(searchTasks) : null;
    case "azure-devops":
      return searchTasks ? createAzureDevOpsChangeDetector(searchTasks) : null;
    case "trello": {
      const apiKey = process.env.TRELLO_API_KEY;
      const apiToken = process.env.TRELLO_API_TOKEN;
      const boardId = process.env.TRELLO_DEFAULT_BOARD_ID;
      if (!apiKey || !apiToken || !boardId) {
        return null; // board actions require TRELLO_DEFAULT_BOARD_ID
      }
      const client = new TrelloClient({ apiKey, apiToken });
      return createTrelloChangeDetector((since) => client.getBoardActions(boardId, { since }));
    }
    case "asana": {
      const apiToken = process.env.ASANA_API_TOKEN;
      const projectGid = process.env.ASANA_DEFAULT_PROJECT_GID;
      if (!apiToken || !projectGid) {
        return null; // events feed requires ASANA_DEFAULT_PROJECT_GID
      }
      const client = new AsanaClient({ apiToken });
      return createAsanaChangeDetector((sync) => client.getEvents(projectGid, sync));
    }
    default:
      return null;
  }
}
