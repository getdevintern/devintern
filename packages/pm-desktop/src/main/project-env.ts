/**
 * Read / update `.devintern-pm/.env` for tracker and project switching.
 *
 * Persistence keeps the desktop app and `devpm` CLI on the same active
 * tracker + project key.
 */

import { readFile, writeFile } from "node:fs/promises";
import { findEnvFile, upsertEnvVars } from "@devintern/utils";
import {
  getProjectKeyEnvVar,
  isTrackerConfigured,
  isTrackerId,
  listConfiguredTrackers,
  parseEnvContent,
  type ConfiguredTracker,
  type TrackerId,
} from "@devintern/task-trackers";

const CONFIG_DIR = ".devintern-pm";

export function resolvePmEnvPath(projectDir: string): string | null {
  return findEnvFile({ configDirName: CONFIG_DIR, startDir: projectDir });
}

export async function readProjectEnv(projectDir: string): Promise<{
  envPath: string | null;
  env: Record<string, string>;
}> {
  const envPath = resolvePmEnvPath(projectDir);
  if (!envPath) {
    return { envPath: null, env: {} };
  }
  const content = await readFile(envPath, "utf8");
  return { envPath, env: parseEnvContent(content) };
}

export async function listConfiguredTrackersForProject(
  projectDir: string,
): Promise<ConfiguredTracker[]> {
  const { env } = await readProjectEnv(projectDir);
  return listConfiguredTrackers(env);
}

export async function upsertProjectEnvVars(
  projectDir: string,
  vars: Record<string, string>,
): Promise<string> {
  const envPath = resolvePmEnvPath(projectDir);
  if (!envPath) {
    throw new Error(`No ${CONFIG_DIR}/.env found under ${projectDir}. Run \`devpm init\` first.`);
  }
  const existing = await readFile(envPath, "utf8");
  const next = upsertEnvVars(existing, vars);
  await writeFile(envPath, next, "utf8");
  // Keep process.env in sync so the next loadConfig sees the new values even
  // if a prior load already populated overlapping keys.
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
  return envPath;
}

/**
 * Persist `TASK_TRACKER` for a configured tracker.
 *
 * @throws When the tracker id is unknown or missing required env vars.
 */
export async function persistActiveTracker(
  projectDir: string,
  trackerId: string,
): Promise<TrackerId> {
  if (!isTrackerId(trackerId)) {
    throw new Error(`Unknown task tracker: ${trackerId}`);
  }
  const { env } = await readProjectEnv(projectDir);
  if (!isTrackerConfigured(trackerId, env)) {
    throw new Error(
      `${trackerId} is not fully configured in ${CONFIG_DIR}/.env. Add its required credentials first.`,
    );
  }
  await upsertProjectEnvVars(projectDir, { TASK_TRACKER: trackerId });
  return trackerId;
}

/**
 * Persist the active project/team/board/repo key for the current tracker.
 *
 * @throws When there is no env file, no active tracker project-key env, or
 *   the key is empty.
 */
export async function persistActiveProject(
  projectDir: string,
  projectKey: string,
  trackerId?: string,
): Promise<{ trackerId: TrackerId; projectKeyEnv: string; projectKey: string }> {
  const trimmed = projectKey.trim();
  if (!trimmed) {
    throw new Error("Project key must not be empty.");
  }

  const { env } = await readProjectEnv(projectDir);
  const activeId = (trackerId ?? env.TASK_TRACKER ?? "jira").toLowerCase();
  if (!isTrackerId(activeId)) {
    throw new Error(`Unknown task tracker: ${activeId}`);
  }

  const projectKeyEnv = getProjectKeyEnvVar(activeId);
  if (!projectKeyEnv) {
    throw new Error(`${activeId} does not support switching remote projects from the UI.`);
  }

  await upsertProjectEnvVars(projectDir, { [projectKeyEnv]: trimmed });
  return { trackerId: activeId, projectKeyEnv, projectKey: trimmed };
}
