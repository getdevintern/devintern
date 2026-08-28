/**
 * Canonical tracker metadata: display names, required env vars, and project-key
 * env vars. {@link parseTrackerConfigFromEnv} and the desktop switcher both
 * read required-env rules from here so they cannot drift.
 *
 * A tracker is considered configured when every `requiredEnv` entry is present
 * and non-empty (optional defaults like the bundled Trello API key are omitted
 * from `requiredEnv`).
 */

import type { TrackerType } from "./types.ts";

export type TrackerId = TrackerType;

export interface TrackerMeta {
  id: TrackerId;
  /** Name shown in UI / menus. */
  displayName: string;
  /**
   * Env vars that must be present (non-empty) for this tracker to load.
   * Single source of truth for `parseTrackerConfigFromEnv` validation.
   */
  requiredEnv: readonly string[];
  /**
   * Env var that stores the active project / team / board / repo key.
   * Absent when the tracker has no selectable remote projects (e.g. markdown).
   */
  projectKeyEnv?: string;
}

/** Menu / switcher order — matches pm and code init wizards. */
export const TRACKER_IDS: readonly TrackerId[] = [
  "jira",
  "linear",
  "trello",
  "azure-devops",
  "asana",
  "github",
  "gitlab",
  "markdown",
] as const;

export const TRACKER_META: Record<TrackerId, TrackerMeta> = {
  jira: {
    id: "jira",
    displayName: "Jira",
    requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_DEFAULT_PROJECT_KEY"],
    projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY",
  },
  linear: {
    id: "linear",
    displayName: "Linear",
    requiredEnv: ["LINEAR_API_KEY"],
    projectKeyEnv: "LINEAR_DEFAULT_TEAM_KEY",
  },
  trello: {
    id: "trello",
    displayName: "Trello",
    // TRELLO_API_KEY falls back to the bundled DevIntern key.
    requiredEnv: ["TRELLO_API_TOKEN"],
    projectKeyEnv: "TRELLO_DEFAULT_BOARD_ID",
  },
  "azure-devops": {
    id: "azure-devops",
    displayName: "Azure DevOps",
    requiredEnv: ["AZURE_DEVOPS_ORG", "AZURE_DEVOPS_PAT", "AZURE_DEVOPS_PROJECT"],
    projectKeyEnv: "AZURE_DEVOPS_PROJECT",
  },
  asana: {
    id: "asana",
    displayName: "Asana",
    requiredEnv: ["ASANA_API_TOKEN"],
    projectKeyEnv: "ASANA_DEFAULT_PROJECT_GID",
  },
  github: {
    id: "github",
    displayName: "GitHub Issues",
    requiredEnv: ["GITHUB_TOKEN", "GITHUB_REPO"],
    projectKeyEnv: "GITHUB_REPO",
  },
  gitlab: {
    id: "gitlab",
    displayName: "GitLab",
    // GITLAB_BASE_URL is optional (defaults to https://gitlab.com) so
    // self-hosted instances are supported without extra ceremony.
    requiredEnv: ["GITLAB_TOKEN", "GITLAB_PROJECT"],
    projectKeyEnv: "GITLAB_PROJECT",
  },
  markdown: {
    id: "markdown",
    displayName: "Markdown files",
    requiredEnv: ["MARKDOWN_TASKS_DIR"],
  },
};

export interface ConfiguredTracker {
  id: TrackerId;
  displayName: string;
  /** Env var used for the active project key, when the tracker supports one. */
  projectKeyEnv?: string;
}

/** Whether `id` is a known tracker type. */
export function isTrackerId(id: string): id is TrackerId {
  return Object.prototype.hasOwnProperty.call(TRACKER_META, id);
}

/** Display name for a tracker id; falls back to the raw id. */
export function getTrackerDisplayName(id: string): string {
  return isTrackerId(id) ? TRACKER_META[id].displayName : id;
}

/**
 * Required env keys for `trackerId` that are missing or blank in `env`.
 * Empty when the id is unknown.
 */
export function getMissingRequiredEnv(
  trackerId: string,
  env: Record<string, string | undefined>,
): string[] {
  if (!isTrackerId(trackerId)) return [];
  return TRACKER_META[trackerId].requiredEnv.filter((key) => !env[key]?.trim());
}

/**
 * True when every required env var for `trackerId` is present and non-empty.
 *
 * @param trackerId - Tracker to check.
 * @param env - Parsed project env (KEY → value).
 */
export function isTrackerConfigured(
  trackerId: string,
  env: Record<string, string | undefined>,
): boolean {
  return isTrackerId(trackerId) && getMissingRequiredEnv(trackerId, env).length === 0;
}

/**
 * Trackers whose required credentials are present in `env`.
 *
 * Order matches {@link TRACKER_IDS}. Does not consult `TASK_TRACKER` — the
 * active tracker is separate from "what can be switched to".
 */
export function listConfiguredTrackers(env: Record<string, string>): ConfiguredTracker[] {
  const configured: ConfiguredTracker[] = [];
  for (const id of TRACKER_IDS) {
    if (!isTrackerConfigured(id, env)) continue;
    const meta = TRACKER_META[id];
    configured.push({
      id,
      displayName: meta.displayName,
      projectKeyEnv: meta.projectKeyEnv,
    });
  }
  return configured;
}

/** Env var that stores the active project key for `trackerId`, if any. */
export function getProjectKeyEnvVar(trackerId: string): string | undefined {
  return isTrackerId(trackerId) ? TRACKER_META[trackerId].projectKeyEnv : undefined;
}
