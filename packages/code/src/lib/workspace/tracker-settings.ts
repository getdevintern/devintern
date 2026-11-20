/**
 * Tracker project settings in `workspace.toml`.
 *
 * Status names and the story-points field describe a tracker project (a Jira
 * key, a Trello board, a GitHub repo slug), not a code repository, so they
 * live in the workspace next to the tracker credentials:
 *
 * ```toml
 * [trackers.jira.projects.DEV]
 * in_progress_status = "In Progress"
 * todo_status = "To Do"
 * pr_status = "In Review"
 * story_points_field = "customfield_10016"
 * ```
 *
 * The parsed result uses the {@link ProjectSettings} shape the legacy
 * `.devintern-code/settings.json` file had, so every status lookup keeps
 * working unchanged.
 */

import { existsSync, readFileSync } from "fs";

import type { BaseProjectConfig, ProjectSettings } from "../../types/settings";
import { asTable } from "./config-readers";
import { resolveWorkspaceDir, workspaceConfigPath } from "./paths";
import { parseToml } from "./toml";

/** Tracker names accepted under `[trackers.<name>]`. */
export const TRACKER_SETTINGS_NAMES = [
  "jira",
  "linear",
  "trello",
  "azure-devops",
  "asana",
  "github",
  "gitlab",
  "markdown",
] as const;

type TrackerSettingsName = (typeof TRACKER_SETTINGS_NAMES)[number];

/** `workspace.toml` key → {@link BaseProjectConfig} field. */
const PROJECT_FIELDS = {
  in_progress_status: "inProgressStatus",
  todo_status: "todoStatus",
  pr_status: "prStatus",
  story_points_field: "storyPointsField",
} as const satisfies Record<string, keyof BaseProjectConfig>;

function isTrackerName(name: string): name is TrackerSettingsName {
  return (TRACKER_SETTINGS_NAMES as readonly string[]).includes(name);
}

/**
 * Parse the `[trackers]` table of a `workspace.toml` document.
 *
 * @param value - The raw `trackers` value from the parsed TOML document
 * @param errors - Collects every validation problem
 * @returns Settings with one section per configured tracker (empty when absent)
 */
export function parseTrackerSettings(value: unknown, errors: string[]): ProjectSettings {
  const settings: ProjectSettings = {};
  const trackers = asTable(value, "[trackers]", errors);
  for (const [name, rawTracker] of Object.entries(trackers)) {
    const label = `[trackers.${name}]`;
    if (!isTrackerName(name)) {
      errors.push(`${label} is not a known tracker (${TRACKER_SETTINGS_NAMES.join(", ")}).`);
      continue;
    }
    const trackerTable = asTable(rawTracker, label, errors);
    for (const key of Object.keys(trackerTable)) {
      if (key !== "projects")
        errors.push(`${label}: "${key}" is not supported; use [trackers.${name}.projects.<KEY>].`);
    }
    const projectsTable = asTable(trackerTable.projects, `[trackers.${name}.projects]`, errors);
    const projects: Record<string, BaseProjectConfig> = {};
    for (const [projectKey, rawProject] of Object.entries(projectsTable)) {
      const projectLabel = `[trackers.${name}.projects.${projectKey}]`;
      const projectTable = asTable(rawProject, projectLabel, errors);
      const project: BaseProjectConfig = {};
      for (const [key, raw] of Object.entries(projectTable)) {
        const field = PROJECT_FIELDS[key as keyof typeof PROJECT_FIELDS];
        if (!field) {
          errors.push(
            `${projectLabel}: "${key}" is not supported (${Object.keys(PROJECT_FIELDS).join(", ")}).`,
          );
          continue;
        }
        if (typeof raw !== "string" || !raw.trim()) {
          errors.push(`${projectLabel}: "${key}" must be a non-empty string.`);
          continue;
        }
        project[field] = raw.trim();
      }
      projects[projectKey] = project;
    }
    settings[name] = { projects };
  }
  return settings;
}

/**
 * Read only the `[trackers]` table of the workspace's `workspace.toml`.
 *
 * Status lookups run in every task, so this avoids the full workspace
 * validation; the worker validates the whole file at startup. A missing,
 * unreadable, or invalid file yields `null` (an invalid one with a warning).
 *
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`)
 */
export function loadWorkspaceTrackerSettings(
  workspaceDir: string = resolveWorkspaceDir(),
): ProjectSettings | null {
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) return null;
  let document: Record<string, unknown>;
  try {
    document = parseToml(readFileSync(configPath, "utf8"));
  } catch {
    // The worker reports a malformed workspace.toml; status lookups degrade.
    return null;
  }
  if (document.trackers === undefined) return null;
  const errors: string[] = [];
  const settings = parseTrackerSettings(document.trackers, errors);
  if (errors.length > 0) {
    console.warn(`⚠️  Ignoring [trackers] in ${configPath}:\n- ${errors.join("\n- ")}`);
    return null;
  }
  return settings;
}

/**
 * Overlay `base` under `primary`: per tracker section, a project key in
 * `primary` wins; keys only in `base` are kept. The legacy top-level
 * `projects` map and other fields follow the same first-wins rule.
 */
export function mergeTrackerSettings(
  primary: ProjectSettings | null,
  base: ProjectSettings | null,
): ProjectSettings | null {
  if (!primary) return base;
  if (!base) return primary;
  const merged: ProjectSettings = { ...base, ...primary };
  for (const name of TRACKER_SETTINGS_NAMES) {
    const projects = { ...base[name]?.projects, ...primary[name]?.projects };
    if (Object.keys(projects).length > 0) merged[name] = { projects };
  }
  if (base.projects || primary.projects) {
    merged.projects = { ...base.projects, ...primary.projects };
  }
  return merged;
}
