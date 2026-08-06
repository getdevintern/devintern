/**
 * Current project session for the main process.
 *
 * The app operates on a user-chosen project directory (same mental model as
 * the CLI: credentials live in `<project>/.devintern-pm/.env`). Nothing uses
 * `process.chdir` — the project dir is threaded through the `baseDir`
 * parameters on pm's config loaders.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { findConfigDir } from "@devintern/utils";
import { getTrackerDisplayName, type ConfiguredTracker } from "@devintern/task-trackers";
import { createEngine, DEFAULT_ISSUE_TYPES, type PmEngine } from "@getdevintern/pm/engine";
import { loadConfig, migrateLegacyConfigDir, type Config } from "@getdevintern/pm/config";
import type { ProjectStatus } from "../shared/ipc-contract.ts";
import {
  listConfiguredTrackersForProject,
  persistActiveProject,
  persistActiveTracker,
  readProjectEnv,
} from "./project-env.ts";

export interface Session {
  projectDir: string;
  config: Config;
  engine: PmEngine;
}

let current: Session | null = null;
/** Last project directory chosen in the UI — kept even when config load fails. */
let lastProjectDir: string | null = null;

export function getSession(): Session | null {
  return current;
}

export function requireSession(): Session {
  if (!current) {
    throw new Error("No project selected. Choose a project directory first.");
  }
  return current;
}

/** Project dir for switch/reload paths that must work even when config failed. */
export function requireProjectDir(): string {
  if (current) return current.projectDir;
  if (lastProjectDir) return lastProjectDir;
  throw new Error("No project selected. Choose a project directory first.");
}

/**
 * Resolve the pm package's bundled prompts/ directory.
 *
 * The engine gets bundled into out/main by electron-vite, so its own
 * module-relative default would point at the wrong place.
 */
function resolvePromptsDir(): string {
  const require = createRequire(import.meta.url);
  const pmPackageJson = require.resolve("@getdevintern/pm/package.json");
  return join(dirname(pmPackageJson), "prompts");
}

/** True when the project (or an ancestor) already has a `.devintern-code` directory. */
export async function detectCodeConfig(projectDir: string): Promise<boolean> {
  return findConfigDir({ configDirName: ".devintern-code", startDir: projectDir }) !== null;
}

async function resolveConfiguredTrackers(projectDir: string): Promise<ConfiguredTracker[]> {
  try {
    return await listConfiguredTrackersForProject(projectDir);
  } catch {
    return [];
  }
}

async function resolveActiveTrackerId(projectDir: string): Promise<string | undefined> {
  try {
    const { env } = await readProjectEnv(projectDir);
    return (env.TASK_TRACKER || "jira").toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Load (or reload) the session for a project directory and report its status.
 *
 * Config problems are reported in the returned status rather than thrown,
 * so the renderer can guide the user instead of crashing.
 */
export async function loadProject(projectDir: string): Promise<ProjectStatus> {
  current = null;
  lastProjectDir = projectDir;

  const configuredTrackers = await resolveConfiguredTrackers(projectDir);
  const activeTrackerId = await resolveActiveTrackerId(projectDir);

  const status: ProjectStatus = {
    projectDir,
    configured: false,
    hasCodeConfig: await detectCodeConfig(projectDir),
    configuredTrackers,
    activeTrackerId,
    activeTrackerDisplayName: activeTrackerId ? getTrackerDisplayName(activeTrackerId) : undefined,
  };

  try {
    await migrateLegacyConfigDir(projectDir);
    const config = await loadConfig(projectDir);
    const engine = await createEngine(config, {
      promptsDir: resolvePromptsDir(),
      baseDir: projectDir,
    });
    current = { projectDir, config, engine };

    status.configured = true;
    status.backendName = engine.backendName;
    status.activeTrackerId = config.backend.type;
    status.activeTrackerDisplayName = getTrackerDisplayName(config.backend.type);
    status.harnessDisplayName = config.agent.harness.displayName;
    status.supportsIssueTypes = engine.supportsIssueTypes;
    status.supportsEpicLinking = engine.supportsEpicLinking;
    status.defaultProjectKey = engine.defaultProjectKey;
    status.supportsProjectSwitch = Boolean(
      configuredTrackers.find((t) => t.id === config.backend.type)?.projectKeyEnv,
    );

    try {
      status.projects = await engine.listProjects();
    } catch (error) {
      status.projects = undefined;
      status.projectsError = error instanceof Error ? error.message : String(error);
    }
    if (engine.supportsIssueTypes) {
      try {
        status.issueTypes = await engine.listIssueTypes(status.defaultProjectKey);
      } catch {
        status.issueTypes = [...DEFAULT_ISSUE_TYPES];
      }
    }
  } catch (error) {
    status.configError = error instanceof Error ? error.message : String(error);
  }

  return status;
}

/** Persist `TASK_TRACKER` and reload the session for the new backend. */
export async function switchTracker(trackerId: string): Promise<ProjectStatus> {
  const projectDir = requireProjectDir();
  await persistActiveTracker(projectDir, trackerId);
  return loadProject(projectDir);
}

/** Persist the tracker's project-key env var and reload the session. */
export async function switchProjectKey(projectKey: string): Promise<ProjectStatus> {
  const projectDir = requireProjectDir();
  const trackerId = getSession()?.config.backend.type;
  await persistActiveProject(projectDir, projectKey, trackerId);
  return loadProject(projectDir);
}
