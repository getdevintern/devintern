/**
 * Project settings loading and per-project workflow status resolution.
 *
 * Extracted from src/index.ts so pipeline steps can consume these helpers
 * without importing the CLI entrypoint (which would create an import cycle).
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { BaseProjectConfig, ProjectSettings, TrackerSection } from "../types/settings";

/** Load `.devintern-code/settings.json` from the current working directory. */
export function loadProjectSettings(): ProjectSettings | null {
  const settingsPath = resolve(process.cwd(), ".devintern-code", "settings.json");

  if (!existsSync(settingsPath)) {
    return null;
  }

  try {
    const settingsContent = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(settingsContent) as ProjectSettings;
    return settings;
  } catch (error) {
    console.warn(`⚠️  Failed to parse settings.json: ${error}`);
    return null;
  }
}

/**
 * Resolve the active tracker type from environment.
 */
export function getActiveTrackerType(): string {
  return (process.env.TASK_TRACKER || "jira").toLowerCase();
}

/** Resolve the settings project key for a task (board key for Trello). */
export function resolveProjectKey(taskKey: string, task?: { raw: unknown }): string {
  const trackerType = getActiveTrackerType();
  if (trackerType === "trello") {
    const raw = task?.raw as
      | { idBoard?: string; board?: { id?: string; shortLink?: string } }
      | undefined;
    const boardKey = raw?.board?.shortLink ?? raw?.idBoard ?? process.env.TRELLO_DEFAULT_BOARD_ID;
    if (boardKey) {
      return boardKey;
    }
  }
  if (trackerType === "github" && process.env.GITHUB_REPO) {
    return process.env.GITHUB_REPO;
  }
  if (trackerType === "azure-devops" && process.env.AZURE_DEVOPS_PROJECT) {
    return process.env.AZURE_DEVOPS_PROJECT;
  }
  if (trackerType === "asana") {
    const raw = task?.raw as { memberships?: Array<{ project?: { gid?: string } }> } | undefined;
    const projectGid =
      raw?.memberships?.find((membership) => membership.project?.gid)?.project?.gid ??
      process.env.ASANA_DEFAULT_PROJECT_GID;
    if (projectGid) {
      return projectGid;
    }
  }
  return taskKey.split("-")[0] ?? taskKey;
}

/**
 * Resolve tracker-specific project configuration from settings.
 *
 * Checks the tracker-specific section first (e.g., `settings.jira.projects`),
 * then falls back to the legacy top-level `projects` map for backward
 * compatibility when the active tracker is Jira.
 */
export function resolveProjectConfig(
  projectKey: string,
  settings: ProjectSettings | null,
  trackerType?: string,
): BaseProjectConfig | undefined {
  if (!settings) {
    return undefined;
  }

  const tracker = trackerType ? trackerType.toLowerCase() : getActiveTrackerType();

  // 1. Check tracker-specific section first
  const trackerSection = settings[tracker as keyof ProjectSettings];
  if (trackerSection && typeof trackerSection === "object" && "projects" in trackerSection) {
    const projects = (trackerSection as TrackerSection).projects;
    if (projects) {
      const config = projects[projectKey];
      if (config) {
        return config;
      }

      // Trello cards expose a 24-char idBoard; settings often use the board short link.
      if (tracker === "trello") {
        const defaultBoardId = process.env.TRELLO_DEFAULT_BOARD_ID;
        if (defaultBoardId && defaultBoardId !== projectKey && projects[defaultBoardId]) {
          return projects[defaultBoardId];
        }

        const projectKeys = Object.keys(projects);
        if (projectKeys.length === 1 && projectKeys[0]) {
          return projects[projectKeys[0]];
        }
      }
    }
  }

  // 2. Fall back to legacy top-level `projects` for Jira backward compatibility.
  //    The legacy map was originally Jira-only, so we only fall back for Jira.
  if (tracker === "jira" && settings.projects) {
    return settings.projects[projectKey];
  }

  return undefined;
}

/** Resolve the status name to use after PR creation for a project. */
export function getPrStatusForProject(
  projectKey: string,
  settings: ProjectSettings | null,
): string | undefined {
  return resolveProjectConfig(projectKey, settings)?.prStatus;
}

/** Resolve the "In Progress" status name for a project. */
export function getInProgressStatusForProject(
  projectKey: string,
  settings: ProjectSettings | null,
): string | undefined {
  return resolveProjectConfig(projectKey, settings)?.inProgressStatus;
}

/** Resolve the "To Do" status name for a project. */
export function getTodoStatusForProject(
  projectKey: string,
  settings: ProjectSettings | null,
): string | undefined {
  return resolveProjectConfig(projectKey, settings)?.todoStatus;
}

/** Return an optional story-points custom field override from project settings. */
export function getStoryPointsFieldForProject(
  projectKey: string,
  settings: ProjectSettings | null,
): string | undefined {
  return resolveProjectConfig(projectKey, settings)?.storyPointsField;
}
