/**
 * Orphaned-run recovery
 *
 * Bridges crash detection to task resumption. When a worker dies mid-task
 * (power cut, crash, `kill -9`), the run row stays `in_progress` in the
 * queue database and the ticket stays stranded in its "In Progress" status
 * with no comment — the graceful SIGINT/SIGTERM feedback path never ran.
 *
 * On startup, before any acquirer picks new work, the worker:
 *
 * 1. Reaps every leftover `in_progress` run (all origins) — the existing
 *    `reapOrphanedRuns` behavior, kept intact.
 * 2. For each orphaned *task* run with a tracker ticket key, approximates
 *    the graceful-shutdown UX: posts the same processing-failure comment
 *    (reusing {@link reportTaskFailure}) and moves the ticket back to its
 *    To Do status, so the normal query can consider it again.
 *
 * No duplicate execution: the posted comment plus the recorded incomplete
 * attempt feed the existing retry gate, so a requeued-but-unchanged ticket
 * is skipped on the next pickup exactly like any other reported failure.
 * It re-runs only when the ticket changes (edit, comment) or `--force` is
 * used — the documented manual behavior is unchanged.
 *
 * Guards against noisy or harmful notifications:
 *
 * - **Remote completion** — a ticket that no longer sits in the configured
 *   "In Progress" status (Done, In Review, or moved by a human) is left
 *   alone; recovery never clobbers progress that happened after the crash.
 * - **Very old orphans** — runs started before the cutoff (default 7 days)
 *   are reaped silently; they were most likely already handled manually.
 * - **Non-ticket runs** — scheduled automations recover via their own lease
 *   machinery and PR-scoped runs have their own comment flows, so only
 *   `task`-origin runs with a real ticket key get tracker feedback.
 *
 * Best-effort throughout: tracker and storage failures degrade to the old
 * reap-only behavior with a warning, never a startup failure.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { isMarkdownFilePath } from "@devintern/task-trackers";

import type { ProjectSettings } from "../types/settings";
import type { FailureAttemptRecorder } from "./failure-feedback";
import { reportTaskFailure } from "./failure-feedback";
import type { RunRecord, RunStore } from "./run-recorder";
import type { TaskTrackerClient } from "./task-tracker-client";

/** Reason posted on tickets whose run was orphaned by a dead worker. */
export const ORPHANED_RUN_REASON =
  "The worker exited unexpectedly (crash or power loss) while this task was in progress, " +
  "before a pull request could be created";

/** Orphans older than this are reaped silently (likely handled manually). */
export const DEFAULT_ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How many orphaned runs to consider per startup (bound tracker feedback). */
const MAX_ORPHANS = 50;

export interface OrphanRecoveryDeps {
  runStore: RunStore;
  /**
   * Tracker client for ticket feedback. Omitted (e.g. tracker credentials
   * unavailable) → reap-only with a warning, matching the old behavior.
   */
  tracker?: TaskTrackerClient;
  /** Tracker identifier stored with the retry state (`TASK_TRACKER`). */
  trackerType?: string;
  /** Resolve the tracker project key for a task key (defaults per tracker env). */
  projectKeyFor?: (taskKey: string) => string;
  /** Resolve the configured In Progress status for a project (null = unknown). */
  getInProgressStatus?: (projectKey: string) => string | null | undefined;
  /** Resolve the configured To Do status for a project (null = unknown). */
  getTodoStatus?: (projectKey: string) => string | null | undefined;
  /** Retry-gate recorder (injected for tests; default is the shared store). */
  recordAttempt?: FailureAttemptRecorder;
  /** Skip feedback for runs started before `now - maxAgeMs`. */
  maxAgeMs?: number;
  /** Present tense "now", overridable in tests. */
  now?: number;
  log?: typeof console.log;
  warn?: typeof console.warn;
}

export interface OrphanRecoveryResult {
  /** Leftover `in_progress` runs marked failed (all origins). */
  reaped: number;
  /** Orphaned task runs that received tracker feedback. */
  recovered: number;
  /** Orphaned task runs deliberately left alone (stale, moved on, no key). */
  skipped: number;
}

/**
 * Detect runs abandoned by a previous worker instance, reap them, and give
 * the affected tickets the same interrupt feedback a graceful shutdown
 * would have. Never throws.
 */
export async function recoverOrphanedTaskRuns(
  deps: OrphanRecoveryDeps,
): Promise<OrphanRecoveryResult> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const now = deps.now ?? Date.now();
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS;

  let orphans: RunRecord[] = [];
  try {
    orphans = deps.runStore.listRuns({ status: "in_progress", origin: "task", limit: MAX_ORPHANS });
  } catch (error) {
    warn(`⚠️  Could not list in-progress runs for recovery: ${(error as Error).message}`);
  }

  // Reap first (all origins) — the pre-existing behavior this module builds on.
  let reaped = 0;
  try {
    reaped = deps.runStore.reapOrphanedRuns();
  } catch (error) {
    warn(`⚠️  Could not reap orphaned runs: ${(error as Error).message}`);
  }

  if (reaped === 0) {
    return { reaped, recovered: 0, skipped: 0 };
  }

  if (!deps.tracker) {
    warn(
      `⚠️  ${reaped} orphaned run(s) from the previous worker marked failed, ` +
        "but no tracker client is available to notify their tickets",
    );
    return { reaped, recovered: 0, skipped: 0 };
  }

  log(
    `🔁 ${reaped} in-progress run(s) left behind by the previous worker; ` +
      "recovering affected tickets before picking up new work",
  );

  let recovered = 0;
  let skipped = 0;
  const notified = new Set<string>();

  for (const run of orphans) {
    const taskKey = run.taskKey;
    if (!taskKey || notified.has(taskKey)) {
      continue;
    }
    notified.add(taskKey);

    if (isMarkdownFilePath(taskKey)) {
      // Markdown "tickets" are local files; automations recover via their
      // next occurrence, so there is nothing to notify.
      skipped++;
      continue;
    }

    if (now - run.startedAt > maxAgeMs) {
      log(
        `⏭️  Orphaned run for ${taskKey} started more than ${Math.round(maxAgeMs / 86_400_000)} day(s) ago; leaving the ticket alone`,
      );
      skipped++;
      continue;
    }

    // Avoid clobbering remote progress: only tickets still sitting in the
    // configured In Progress status were stranded by the crash.
    const projectKey = (deps.projectKeyFor ?? defaultProjectKeyFor)(taskKey);
    const inProgressStatus = deps.getInProgressStatus?.(projectKey)?.trim();
    let movedToInProgress = false;
    try {
      const task = await deps.tracker.getTask(taskKey);
      const currentStatus = task.status?.trim();
      if (inProgressStatus && currentStatus !== inProgressStatus) {
        log(
          `⏭️  ${taskKey} is now '${currentStatus ?? "unknown"}' (not '${inProgressStatus}'); ` +
            "assuming it was handled after the crash and leaving it alone",
        );
        skipped++;
        continue;
      }
      movedToInProgress = Boolean(inProgressStatus);
    } catch (error) {
      warn(`⚠️  Could not fetch ${taskKey} to recover it: ${(error as Error).message}`);
      skipped++;
      continue;
    }

    await reportTaskFailure({
      taskKey,
      reason: ORPHANED_RUN_REASON,
      tracker: deps.tracker,
      trackerType: deps.trackerType ?? process.env.TASK_TRACKER ?? "jira",
      projectKey,
      movedToInProgress,
      getTodoStatus: () => deps.getTodoStatus?.(projectKey),
      recordAttempt: deps.recordAttempt,
      log,
      warn,
    });
    recovered++;
  }

  if (recovered > 0) {
    log(
      `✅ Recovered ${recovered} orphaned ticket(s): failure comment posted and moved back to ` +
        "To Do. They re-run when the ticket changes (see the posted comment).",
    );
  }
  return { reaped, recovered, skipped };
}

/**
 * Best-effort project key for a task key, mirroring the CLI's env-based
 * resolution (tracker-specific env wins; otherwise the `PROJ-1` prefix).
 */
export function defaultProjectKeyFor(taskKey: string): string {
  const trackerType = (process.env.TASK_TRACKER || "jira").toLowerCase();
  const envKey: Record<string, string | undefined> = {
    trello: process.env.TRELLO_DEFAULT_BOARD_ID,
    github: process.env.GITHUB_REPO,
    gitlab: process.env.GITLAB_PROJECT,
    "azure-devops": process.env.AZURE_DEVOPS_PROJECT,
    asana: process.env.ASANA_DEFAULT_PROJECT_GID,
  };
  return envKey[trackerType] || taskKey.split("-")[0] || taskKey;
}

// ---------------------------------------------------------------------------
// Settings resolution for status names.
//
// Fleet tasks run as CLI subprocesses in per-repo worktrees, so the pipeline
// reads each repo's `.devintern-code/settings.json` relative to its cwd. The
// recovery path runs in the worker process before any worktree exists for the
// orphaned run, so it reads settings from the repos' persistent base
// worktrees instead (first configured repo wins per project key).
// ---------------------------------------------------------------------------

const TRACKER_SECTION_KEYS = [
  "jira",
  "linear",
  "trello",
  "azure-devops",
  "asana",
  "github",
  "gitlab",
  "markdown",
] as const;

/**
 * Merge the `.devintern-code/settings.json` of the given directories into one
 * settings view (earlier directories win per project key). Returns null when
 * none of the directories has a readable settings file.
 */
export function loadProjectSettingsFrom(dirs: string[]): ProjectSettings | null {
  let merged: ProjectSettings | null = null;
  for (const dir of dirs) {
    const settingsPath = join(dir, ".devintern-code", "settings.json");
    if (!existsSync(settingsPath)) {
      continue;
    }
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as ProjectSettings;
      merged = merged ?? {};
      mergeSettingsInto(merged, settings);
    } catch {
      // Unreadable settings degrade to "no status names configured".
    }
  }
  return merged;
}

/** First-wins merge of tracker project sections and the legacy top-level map. */
function mergeSettingsInto(target: ProjectSettings, source: ProjectSettings): void {
  for (const key of TRACKER_SECTION_KEYS) {
    const projects = source[key]?.projects;
    if (!projects) {
      continue;
    }
    const existing = target[key]?.projects ?? {};
    target[key] = { projects: { ...projects, ...existing } };
  }
  if (source.projects) {
    target.projects = { ...source.projects, ...target.projects };
  }
}

/**
 * Resolve a status name (`inProgressStatus` / `todoStatus` / `prStatus`) for
 * a project from settings. Mirrors the CLI's resolution: tracker-specific
 * section first, tracker-specific env key fallback for the project key's
 * meaning is handled by the caller; legacy top-level `projects` applies to
 * Jira only.
 */
export function resolveStatusName(
  settings: ProjectSettings | null,
  trackerType: string,
  projectKey: string,
  field: "inProgressStatus" | "todoStatus" | "prStatus",
): string | undefined {
  if (!settings) {
    return undefined;
  }
  const tracker = trackerType.toLowerCase();
  const section = settings[tracker as keyof ProjectSettings] as
    | { projects?: Record<string, Record<string, unknown>> }
    | undefined;
  const projectConfig = section?.projects?.[projectKey];
  const fromSection = projectConfig?.[field];
  if (typeof fromSection === "string") {
    return fromSection;
  }

  // Trello cards key settings by board; a single configured board stands in
  // for an unlisted one (same fallback the pipeline uses).
  if (tracker === "trello") {
    const boardKeys = Object.keys(section?.projects ?? {});
    const fallback = boardKeys.length === 1 ? (boardKeys[0] as string) : undefined;
    if (fallback) {
      const single = section?.projects?.[fallback]?.[field];
      if (typeof single === "string") {
        return single;
      }
    }
  }

  if (tracker === "jira") {
    const legacy = (settings.projects?.[projectKey] as Record<string, unknown> | undefined)?.[
      field
    ];
    if (typeof legacy === "string") {
      return legacy;
    }
  }

  return undefined;
}
